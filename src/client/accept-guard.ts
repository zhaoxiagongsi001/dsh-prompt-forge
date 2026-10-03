/**
 * The accept gate: the one rule that protects the user's draft.
 *
 * Pure and isolated on purpose. v1 kept this next to the modal component, which
 * was fine while the modal was the only surface; in v2 the panel is the surface
 * and the modal is retired, so the rule lives in its own module rather than
 * being inherited from a component that no longer exists.
 *
 * Why it is a named export instead of an inline `if`: the mid-stream refusal is
 * the difference between writing the model's *answer* into the composer and
 * writing a *prefix* of it. A rule that only lives inside an event handler is a
 * rule nothing can regression-test without a browser.
 */

/** Which pass is showing, as far as the accept gate cares. */
export type AcceptPhase = 'idle' | 'running' | 'settled'

/**
 * Why an accept must be refused, or undefined when the write may proceed.
 * @param phase - the current run's phase.
 * @param text - the text the result pane currently holds.
 * @returns the refusal reason, or undefined to allow the write.
 */
export function acceptRefusal(phase: AcceptPhase, text: string): 'busy' | 'empty' | undefined {
  if (phase === 'running') return 'busy'
  if (text.trim() === '') return 'empty'
  return undefined
}
