import * as settingsModule from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';

// ---- src/settings-compat.ts ----
const compatModule = settingsModule;
/** The loader entry id of the plugin instance owning `ctx`, when available. */
function entryNamespaceOf(ctx) {
    const compat = ctx;
    const entry = compat.fiber?.entry;
    const candidates = [
        entry?.options?.id,
        entry?.id,
        compat.loader?.locate?.(compat.fiber),
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate !== '')
            return candidate;
    }
    return undefined;
}
/** Brand a namespace where the installed settings package still exposes it. */
function settingsNamespaceCompat(value) {
    return compatModule.settingsNamespace?.(value) ?? value;
}
/**
 * Resolve the namespace the settings route must read and write.
 *
 * Managed-forms hosts key the namespace by the profile entry id, which is the
 * string the settings shell already shows; legacy hosts use the caller-chosen
 * namespace. The public route contract keeps the branded id either way.
 * @param ctx - the plugin context.
 * @param fallback - the branded namespace to use when no entry id resolves.
 * @returns the internal namespace for seam calls.
 */
function resolveSettingsNamespaceCompat(ctx, fallback) {
    if (compatModule.installSettingsSection !== undefined)
        return fallback;
    const provider = ctx.get('settings');
    if (provider?.installSection !== undefined)
        return fallback;
    if (provider?.configure !== undefined)
        return entryNamespaceOf(ctx) ?? fallback;
    return fallback;
}
/**
 * Register this plugin's settings presentation.
 *
 * Managed-forms hosts only need to be told that this plugin draws its own page
 * (`auto: false`), which suppresses the auto-generated duplicate. Hosts with an
 * explicit installer get their section registered. A host exposing neither is
 * tolerated rather than fatal: the feature still works with composition-level
 * defaults, and a boot crash would be a far worse outcome than a missing page.
 * @param ctx - the plugin context.
 * @param ns - the branded settings namespace.
 * @param schema - the plugin's Config schema.
 * @param entry - the resolved config entry.
 */
function installSettingsSectionCompat(ctx, ns, schema, entry) {
    const legacyInstaller = compatModule.installSettingsSection;
    if (legacyInstaller !== undefined) {
        try {
            legacyInstaller(ctx, ns, schema, entry, {});
        }
        catch (error) {
            ctx.logger?.warn?.('dsh-prompt-forge: legacy settings section not installed:', error);
        }
        return;
    }
    ctx.inject(['settings'], (sctx) => {
        sctx.effect(() => {
            const provider = sctx.get('settings');
            if (provider?.installSection !== undefined) {
                try {
                    provider.installSection(ctx, ns, schema, entry, {});
                }
                catch (error) {
                    sctx.logger?.warn?.('dsh-prompt-forge: settings section not installed:', error);
                }
                return () => { };
            }
            if (provider?.configure === undefined) {
                sctx.logger?.warn?.('dsh-prompt-forge: settings provider exposes neither installSection nor configure; using composition defaults');
                return () => { };
            }
            // Managed-forms host: the Config's volatile fields are the form. Declaring
            // auto:false keeps the official shell from also drawing a generic page for
            // this plugin, because this plugin ships its own settings section.
            const dispose = provider.configure({ auto: false }, ctx.fiber);
            return typeof dispose === 'function' ? dispose : () => { };
        }, 'dsh-prompt-forge: settings presentation');
    });
}

// ---- src/prompts.ts ----
/**
 * Prompt copy owned by the plugin: one default main system prompt and the
 * built-in preset roster.
 *
 * Every prompt here obeys the same three rules, because they are what keeps an
 * optimizer from becoming a rewriter: preserve the user's intent and language,
 * invent no facts, and emit the prompt and nothing else.
 */
