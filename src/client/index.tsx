/**
 * dsh-prompt-forge — browser half.
 *
 * Contributes exactly three things and nothing else:
 *   1. one compact button in the composer tool row (`conversation.input.left`);
 *   2. one settings page (`settings.section`);
 *   3. one inline optimizer panel inside the composer card
 *      (`conversation.input.overlay`), mounted only while that session has a
 *      panel open.
 *
 * The panel moved into the composer card in v2, out of the frame-wide overlay.
 * The slot's anchor is a zero-height, absolutely-positioned element inside the
 * card (`client.js:17172`), so a panel positioned against its top edge floats
 * above the composer without occupying layout: opening it never moves the
 * editor and never reflows the transcript. That anchoring is also why the panel
 * can be taller than the composer itself.
 *
 * The write-back path became simpler in the same move. A session-scope slot
 * occurrence is handed `inputActions` (including `setDraft`) as a standard prop,
 * so v1's `sessions.scope()` + `conversation.input.for()` resolution — which
 * could only ever be looked up defensively — is gone. The occurrence already
 * *is* the session, so there is no session to look up.
 *
 * Failure policy: every mount step is guarded. A plugin that throws out of
 * `apply` fails the whole web boot, so a broken surface here must degrade to a
 * missing button, never to a dead GUI.
 */
