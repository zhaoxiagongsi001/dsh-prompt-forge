/**
 * dsh-prompt-forge — host half.
 *
 * Owns everything the browser must not: the `ctx.llm` call, the provider and
 * model directory, the settings namespace, and the loopback-fenced route
 * family. The browser half (./client) contributes one composer button and one
 * settings page; it never sees a credential or a base URL.
 *
 * Failure policy: mounting problems inside this file degrade the feature
 * (routes absent, page absent) but must never throw out of `apply`, because a
 * throwing plugin takes the whole GUI boot down with it.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
// Type-only: pulls the webServer Context merge (route registration).
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { installSettingsSectionCompat, settingsNamespaceCompat } from './settings-compat.ts'
import { BUILTIN_PRESETS, DEFAULT_MAIN_PROMPT, resolveSystemPrompt } from './prompts.ts'
import { llmOf, listProviderGroups } from './model-catalog.ts'
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_TEMPERATURE,
  MAX_DRAFT_CHARS,
  OPTIMIZER_API,
  PROMPT_FORGE_NAMESPACE,
  type OptimizeEvent,
} from './protocol.ts'

/** Stable Cordis plugin name. */
export const name = 'prompt-forge'

/** The web carrier is the only hard service: without it there is no bridge. */
export const inject = ['webServer']

/** Upper bound on one request body; drafts are text and small. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** Plugin config, validated by the same-named schemastery schema below. */
export interface Config {
  /** Master switch: hides the composer button and refuses both routes. */
  enabled?: boolean
  /** Provider route id (a `ctx.llm` provider key). */
  provider?: string
  /** Model id inside that provider. */
  model?: string
  /** Sampling temperature for the rewrite. */
  temperature?: number
  /** Output token ceiling; 0 leaves the model default. */
  maxTokens?: number
  /** System prompt applied when no preset is selected. */
  mainSystemPrompt?: string
  /** Named alternative system prompts. */
  presets?: Array<{ id: string; name: string; system: string }>
  /** Selected preset id, or empty for the main prompt. */
  activePresetId?: string
}

/**
 * Every field is `.volatile()` so the settings seam can edit it live: the
 * loader resolves volatile top-level fields to references that re-read on
 * every `get()`, which is what lets a saved setting apply without remounting
 * the plugin (and therefore without dropping the running GUI).
 */
const configSchema = z.object({
  enabled: z.boolean().default(true).volatile(),
  provider: z.string().default(DEFAULT_PROVIDER).volatile(),
  model: z.string().default(DEFAULT_MODEL).volatile(),
  temperature: z.number().default(DEFAULT_TEMPERATURE).volatile(),
  maxTokens: z.number().default(0).volatile(),
  mainSystemPrompt: z.string().default(DEFAULT_MAIN_PROMPT).volatile(),
  presets: z.array(z.object({
    id: z.string(),
    name: z.string(),
    system: z.string(),
  })).default(BUILTIN_PRESETS).volatile(),
  activePresetId: z.string().default('').volatile(),
})

// The public schema type stays the plain Config shape; the loader resolves the
// top-level fields to volatile references.
export const Config: z<Config> = configSchema as unknown as z<Config>

/** One live config field exposed by schemastery's volatile resolver. */
interface VolatileValue<T> {
  get: () => T
}

/** Read a value that may be a volatile config reference. */
function unwrapVolatileValue<T>(value: unknown): T {
  if (typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function') {
    return (value as VolatileValue<T>).get()
  }
  return value as T
}

/** Detach a plain Config view from the loader's volatile fields. */
function unwrapConfig(value: unknown): Config {
  if (typeof value !== 'object' || value === null) return {}
  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(value)) out[key] = unwrapVolatileValue(field)
  return out as Config
}

/** Human-readable text from an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Loopback fence plus same-origin marker check, mirroring the shipped route
 * families: a remote browser must not be able to spend the user's model quota.
 * @param req - the incoming request.
 * @returns whether the request may proceed.
 */
function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** One JSON answer, always `ok`-tagged so the client never parses HTTP codes. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

/** Read a JSON request body; undefined when oversized or unparseable. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  if (chunks.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** Open one server-sent-event response and return its frame writer. */
function openEventStream(req: IncomingMessage, res: ServerResponse): ((event: OptimizeEvent) => void) | undefined {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'referrer-policy': 'no-referrer',
  })
  // An immediate comment flushes the headers so the client's fetch resolves
  // before the first token arrives, which is what makes the dialog's pending
  // state honest rather than a spinner that waits on the model.
  res.write(': open\n\n')
  let closed = false
  const close = (): void => { closed = true }
  req.on('close', close)
  res.on('close', close)
  return (event: OptimizeEvent): void => {
    if (closed) return
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    } catch {
      closed = true
    }
  }
}

