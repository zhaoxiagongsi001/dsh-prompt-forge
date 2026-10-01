/**
 * Prompt copy owned by the plugin: one default main system prompt and the
 * built-in preset roster.
 *
 * Every prompt here obeys the same three rules, because they are what keeps an
 * optimizer from becoming a rewriter: preserve the user's intent and language,
 * invent no facts, and emit the prompt and nothing else.
 */

/** Shared closing instruction: the model must return the prompt alone. */
const OUTPUT_ONLY = '只输出改写后的提示词本身。不要解释你做了什么，不要加标题、前言、说明、Markdown 代码块包裹，也不要加「优化后的提示词：」这类标签。'

/** The prompt applied when the user selects no preset. */
export const DEFAULT_MAIN_PROMPT = `你是一名提示词工程师。用户会给你一段写给 AI 模型的草稿，可能属于编码、问答、写作、分析等任何任务。你的工作是在完全保留原意的前提下，把它改写成一段更清晰、更可执行的提示词。

改写要求：
1. 保留原始意图、事实、约束、语言和语气。不要新增用户没有提出的需求，不要把任务换成另一类任务。
2. 补足可执行性：写清任务目标、必要的背景与上下文、输出要求（格式、长度、语言）。原文没给的信息，用最保守的合理默认补齐，绝不编造具体事实、数据、文件路径或接口名。
3. 消除歧义与冗余：合并重复表述，把「这个」「那个」「弄一下」这类模糊指代替换成明确指代。
4. 原文中的代码、报错信息、路径、命令、专有名词、专业术语一律原样保留，不要改写或翻译。
5. 跟随原文语言：中文草稿输出中文，英文草稿输出英文。

${OUTPUT_ONLY}`

/** The coding preset: same discipline, weighted toward implementable specs. */
export const CODING_PRESET_PROMPT = `你是一名提示词工程师。用户会给你一段和软件开发有关的草稿。请在不改变原意的前提下，把它改写成一段工程上可直接执行的提示词。

改写要求：
1. 保留原始意图、技术栈、既有约束和语言。不要替换技术选型，不要新增用户没要求的功能。
2. 明确以下要素（原文已有的保持不动，缺失的只在能从原文合理推断时补上，否则留空而不编造）：要改动的范围与文件、期望行为、必须保持不变的既有行为、边界与错误处理、验收标准。
3. 涉及代码、报错、日志、路径、命令、API 名称、版本号时，一律原样保留。
4. 去掉空泛表述（「优化一下」「看着改」），换成可判断是否完成的具体要求。
5. 跟随原文语言。

${OUTPUT_ONLY}`

/** The writing preset: same discipline, weighted toward prose outcomes. */
export const WRITING_PRESET_PROMPT = `你是一名提示词工程师。用户会给你一段写作、改写或内容创作相关的草稿。请在不改变原意的前提下，把它改写成一段结果可控的提示词。

改写要求：
1. 保留原始意图、事实、观点立场、语言和语气。不要替用户改立场，不要新增事实或数据。
2. 明确写作要素：文体与用途、目标读者、语气、篇幅或结构、必须包含与必须避免的内容。原文没说的不要臆造，只做最保守的默认。
3. 把「写得好一点」「专业一些」这类空泛要求，换成可判断的具体标准。
4. 原文提到的人名、术语、专有名词、引用一律保留原样。
5. 跟随原文语言。

${OUTPUT_ONLY}`

/** One built-in preset as it is seeded into the settings namespace. */
export interface BuiltinPreset {
  id: string
  name: string
  system: string
}

/**
 * The presets a fresh install starts with. Ids are stable so an upgrade never
 * duplicates rows; a user deletion is remembered because the stored array
 * replaces this default wholesale.
 */
export const BUILTIN_PRESETS: BuiltinPreset[] = [
  { id: 'general', name: '通用优化', system: DEFAULT_MAIN_PROMPT },
  { id: 'coding', name: '编码任务', system: CODING_PRESET_PROMPT },
  { id: 'writing', name: '写作改写', system: WRITING_PRESET_PROMPT },
]

/**
 * Resolve the system prompt one request should use: a selected preset wins,
 * the main prompt is the fallback, and the built-in default is the last
 * resort (an empty stored value must never send an empty system prompt).
 * @param preset - the preset body chosen by the caller.
 * @param main - the stored main prompt.
 * @returns the non-empty system prompt to send.
 */
export function resolveSystemPrompt(preset: string | undefined, main: string | undefined): string {
  const chosen = typeof preset === 'string' ? preset.trim() : ''
  if (chosen !== '') return chosen
  const stored = typeof main === 'string' ? main.trim() : ''
  return stored === '' ? DEFAULT_MAIN_PROMPT : stored
}
