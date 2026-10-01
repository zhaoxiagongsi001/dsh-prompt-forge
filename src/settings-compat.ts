/**
 * Compatibility shim for the settings API transition.
 *
 * The desktop profile runs the managed-forms settings provider: it derives an
 * editable form from the plugin's volatile Config and exposes it under the
 * plugin's Loader **entry id**. Older providers instead expose an explicit
 * `installSettingsSection(ctx, ns, schema, entry, hooks)`. This plugin wants
 * the managed path (its page is custom and its namespace must equal the entry
 * id), so this module only has to make the older installers a no-op instead of
 * a crash.
 *
 * Mirrors the shipped `settings-compat.ts` shape so the two agree on which
 * provider generation is mounted.
 */
import type { Context } from '@deepseek-ai/cordis'
import * as settingsModule from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type z from '@deepseek-ai/schemastery'

type SettingsModuleCompat = {
  settingsNamespace?: (value: string) => SettingsNamespace
  installSettingsSection?: <T>(
    ctx: Context,
    ns: SettingsNamespace,
    schema: z<T>,
    entry: T,
    hooks: unknown,
  ) => void
}

interface SettingsProviderCompat {
  configure?: (
    presentation: { auto?: boolean },
    owner?: unknown,
  ) => (() => void) | void
  installSection?: <T>(
    owner: Context,
    ns: SettingsNamespace,
    schema: z<T>,
    entry: T,
    hooks: unknown,
  ) => void
}

const compatModule = settingsModule as unknown as SettingsModuleCompat

/** The loader entry id of the plugin instance owning `ctx`, when available. */
export function entryNamespaceOf(ctx: Context): SettingsNamespace | undefined {
  const compat = ctx as unknown as {
    fiber?: { entry?: { id?: unknown; options?: { id?: unknown } } }
    loader?: { locate?: (fiber?: unknown) => unknown }
  }
  const entry = compat.fiber?.entry
  const candidates = [
    entry?.options?.id,
    entry?.id,
    compat.loader?.locate?.(compat.fiber),
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate as SettingsNamespace
  }
  return undefined
}

/** Brand a namespace where the installed settings package still exposes it. */
export function settingsNamespaceCompat(value: string): SettingsNamespace {
  return compatModule.settingsNamespace?.(value) ?? value as SettingsNamespace
}

/**
 * Resolve the namespace the settings route must read and write.
 *
 * Managed-forms hosts key the namespace by the profile entry id, which is the
 * string the settings shell already shows; legacy hosts use the caller-chosen
 * namespace. The public route contract keeps the branded id either way.
 * @param ctx - the plugin context.
 * @param fallback - the branded namespace to use when no entry id resolves.
 * @returns the internal namespace for seam calls.
 */
export function resolveSettingsNamespaceCompat(ctx: Context, fallback: SettingsNamespace): SettingsNamespace {
  if (compatModule.installSettingsSection !== undefined) return fallback
  const provider = ctx.get('settings') as unknown as SettingsProviderCompat | undefined
  if (provider?.installSection !== undefined) return fallback
  if (provider?.configure !== undefined) return entryNamespaceOf(ctx) ?? fallback
  return fallback
}

/**
 * Register this plugin's settings presentation.
 *
 * Managed-forms hosts only need to be told that this plugin draws its own page
 * (`auto: false`), which suppresses the auto-generated duplicate. Hosts with an
 * explicit installer get their section registered. A host exposing neither is
 * tolerated rather than fatal: the feature still works with composition-level
 * defaults, and a boot crash would be a far worse outcome than a missing page.
 * @param ctx - the plugin context.
 * @param ns - the branded settings namespace.
 * @param schema - the plugin's Config schema.
 * @param entry - the resolved config entry.
 */
export function installSettingsSectionCompat<T>(
  ctx: Context,
  ns: SettingsNamespace,
  schema: z<T>,
  entry: T,
): void {
  const legacyInstaller = compatModule.installSettingsSection
  if (legacyInstaller !== undefined) {
    try {
      legacyInstaller(ctx, ns, schema, entry, {})
    } catch (error) {
      ctx.logger?.warn?.('dsh-prompt-forge: legacy settings section not installed:', error)
    }
    return
  }

  ctx.inject(['settings'], (sctx) => {
    sctx.effect(() => {
      const provider = sctx.get('settings') as unknown as SettingsProviderCompat | undefined
      if (provider?.installSection !== undefined) {
        try {
          provider.installSection(ctx, ns, schema, entry, {})
        } catch (error) {
          sctx.logger?.warn?.('dsh-prompt-forge: settings section not installed:', error)
        }
        return () => {}
      }
      if (provider?.configure === undefined) {
        sctx.logger?.warn?.('dsh-prompt-forge: settings provider exposes neither installSection nor configure; using composition defaults')
        return () => {}
      }
      // Managed-forms host: the Config's volatile fields are the form. Declaring
      // auto:false keeps the official shell from also drawing a generic page for
      // this plugin, because this plugin ships its own settings section.
      const dispose = provider.configure({ auto: false }, ctx.fiber)
      return typeof dispose === 'function' ? dispose : () => {}
    }, 'dsh-prompt-forge: settings presentation')
  })
}
