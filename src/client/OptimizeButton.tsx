/**
 * The composer tool-row button.
 *
 * Registering into `conversation.input.left` (scope `session`) means the
 * framework already resolved this session's scope and hands the component
 * `sessionId` plus the `useInput` selector hook. That is the entire reason this
 * plugin does not have to guess which session it is acting on.
 *
 * The button is disabled — never hidden — while the composer is empty or the
 * plugin is off, so the control's position stays stable and the tooltip can
 * explain why.
 */
import { useCallback, useEffect, useState } from 'react'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { tt } from './locales.ts'
import { MAX_DRAFT_CHARS } from '../protocol.ts'

/** Props the slot framework supplies (standard kit + owner share). */
export interface OptimizeButtonProps {
  /** Strict session-scope slots receive a definite identity. */
  sessionId: SessionId
  /** Session input state selector hook from the standard kit. */
  useInput: (selector: (state: InputState) => unknown) => unknown
  /** Whether the plugin is enabled (owner share, live from settings). */
  enabled: boolean
  /** Open the dialog for the current draft. */
  onOpen: (draft: string) => void
}

/**
 * Render the optimize button.
 * @param props - session identity, input hook, and the open callback.
 * @returns the button element.
 */
export function OptimizeButton(props: OptimizeButtonProps): React.JSX.Element {
  const { sessionId, useInput, enabled, onOpen } = props
  const draft = useInput(state => state.draft) as string
  const phase = useInput(state => state.phase) as InputState['phase']
  const [hovered, setHovered] = useState(false)

  const empty = draft.trim() === ''
  const tooLong = draft.length > MAX_DRAFT_CHARS
  const busy = phase !== 'plain'
  const disabled = !enabled || empty || tooLong || busy

  const reason = !enabled
    ? tt('button.disabledOff')
    : empty
      ? tt('button.disabledEmpty')
      : tooLong
        ? tt('dialog.tooLong')
        : tt('button.tooltip')

  const open = useCallback((): void => {
    if (disabled) return
    onOpen(draft)
  }, [disabled, draft, onOpen])

  // Keep the tooltip honest without pulling in a tooltip primitive the plugin
  // does not otherwise need: a native title plus an accessible label is enough
  // for a single compact control.
  useEffect(() => {
    // Session switches remount this entry; nothing to clean up beyond state.
  }, [sessionId])

  return (
    <button
      type="button"
      className={css.toolButton}
      data-active={hovered && !disabled ? 'true' : undefined}
      aria-label={tt('button.label')}
      title={reason}
      disabled={disabled}
      // Keep the composer focus: clicking a tool-row control must not blur the
      // editor, exactly like the shipped buttons in this row.
      onMouseDown={event => { event.preventDefault() }}
      onMouseEnter={() => { setHovered(true) }}
      onMouseLeave={() => { setHovered(false) }}
      onClick={open}
    >
      <IconSparkle />
      <span className={css.toolLabel}>{tt('button.label')}</span>
    </button>
  )
}

/** Inline glyph: avoids depending on an icon package for one button. */
function IconSparkle(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M8 1.6l1.32 3.42L12.8 6.4l-3.48 1.38L8 11.2 6.68 7.78 3.2 6.4l3.48-1.38L8 1.6z"
        fill="currentColor"
      />
      <path d="M12.4 10.4l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6.6-1.6z" fill="currentColor" opacity="0.7" />
    </svg>
  )
}

import css from './optimizer.module.css'