/** Shared closing instruction: the model must return the prompt alone. */
const OUTPUT_ONLY = '只输出改写后的提示词本身。不要解释你做了什么，不要加标题、前言、说明、Markdown 代码块包裹，也不要加「优化后的提示词：」这类标签。';
/** The prompt applied when the user selects no preset. */
const DEFAULT_MAIN_PROMPT = `你是一名提示词工程师。用户会给你一段写给 AI 模型的草稿，可能属于编码、问答、写作、分析等任何任务。你的工作是在完全保留原意的前提下，把它改写成一段更清晰、更可执行的提示词。

改写要求：
1. 保留原始意图、事实、约束、语言和语气。不要新增用户没有提出的需求，不要把任务换成另一类任务。
2. 补足可执行性：写清任务目标、必要的背景与上下文、输出要求（格式、长度、语言）。原文没给的信息，用最保守的合理默认补齐，绝不编造具体事实、数据、文件路径或接口名。
3. 消除歧义与冗余：合并重复表述，把「这个」「那个」「弄一下」这类模糊指代替换成明确指代。
4. 原文中的代码、报错信息、路径、命令、专有名词、专业术语一律原样保留，不要改写或翻译。
5. 跟随原文语言：中文草稿输出中文，英文草稿输出英文。

${OUTPUT_ONLY}`;
/** The coding preset: same discipline, weighted toward implementable specs. */
const CODING_PRESET_PROMPT = `你是一名提示词工程师。用户会给你一段和软件开发有关的草稿。请在不改变原意的前提下，把它改写成一段工程上可直接执行的提示词。

改写要求：
1. 保留原始意图、技术栈、既有约束和语言。不要替换技术选型，不要新增用户没要求的功能。
2. 明确以下要素（原文已有的保持不动，缺失的只在能从原文合理推断时补上，否则留空而不编造）：要改动的范围与文件、期望行为、必须保持不变的既有行为、边界与错误处理、验收标准。
3. 涉及代码、报错、日志、路径、命令、API 名称、版本号时，一律原样保留。
4. 去掉空泛表述（「优化一下」「看着改」），换成可判断是否完成的具体要求。
5. 跟随原文语言。

${OUTPUT_ONLY}`;
/** The writing preset: same discipline, weighted toward prose outcomes. */
const WRITING_PRESET_PROMPT = `你是一名提示词工程师。用户会给你一段写作、改写或内容创作相关的草稿。请在不改变原意的前提下，把它改写成一段结果可控的提示词。

改写要求：
1. 保留原始意图、事实、观点立场、语言和语气。不要替用户改立场，不要新增事实或数据。
2. 明确写作要素：文体与用途、目标读者、语气、篇幅或结构、必须包含与必须避免的内容。原文没说的不要臆造，只做最保守的默认。
3. 把「写得好一点」「专业一些」这类空泛要求，换成可判断的具体标准。
4. 原文提到的人名、术语、专有名词、引用一律保留原样。
5. 跟随原文语言。

${OUTPUT_ONLY}`;
/**
 * The presets a fresh install starts with. Ids are stable so an upgrade never
 * duplicates rows; a user deletion is remembered because the stored array
 * replaces this default wholesale.
 */
const BUILTIN_PRESETS = [
    { id: 'general', name: '通用优化', system: DEFAULT_MAIN_PROMPT },
    { id: 'coding', name: '编码任务', system: CODING_PRESET_PROMPT },
    { id: 'writing', name: '写作改写', system: WRITING_PRESET_PROMPT },
];
/**
 * Resolve the system prompt one request should use: a selected preset wins,
 * the main prompt is the fallback, and the built-in default is the last
 * resort (an empty stored value must never send an empty system prompt).
 * @param preset - the preset body chosen by the caller.
 * @param main - the stored main prompt.
 * @returns the non-empty system prompt to send.
 */
function resolveSystemPrompt(preset, main) {
    const chosen = typeof preset === 'string' ? preset.trim() : '';
    if (chosen !== '')
        return chosen;
    const stored = typeof main === 'string' ? main.trim() : '';
    return stored === '' ? DEFAULT_MAIN_PROMPT : stored;
}

