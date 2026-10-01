/**
 * Copy for the browser half.
 *
 * The dictionaries are registered with the DSH locale service when it is
 * mounted and fall back to the built-in Chinese strings otherwise, so the
 * plugin stays readable in a composition that ships no locale plugin, and
 * follows the interface language when one is present.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'

/** Locale namespace this plugin owns. */
export const NS = 'dsh-prompt-forge'

/** Chinese copy (also the built-in fallback). */
export const zh = {
  'button.label': '优化',
  'button.tooltip': '优化输入框里的提示词',
  'button.disabledEmpty': '输入框是空的，先写点内容',
  'button.disabledOff': '提示词优化插件已关闭（设置 → 提示词优化）',

  'dialog.title': '提示词优化',
  'dialog.original': '原文',
  'dialog.optimized': '优化版',
  'dialog.accept': '采纳',
  'dialog.acceptHint': 'Ctrl+Enter',
  'dialog.acceptBusy': '正在生成中，等输出结束再采纳',
  'dialog.acceptFailed': '没能写入输入框：该会话已不可写。内容仍在这里，请手动复制。',
  'dialog.copy': '复制',
  'dialog.copied': '已复制',
  'dialog.close': '关闭',
  'dialog.retry': '重新优化',
  'dialog.stop': '停止',
  'dialog.refinePlaceholder': '再说一句要求，例如：再短一点 / 补上输出格式 / 强调不要改动既有行为',
  'dialog.refine': '继续微调',
  'dialog.preset': '预设',
  'dialog.mainPreset': '主提示词',
  'dialog.thinking': '正在优化…',
  'dialog.empty': '（等待模型输出）',
  'dialog.edited': '已手动编辑',
  'dialog.model': '模型',
  'dialog.noModel': '未配置模型（设置 → 提示词优化）',
  'dialog.tooLong': '草稿过长，已超过上限',

  'settings.title': '提示词优化',
  'settings.description': '在输入框旁加一个按钮，用你配置的模型渠道把草稿改写成更清晰的提示词。只有点击「采纳」才会写回输入框。',
  'settings.enabled': '启用插件',
  'settings.enabledHint': '关闭后按钮不再出现，优化请求也会被拒绝',
  'settings.channel': '渠道',
  'settings.model': '模型',
  'settings.temperature': '温度',
  'settings.temperatureHint': '越低越稳，建议 0.3；调高会更发散',
  'settings.maxTokens': '输出上限 token',
  'settings.maxTokensHint': '0 表示用模型默认值',
  'settings.catalogLoad': '读取渠道与模型…',
  'settings.catalogFailed': '读取模型列表失败',
  'settings.catalogRetry': '重新读取',
  'settings.noProviders': '宿主没有报告任何可用渠道',
  'settings.noModels': '该渠道没有可选模型',
  'settings.scopeLoading': '正在读取设置…',
  'settings.scopeUnavailable': '设置不可用：当前页面连不上宿主设置文档，插件将使用默认值',
  'settings.mainPrompt': '主提示词',
  'settings.mainPromptHint': '没有选中预设时使用这一段',
  'settings.resetMain': '恢复默认',
  'settings.presets': '预设',
  'settings.presetsHint': '多套提示词，可在弹窗里切换',
  'settings.presetName': '名称',
  'settings.presetSystem': '系统提示词',
  'settings.addPreset': '新增预设',
  'settings.removePreset': '删除',
  'settings.activePreset': '默认使用的预设',
  'settings.noPreset': '（使用主提示词）',
  'settings.save': '保存',
  'settings.saved': '已保存',
  'settings.saveFailed': '保存失败',
  'settings.writable': '只读：当前设置文档不接受写入',
} as const

