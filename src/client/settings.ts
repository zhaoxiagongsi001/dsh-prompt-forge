/**
 * Browser-side settings access.
 *
 * The official settings provider (`ctx.configForms`) already serves every
 * namespace the Host registers, keyed by the plugin's Loader entry id, and it
 * is the only supported path — third-party plugins must not hand-roll a
 * settings wire. This module therefore prefers `ctx.configForms.get(entryId)`
 * for both reads and writes, and falls back to a small loopback bridge over
 * this plugin's own route family only when `configForms` is absent.
 *
 * The entry id is discovered from the served roster rather than assumed: the
 * client half and the host half agree on the namespace string, but the entry id
 * is the profile's choice, so it is looked up by matching the namespace.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { CONFIG_FINGERPRINT_FIELDS, PROMPT_FORGE_NAMESPACE, type OptimizerConfig } from '../protocol.ts'
import { BUILTIN_PRESETS } from '../prompts.ts'

/** One settings path operation, matching the `settings.mutate` wire shape. */
export type SettingsOp = { op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }

/** One optimization preset: a named system prompt. */
export type ResolvedPreset = { id: string; name: string; system: string }

/**
 * The fully-resolved settings shape every consumer reads.
 *
 * Distinct from the wire's `OptimizerConfig`, whose fields are all optional
 * because they are individually overridable: consumers must not have to
 * re-decide what an absent field means, and `resolveConfig` is the one place
 * that decides.
 */
export interface ResolvedConfig {
  enabled: boolean
  provider: string
  model: string
  temperature: number
  maxTokens: number
  mainSystemPrompt: string
  presets: ResolvedPreset[]
  activePresetId: string
}

/** Snapshot the settings UI renders from. */
export interface SettingsSnapshot {
  /** `loading` until the first accepted section, `unavailable` when unreachable. */
  status: 'loading' | 'ready' | 'unavailable'
  /** Resolved values (stored over defaults). */
  value: ResolvedConfig
  /** Namespace revision fencing the next write. */
  revision: number | undefined
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** Which transport answered: the official form, or built-in defaults. */
  transport: 'configForms' | 'defaults'
}

/** The settings face the UI consumes. */
export interface SettingsHandle {
  getSnapshot(): SettingsSnapshot
  subscribe(listener: () => void): () => void
  /** Queue one atomic set of path operations. */
  apply(ops: SettingsOp[]): Promise<boolean>
  /** Re-read from the host. */
  reload(): Promise<void>
  /** Stop observing; safe to call once. */
  dispose(): void
}

/** Defaults mirroring the host schema, so a disconnected UI still renders. */
export const CONFIG_DEFAULTS: ResolvedConfig = {
  enabled: true,
  provider: 'ofox',
  model: 'deepseek/deepseek-v4.1-flash',
  temperature: 0.3,
  maxTokens: 0,
  mainSystemPrompt: '',
  presets: BUILTIN_PRESETS,
  activePresetId: '',
}

/**
 * Merge a stored section over the defaults.
 * @param stored - the namespace section as the host reported it.
 * @returns a complete config value.
 */
export function resolveConfig(stored: OptimizerConfig | undefined): ResolvedConfig {
  const value = stored ?? {}
  const presets = Array.isArray(value.presets) && value.presets.length > 0
    ? value.presets
      .filter(preset => typeof preset?.id === 'string' && preset.id !== '')
      .map(preset => ({
        id: preset.id,
        name: typeof preset.name === 'string' && preset.name.trim() !== '' ? preset.name : preset.id,
        system: typeof preset.system === 'string' ? preset.system : '',
      }))
    : CONFIG_DEFAULTS.presets
  return {
    enabled: value.enabled !== false,
    provider: typeof value.provider === 'string' ? value.provider : CONFIG_DEFAULTS.provider,
    model: typeof value.model === 'string' ? value.model : CONFIG_DEFAULTS.model,
    temperature: typeof value.temperature === 'number' && Number.isFinite(value.temperature)
      ? value.temperature
      : CONFIG_DEFAULTS.temperature,
    maxTokens: typeof value.maxTokens === 'number' && Number.isFinite(value.maxTokens) ? value.maxTokens : 0,
    mainSystemPrompt: typeof value.mainSystemPrompt === 'string' ? value.mainSystemPrompt : '',
    presets,
    activePresetId: typeof value.activePresetId === 'string' ? value.activePresetId : '',
  }
}

/** The `ctx.configForms` surface this module consumes (structural). */
interface ConfigFormFace<T> {
  getSnapshot(): {
    status: 'loading' | 'ready' | 'unavailable'
    value: T | undefined
    revision: number | undefined
    writable: boolean
  }
  subscribe(listener: () => void): () => void
  mutate(ops: unknown[], expectedRevision?: number): Promise<boolean>
}

interface ConfigFormsFace {
  get<T>(entryId: string): ConfigFormFace<T>
  describe(): {
    getSnapshot(): { view: { namespaces: ReadonlyArray<{ ns: string; schema?: unknown }> } | undefined }
    subscribe(listener: () => void): () => void
    ensure(): Promise<void>
  }
}

/** Narrow an unknown service handle to the config-forms surface. */
export function asConfigForms(value: unknown): ConfigFormsFace | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as Partial<ConfigFormsFace>
  if (typeof candidate.get !== 'function' || typeof candidate.describe !== 'function') return undefined
  return candidate as ConfigFormsFace
}

