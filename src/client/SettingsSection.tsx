/**
 * The plugin's settings page.
 *
 * Registered into `settings.section`, so it lives in the official Settings
 * dialog beside every other feature page. The page is a staged editor: local
 * state holds the working copy, and Save writes one atomic set of path
 * operations, which is what keeps a half-finished preset from reaching the
 * stored config.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OptimizerPreset, ProviderModelGroup } from '../protocol.ts'
import { DEFAULT_MAIN_PROMPT } from '../prompts.ts'
import { tt } from './locales.ts'
import { fetchModels } from './api.ts'
import { CONFIG_DEFAULTS, type ResolvedConfig, type SettingsHandle, type SettingsOp, type SettingsSnapshot } from './settings.ts'

/** Props the settings shell supplies (owner share). */
export interface SettingsSectionProps {
  /** Close the settings panel. */
  close: () => void
  /** The bound settings handle (staged through `inject`). */
  settings: SettingsHandle
}

/** Subscribe a component to the settings snapshot. */
function useSettingsSnapshot(settings: SettingsHandle): SettingsSnapshot {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>(() => settings.getSnapshot())
  useEffect(() => {
    setSnapshot(settings.getSnapshot())
    return settings.subscribe(() => { setSnapshot(settings.getSnapshot()) })
  }, [settings])
  return snapshot
}

/** One working-copy draft of the editable fields. */
interface Draft {
  enabled: boolean
  provider: string
  model: string
  temperature: number
  maxTokens: number
  mainSystemPrompt: string
  presets: OptimizerPreset[]
  activePresetId: string
}

/** Project a resolved config into an editable draft. */
function toDraft(value: ResolvedConfig): Draft {
  return {
    enabled: value.enabled,
    provider: value.provider,
    model: value.model,
    temperature: value.temperature,
    maxTokens: value.maxTokens,
    mainSystemPrompt: value.mainSystemPrompt === '' ? DEFAULT_MAIN_PROMPT : value.mainSystemPrompt,
    presets: value.presets.map(preset => ({ ...preset })),
    activePresetId: value.activePresetId,
  }
}

/**
 * Render the settings page.
 * @param props - the settings shell owner share plus the bound handle.
 * @returns the page element tree.
 */
