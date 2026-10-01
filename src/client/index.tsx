/**
 * dsh-prompt-forge — browser half.
 *
 * Contributes exactly three things and nothing else:
 *   1. one compact button in the composer tool row (`conversation.input.left`);
 *   2. one settings page (`settings.section`);
 *   3. one floating dialog (`shell.overlay`), mounted only while open.
 *
 * The dialog lives in the frame-wide overlay rather than inside the composer
 * because the composer's tool row is a tight horizontal strip: a side-by-side
 * comparison cannot be laid out there without fighting the shell's own styles.
 *
 * Failure policy: every mount step is guarded. A plugin that throws out of
 * `apply` fails the whole web boot, so a broken surface here must degrade to a
 * missing button, never to a dead GUI.
 */
import { useCallback, useEffect, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the settings slot contract (settings.section).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the conversation slot contract (conversation.input.left).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { bindSettings, type SettingsHandle, type SettingsSnapshot } from './settings.ts'
import { composerFor, writeDraft } from './composer.ts'
import { installLocale, tt } from './locales.ts'
import { OptimizeButton } from './OptimizeButton.tsx'
import { OptimizeDialog, type OptimizeDialogProps } from './OptimizeDialog.tsx'
import { SettingsSection } from './SettingsSection.tsx'
import { resolveSystemPrompt } from '../prompts.ts'

/** Services this plugin needs before it can mount anything. */
export const inject = ['slots', 'locale', 'sessions', 'conversation']

/** Settings page ordering within the Settings dialog's section list. */
const SETTINGS_ORDER = 62

/** Composer tool-row ordering; after the shipped permission/plan controls. */
const BUTTON_ORDER = 20

/**
 * One open dialog's captured inputs.
 *
 * The draft is captured at open time and never re-read: the dialog must show
 * the text the user had when they clicked, even if they keep typing behind it.
 */
interface OpenDialog {
  draft: string
  sessionId: SessionId
  /** Monotonic key so a second open remounts the component (and its run) cleanly. */
  key: number
}

/** The slots service surface this plugin consumes (structural). */
interface SlotsFace {
  register(options: Record<string, unknown>, component: (props: never) => unknown): () => void
  inject(key: string, callback: () => () => void): () => void
}

/**
 * Mount the composer button, the settings page, and the overlay dialog.
 * @param ctx - client root context (slots, locale, sessions, conversation).
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => installLocale(ctx), 'dsh-prompt-forge: locale')

  const settings: SettingsHandle = bindSettings(ctx)
  ctx.effect(() => () => settings.dispose(), 'dsh-prompt-forge: settings handle')

  const slots = ctx.get('slots') as SlotsFace | undefined
  if (slots === undefined || typeof slots.register !== 'function' || typeof slots.inject !== 'function') {
    console.warn('[dsh-prompt-forge] the slots service is unavailable; no surfaces were mounted')
    return
  }

  /** Subscribe a component to the settings snapshot. */
  const useSettings = (): SettingsSnapshot => {
    const [snapshot, setSnapshot] = useState<SettingsSnapshot>(() => settings.getSnapshot())
    useEffect(() => {
      setSnapshot(settings.getSnapshot())
      return settings.subscribe(() => { setSnapshot(settings.getSnapshot()) })
    }, [])
    return snapshot
  }

  // -------------------------------------------------- composer tool-row button
  const ComposerButton = (props: { sessionId: SessionId; useInput: (selector: (state: InputState) => unknown) => unknown }): React.JSX.Element => {
    const snapshot = useSettings()
    const open = useCallback((draft: string): void => {
      dialog.open({ draft, sessionId: props.sessionId })
    }, [props.sessionId])
    return (
      <OptimizeButton
        sessionId={props.sessionId}
        useInput={props.useInput}
        enabled={snapshot.value.enabled && snapshot.status !== 'unavailable'}
        onOpen={open}
      />
    )
  }

  // ------------------------------------------------------------- settings page
  const SettingsPage = (props: { close: () => void }): React.JSX.Element => (
    <SettingsSection close={props.close} settings={settings} />
  )

  // -------------------------------------------------------------- overlay host
  const OverlayHost = (): React.JSX.Element | null => {
    const current = useDialogRecord()
    if (current === undefined) return null
    const config = settings.getSnapshot().value
    /**
     * Write the accepted text back, reporting whether it landed.
     *
     * The draft must not be touched when the composer is unaddressable, and the
     * caller must not close the dialog as if the accept had worked: the boolean
     * is the whole contract between this host and the dialog.
     * @returns whether the draft was actually replaced.
     */
    const accept = (text: string): boolean => {
      const input = composerFor(ctx, current.sessionId)
      if (input === undefined) {
        // The session stopped being addressable between open and accept.
        console.warn('[dsh-prompt-forge] no composer to write the accepted prompt into')
        return false
      }
      return writeDraft(input, text)
    }
    const dialogProps: OptimizeDialogProps = {
      original: current.draft,
      config,
      system: resolveSystemPrompt(
        config.presets.find(preset => preset.id === config.activePresetId)?.system,
        config.mainSystemPrompt,
      ),
      sessionId: current.sessionId,
      onAccept: accept,
      onClose: () => { dialog.close() },
    }
    return <OptimizeDialog key={current.key} {...dialogProps} />
  }

  // ------------------------------------------------------------------- wiring
  const listeners = new Set<() => void>()
  let current: OpenDialog | undefined
  let key = 0
  const notify = (): void => { for (const listener of [...listeners]) listener() }
  const dialog = {
    open(entry: Omit<OpenDialog, 'key'>): void {
      current = { ...entry, key: ++key }
      notify()
    },
    close(): void {
      current = undefined
      notify()
    },
  }
  /** Read the open record and re-render on every change. */
  function useDialogRecord(): OpenDialog | undefined {
    const [record, setRecord] = useState<OpenDialog | undefined>(current)
    useEffect(() => {
      const listener = (): void => { setRecord(current) }
      listeners.add(listener)
      listener()
      return () => { listeners.delete(listener) }
    }, [])
    return record
  }

  try {
    slots.inject('conversation.input.left', () => slots.register(
      { name: 'conversation.input.left', id: 'prompt-forge', order: BUTTON_ORDER, label: () => tt('button.label') },
      ComposerButton as never,
    ))
    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'prompt-forge', order: SETTINGS_ORDER, label: () => tt('settings.title') },
      SettingsPage as never,
    ))
    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'prompt-forge', order: 30, label: () => tt('dialog.title') },
      OverlayHost as never,
    ))
  } catch (error) {
    // A slot collision or a missing declaration must not take the GUI down.
    console.warn('[dsh-prompt-forge] surface registration failed:', error)
  }
}

// Re-exported so a smoke check can drive the pure helpers without the GUI.
export { composerFor, readDraft, writeDraft } from './composer.ts'
export { resolveConfig, bindSettings, CONFIG_DEFAULTS } from './settings.ts'
export { runOptimize, fetchModels, draftRejection } from './api.ts'
export { tt, applyHostLocale, installLocale, NS } from './locales.ts'
// The dialog is exported for the render check to mount directly: it is the
// component with the most surface area, and the overlay path that reaches it
// in production cannot be driven from outside the module.
export { OptimizeDialog, acceptRefusal } from './OptimizeDialog.tsx'
export { SettingsSection } from './SettingsSection.tsx'
export { OptimizeButton } from './OptimizeButton.tsx'