// ---- src/model-catalog.ts ----
/**
 * Model ids that are never chat-completion targets, matched case-insensitively.
 *
 * `rerank(?:er)?` is deliberate: gateways publish both `bge-rerank-v1` and
 * `bge-reranker-v2-m3`, and a bare `rerank` token misses the second spelling
 * because the regex requires a `/`, `_`, `-` or end right after the match.
 * Embedding names without a keyword at all (`bge-m3`, `voyage-code-2`) cannot
 * be caught by name and are left to the modality check below.
 */
const NON_CHAT_MODEL = /(?:^|[/_-])(embed(?:ding)?|rerank(?:er)?|moderation|whisper|tts|speech|transcri|image|vision-encoder|dall-e|stable-diffusion|sora)(?:$|[/_-])/i;
/** Provider routes that carry no chat models at all. */
const NON_CHAT_PROVIDER = /(?:^|[/_-])(deepseek-account|account)$/i;
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
function isChatModel(model) {
    if (NON_CHAT_MODEL.test(model.id))
        return false;
    const modalities = model.inputModalities;
    if (modalities !== undefined && modalities.length > 0) {
        // A text input is required; image-only routes cannot read a draft.
        return modalities.includes('text');
    }
    return true;
}
/**
 * Read every registered provider with its advertised chat models.
 *
 * A provider whose catalog throws is reported with an empty model list rather
 * than failing the whole request: one broken gateway must not hide the rest.
 * @param llm - the `ctx.llm` service.
 * @returns provider groups in registration order, each sorted by model id.
 */
async function listProviderGroups(llm) {
    const providers = llm.listProviders().filter(provider => !NON_CHAT_PROVIDER.test(provider.id));
    const groups = await Promise.all(providers.map(async (provider) => {
        let models = [];
        try {
            models = await llm.listModels(provider.id);
        }
        catch {
            // An unreachable gateway yields an empty picker row, not a failed page.
            models = [];
        }
        const chat = models
            .filter(isChatModel)
            .map(model => ({ id: model.id, name: model.name === '' ? model.id : model.name }))
            .sort((left, right) => left.id.localeCompare(right.id));
        // De-duplicate by id: some adapters repeat a model across catalog pages.
        const unique = chat.filter((model, index) => chat.findIndex(candidate => candidate.id === model.id) === index);
        return { id: provider.id, name: provider.name === '' ? provider.id : provider.name, models: unique };
    }));
    return groups;
}
/** Narrow an unknown service handle to the directory surface, or undefined. */
function asLlmDirectory(value) {
    if (value === null || typeof value !== 'object')
        return undefined;
    const candidate = value;
    if (typeof candidate.listProviders !== 'function' || typeof candidate.listModels !== 'function')
        return undefined;
    return candidate;
}
/** Resolve the optional `ctx.llm` service from a context. */
function llmOf(ctx) {
    return asLlmDirectory(ctx.get('llm'));
}

// ---- src/protocol.ts ----
/**
 * Shared wire contract between the two halves of dsh-prompt-forge.
 *
 * The host half owns the LLM channel: the browser never sees an API key, a
 * base URL, or the provider SDK — it posts a draft to a loopback route and
 * reads a server-sent event stream back. Everything both halves must agree on
 * (route paths, request/response shapes, limits) lives here.
 */
/**
 * Settings namespace the host half registers, as declared in cordis.patch.yml.
 *
 * The managed-forms settings provider keys every namespace by Loader entry id,
 * and an **inserted** row's entry id is `include:<rowId>`. So this plugin's
 * live namespace is `include:prompt-forge`, not this bare value: the
 * constant names the row, and the browser half resolves the concrete string at
 * runtime (exact id → `:<rowId>` suffix → schema fingerprint). Keeping the row
 * id and this constant identical is what makes that resolution unambiguous.
 */
const PROMPT_FORGE_NAMESPACE = 'prompt-forge';
/**
 * Field names unique to this plugin's Config, used to recognize its settings
 * section if the entry id ever stops matching {@link PROMPT_FORGE_NAMESPACE}
 * (a renamed patch row, or a host that keys sections differently).
 */
