/**
 * Browser-side transport for the plugin's loopback routes.
 *
 * One module owns both endpoints so the request shapes, the SSE parser, and
 * the abort discipline live in exactly one place.
 */
import {
  MAX_DRAFT_CHARS,
  OPTIMIZER_API,
  type ModelsResponse,
  type OptimizeEvent,
  type ProviderModelGroup,
} from '../protocol.ts'

/** One candidate provider roster plus any failure the route reported. */
export interface ModelsResult {
  ok: boolean
  providers: ProviderModelGroup[]
  message?: string
}

/**
 * Read the host's provider and chat-model roster.
 * @param signal - caller cancellation.
 * @returns the roster, or an `ok: false` result carrying a readable reason.
 */
export async function fetchModels(signal?: AbortSignal): Promise<ModelsResult> {
  let response: Response
  try {
    response = await fetch(OPTIMIZER_API.models, { headers: { accept: 'application/json' }, ...signal === undefined ? {} : { signal } })
  } catch (error) {
    return { ok: false, providers: [], message: error instanceof Error ? error.message : String(error) }
  }
  if (!response.ok) return { ok: false, providers: [], message: `HTTP ${response.status}` }
  let body: ModelsResponse
  try {
    body = await response.json() as ModelsResponse
  } catch {
    return { ok: false, providers: [], message: 'the model route returned non-JSON' }
  }
  if (body.ok !== true || !Array.isArray(body.providers)) {
    return { ok: false, providers: [], message: body.message ?? 'the model route refused the request' }
  }
  return { ok: true, providers: body.providers }
}

/** One optimization run's inputs. */
export interface OptimizeInput {
  /** The draft to rewrite. */
  text: string
  /** The resolved system prompt (preset body or main prompt). */
  system: string
  /** Previous optimized text, for a follow-up tweak. */
  previous?: string
  /** The user's follow-up instruction. */
  instruction?: string
  /** Caller cancellation; aborts the upstream model call host-side too. */
  signal?: AbortSignal
}

/** A run's outcome, normalized for the dialog. */
export type OptimizeOutcome =
  | { kind: 'done'; text: string }
  | { kind: 'aborted'; text: string }
  | { kind: 'error'; code: string; message: string }

/**
 * Refusal reasons the client can decide before spending a round trip.
 * @param text - the draft.
 * @returns the limit message, or undefined when the draft is acceptable.
 */
export function draftRejection(text: string): string | undefined {
  if (text.trim() === '') return 'empty'
  if (text.length > MAX_DRAFT_CHARS) return 'too-long'
  return undefined
}

/**
 * Run one optimization, streaming deltas through `onDelta`.
 *
 * Resolves with the terminal outcome rather than throwing: a model failure is a
 * normal result the dialog renders, not an exception the caller has to catch.
 * @param input - the request.
 * @param onDelta - called for every visible text fragment.
 * @returns the terminal outcome.
 */
export async function runOptimize(
  input: OptimizeInput,
  onDelta: (text: string) => void,
): Promise<OptimizeOutcome> {
  let response: Response
  try {
    response = await fetch(OPTIMIZER_API.optimize, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        text: input.text,
        system: input.system,
        ...input.previous === undefined ? {} : { previous: input.previous },
        ...input.instruction === undefined ? {} : { instruction: input.instruction },
      }),
      ...input.signal === undefined ? {} : { signal: input.signal },
    })
  } catch (error) {
    if (input.signal?.aborted === true) return { kind: 'aborted', text: '' }
    return { kind: 'error', code: 'network', message: error instanceof Error ? error.message : String(error) }
  }

  if (!response.ok) {
    // The route answers refusals (empty draft, over-long draft, unavailable
    // LLM service) as JSON before the stream opens, so surface that message.
    const message = await readErrorMessage(response)
    return { kind: 'error', code: `http-${response.status}`, message }
  }
  if (response.body === null) return { kind: 'error', code: 'no-body', message: 'The optimize route returned no stream' }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let assembled = ''
  let outcome: OptimizeOutcome | undefined

  const handleFrame = (payload: string): void => {
    let event: OptimizeEvent
    try {
      event = JSON.parse(payload) as OptimizeEvent
    } catch {
      return
    }
    if (event.type === 'delta') {
      assembled += event.text
      onDelta(event.text)
      return
    }
    if (event.type === 'done') {
      outcome = event.aborted === true ? { kind: 'aborted', text: assembled } : { kind: 'done', text: assembled }
      return
    }
    if (event.type === 'error') {
      outcome = { kind: 'error', code: event.code, message: event.message }
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // Frames are `data: <json>` separated by a blank line; tolerate CRLF.
      let boundary = findFrameBoundary(buffer)
      while (boundary !== undefined) {
        const raw = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary.length)
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith('data:')) handleFrame(line.slice(5).trim())
        }
        boundary = findFrameBoundary(buffer)
      }
    }
    // A final frame without its trailing blank line still counts.
    for (const line of buffer.split(/\r?\n/)) {
      if (line.startsWith('data:')) handleFrame(line.slice(5).trim())
    }
  } catch (error) {
    if (input.signal?.aborted === true) return { kind: 'aborted', text: assembled }
    return { kind: 'error', code: 'stream', message: error instanceof Error ? error.message : String(error) }
  }

  if (outcome !== undefined) return outcome
  if (input.signal?.aborted === true) return { kind: 'aborted', text: assembled }
  // The stream closed without a terminal frame: report what arrived rather
  // than pretending the run succeeded.
  return assembled === ''
    ? { kind: 'error', code: 'no-output', message: 'The model returned nothing' }
    : { kind: 'done', text: assembled }
}

/** Locate the next SSE frame boundary in a buffer. */
function findFrameBoundary(buffer: string): { index: number; length: number } | undefined {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf < 0 && crlf < 0) return undefined
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 }
  return { index: lf, length: 2 }
}

/** Read a refusal body's message, falling back to the status line. */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { message?: unknown; error?: unknown }
    if (typeof body.message === 'string' && body.message !== '') return body.message
    if (typeof body.error === 'string' && body.error !== '') return body.error
  } catch {
    // Non-JSON refusals keep the generic text.
  }
  return `HTTP ${response.status}`
}
