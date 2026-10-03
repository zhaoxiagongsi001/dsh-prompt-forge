/**
 * Composer-bound helpers.
 *
 * The write-back path — "put this accepted text into the user's composer" —
 * lives here, and it is the one place where a mistake would damage user data.
 *
 * v2 note: the panel no longer routes through {@link composerFor}. The
 * `conversation.input.overlay` slot occurrence receives `inputActions`
 * (including `setDraft`) as a standard prop, so the host writes directly and
 * this lookup is no longer on the live path. It is kept exported because the
 * render check still drives it, and because the resolution rules below remain
 * the documented contract for reaching a composer from a plain context.
 *
 * `conversation.input.for(scope)` does not take a session id: it takes a
 * **Session-scope context**, and it throws outright when that scope is not a
 * currently retained session. The Session Controller's `scope(id)` is the
 * supported way to obtain one (the shipped dsh-imagegen panel resolves its
 * composer exactly this way), so that is the path used here.
 *
 * Everything below therefore returns `undefined` rather than throwing: an
 * unaddressable composer disables the button or silently declines the write,
 * where an exception would take the whole panel down.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** The slice of the per-session composer facade this plugin drives. */
export interface ComposerInput {
  readonly state: { getSnapshot(): { readonly draft: string } }
  setDraft(text: string): void
  focus?(): void
}

/** The `ctx.conversation` surface this plugin consumes (structural). */
export interface ConversationFace {
  input: { for(sessionScope: unknown): ComposerInput }
}

/** The `ctx.sessions` surface this plugin consumes (structural). */
interface SessionsFace {
  /**
   * Resolve the Session-scope context for one identity, or undefined when it is
   * not mounted. This is the documented SessionInputResolver dependency.
   */
  scope?(id: SessionId): unknown
}

/**
 * Resolve the composer facade for one session.
 *
 * @param ctx - client root context.
 * @param sessionId - the session whose composer is addressed.
 * @returns the composer facade, or undefined when this session has none.
 */
export function composerFor(ctx: ClientContext, sessionId: SessionId): ComposerInput | undefined {
  const conversation = ctx.get('conversation') as ConversationFace | undefined
  if (conversation === undefined || typeof conversation.input?.for !== 'function') return undefined

  const sessions = ctx.get('sessions') as SessionsFace | undefined
  if (sessions === undefined || typeof sessions.scope !== 'function') return undefined

  let scope: unknown
  try {
    scope = sessions.scope(sessionId)
  } catch {
    return undefined
  }
  // `for()` refuses an absent scope, so short-circuit before calling it.
  if (scope === undefined || scope === null) return undefined

  try {
    return conversation.input.for(scope)
  } catch {
    // "requires a retained Session scope" is the expected refusal for a session
    // that stopped being retained between open and accept.
    return undefined
  }
}

/**
 * Read the current draft of one composer.
 * @param input - the composer facade.
 * @returns the draft text, or an empty string when unreadable.
 */
export function readDraft(input: ComposerInput): string {
  try {
    const draft = input.state.getSnapshot().draft
    return typeof draft === 'string' ? draft : ''
  } catch {
    return ''
  }
}

/**
 * Write accepted text into one composer and return focus to it.
 *
 * The caller is responsible for having already confirmed the composer exists;
 * this returns whether the write landed so a failed accept can be reported
 * instead of appearing to succeed.
 * @param input - the composer facade.
 * @param text - the accepted prompt.
 * @returns whether the draft was replaced.
 */
export function writeDraft(input: ComposerInput, text: string): boolean {
  try {
    input.setDraft(text)
  } catch {
    return false
  }
  // Focus is best-effort: the text is already in place, and a shell without the
  // verb should not turn a successful accept into a failure.
  try {
    input.focus?.()
  } catch {
    // Ignored on purpose.
  }
  return true
}

/**
 * Whether replacing the whole draft would damage structured content in it.
 *
 * `setDraft` clears the editor document and rewrites it as plain text, so every
 * `@` reference chip degrades to its clipboard projection and any draft
 * attachment is left without matching text. Neither leaves a separate undo
 * step. When this returns true the panel must ask before writing, rather than
 * silently flattening the user's draft.
 *
 * Non-finite counts are treated as absent: a `NaN` from an upstream projection
 * must not be read as "has references" and nag the user on every accept.
 * @param occurrences - the number of `@` reference chips in the live draft.
 * @param attachmentIds - the number of attachment drafts in the live draft.
 * @returns whether the write needs a confirmation step.
 */
export function writeNeedsConfirm(occurrences: number, attachmentIds: number): boolean {
  const references = Number.isFinite(occurrences) && occurrences > 0
  const attachments = Number.isFinite(attachmentIds) && attachmentIds > 0
  return references || attachments
}
