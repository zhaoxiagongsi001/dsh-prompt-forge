/**
 * The inline optimization panel.
 *
 * One panel is mounted through the composer card's overlay slot
 * (`conversation.input.overlay`), but it is a **viewport-centred floating layer**
 * rather than a child anchored to the card: a long draft scrolls the card's top
 * edge above the viewport, and anchoring there would hide the panel. It occupies
 * **no** layout, so opening and closing the panel never moves the composer,
 * never reflows the transcript, and leaves the editor exactly where the user
 * left it.
 *
 * The write-back contract is unchanged from v1 and is still the point of this
 * component: the composer is only ever touched by Accept. Closing, stopping,
 * retrying, or refining leaves the draft exactly as the user left it.
 *
 * Deliberate v2 change — no keyboard shortcuts at all. v1 bound Escape and
 * Ctrl+Enter on `document` in the capture phase. Inline, that collides with the
 * shipped composer: the official Lexical keymap treats Ctrl/Cmd+Enter as
 * "deliver now" and submits (`client.js:16704-16716`), and the panel's own
 * handler did not stop propagation, so both would fire — the panel would accept
 * *and* the composer would send. Every action here is a visible button instead.
 * The only Enter key this component reacts to is the one inside its own refine
 * input, which is that input's own submit key and not a global shortcut.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { runOptimize } from './api.ts'
import { tt } from './locales.ts'
import type { ResolvedConfig } from './settings.ts'
import { resolveSystemPrompt } from '../prompts.ts'
// The mid-stream accept gate lives in its own module so the retired modal and
// this panel cannot drift apart: one predicate, used by both the button's
// disabled state and the accept handler, so the two can never disagree about
// whether writing back is allowed.
import { acceptRefusal } from './accept-guard.ts'

/** Props the inline panel host passes in. */
export interface InlinePanelProps {
  /** The draft captured when the panel opened; never mutated in place. */
  original: string
  /** Live resolved plugin config (preset roster, resolved model label). */
  config: ResolvedConfig
  /** Session this panel belongs to; also the write-back target. */
  sessionId: SessionId
  /**
   * Write the accepted text into the composer.
   * @returns whether the write actually landed. A refusal must keep the panel
   *   expanded: collapsing on a failed write would look like a successful
   *   accept while the draft stayed untouched, which is the one outcome this
   *   plugin exists to avoid.
   */
  onWrite: (text: string) => boolean
  /** Collapse the panel. Never touches the draft. */
  onClose: () => void
  /**
   * Whether the live draft carries `@` reference chips or draft attachments.
   *
   * A whole-draft replace (`setDraft`) clears the Lexical document and rewrites
   * it as plain text, so every chip is flattened and attachments are left
   * without matching text. With references present, Accept therefore asks first.
   */
  hasReferences: boolean
}

/** One run's visible state. */
interface RunState {
  /** Which pass is showing: a run in flight, or a settled result. */
  phase: 'running' | 'settled'
  /** Streamed text so far. */
  text: string
  /** Whether the user edited the result by hand. */
  edited: boolean
  /** Terminal failure, when the last run failed. */
  error: string | undefined
}

/**
 * Render the inline optimization panel.
 * @param props - the captured draft, config, and callbacks.
 * @returns the panel element tree.
 */