/** End an event stream, releasing the socket. */
function endEventStream(res: ServerResponse): void {
  if (!res.writableEnded) res.end()
}

/**
 * Mount the settings section and the route family.
 * @param ctx - host plugin context carrying webServer.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(ctx: Context, config?: Config): void {
  // The live config source. The loader hands over volatile references, so this
  // one binding keeps reading current values after any settings write.
  const resolve = (): Required<Pick<Config, 'enabled' | 'provider' | 'model' | 'temperature' | 'maxTokens' | 'mainSystemPrompt' | 'activePresetId'>> & { presets: NonNullable<Config['presets']> } => {
    const value = unwrapConfig(config ?? {})
    const presets = Array.isArray(value.presets) && value.presets.length > 0
      ? value.presets.filter(preset => typeof preset?.id === 'string' && typeof preset?.system === 'string')
      : BUILTIN_PRESETS
    return {
      enabled: value.enabled !== false,
      provider: typeof value.provider === 'string' && value.provider.trim() !== '' ? value.provider.trim() : DEFAULT_PROVIDER,
      model: typeof value.model === 'string' && value.model.trim() !== '' ? value.model.trim() : DEFAULT_MODEL,
      temperature: typeof value.temperature === 'number' && Number.isFinite(value.temperature) ? value.temperature : DEFAULT_TEMPERATURE,
      maxTokens: typeof value.maxTokens === 'number' && Number.isFinite(value.maxTokens) && value.maxTokens > 0 ? Math.floor(value.maxTokens) : 0,
      mainSystemPrompt: typeof value.mainSystemPrompt === 'string' ? value.mainSystemPrompt : DEFAULT_MAIN_PROMPT,
      presets,
      activePresetId: typeof value.activePresetId === 'string' ? value.activePresetId : '',
    }
  }

  // Treat this instance as a custom-page plugin: the official settings shell
  // must not also auto-generate a form page for the same Config.
  installSettingsSectionCompat(ctx, settingsNamespaceCompat(PROMPT_FORGE_NAMESPACE), Config, unwrapConfig(config ?? {}))

  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => {
      const disposers = [
        // ------------------------------------------- provider/model directory
        sctx.webServer.register({
          kind: 'exact',
          path: OPTIMIZER_API.models,
          handler: async (req, res) => {
            if (!isLoopbackRequest(req)) {
              writeJson(res, 403, { ok: false, code: 'forbidden', message: 'loopback-only' })
              return
            }
            if (req.method !== 'GET') {
              writeJson(res, 405, { ok: false, code: 'method', message: `method not allowed: ${req.method}` })
              return
            }
            const llm = llmOf(sctx)
            if (llm === undefined) {
              writeJson(res, 200, { ok: false, code: 'llm-unavailable', message: 'Host LLM service is not mounted in this composition' })
              return
            }
            try {
              writeJson(res, 200, { ok: true, providers: await listProviderGroups(llm) })
            } catch (error) {
              writeJson(res, 200, { ok: false, code: 'catalog-failed', message: messageOf(error) })
            }
          },
        }),
        // ------------------------------------------------------- optimization
        sctx.webServer.register({
          kind: 'exact',
          path: OPTIMIZER_API.optimize,
          handler: async (req, res) => {
            if (!isLoopbackRequest(req)) {
              writeJson(res, 403, { ok: false, code: 'forbidden', message: 'loopback-only' })
              return
            }
            if (req.method !== 'POST') {
              writeJson(res, 405, { ok: false, code: 'method', message: `method not allowed: ${req.method}` })
              return
            }
            const body = await readJsonBody(req)
            if (body === undefined) {
              writeJson(res, 400, { ok: false, code: 'bad-request', message: 'unreadable JSON body' })
              return
            }
            const text = typeof body.text === 'string' ? body.text : ''
            const trimmed = text.trim()
            if (trimmed === '') {
              writeJson(res, 400, { ok: false, code: 'empty-draft', message: 'The draft is empty' })
              return
            }
            if (text.length > MAX_DRAFT_CHARS) {
              writeJson(res, 400, {
                ok: false,
                code: 'draft-too-long',
                message: `Draft is ${text.length} characters; the limit is ${MAX_DRAFT_CHARS}. Shorten it or split the task.`,
              })
              return
            }

            const settings = resolve()
            const llm = llmOf(sctx)
            if (llm === undefined) {
              writeJson(res, 400, { ok: false, code: 'llm-unavailable', message: 'Host LLM service is not mounted in this composition' })
              return
            }

            const send = openEventStream(req, res)
            if (send === undefined) return

            // Cancellation: the client may abort mid-stream, and disposal must
            // not leave the upstream generator running against a dead socket.
            const controller = new AbortController()
            req.on('close', () => { controller.abort() })

            const system = resolveSystemPrompt(
              typeof body.system === 'string' ? body.system : undefined,
              settings.mainSystemPrompt,
            )
            const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : ''
            const previous = typeof body.previous === 'string' ? body.previous : ''
            const userContent = composeUserContent(trimmed, previous, instruction)

            let assembled = ''
            let aborted = false
            try {
              for await (const chunk of llmStream(llm, {
                provider: settings.provider,
                model: settings.model,
                temperature: settings.temperature,
                ...settings.maxTokens > 0 ? { maxTokens: settings.maxTokens } : {},
                system,
                content: userContent,
                signal: controller.signal,
              })) {
                if (chunk.type === 'start') send(chunk)
                else if (chunk.type === 'delta') {
                  assembled += chunk.text
                  send(chunk)
                } else if (chunk.type === 'aborted') {
                  aborted = true
                } else if (chunk.type === 'error') {
                  send(chunk)
                  endEventStream(res)
                  return
                }
              }
              // An abort is reported as aborted rather than as a clean finish:
              // the dialog must not present truncated output as a complete run.
              send({ type: 'done', text: assembled, ...aborted || controller.signal.aborted ? { aborted: true } : {} })
            } catch (error) {
              send({ type: 'error', code: 'optimize-failed', message: messageOf(error) })
            }
            endEventStream(res)
          },
        }),
      ]
      return () => { for (const dispose of disposers) dispose() }
    }, 'dsh-prompt-forge: routes')
  })
}

/**
 * Build the user turn from the draft plus optional follow-up context.
 *
 * A follow-up tweak names the previous version explicitly so the model edits it
 * rather than starting over, which is what makes "make it shorter" mean
 * "shorten that" instead of "rewrite the original differently".
 * @param draft - the original draft.
 * @param previous - the previous optimized version, empty on a first run.
 * @param instruction - the user's follow-up instruction, empty on a first run.
 * @returns the user message text.
 */
