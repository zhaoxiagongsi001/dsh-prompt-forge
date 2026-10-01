/**
 * Provider and model discovery for the settings page.
 *
 * The client cannot reach `ctx.llm` (the client runtime exposes no `llm`
 * remote namespace), so the host projects the roster onto a loopback route.
 * Chat-capable filtering happens here: a provider advertises image, embedding,
 * and rerank models on the same route, and offering those as rewrite targets
 * would produce a confusing upstream error instead of a usable picker.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { ProviderModelGroup } from './protocol.ts'

/** The `ctx.llm` surface this module consumes (structural, so tests can fake it). */
export interface LlmDirectory {
  listProviders(): Array<{ id: string; name: string }>
  listModels(provider: string): Promise<readonly LlmModelInfo[]>
}

/**
 * Model ids that are never chat-completion targets, matched case-insensitively.
 *
 * `rerank(?:er)?` is deliberate: gateways publish both `bge-rerank-v1` and
 * `bge-reranker-v2-m3`, and a bare `rerank` token misses the second spelling
 * because the regex requires a `/`, `_`, `-` or end right after the match.
 * Embedding names without a keyword at all (`bge-m3`, `voyage-code-2`) cannot
 * be caught by name and are left to the modality check below.
 */
const NON_CHAT_MODEL = /(?:^|[/_-])(embed(?:ding)?|rerank(?:er)?|moderation|whisper|tts|speech|transcri|image|vision-encoder|dall-e|stable-diffusion|sora)(?:$|[/_-])/i

/** Provider routes that carry no chat models at all. */
const NON_CHAT_PROVIDER = /(?:^|[/_-])(deepseek-account|account)$/i

/**
 * Whether one advertised model can plausibly serve a chat-completion rewrite.
 *
 * The id heuristic runs FIRST and can only exclude: an embedding or image route
 * is never a rewrite target no matter what modality metadata claims, because
 * gateways routinely report `text` input for embedding models. Modality data
 * then decides the remaining, id-neutral models — where it is the more precise
 * signal, since it can also drop an image-only route.
 * @param model - one advertised model record.
 * @returns true when the picker should offer it.
 */
export function isChatModel(model: LlmModelInfo): boolean {
  if (NON_CHAT_MODEL.test(model.id)) return false
  const modalities = model.inputModalities
  if (modalities !== undefined && modalities.length > 0) {
    // A text input is required; image-only routes cannot read a draft.
    return modalities.includes('text')
  }
  return true
}

/**
 * Read every registered provider with its advertised chat models.
 *
 * A provider whose catalog throws is reported with an empty model list rather
 * than failing the whole request: one broken gateway must not hide the rest.
 * @param llm - the `ctx.llm` service.
 * @returns provider groups in registration order, each sorted by model id.
 */
export async function listProviderGroups(llm: LlmDirectory): Promise<ProviderModelGroup[]> {
  const providers = llm.listProviders().filter(provider => !NON_CHAT_PROVIDER.test(provider.id))
  const groups = await Promise.all(providers.map(async (provider): Promise<ProviderModelGroup> => {
    let models: readonly LlmModelInfo[] = []
    try {
      models = await llm.listModels(provider.id)
    } catch {
      // An unreachable gateway yields an empty picker row, not a failed page.
      models = []
    }
    const chat = models
      .filter(isChatModel)
      .map(model => ({ id: model.id, name: model.name === '' ? model.id : model.name }))
      .sort((left, right) => left.id.localeCompare(right.id))
    // De-duplicate by id: some adapters repeat a model across catalog pages.
    const unique = chat.filter((model, index) => chat.findIndex(candidate => candidate.id === model.id) === index)
    return { id: provider.id, name: provider.name === '' ? provider.id : provider.name, models: unique }
  }))
  return groups
}

/** Narrow an unknown service handle to the directory surface, or undefined. */
export function asLlmDirectory(value: unknown): LlmDirectory | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as Partial<LlmDirectory>
  if (typeof candidate.listProviders !== 'function' || typeof candidate.listModels !== 'function') return undefined
  return candidate as LlmDirectory
}

/** Resolve the optional `ctx.llm` service from a context. */
export function llmOf(ctx: Context): LlmDirectory | undefined {
  return asLlmDirectory(ctx.get('llm'))
}