/**
 * Bind the plugin's settings.
 *
 * Preference order: the official shared form (works with live reload and the
 * host's own write queue), then a direct `remote.settings` view, then defaults.
 * The fallback is deliberately last-resort: it renders a working page in a
 * composition that replaced the settings provider, at the cost of no live
 * invalidation.
 * @param ctx - client root context.
 * @returns the bound handle.
 */
export function bindSettings(ctx: ClientContext): SettingsHandle {
  const store: SnapshotStore<SettingsSnapshot> = createSnapshotStore<SettingsSnapshot>({
    status: 'loading',
    value: CONFIG_DEFAULTS,
    revision: undefined,
    writable: false,
    transport: 'defaults',
  })

  const forms = asConfigForms(ctx.get('configForms'))
  const disposers: Array<() => void> = []
  let disposed = false
  let boundEntryId: string | undefined

  /** Publish one accepted section. */
  const accept = (
    transport: SettingsSnapshot['transport'],
    status: SettingsSnapshot['status'],
    stored: OptimizerConfig | undefined,
    revision: number | undefined,
    writable: boolean,
  ): void => {
    if (disposed) return
    store.set({
      status,
      value: resolveConfig(stored),
      revision,
      writable,
      transport,
    })
  }

  if (forms !== undefined) {
    const describeFace = forms.describe()
    /**
     * Resolve (and cache) the namespace this plugin's settings live under.
     *
     * The managed-forms host keys sections by the Loader entry id, which is not
     * simply the package name: a cordis `insert` row lands under
     * `include:<rowId>`, so the row in cordis.patch.yml produces the namespace
     * `include:prompt-forge` while the row's own id stays `prompt-forge`.
     * The resolution below therefore tries the exact declared id first, then the
     * row-id suffix, and finally a fingerprint of the Config's own field names.
     * Getting this wrong would show an empty page and silently drop every write,
     * so all three checks run in order of how directly they identify the plugin.
     */
    const entryIdOf = (): string | undefined => {
      if (boundEntryId !== undefined) return boundEntryId
      const namespaces = describeFace.getSnapshot().view?.namespaces ?? []

      const exact = namespaces.find(row => row.ns === PROMPT_FORGE_NAMESPACE)
      if (exact !== undefined) {
        boundEntryId = exact.ns
        return boundEntryId
      }

      // The `include:`/`<any-prefix>:` form the loader gives an inserted row.
      const suffix = namespaces.find(row => row.ns.endsWith(`:${PROMPT_FORGE_NAMESPACE}`))
      if (suffix !== undefined) {
        boundEntryId = suffix.ns
        console.info(`[dsh-prompt-forge] settings namespace resolved by row-id suffix: "${suffix.ns}"`)
        return boundEntryId
      }

      // Last resort: recognize the section by fields only this Config declares.
      const shapeOf = (schema: unknown): string => JSON.stringify(schema ?? null)
      const fingerprint = namespaces.find(row => CONFIG_FINGERPRINT_FIELDS.every(
        field => shapeOf(row.schema).includes(`"${field}"`),
      ))
      if (fingerprint !== undefined) {
        boundEntryId = fingerprint.ns
        console.info(`[dsh-prompt-forge] settings namespace resolved by fingerprint: "${fingerprint.ns}"`)
      }
      return boundEntryId
    }

    const form = (): ConfigFormFace<OptimizerConfig> | undefined => {
      const entryId = entryIdOf()
      return entryId === undefined ? undefined : forms.get<OptimizerConfig>(entryId)
    }

    /** Fold the shared form's current answer into the snapshot. */
    const sync = (): void => {
      const current = form()
      if (current === undefined) return
      const snapshot = current.getSnapshot()
      if (snapshot.status === 'loading') {
        // A pending read must not wipe the values already on screen.
        store.update(draft => {
          draft.status = 'loading'
          draft.revision = snapshot.revision
          draft.writable = snapshot.writable
          draft.transport = 'configForms'
        })
        return
      }
      accept('configForms', snapshot.status, snapshot.value, snapshot.revision, snapshot.writable)
    }

    void describeFace.ensure().then(() => {
      if (disposed) return
      const current = form()
      if (current === undefined) {
        // The host does not serve this namespace (plugin disabled at the
        // profile level, or a settings provider without it). Defaults stay.
        accept('defaults', 'ready', undefined, undefined, false)
        return
      }
      disposers.push(current.subscribe(sync))
      disposers.push(describeFace.subscribe(sync))
      sync()
    }).catch(() => {
      accept('defaults', 'unavailable', undefined, undefined, false)
    })

    return {
      getSnapshot: () => store.getSnapshot(),
      subscribe: listener => store.subscribe(listener),
      apply: async (ops) => {
        const current = form()
        if (current === undefined) return false
        try {
          return await current.mutate(ops, store.getSnapshot().revision)
        } catch {
          sync()
          return false
        }
      },
      reload: async () => {
        try {
          await describeFace.ensure()
          sync()
        } catch {
          accept('defaults', 'unavailable', undefined, undefined, false)
        }
      },
      dispose: () => {
        disposed = true
        for (const dispose of disposers.splice(0)) dispose()
      },
    }
  }

  // No official settings provider: report defaults instead of inventing a wire.
  accept('defaults', 'unavailable', undefined, undefined, false)
  return {
    getSnapshot: () => store.getSnapshot(),
    subscribe: listener => store.subscribe(listener),
    apply: async () => false,
    reload: async () => {},
    dispose: () => { disposed = true },
  }
}