export function InlinePanel(props: InlinePanelProps): React.JSX.Element {
  const { original, config, onWrite, onClose, hasReferences } = props
  const [run, setRun] = useState<RunState>({ phase: 'running', text: '', edited: false, error: undefined })
  const [instruction, setInstruction] = useState('')
  const [presetId, setPresetId] = useState(config.activePresetId)
  const [copied, setCopied] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [showOriginal, setShowOriginal] = useState(false)
  const abortRef = useRef<AbortController | undefined>(undefined)

  /** The system prompt for the currently selected preset. */
  const system = useMemo(() => resolveSystemPrompt(
    config.presets.find(candidate => candidate.id === presetId)?.system,
    config.mainSystemPrompt,
  ), [config.presets, config.mainSystemPrompt, presetId])

  /**
   * Latest resolved system prompt, read without changing `start`'s identity.
   *
   * The panel must re-run when the *user* switches preset, and must not re-run
   * merely because plugin settings finished loading. Both events change the
   * resolved prompt string, so the effect below keys on the preset id and reads
   * the prompt through this ref instead.
   */
  const systemRef = useRef(system)
  systemRef.current = system

  /** Run one pass; `previous` and `directive` are set only for a refine. */
  const start = useCallback((previous: string, directive: string): void => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setConfirming(false)
    setRun(current => ({ phase: 'running', text: previous, edited: current.edited, error: undefined }))
    void runOptimize(
      {
        text: original,
        system: systemRef.current,
        ...previous === '' ? {} : { previous },
        ...directive === '' ? {} : { instruction: directive },
        signal: controller.signal,
      },
      delta => { setRun(current => ({ ...current, text: current.text + delta })) },
    ).then(outcome => {
      if (controller.signal.aborted && outcome.kind !== 'error') {
        setRun(current => ({ ...current, phase: 'settled' }))
        return
      }
      if (outcome.kind === 'error') {
        setRun(current => ({ ...current, phase: 'settled', error: outcome.message }))
        return
      }
      setRun({ phase: 'settled', text: outcome.text === '' ? previous : outcome.text, edited: false, error: undefined })
    })
  }, [original])

  // First run on mount, and a re-run when the user switches preset. Keyed on
  // `presetId` rather than the resolved prompt: settings arriving late
  // (loading → ready) also changes the resolved prompt, and re-running for that
  // would spend a second model call the user never asked for. Unmount aborts
  // whatever run is in flight.
  useEffect(() => {
    start('', '')
    return () => { abortRef.current?.abort() }
  }, [start, presetId])

  const busy = run.phase === 'running'
  /** Whether the pane holds anything worth copying — true mid-stream too. */
  const hasText = run.text.trim() !== ''
  /** Accept is stricter: a running pass would write back a prefix, not an answer. */
  const canAccept = acceptRefusal(run.phase, run.text) === undefined
  const modelLabel = config.provider !== '' && config.model !== ''
    ? `${config.provider} / ${config.model}`
    : tt('dialog.noModel')

  /**
   * Commit the result to the composer — the only path that touches the draft.
   *
   * The write is guarded by the same predicate the Accept button's disabled
   * state uses, and a refused write keeps the panel expanded with a visible
   * reason instead of collapsing as if it had worked.
   */
  function commit(): void {
    if (acceptRefusal(run.phase, run.text) !== undefined) return
    if (!onWrite(run.text.trim())) {
      setRun(current => ({ ...current, error: tt('dialog.acceptFailed') }))
      return
    }
    onClose()
  }

  /** Accept: ask first when the draft carries references or attachments. */
  function accept(): void {
    if (acceptRefusal(run.phase, run.text) !== undefined) return
    if (hasReferences) {
      setConfirming(true)
      return
    }
    commit()
  }

  /**
   * Collapse the panel, aborting any run first.
   *
   * The unmount cleanup would abort anyway, but stopping the upstream call
   * *before* handing control back keeps the contract literal: the moment the
   * panel is asked to close, no model call of its is still burning.
   */
  function close(): void {
    abortRef.current?.abort()
    onClose()
  }

  /** Copy the current result to the clipboard. */
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(run.text)
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1600)
    } catch {
      // Clipboard permission is a browser policy, not a plugin failure.
      setCopied(false)
    }
  }

  return (
    <div className={css.panel} role="region" aria-label={tt('panel.regionLabel')} data-session={String(props.sessionId)}>
      <header className={css.head}>
        <span className={css.title}>{tt('dialog.title')}</span>
        <span className={css.model} title={modelLabel}>{modelLabel}</span>
        <div className={css.headRight}>
          <select
            className={css.select}
            value={presetId}
            disabled={busy}
            aria-label={tt('dialog.preset')}
            onChange={event => { setPresetId(event.target.value) }}
          >
            <option value="">{tt('dialog.mainPreset')}</option>
            {config.presets.map(preset => (
              <option key={preset.id} value={preset.id}>{preset.name}</option>
            ))}
          </select>
          <button type="button" className={css.iconButton} aria-label={tt('panel.close')} title={tt('panel.close')} onClick={close}>✕</button>
        </div>
      </header>

      <div className={css.body}>
        <button type="button" className={css.fold} onClick={() => { setShowOriginal(current => !current) }}>
          {showOriginal ? '▾ ' : '▸ '}{showOriginal ? tt('panel.hideOriginal') : tt('panel.showOriginal')}（{original.length}）
        </button>
        {showOriginal ? <div className={css.originalBox}>{original}</div> : null}

        <div className={css.paneHead}>
          <span className={css.paneTitle}>{tt('dialog.optimized')}</span>
          <span className={css.counter}>
            {run.text.length}
            {run.edited ? ` · ${tt('dialog.edited')}` : ''}
          </span>
        </div>
        <textarea
          className={css.resultBox}
          value={run.text}
          spellCheck={false}
          readOnly={busy}
          placeholder={busy ? tt('dialog.thinking') : tt('dialog.empty')}
          onChange={event => {
            setRun(current => ({ ...current, text: event.target.value, edited: true }))
          }}
        />
        {busy ? <div className={css.progress} role="presentation"><i /></div> : null}
        {run.error === undefined ? null : <p className={css.error}>{run.error}</p>}
      </div>

      <footer className={css.foot}>
        <div className={css.refineRow}>
          <input
            className={css.refineInput}
            value={instruction}
            placeholder={tt('dialog.refinePlaceholder')}
            disabled={busy}
            onChange={event => { setInstruction(event.target.value) }}
            // This is the input's own submit key, not a global shortcut: it only
            // fires while the refine field itself has focus.
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && instruction.trim() !== '' && !busy) {
                event.preventDefault()
                start(run.text, instruction.trim())
              }
            }}
          />
          <button
            type="button"
            className={css.button}
            disabled={busy || instruction.trim() === '' || run.text.trim() === ''}
            onClick={() => { start(run.text, instruction.trim()) }}
          >
            {tt('dialog.refine')}
          </button>
          {busy
            ? <button type="button" className={css.button} onClick={() => { abortRef.current?.abort() }}>{tt('panel.stop')}</button>
            : <button type="button" className={css.button} disabled={!canAccept} onClick={() => { start('', '') }}>{tt('panel.retry')}</button>}
        </div>
        <div className={css.actions}>
          <span className={css.status}>{hasReferences ? tt('panel.statusRefs') : ''}</span>
          <span className={css.spacer} />
          <button type="button" className={css.button} disabled={!hasText} onClick={() => { void copy() }}>
            {copied ? tt('dialog.copied') : tt('dialog.copy')}
          </button>
          <button type="button" className={css.primary} disabled={!canAccept} onClick={accept}>
            {tt('dialog.accept')}
          </button>
        </div>
      </footer>

      {confirming
        ? (
          <div className={css.confirmBackdrop}>
            <div className={css.confirm} role="alertdialog" aria-modal="true" aria-label={tt('panel.confirmTitle')}>
              <h3 className={css.confirmTitle}>{tt('panel.confirmTitle')}</h3>
              <p className={css.confirmBody}>{tt('panel.confirmBody')}</p>
              <div className={css.confirmActions}>
                <button type="button" className={css.button} onClick={() => { setConfirming(false) }}>{tt('panel.confirmCancel')}</button>
                <button type="button" className={css.primary} onClick={commit}>{tt('panel.confirmOk')}</button>
              </div>
            </div>
          </div>
        )
        : null}
    </div>
  )
}

import css from './inline.module.css'
