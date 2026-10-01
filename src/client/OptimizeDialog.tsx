/**
 * The side-by-side optimization dialog.
 *
 * Owns one run's lifecycle (start, stream, abort, refine, accept) and renders
 * into the `shell.overlay` seat, so it floats above every column rather than
 * being trapped inside the composer's stacking context.
 *
 * The write-back contract is the point of this component: the composer is only
 * ever touched by the Accept action. Closing, aborting, or refining leaves the
 * draft exactly as the user left it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { runOptimize } from './api.ts'
import { tt } from './locales.ts'
import type { ResolvedConfig } from './settings.ts'

/** Props the shell overlay host passes in. */
export interface OptimizeDialogProps {
  /** The draft captured when the dialog opened; never mutated in place. */
  original: string
  /** Live resolved plugin config (preset roster, resolved model label). */
  config: ResolvedConfig
  /** The system prompt to use for the first run. */
  system: string
  /** Session the Accept action should write back into. */
  sessionId: SessionId
  /**
   * Write the accepted text into the composer.
   * @returns whether the write actually landed. A refusal must keep the dialog
   *   open: closing on a failed write would look like a successful accept while
   *   the draft stayed untouched, which is the one outcome this plugin exists
   *   to avoid.
   */
  onAccept: (text: string) => boolean
  /** Close the dialog. */
  onClose: () => void
}

/** One run's visible state. */
interface RunState {
  /** Which pass is showing: the first run or a follow-up refine. */
  phase: 'idle' | 'running' | 'settled'
  /** Streamed text so far. */
  text: string
  /** Whether the user edited the result by hand. */
  edited: boolean
  /** Terminal failure, when the last run failed. */
  error: string | undefined
}

/**
 * Why an accept must be refused, or undefined when the write may proceed.
 *
 * Pure and exported on purpose: the mid-stream refusal is the one rule that
 * protects the user's draft from a half-finished prefix, and a rule that lives
 * only inside a component's event handler is a rule nothing can regression-test
 * without a browser.
 * @param phase - the current run's phase.
 * @param text - the text the result pane currently holds.
 * @returns the refusal reason, or undefined to allow the write.
 */
export function acceptRefusal(phase: RunState['phase'], text: string): 'busy' | 'empty' | undefined {
  if (phase === 'running') return 'busy'
  if (text.trim() === '') return 'empty'
  return undefined
}

/**
 * Render the optimization dialog.
 * @param props - the captured draft, config, and callbacks.
 * @returns the dialog element tree.
 */