const CONFIG_FINGERPRINT_FIELDS = ['mainSystemPrompt', 'activePresetId'];
/** Route family, all loopback-fenced same-origin POST/GET endpoints. */
const OPTIMIZER_API = {
    /** GET: the configured provider roster with each route's model catalog. */
    models: '/api/dsh-prompt-forge/models',
    /** POST: one optimization run, answered as an SSE stream. */
    optimize: '/api/dsh-prompt-forge/optimize',
};
/**
 * Default model route. `ofox` is the provider id the desktop profile declares;
 * the model is the flash tier, which is fast enough for interactive rewriting.
 */
const DEFAULT_PROVIDER = 'ofox';
const DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash';
/** Default sampling temperature: low, because rewriting must not invent intent. */
const DEFAULT_TEMPERATURE = 0.3;
/**
 * Draft length ceiling. The route refuses anything longer instead of silently
 * truncating: a user who pasted a whole file deserves a readable refusal.
 */
const MAX_DRAFT_CHARS = 20000;

// ---- src/index.ts ----
/** Stable Cordis plugin name. */
const name = 'prompt-forge';
/** The web carrier is the only hard service: without it there is no bridge. */
const inject = ['webServer'];
/** Upper bound on one request body; drafts are text and small. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
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
});
// The public schema type stays the plain Config shape; the loader resolves the
// top-level fields to volatile references.
const Config = configSchema;
/** Read a value that may be a volatile config reference. */
function unwrapVolatileValue(value) {
    if (typeof value === 'object' && value !== null && typeof value.get === 'function') {
        return value.get();
    }
    return value;
}
/** Detach a plain Config view from the loader's volatile fields. */
function unwrapConfig(value) {
    if (typeof value !== 'object' || value === null)
        return {};
    const out = {};
    for (const [key, field] of Object.entries(value))
        out[key] = unwrapVolatileValue(field);
    return out;
}
/** Human-readable text from an unknown thrown value. */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Loopback fence plus same-origin marker check, mirroring the shipped route
 * families: a remote browser must not be able to spend the user's model quota.
 * @param req - the incoming request.
 * @returns whether the request may proceed.
 */
function isLoopbackRequest(req) {
    const address = req.socket.remoteAddress;
    if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1')
        return false;
    const host = req.headers.host;
    if (typeof host !== 'string')
        return false;
    let hostUrl;
    try {
        hostUrl = new URL(`http://${host}`);
    }
    catch {
        return false;
    }
    if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]')
        return false;
    if (req.headers['sec-fetch-site'] === 'cross-site')
        return false;
    const origin = req.headers.origin;
    if (origin === undefined)
        return true;
    try {
        return new URL(origin).host === hostUrl.host;
    }
    catch {
        return false;
    }
}
/** One JSON answer, always `ok`-tagged so the client never parses HTTP codes. */
function writeJson(res, status, body) {
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'referrer-policy': 'no-referrer',
    });
    res.end(JSON.stringify(body));
}
/** Read a JSON request body; undefined when oversized or unparseable. */
async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const buffer = chunk;
        size += buffer.length;
        if (size > MAX_BODY_BYTES)
            return undefined;
        chunks.push(buffer);
    }
    if (chunks.length === 0)
        return undefined;
    try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