export function SettingsSection(props: SettingsSectionProps): React.JSX.Element {
  const snapshot = useSettingsSnapshot(props.settings)
  const [draft, setDraft] = useState<Draft>(() => toDraft(snapshot.value))
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<'idle' | 'saved' | 'failed'>('idle')
  const [groups, setGroups] = useState<ProviderModelGroup[] | undefined>(undefined)
  const [catalogError, setCatalogError] = useState<string | undefined>(undefined)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const adopted = useRef<string | undefined>(undefined)

  // Adopt host values whenever the stored section changes and the user has no
  // unsaved edits; a dirty draft is never silently overwritten.
  useEffect(() => {
    if (dirty) return
    setDraft(toDraft(snapshot.value))
  }, [snapshot.value, dirty])

  const loadCatalog = useCallback((): (() => void) => {
    const controller = new AbortController()
    setCatalogLoading(true)
    setCatalogError(undefined)
    void fetchModels(controller.signal).then(result => {
      setCatalogLoading(false)
      if (!result.ok) {
        setCatalogError(result.message ?? tt('settings.catalogFailed'))
        return
      }
      setGroups(result.providers)
    })
    return () => { controller.abort() }
  }, [])

  useEffect(() => loadCatalog(), [loadCatalog])

  /** The provider rows the pickers render, with the stored values kept visible. */
  const providers = useMemo<ProviderModelGroup[]>(() => {
    const rows = groups ?? []
    // A stored provider the host no longer advertises must stay selectable,
    // otherwise opening the page would silently rewrite the user's choice.
    if (draft.provider !== '' && !rows.some(row => row.id === draft.provider)) {
      return [{ id: draft.provider, name: `${draft.provider} (${tt('settings.noModels')})`, models: [] }, ...rows]
    }
    return rows
  }, [groups, draft.provider])

  const models = useMemo(() => {
    const row = providers.find(candidate => candidate.id === draft.provider)
    const list = row?.models ?? []
    if (draft.model !== '' && !list.some(model => model.id === draft.model)) {
      return [{ id: draft.model, name: `${draft.model} (${tt('settings.noModels')})` }, ...list]
    }
    return list
  }, [providers, draft.provider, draft.model])

  const update = useCallback((change: Partial<Draft>): void => {
    setDraft(current => ({ ...current, ...change }))
    setDirty(true)
    setStatus('idle')
  }, [])

  /** Persist the working copy as one revision-fenced mutation. */
  const save = useCallback((): void => {
    setSaving(true)
    setStatus('idle')
    const ops: SettingsOp[] = [
      { op: 'set', path: ['enabled'], value: draft.enabled },
      { op: 'set', path: ['provider'], value: draft.provider },
      { op: 'set', path: ['model'], value: draft.model },
      { op: 'set', path: ['temperature'], value: draft.temperature },
      { op: 'set', path: ['maxTokens'], value: draft.maxTokens },
      { op: 'set', path: ['mainSystemPrompt'], value: draft.mainSystemPrompt },
      // Array fields are written wholesale: path operations cannot reach
      // inside an array, so a partial edit is not expressible.
      { op: 'set', path: ['presets'], value: draft.presets.map(preset => ({ ...preset })) },
      { op: 'set', path: ['activePresetId'], value: draft.activePresetId },
    ]
    void props.settings.apply(ops).then(ok => {
      setSaving(false)
      if (ok) {
        setDirty(false)
        setStatus('saved')
        window.setTimeout(() => { setStatus(current => current === 'saved' ? 'idle' : current) }, 2000)
        return
      }
      setStatus('failed')
    })
  }, [draft, props.settings])

  const addPreset = useCallback((): void => {
    const id = `preset-${Date.now().toString(36)}`
    update({ presets: [...draft.presets, { id, name: '新预设', system: '' }] })
  }, [draft.presets, update])

  const removePreset = useCallback((id: string): void => {
    update({
      presets: draft.presets.filter(preset => preset.id !== id),
      activePresetId: draft.activePresetId === id ? '' : draft.activePresetId,
    })
  }, [draft.presets, draft.activePresetId, update])

  const editPreset = useCallback((id: string, change: Partial<OptimizerPreset>): void => {
    update({ presets: draft.presets.map(preset => preset.id === id ? { ...preset, ...change } : preset) })
  }, [draft.presets, update])

  const writable = snapshot.writable
  const transportNote = snapshot.status === 'loading'
    ? tt('settings.scopeLoading')
    : snapshot.status === 'unavailable' || !writable
      ? tt('settings.scopeUnavailable')
      : undefined

  return (
    <div className={css.section}>
      <p className={css.sectionDescription}>{tt('settings.description')}</p>
      {transportNote === undefined ? null : <p className={css.notice}>{transportNote}</p>}

      {/* --------------------------------------------------------- switch */}
      <section className={css.fieldset}>
        <label className={css.checkboxRow}>
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={!writable}
            onChange={event => { update({ enabled: event.target.checked }) }}
          />
          <span>
            <span className={css.fieldLabel}>{tt('settings.enabled')}</span>
            <br />
            <span className={css.fieldHint}>{tt('settings.enabledHint')}</span>
          </span>
        </label>
      </section>

      {/* -------------------------------------------------------- channel */}
      <section className={css.fieldset}>
        <h3 className={css.fieldsetTitle}>{tt('settings.channel')}</h3>
        {catalogError === undefined ? null : (
          <p className={`${css.notice} ${css.noticeError}`}>
            {catalogError}
            <button type="button" className={css.button} onClick={loadCatalog} style={{ marginLeft: 8 }}>
              {tt('settings.catalogRetry')}
            </button>
          </p>
        )}
        {catalogLoading ? <p className={css.notice}>{tt('settings.catalogLoad')}</p> : null}
        <div className={css.row}>
          <label className={`${css.field} ${css.grow}`}>
            <span className={css.fieldLabel}>{tt('settings.channel')}</span>
            <select
              className={css.select}
              value={draft.provider}
              disabled={!writable}
              onChange={event => {
                const provider = event.target.value
                const first = providers.find(row => row.id === provider)?.models[0]?.id ?? ''
                update({ provider, model: first })
              }}
            >
              {providers.length === 0 ? <option value={draft.provider}>{tt('settings.noProviders')}</option> : null}
              {providers.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
            </select>
          </label>
          <label className={`${css.field} ${css.grow}`}>
            <span className={css.fieldLabel}>{tt('settings.model')}</span>
            <select
              className={css.select}
              value={draft.model}
              disabled={!writable}
              onChange={event => { update({ model: event.target.value }) }}
            >
              {models.length === 0 ? <option value={draft.model}>{tt('settings.noModels')}</option> : null}
              {models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
            </select>
          </label>
        </div>
        <div className={css.row}>
          <label className={`${css.field} ${css.grow}`}>
            <span className={css.fieldLabel}>{tt('settings.temperature')}</span>
            <input
              className={css.input}
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={draft.temperature}
              disabled={!writable}
              onChange={event => {
                const next = Number(event.target.value)
                update({ temperature: Number.isFinite(next) ? next : CONFIG_DEFAULTS.temperature })
              }}
            />
            <span className={css.fieldHint}>{tt('settings.temperatureHint')}</span>
          </label>
          <label className={`${css.field} ${css.grow}`}>
            <span className={css.fieldLabel}>{tt('settings.maxTokens')}</span>
            <input
              className={css.input}
              type="number"
              min={0}
              step={256}
              value={draft.maxTokens}
              disabled={!writable}
              onChange={event => {
                const next = Math.floor(Number(event.target.value))
                update({ maxTokens: Number.isFinite(next) && next > 0 ? next : 0 })
              }}
            />
            <span className={css.fieldHint}>{tt('settings.maxTokensHint')}</span>
          </label>
        </div>
      </section>

      {/* --------------------------------------------------------- prompts */}
      <section className={css.fieldset}>
        <h3 className={css.fieldsetTitle}>{tt('settings.mainPrompt')}</h3>
        <span className={css.fieldHint}>{tt('settings.mainPromptHint')}</span>
        <textarea
          className={css.promptArea}
          value={draft.mainSystemPrompt}
          disabled={!writable}
          onChange={event => { update({ mainSystemPrompt: event.target.value }) }}
        />
        <div className={css.actions}>
          <button
            type="button"
            className={css.button}
            disabled={!writable}
            onClick={() => { update({ mainSystemPrompt: DEFAULT_MAIN_PROMPT }) }}
          >
            {tt('settings.resetMain')}
          </button>
        </div>
      </section>

      <section className={css.fieldset}>
        <h3 className={css.fieldsetTitle}>{tt('settings.presets')}</h3>
        <span className={css.fieldHint}>{tt('settings.presetsHint')}</span>
        <label className={css.field}>
          <span className={css.fieldLabel}>{tt('settings.activePreset')}</span>
          <select
            className={css.select}
            value={draft.activePresetId}
            disabled={!writable}
            onChange={event => { update({ activePresetId: event.target.value }) }}
          >
            <option value="">{tt('settings.noPreset')}</option>
            {draft.presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
          </select>
        </label>

        {draft.presets.map(preset => (
          <div key={preset.id} className={css.presetCard}>
            <div className={css.presetHead}>
              <input
                className={`${css.input} ${css.grow}`}
                value={preset.name}
                disabled={!writable}
                aria-label={tt('settings.presetName')}
                onChange={event => { editPreset(preset.id, { name: event.target.value }) }}
              />
              <button
                type="button"
                className={css.button}
                disabled={!writable}
                onClick={() => { removePreset(preset.id) }}
              >
                {tt('settings.removePreset')}
              </button>
            </div>
            <textarea
              className={css.promptArea}
              value={preset.system}
              disabled={!writable}
              aria-label={tt('settings.presetSystem')}
              onChange={event => { editPreset(preset.id, { system: event.target.value }) }}
            />
          </div>
        ))}

        <div className={css.actions}>
          <button type="button" className={css.button} disabled={!writable} onClick={addPreset}>
            {tt('settings.addPreset')}
          </button>
        </div>
      </section>

      {/* ----------------------------------------------------------- save */}
      <div className={css.actions}>
        {status === 'saved' ? <span className={css.statusLine}>{tt('settings.saved')}</span> : null}
        {status === 'failed' ? <span className={`${css.notice} ${css.noticeError}`}>{tt('settings.saveFailed')}</span> : null}
        <button type="button" className={css.primary} disabled={!writable || saving || !dirty} onClick={save}>
          {saving ? '…' : tt('settings.save')}
        </button>
      </div>
    </div>
  )
}

import css from './optimizer.module.css'