export function OptimizeDialog(props: OptimizeDialogProps): React.JSX.Element {
  const { original, config, sessionId, onAccept, onClose } = props
  const [run, setRun] = useState<RunState>({ phase: 'running', text: '', edited: false, error: undefined })
  const [instruction, setInstruction] = useState('')
  const [presetId, setPresetId] = useState(config.activePresetId)
  const [copied, setCopied] = useState(false)
  const abortRef = useRef<AbortController | undefined>(undefined)
  const resultRef = useRef<HTMLTextAreaElement | null>(null)

  /** The system prompt for the currently selected preset. */
  const system = useMemo(() => {
    const preset = config.presets.find(candidate => candidate.id === presetId)
    return preset === undefined ? props.system : preset.system
  }, [config.presets, presetId, props.system])

  /** Run one pass; `previous` and `directive` are set only for a refine. */
  const start = useCallback((previous: string, directive: string): void => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setRun(current => ({ phase: 'running', text: previous, edited: current.edited, error: undefined }))
    void runOptimize(
      {
        text: original,
        system,
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
  }, [original, system])

  // First run on mount, and a re-run whenever the preset changes while the
  // dialog is still on its first, untouched pass.
  useEffect(() => {
    start('', '')
    return () => { abortRef.current?.abort() }
    // Deliberately keyed on `system`: switching presets restarts the run, which
    // is the whole point of the selector.
  }, [start, system])

  // Escape closes; Ctrl/Cmd+Enter accepts. Bound on the document so the
  // shortcut works wherever focus sits inside the dialog.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        accept()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  })

  /**
   * Accept the current result: the only path that touches the composer.
   *
   * Two refusals guard the write, because this is the one place where a mistake
   * damages user data:
   *   - mid-stream, the text on screen is a prefix of the model's answer, not
   *     its answer. The Accept button is disabled while running, but the
   *     document-level Ctrl+Enter shortcut bypasses that, so the check has to
   *     live here rather than on the button.
   *   - when the composer refuses the write, the dialog stays open and says so,
   *     instead of closing as if the accept had worked.
   */
  function accept(): void {
    // The same predicate the button's disabled state uses, so the shortcut and
    // the button can never disagree about whether accepting is allowed.
    if (acceptRefusal(run.phase, run.text) !== undefined) return
    const text = run.text.trim()
    if (!onAccept(text)) {
      setRun(current => ({ ...current, error: tt('dialog.acceptFailed') }))
      return
    }
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

  const busy = run.phase === 'running'
  /** Whether the pane holds anything worth copying — true mid-stream too. */
  const hasText = run.text.trim() !== ''
  /** Accept is stricter: a running pass would write back a prefix, not an answer. */
  const canAccept = acceptRefusal(run.phase, run.text) === undefined
  const modelLabel = config.provider !== '' && config.model !== ''
    ? `${config.provider} / ${config.model}`
    : tt('dialog.noModel')

  return (
    <div className={css.backdrop} role="presentation" data-session={String(sessionId)}>
      <div className={css.dialog} role="dialog" aria-modal="true" aria-label={tt('dialog.title')}>
        <header className={css.header}>
          <h2 className={css.title}>{tt('dialog.title')}</h2>
          <div className={css.headerMeta}>
            <label className={css.presetField}>
              <span>{tt('dialog.preset')}</span>
              <select
                className={css.select}
                value={presetId}
                disabled={busy}
                onChange={event => { setPresetId(event.target.value) }}
              >
                <option value="">{tt('dialog.mainPreset')}</option>
                {config.presets.map(preset => (
                  <option key={preset.id} value={preset.id}>{preset.name}</option>
                ))}
              </select>
            </label>
            <span className={css.modelLabel} title={modelLabel}>{modelLabel}</span>
            <button type="button" className={css.iconButton} aria-label={tt('dialog.close')} onClick={onClose}>✕</button>
          </div>
        </header>

        <div className={css.body}>
          <section className={css.pane}>
            <div className={css.paneHead}>
              <span className={css.paneTitle}>{tt('dialog.original')}</span>
              <span className={css.counter}>{original.length}</span>
            </div>
            <div className={css.originalBox}>{original}</div>
          </section>

          <section className={css.pane}>
            <div className={css.paneHead}>
              <span className={css.paneTitle}>{tt('dialog.optimized')}</span>
              <span className={css.counter}>
                {run.text.length}
                {run.edited ? ` · ${tt('dialog.edited')}` : ''}
              </span>
            </div>
            <textarea
              ref={resultRef}
              className={css.resultBox}
              value={run.text}
              spellCheck={false}
              placeholder={busy ? tt('dialog.thinking') : tt('dialog.empty')}
              onChange={event => {
                setRun(current => ({ ...current, text: event.target.value, edited: true }))
              }}
            />
            {run.error === undefined ? null : <p className={css.error}>{run.error}</p>}
          </section>
        </div>

        <footer className={css.footer}>
          <div className={css.refineRow}>
            <input
              className={css.refineInput}
              value={instruction}
              placeholder={tt('dialog.refinePlaceholder')}
              disabled={busy}
              onChange={event => { setInstruction(event.target.value) }}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && instruction.trim() !== '') {
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
              ? <button type="button" className={css.button} onClick={() => { abortRef.current?.abort() }}>{tt('dialog.stop')}</button>
              : <button type="button" className={css.button} disabled={!canAccept} onClick={() => { start('', '') }}>{tt('dialog.retry')}</button>}
          </div>
          <div className={css.actions}>
            <button type="button" className={css.button} disabled={!hasText} onClick={() => { void copy() }}>
              {copied ? tt('dialog.copied') : tt('dialog.copy')}
            </button>
            <button
              type="button"
              className={css.primary}
              disabled={!canAccept}
              onClick={accept}
              title={busy ? tt('dialog.acceptBusy') : tt('dialog.acceptHint')}
            >
              {tt('dialog.accept')} <kbd className={css.kbd}>Ctrl+↵</kbd>
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}

import css from './optimizer.module.css'