export function composeUserContent(draft: string, previous: string, instruction: string): string {
  if (instruction === '' && previous === '') return draft
  const sections = [`【原始草稿】\n${draft}`]
  if (previous !== '') sections.push(`【上一版改写结果】\n${previous}`)
  if (instruction !== '') sections.push(`【本次修改要求】\n${instruction}`)
  sections.push('请基于上述内容输出改写后的完整提示词。')
  return sections.join('\n\n')
}

/** The `ctx.llm` call surface this module consumes (structural, for tests). */
export interface LlmStreamer {
  stream(options: {
    provider: string
    model: string
    system?: string
    messages: Array<{ role: 'user'; content: Array<{ type: 'text'; text: string }> }>
    temperature?: number
    maxTokens?: number
    signal?: AbortSignal
  }): AsyncIterable<{ type: string; text?: string; reason?: { kind: string; failure?: { message?: string; code?: string } } }>
}

/** Normalize one upstream chunk into the frames the route emits. */
type NormalizedChunk =
  | { type: 'start'; provider: string; model: string }
  | { type: 'delta'; text: string }
  | { type: 'aborted' }
  | { type: 'error'; code: string; message: string }

/**
 * Drive one `ctx.llm.stream` call and normalize its chunks.
 *
 * Reasoning deltas are dropped on purpose: the rewrite pane must show the
 * prompt, and a reasoning model would otherwise leak its scratchpad into the
 * text the user is about to paste into the composer.
 * @param llm - the host LLM service.
 * @param request - the resolved request.
 * @returns normalized frames, with a terminal error frame on upstream failure.
 */
export async function* llmStream(
  llm: unknown,
  request: {
    provider: string
    model: string
    system: string
    content: string
    temperature: number
    maxTokens?: number
    signal: AbortSignal
  },
): AsyncGenerator<NormalizedChunk> {
  const streamer = llm as Partial<LlmStreamer>
  if (typeof streamer.stream !== 'function') {
    yield { type: 'error', code: 'llm-unsupported', message: 'The mounted LLM service does not expose stream()' }
    return
  }
  yield { type: 'start', provider: request.provider, model: request.model }
  const iterator = streamer.stream({
    provider: request.provider,
    model: request.model,
    system: request.system,
    temperature: request.temperature,
    ...request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens },
    messages: [{ role: 'user', content: [{ type: 'text', text: request.content }] }],
    signal: request.signal,
  })
  for await (const chunk of iterator) {
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
      yield { type: 'delta', text: chunk.text }
      continue
    }
    if (chunk.type === 'finish') {
      const kind = chunk.reason?.kind
      if (kind === 'error') {
        yield {
          type: 'error',
          code: chunk.reason?.failure?.code ?? 'upstream-error',
          message: chunk.reason?.failure?.message ?? 'The model call failed',
        }
        return
      }
      if (kind === 'aborted') {
        // A distinct frame, not silence: the route has to tell the client that
        // what it received is incomplete.
        yield { type: 'aborted' }
        return
      }
    }
  }
}