import { useCallback, useEffect, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { InputActions, InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the settings slot contract (settings.section).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the conversation slot contract (conversation.input.left,
// conversation.input.overlay) and the session standard kit read below.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { bindSettings, type SettingsHandle, type SettingsSnapshot } from './settings.ts'
import { writeNeedsConfirm } from './composer.ts'
import { installLocale, tt } from './locales.ts'
import { InlinePanel } from './InlinePanel.tsx'
import { OptimizeButton } from './OptimizeButton.tsx'
import { SettingsSection } from './SettingsSection.tsx'

/** Services this plugin needs before it can mount anything. */
export const inject = ['slots', 'locale', 'sessions', 'conversation']

/** Settings page ordering within the Settings dialog's section list. */
const SETTINGS_ORDER = 62

/** Composer tool-row ordering; after the shipped permission/plan controls. */
const BUTTON_ORDER = 20

/**
 * Panel ordering inside the composer-card overlay slot.
 *
 * Deliberately 40, not 10: `dsh-context` registers its `context-modal` into
 * this same slot at order 10. Sharing a cell id would throw at registration and
 * take the GUI boot down with it, so this entry keeps a distinct id *and* a
 * distinct order behind the shipped one.
 */
const PANEL_ORDER = 40

/**
 * One open panel's captured inputs, keyed by session.
 *
 * The draft is captured at open time and never re-read: the panel must show the
 * text the user had when they clicked, even if they keep typing behind it.
 */
interface OpenPanel {
  draft: string
  /** Monotonic key so a second open remounts the component (and its run) cleanly. */
  key: number
}

/** The standard props a session-scope slot occurrence receives (structural). */
interface SessionSlotProps {
  sessionId: SessionId
  /** Selector hook over the live input machine. */
  useInput: (selector: (state: InputState) => unknown) => unknown
  /** Stable write actions for this session's composer. */
  inputActions: InputActions
}

/** The slots service surface this plugin consumes (structural). */
interface SlotsFace {
  register(options: Record<string, unknown>, component: (props: never) => unknown): () => void
  inject(key: string, callback: () => () => void): () => void
}

/**
 * Mount the composer button, the settings page, and the inline panel.
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

  // --------------------------------------------------------- session-bucketed panels
  /**
   * One open panel per session, never one global singleton.
   *
   * The occurrence is already session-scoped, but the *state* still has to be
   * bucketed by session identity: a panel opened in one session must never be
   * handed a draft captured in another, and retiring one session's panel must
   * not touch another's.
   */
  const panels = new Map<SessionId, OpenPanel>()
  /** Subscribers per session, so a change wakes only that session's panel. */
  const panelListeners = new Map<SessionId, Set<() => void>>()
  /** Global remount-key source; monotonic for the life of the plugin. */
  let panelKey = 0

  /** Wake the subscribers of one session. */
  const notifyPanel = (sessionId: SessionId): void => {
    const listeners = panelListeners.get(sessionId)
    if (listeners === undefined) return
    for (const listener of [...listeners]) listener()
  }

  const panelStore = {
    /**
     * Record one open. A second open in the same session bumps the key, which
     * remounts the panel and thereby restarts its run from the newer draft.
     */
    open(sessionId: SessionId, draft: string): void {
      panels.set(sessionId, { draft, key: ++panelKey })
      notifyPanel(sessionId)
    },
    /** Retire one session's panel; the draft is untouched. */
    close(sessionId: SessionId): void {
      if (!panels.delete(sessionId)) return
      notifyPanel(sessionId)
    },
    /**
     * Drop one session's bucket without waking anyone.
     *
     * Called when the session's slot occurrence goes away — a session scope
     * disposal or an unmount. The panel component's own unmount cleanup aborts
     * whatever request it had in flight, so the bucket is the only state left
     * to release here.
     */
    forget(sessionId: SessionId): void {
      panels.delete(sessionId)
    },
  }

  // ------------------------------------------------------ inline panel occurrence
  /**
   * Render the panel for exactly one session.
   *
   * State is read in an effect rather than during the first render: the bucket
   * is plugin-owned mutable state, and reading it while rendering would make the
   * render impure. Session-scope entries remount on a session switch, so the
   * subscription below always describes the session this occurrence was mounted
   * for.
   *
   * `hasReferences` describes the **live** draft — the one Accept is about to
   * replace — not the draft captured at open time. A whole-draft `setDraft`
   * flattens reference chips into plain text, so the panel has to know whether
   * any are present *now*. It is computed by {@link writeNeedsConfirm}, the same
   * predicate the panel's confirm branch is built on, so the two can never
   * disagree about whether Accept has to ask first.
   */
  const PanelHost = (props: SessionSlotProps): React.JSX.Element | null => {
    const { sessionId, useInput, inputActions } = props

    const [current, setCurrent] = useState<OpenPanel | undefined>(() => panels.get(sessionId))
    useEffect(() => {
      // Re-sync on mount and on every change of this session's bucket. The
      // `undefined` seed above is only ever visible for the first frame of a
      // panel that was opened in a previous session — never for one opened in
      // this one, because the button's `open` runs before this entry re-renders.
      const listener = (): void => { setCurrent(panels.get(sessionId)) }
      let listeners = panelListeners.get(sessionId)
      if (listeners === undefined) {
        listeners = new Set()
        panelListeners.set(sessionId, listeners)
      }
      listeners.add(listener)
      listener()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) panelListeners.delete(sessionId)
        // Scope disposal or unmount releases this session's bucket. The panel
        // component's own unmount cleanup aborts any request it had in flight.
        panelStore.forget(sessionId)
      }
    }, [sessionId])

    // The same predicate the panel uses to decide whether Accept must ask first,
    // read from the LIVE input state: the draft Accept is about to replace is the
    // current one, not the draft frozen at open time.
    const hasReferences = useInput(
      state => writeNeedsConfirm(state.occurrences.length, state.attachmentIds.length),
    ) === true
    // Subscribed, not a one-shot read: the panel's preset roster and model
    // label must follow a settings change while it is still open.
    const config = useSettings().value

    if (current === undefined) return null

    /**
     * Write the accepted text back, reporting whether it landed.
     *
     * The draft must not be touched when this panel is no longer the live one
     * for the session, and the caller must not close as if the accept had
     * worked: the boolean is the whole contract between this host and the panel.
     *
     * Three refusal cases, not two. `setDraft` throwing is the documented one
     * (the session stopped being writable). The third is subtle and is why the
     * comparison below is on the bucket *identity* rather than the session id: a
     * re-open in the same session (`key++`) leaves the previous panel's
     * `onWrite` closure alive and callable, and that orphan would otherwise
     * write text the user never accepted, from a panel that is no longer on
     * screen.
     * @returns whether the draft was actually replaced.
     */
    const write = (text: string): boolean => {
      if (panels.get(sessionId) !== current) {
        // Retired between render and click: closed, or re-opened under a new
        // key. Writing now would land text this panel no longer owns.
        console.warn('[dsh-prompt-forge] the panel was replaced before its write landed')
        return false
      }
      try {
        inputActions.setDraft(text)
      } catch (error) {
        // A session that stopped being writable refuses here; the panel stays
        // expanded and reports it.
        console.warn('[dsh-prompt-forge] the composer refused the accepted draft:', error)
        return false
      }
      return true
    }

    return (
      <InlinePanel
        key={current.key}
        original={current.draft}
        config={config}
        sessionId={sessionId}
        onWrite={write}
        onClose={() => { panelStore.close(sessionId) }}
        hasReferences={hasReferences}
      />
    )
  }

  /**
   * Guarded slot entry point.
   *
   * The standard kit always supplies the three props below for a session-scope
   * entry, but a composition that mounted this entry without a session binding —
   * or a check that renders it with no props at all — must render nothing rather
   * than throw. The guard is a single hook-free branch, so it cannot disturb the
   * hook order inside {@link PanelHost}.
   */
  const OverlayHost = (props: Partial<SessionSlotProps>): React.JSX.Element | null => {
    if (props.sessionId === undefined || props.inputActions === undefined || typeof props.useInput !== 'function') return null
    return <PanelHost sessionId={props.sessionId} useInput={props.useInput} inputActions={props.inputActions} />
  }

  // -------------------------------------------------- composer tool-row button
  const ComposerButton = (props: { sessionId: SessionId; useInput: (selector: (state: InputState) => unknown) => unknown }): React.JSX.Element => {
    const snapshot = useSettings()
    const open = useCallback((draft: string): void => {
      panelStore.open(props.sessionId, draft)
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

  // ------------------------------------------------------------------- wiring
  try {
    slots.inject('conversation.input.left', () => slots.register(
      { name: 'conversation.input.left', id: 'prompt-forge', order: BUTTON_ORDER, label: () => tt('button.label') },
      ComposerButton as never,
    ))
    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'prompt-forge', order: SETTINGS_ORDER, label: () => tt('settings.title') },
      SettingsPage as never,
    ))
    slots.inject('conversation.input.overlay', () => slots.register(
      { name: 'conversation.input.overlay', id: 'prompt-forge', order: PANEL_ORDER, label: () => tt('dialog.title') },
      OverlayHost as never,
    ))
  } catch (error) {
    // A slot collision or a missing declaration must not take the GUI down.
    console.warn('[dsh-prompt-forge] surface registration failed:', error)
  }
}

// Re-exported so a smoke check can drive the pure helpers without the GUI.
export { composerFor, readDraft, writeDraft, writeNeedsConfirm } from './composer.ts'
export { resolveConfig, bindSettings, CONFIG_DEFAULTS } from './settings.ts'
export { runOptimize, fetchModels, draftRejection } from './api.ts'
export { tt, applyHostLocale, installLocale, NS } from './locales.ts'
// The accept gate and the panel are exported for the render check to drive
// directly: the overlay path that reaches them in production cannot be driven
// from outside the module.
export { acceptRefusal } from './accept-guard.ts'
export { InlinePanel }
export { SettingsSection } from './SettingsSection.tsx'
export { OptimizeButton } from './OptimizeButton.tsx'