/** Open one server-sent-event response and return its frame writer. */
function openEventStream(req, res) {
    res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'referrer-policy': 'no-referrer',
    });
    // An immediate comment flushes the headers so the client's fetch resolves
    // before the first token arrives, which is what makes the dialog's pending
    // state honest rather than a spinner that waits on the model.
    res.write(': open\n\n');
    let closed = false;
    const close = () => { closed = true; };
    req.on('close', close);
    res.on('close', close);
    return (event) => {
        if (closed)
            return;
        try {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        catch {
            closed = true;
        }
    };
}
/** End an event stream, releasing the socket. */
function endEventStream(res) {
    if (!res.writableEnded)
        res.end();
}
/**
 * Mount the settings section and the route family.
 * @param ctx - host plugin context carrying webServer.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
function apply(ctx, config) {
    // The live config source. The loader hands over volatile references, so this
    // one binding keeps reading current values after any settings write.
    const resolve = () => {
        const value = unwrapConfig(config ?? {});
        const presets = Array.isArray(value.presets) && value.presets.length > 0
            ? value.presets.filter(preset => typeof preset?.id === 'string' && typeof preset?.system === 'string')
            : BUILTIN_PRESETS;
        return {
            enabled: value.enabled !== false,
            provider: typeof value.provider === 'string' && value.provider.trim() !== '' ? value.provider.trim() : DEFAULT_PROVIDER,
            model: typeof value.model === 'string' && value.model.trim() !== '' ? value.model.trim() : DEFAULT_MODEL,
            temperature: typeof value.temperature === 'number' && Number.isFinite(value.temperature) ? value.temperature : DEFAULT_TEMPERATURE,
            maxTokens: typeof value.maxTokens === 'number' && Number.isFinite(value.maxTokens) && value.maxTokens > 0 ? Math.floor(value.maxTokens) : 0,
            mainSystemPrompt: typeof value.mainSystemPrompt === 'string' ? value.mainSystemPrompt : DEFAULT_MAIN_PROMPT,
            presets,
            activePresetId: typeof value.activePresetId === 'string' ? value.activePresetId : '',
        };
    };
    // Treat this instance as a custom-page plugin: the official settings shell
    // must not also auto-generate a form page for the same Config.
    installSettingsSectionCompat(ctx, settingsNamespaceCompat(PROMPT_FORGE_NAMESPACE), Config, unwrapConfig(config ?? {}));
    ctx.inject(['webServer'], (sctx) => {
        sctx.effect(() => {
            const disposers = [
                // ------------------------------------------- provider/model directory
                sctx.webServer.register({
                    kind: 'exact',
                    path: OPTIMIZER_API.models,
                    handler: async (req, res) => {
                        if (!isLoopbackRequest(req)) {
                            writeJson(res, 403, { ok: false, code: 'forbidden', message: 'loopback-only' });
                            return;
                        }
                        if (req.method !== 'GET') {
                            writeJson(res, 405, { ok: false, code: 'method', message: `method not allowed: ${req.method}` });
                            return;
                        }
                        const llm = llmOf(sctx);
                        if (llm === undefined) {
                            writeJson(res, 200, { ok: false, code: 'llm-unavailable', message: 'Host LLM service is not mounted in this composition' });
                            return;
                        }
                        try {
                            writeJson(res, 200, { ok: true, providers: await listProviderGroups(llm) });
                        }
                        catch (error) {
                            writeJson(res, 200, { ok: false, code: 'catalog-failed', message: messageOf(error) });
                        }
                    },
                }),
                // ------------------------------------------------------- optimization
                sctx.webServer.register({
                    kind: 'exact',
                    path: OPTIMIZER_API.optimize,
                    handler: async (req, res) => {
                        if (!isLoopbackRequest(req)) {
                            writeJson(res, 403, { ok: false, code: 'forbidden', message: 'loopback-only' });
                            return;
                        }
                        if (req.method !== 'POST') {
                            writeJson(res, 405, { ok: false, code: 'method', message: `method not allowed: ${req.method}` });
                            return;
                        }
                        const body = await readJsonBody(req);
                        if (body === undefined) {
                            writeJson(res, 400, { ok: false, code: 'bad-request', message: 'unreadable JSON body' });
                            return;
                        }
                        const text = typeof body.text === 'string' ? body.text : '';
                        const trimmed = text.trim();
                        if (trimmed === '') {
                            writeJson(res, 400, { ok: false, code: 'empty-draft', message: 'The draft is empty' });
                            return;
                        }
                        if (text.length > MAX_DRAFT_CHARS) {
                            writeJson(res, 400, {
                                ok: false,
                                code: 'draft-too-long',
                                message: `Draft is ${text.length} characters; the limit is ${MAX_DRAFT_CHARS}. Shorten it or split the task.`,
                            });
                            return;
                        }
                        const settings = resolve();
                        const llm = llmOf(sctx);
                        if (llm === undefined) {
                            writeJson(res, 400, { ok: false, code: 'llm-unavailable', message: 'Host LLM service is not mounted in this composition' });
                            return;
                        }
                        const send = openEventStream(req, res);
                        if (send === undefined)
                            return;
                        // Cancellation: the client may abort mid-stream, and disposal must
                        // not leave the upstream generator running against a dead socket.
                        const controller = new AbortController();
                        req.on('close', () => { controller.abort(); });
                        const system = resolveSystemPrompt(typeof body.system === 'string' ? body.system : undefined, settings.mainSystemPrompt);
                        const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
                        const previous = typeof body.previous === 'string' ? body.previous : '';
                        const userContent = composeUserContent(trimmed, previous, instruction);
                        let assembled = '';
                        let aborted = false;
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
                                if (chunk.type === 'start')
                                    send(chunk);
                                else if (chunk.type === 'delta') {
                                    assembled += chunk.text;
                                    send(chunk);
                                }
                                else if (chunk.type === 'aborted') {
                                    aborted = true;
                                }
                                else if (chunk.type === 'error') {
                                    send(chunk);
                                    endEventStream(res);
                                    return;
                                }
                            }
                            // An abort is reported as aborted rather than as a clean finish:
                            // the dialog must not present truncated output as a complete run.
                            send({ type: 'done', text: assembled, ...aborted || controller.signal.aborted ? { aborted: true } : {} });
                        }
                        catch (error) {
                            send({ type: 'error', code: 'optimize-failed', message: messageOf(error) });
                        }
                        endEventStream(res);
                    },
                }),
            ];
            return () => { for (const dispose of disposers)
                dispose(); };
        }, 'dsh-prompt-forge: routes');
    });
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
function composeUserContent(draft, previous, instruction) {
    if (instruction === '' && previous === '')
        return draft;
    const sections = [`【原始草稿】\n${draft}`];
    if (previous !== '')
        sections.push(`【上一版改写结果】\n${previous}`);
    if (instruction !== '')
        sections.push(`【本次修改要求】\n${instruction}`);
    sections.push('请基于上述内容输出改写后的完整提示词。');
    return sections.join('\n\n');
}
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
export async function* llmStream(llm, request) {
    const streamer = llm;
    if (typeof streamer.stream !== 'function') {
        yield { type: 'error', code: 'llm-unsupported', message: 'The mounted LLM service does not expose stream()' };
        return;
    }
    yield { type: 'start', provider: request.provider, model: request.model };
    const iterator = streamer.stream({
        provider: request.provider,
        model: request.model,
        system: request.system,
        temperature: request.temperature,
        ...request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens },
        messages: [{ role: 'user', content: [{ type: 'text', text: request.content }] }],
        signal: request.signal,
    });
    for await (const chunk of iterator) {
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
            yield { type: 'delta', text: chunk.text };
            continue;
        }
        if (chunk.type === 'finish') {
            const kind = chunk.reason?.kind;
            if (kind === 'error') {
                yield {
                    type: 'error',
                    code: chunk.reason?.failure?.code ?? 'upstream-error',
                    message: chunk.reason?.failure?.message ?? 'The model call failed',
                };
                return;
            }
            if (kind === 'aborted') {
                // A distinct frame, not silence: the route has to tell the client that
                // what it received is incomplete.
                yield { type: 'aborted' };
                return;
            }
        }
    }
}


export { name, inject, Config, apply, composeUserContent, resolveSystemPrompt, isChatModel, listProviderGroups, resolveSettingsNamespaceCompat, installSettingsSectionCompat, settingsNamespaceCompat, entryNamespaceOf };