/** English copy. */
export const en: Record<keyof typeof zh, string> = {
  'button.label': 'Optimize',
  'button.tooltip': 'Rewrite the composer draft into a clearer prompt',
  'button.disabledEmpty': 'The composer is empty — write something first',
  'button.disabledOff': 'Prompt optimizer is disabled (Settings → Prompt Optimizer)',

  'dialog.title': 'Prompt optimizer',
  'dialog.original': 'Original',
  'dialog.optimized': 'Optimized',
  'dialog.accept': 'Accept',
  'dialog.acceptHint': 'Ctrl+Enter',
  'dialog.acceptBusy': 'Still generating — accept once the output finishes',
  'dialog.acceptFailed': 'Could not write to the composer: this session is no longer writable. The text is still here, copy it manually.',
  'dialog.copy': 'Copy',
  'dialog.copied': 'Copied',
  'dialog.close': 'Close',
  'dialog.retry': 'Run again',
  'dialog.stop': 'Stop',
  'dialog.refinePlaceholder': 'Add one more requirement, e.g. shorter / specify the output format',
  'dialog.refine': 'Refine',
  'dialog.preset': 'Preset',
  'dialog.mainPreset': 'Main prompt',
  'dialog.thinking': 'Optimizing…',
  'dialog.empty': '(waiting for the model)',
  'dialog.edited': 'manually edited',
  'dialog.model': 'Model',
  'dialog.noModel': 'No model configured (Settings → Prompt Optimizer)',
  'dialog.tooLong': 'The draft exceeds the length limit',

  'settings.title': 'Prompt optimizer',
  'settings.description': 'Adds a button beside the composer that rewrites your draft through a configured model channel. The draft is replaced only when you press Accept.',
  'settings.enabled': 'Enable plugin',
  'settings.enabledHint': 'When off, the button disappears and optimize requests are refused',
  'settings.channel': 'Channel',
  'settings.model': 'Model',
  'settings.temperature': 'Temperature',
  'settings.temperatureHint': 'Lower is steadier; 0.3 is recommended',
  'settings.maxTokens': 'Output token limit',
  'settings.maxTokensHint': '0 uses the model default',
  'settings.catalogLoad': 'Reading channels and models…',
  'settings.catalogFailed': 'Could not read the model list',
  'settings.catalogRetry': 'Retry',
  'settings.noProviders': 'The host reported no usable channel',
  'settings.noModels': 'This channel offers no selectable model',
  'settings.scopeLoading': 'Reading settings…',
  'settings.scopeUnavailable': 'Settings unavailable: this page cannot reach the host settings document, so defaults apply',
  'settings.mainPrompt': 'Main prompt',
  'settings.mainPromptHint': 'Used when no preset is selected',
  'settings.resetMain': 'Restore default',
  'settings.presets': 'Presets',
  'settings.presetsHint': 'Several prompts, switchable from the dialog',
  'settings.presetName': 'Name',
  'settings.presetSystem': 'System prompt',
  'settings.addPreset': 'Add preset',
  'settings.removePreset': 'Remove',
  'settings.activePreset': 'Preset used by default',
  'settings.noPreset': '(use the main prompt)',
  'settings.save': 'Save',
  'settings.saved': 'Saved',
  'settings.saveFailed': 'Save failed',
  'settings.writable': 'Read-only: the settings document refuses writes',
}

/** Dictionary keys this plugin owns. */
export type OptimizerKey = keyof typeof zh

/** The translate function shape both the locale seat and the fallback share. */
export type Translate = (key: OptimizerKey, params?: Record<string, unknown>) => string

/** Active dictionary, swapped by {@link applyHostLocale}. */
let active: Record<OptimizerKey, string> = zh

/** Interpolate `{name}` params into one string. */
function interpolate(text: string, params?: Record<string, unknown>): string {
  if (params === undefined) return text
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

/** Translate one key from the active dictionary. */
export function tt(key: OptimizerKey, params?: Record<string, unknown>): string {
  return interpolate(active[key] ?? zh[key] ?? key, params)
}

/** Switch the active dictionary; `zh` is the fallback for unknown languages. */
export function applyHostLocale(locale: string | undefined): void {
  active = locale !== undefined && locale.toLowerCase().startsWith('en') ? en : zh
}

/**
 * Register the dictionaries and follow the host language.
 *
 * Every step degrades silently: a composition without the locale plugin must
 * keep working, and a duplicate registration must not take the GUI down.
 * @param ctx - client root context.
 * @returns a disposer releasing the locale subscription.
 */
export function installLocale(ctx: ClientContext): () => void {
  const disposers: Array<() => void> = []
  const locale = ctx.get('locale') as {
    register?: (ns: string, localeOrDicts: string | Record<string, Record<string, string>>, dict?: Record<string, string>) => () => void
    getLocale?: () => { active?: string }
    subscribe?: (listener: () => void) => () => void
  } | undefined

  if (locale === undefined) {
    applyHostLocale(undefined)
    return () => {}
  }

  try {
    const dispose = locale.register?.(NS, { zh: { ...zh }, en: { ...en } })
    if (typeof dispose === 'function') disposers.push(dispose)
  } catch (error) {
    // A duplicate namespace registration is a composition fact, not a failure.
    console.warn('[dsh-prompt-forge] locale dictionary not registered:', error)
  }

  const sync = (): void => {
    try {
      applyHostLocale(locale.getLocale?.().active)
    } catch {
      applyHostLocale(undefined)
    }
  }
  sync()
  try {
    const dispose = locale.subscribe?.(sync)
    if (typeof dispose === 'function') disposers.push(dispose)
  } catch {
    // A locale service without subscribe is still usable for the initial read.
  }

  return () => { for (const dispose of disposers.splice(0)) dispose() }
}
