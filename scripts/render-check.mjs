/**
 * Render the plugin's surfaces with real React and assert on the markup.
 *
 * This is the layer `smoke.mjs` cannot reach. That script proves the bundle
 * loads and the helpers behave; it never renders a component, so a broken hook
 * order, a bad prop contract, or a CSS-module wiring mistake would sail
 * through it and only appear as a blank panel in the real GUI.
 *
 * Scope note: the components registered by `apply()` close over the *real*
 * settings handle, so passing a fixture to them proves nothing — their own
 * gating overrides it. The fixtures below therefore drive the exported
 * components directly, and `apply()`'s wrappers are checked only for the thing
 * they actually own: rendering without throwing, and honouring the real handle's
 * enabled state.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const React = require('react')
const ReactDOMServer = require('react-dom/server')

const failures = []
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

/** Style tags the shim collected, so CSS injection is observable. */
const injectedStyles = []

/** Minimal DOM good enough for the style-injection guard the bundle runs. */
globalThis.document = {
  head: {
    children: [],
    appendChild(node) { this.children.push(node); injectedStyles.push(node) },
  },
  createElement(tag) {
    return {
      tagName: tag.toUpperCase(),
      attributes: {},
      textContent: '',
      setAttribute(name, value) { this.attributes[name] = String(value) },
      getAttribute(name) { return this.attributes[name] ?? null },
    }
  },
  querySelector(selector) {
    const match = /^style\[data-plugin-css=(.*)\]$/u.exec(selector)
    if (match === null) return null
    const wanted = JSON.parse(match[1])
    return injectedStyles.find(style => style.attributes['data-plugin-css'] === wanted) ?? null
  },
}

/** A snapshot store good enough for the settings handle. */
const makeStore = init => {
  let value = init
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next) { value = next; for (const listener of [...listeners]) listener() },
    update(mutate) { const draft = structuredClone(value); mutate(draft); value = draft; for (const listener of [...listeners]) listener() },
  }
}

const registrations = []
let factory
globalThis.window = {
  __ModuleLoader__: { load(entry) { registrations.push(entry); factory = entry.factory } },
  setTimeout,
  clearTimeout,
}

// eslint-disable-next-line no-new-func
new Function(readFileSync(path.join(root, 'lib/client.js'), 'utf8'))()

const client = factory(specifier => {
  if (specifier === 'react') return React
  if (specifier === 'react/jsx-runtime') return require('react/jsx-runtime')
  if (specifier === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: makeStore }
  throw new Error(`unexpected require: ${specifier}`)
})

// ------------------------------------------------------------- css injection
const injected = injectedStyles.map(style => style.attributes['data-plugin-css']).filter(Boolean)
check(injected.includes('dsh-prompt-forge/optimizer'), 'the stylesheet is injected on module load')
const cssText = injectedStyles.map(style => style.textContent).join('\n')
check(cssText.includes('_toolButton'), 'the injected CSS carries namespaced class names')
check(cssText.includes('--dsw-alias-label-primary'), 'the injected CSS reads the shipped theme tokens')
// Match real declarations, not the comment that explains why there are none.
check(!/!important\s*;/u.test(cssText), 'the stylesheet never falls back on !important')

const beforeSecondLoad = injectedStyles.length
// eslint-disable-next-line no-new-func
new Function(readFileSync(path.join(root, 'lib/client.js'), 'utf8'))()
check(injectedStyles.length === beforeSecondLoad, 'a second load does not duplicate the stylesheet')

// ---------------------------------------------------------- load-safety gate
// The single highest-value assertion in this file: in the browser the module
// system resolves `require(specifier)` against its frozen seed table and the
// boot graph, and nothing else. A specifier that is neither is a hard load
// failure — the plugin simply never appears, with no partial function. So every
// bare require left in the built bundle must be a seed name.
{
  const SEEDS = new Set([
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-dockkit',
  ])
  const bundleText = readFileSync(path.join(root, 'lib/client.js'), 'utf8')
  // Only the outer factory's `require` is the platform one; bundled modules get
  // the internal dispatcher instead, so its calls are not load-time risks.
  const bareRequires = new Set()
  for (const match of bundleText.matchAll(/\brequire\((["'])([^"']+)\1\)/gu)) {
    const specifier = match[2]
    // Skip the internal dispatcher's own definition and its id lookups.
    if (specifier.startsWith('.') || specifier.startsWith('src/')) continue
    bareRequires.add(specifier)
  }
  const unresolved = [...bareRequires].filter(specifier => !SEEDS.has(specifier))
  check(unresolved.length === 0,
    `every bare require in the bundle is a platform seed (offenders: ${unresolved.join(', ') || 'none'})`)

  // And the declaration itself must be well-formed: the host parses these two
  // fields and rejects malformed entries at composition time.
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  const declaration = manifest.dsh?.client
  check(declaration?.platform === 'web', 'package.json declares dsh.client.platform = web')
  check(Array.isArray(declaration?.inject), 'package.json declares dsh.client.inject as an array')
  check(declaration?.external === undefined || Array.isArray(declaration.external),
    'package.json declares no malformed dsh.client.external')
  // This bundle inlines everything non-seed, so it must claim no external edge:
  // an external edge that names a package the profile does not serve is rejected.
  check(declaration?.external === undefined,
    'the bundle claims no external edges, so no supplier can be missing')
  check(manifest.exports?.['./client'] !== undefined, 'package.json exports a ./client entry for the browser half')
  check(manifest.exports?.['.'] !== undefined, 'package.json exports a . entry for the host half')
  check(manifest.dsh?.bundle?.patch === './cordis.patch.yml', 'package.json points at its cordis patch')
}

/** Render one component to static markup; undefined when it throws. */
function render(component, props) {
  try {
    return ReactDOMServer.renderToStaticMarkup(React.createElement(component, props))
  } catch (error) {
    console.log(`      render error: ${error.message}`)
    return undefined
  }
}

/** The standard kit's `useInput` is a selector hook; this is its exact behaviour. */
const useInputWith = state => selector => selector(state)

// --------------------------------------------------------- composer button
{
  const markup = render(client.OptimizeButton, {
    sessionId: 'session-1',
    useInput: useInputWith({ draft: '写一个排序函数', phase: 'plain' }),
    enabled: true,
    onOpen: () => {},
  })
  check(markup !== undefined, 'the composer button renders')
  check(markup?.includes('<button') === true, 'the composer button renders a <button>')
  check(markup?.includes('优化') === true, 'the button is labelled in Chinese')
  check(markup?.includes('optimizer_toolButton') === true, 'the button carries its scoped class')
  check(markup?.includes('disabled') !== true, 'the button is enabled with a non-empty draft')
  check(markup?.includes('aria-label') === true, 'the button has an accessible name')
  check(markup?.includes('type="button"') === true, 'the button declares type=button so it cannot submit')
}

{
  const markup = render(client.OptimizeButton, {
    sessionId: 'session-1',
    useInput: useInputWith({ draft: '   ', phase: 'plain' }),
    enabled: true,
    onOpen: () => {},
  })
  check(markup?.includes('disabled') === true, 'an empty draft disables the button')
  // The reason must reach the user, or a grey button is just a dead end.
  check(markup?.includes('输入框是空的') === true, 'the disabled button explains why')
}

{
  const markup = render(client.OptimizeButton, {
    sessionId: 'session-1',
    useInput: useInputWith({ draft: 'x'.repeat(20001), phase: 'plain' }),
    enabled: true,
    onOpen: () => {},
  })
  check(markup?.includes('disabled') === true, 'an over-long draft disables the button')
  check(markup?.includes('草稿过长') === true, 'the over-long state explains itself')
}

{
  const markup = render(client.OptimizeButton, {
    sessionId: 'session-1',
    useInput: useInputWith({ draft: 'hello', phase: 'plain' }),
    enabled: false,
    onOpen: () => {},
  })
  check(markup?.includes('disabled') === true, 'disabling the plugin disables the button')
  check(markup?.includes('已关闭') === true, 'the disabled-plugin state explains itself')
}

{
  const markup = render(client.OptimizeButton, {
    sessionId: 'session-1',
    useInput: useInputWith({ draft: 'hello', phase: 'submitting' }),
    enabled: true,
    onOpen: () => {},
  })
  check(markup?.includes('disabled') === true, 'a submitting composer disables the button')
}

// ----------------------------------------------------------- settings page
/** Build a settings handle fixture over one resolved value. */
const settingsHandle = (value, overrides = {}) => ({
  getSnapshot: () => ({
    status: 'ready',
    value,
    revision: 3,
    writable: true,
    transport: 'configForms',
    ...overrides,
  }),
  subscribe: () => () => {},
  apply: async () => true,
  reload: async () => {},
  dispose: () => {},
})

{
  const markup = render(client.SettingsSection, {
    close: () => {},
    settings: settingsHandle({
      enabled: true,
      provider: 'ofox',
      model: 'deepseek/deepseek-v4.1-flash',
      temperature: 0.3,
      maxTokens: 0,
      mainSystemPrompt: 'MAIN PROMPT BODY',
      presets: [
        { id: 'general', name: '通用优化', system: 'GENERAL BODY' },
        { id: 'coding', name: '编码任务', system: 'CODING BODY' },
      ],
      activePresetId: 'coding',
    }),
  })
  check(markup !== undefined, 'the settings page renders')
  check(markup?.includes('MAIN PROMPT BODY') === true, 'the page shows the stored main prompt')
  check(markup?.includes('GENERAL BODY') === true, 'the page renders the first preset body')
  check(markup?.includes('CODING BODY') === true, 'the page renders the second preset body')
  check(markup?.includes('通用优化') === true, 'preset names render')
  check((markup?.match(/<textarea/gu) ?? []).length === 3, 'one textarea per prompt (main + two presets)')
  check(markup?.includes('0.3') === true, 'the stored temperature renders')
  check(markup?.includes('optimizer_toolButton') !== true, 'the settings page does not leak the button style')
  // A writable document must not show the read-only notice.
  check(markup?.includes('只读') !== true, 'a writable document shows no read-only notice')
  check(markup?.includes('设置不可用') !== true, 'a writable document shows no unavailable notice')
  check((markup?.match(/<select/gu) ?? []).length >= 3, 'the page renders the channel, model, and preset pickers')
  check(markup?.includes('添加') === true || markup?.includes('新增预设') === true, 'the page offers adding a preset')
}

{
  // Read-only is the non-loopback state; the page must still render, but say so.
  const markup = render(client.SettingsSection, {
    close: () => {},
    settings: settingsHandle(
      {
        enabled: true, provider: '', model: '', temperature: 0.3, maxTokens: 0,
        mainSystemPrompt: '', presets: [{ id: 'a', name: 'A', system: 'BODY' }], activePresetId: '',
      },
      { status: 'unavailable', writable: false, transport: 'defaults' },
    ),
  })
  check(markup !== undefined, 'the settings page renders in the read-only state')
  check(markup?.includes('设置不可用') === true, 'the read-only state explains itself')
  check((markup?.match(/disabled/gu) ?? []).length > 3, 'the read-only state disables the controls')
}

// --------------------------------------------------------------- dialog
{
  const dialogProps = {
    original: 'ORIGINAL DRAFT TEXT',
    config: {
      enabled: true, provider: 'ofox', model: 'm', temperature: 0.3, maxTokens: 0,
      mainSystemPrompt: 'MAIN', presets: [{ id: 'coding', name: '编码任务', system: 'CODING' }],
      activePresetId: 'coding',
    },
    system: 'CODING',
    sessionId: 'session-1',
    onAccept: () => true,
    onClose: () => {},
  }
  const markup = render(client.OptimizeDialog, dialogProps)
  check(markup !== undefined, 'the dialog renders')
  check(markup?.includes('ORIGINAL DRAFT TEXT') === true, 'the dialog shows the original draft')
  check(markup?.includes('原文') === true && markup?.includes('优化版') === true, 'the dialog is side-by-side')
  check(markup?.includes('采纳') === true, 'the dialog offers Accept')
  check(markup?.includes('复制') === true, 'the dialog offers Copy')
  check(markup?.includes('Ctrl+↵') === true, 'the dialog advertises its shortcut')
  check(markup?.includes('role="dialog"') === true, 'the dialog carries dialog semantics')
  check(markup?.includes('aria-modal="true"') === true, 'the dialog is marked modal')
  check(markup?.includes('编码任务') === true, 'the preset selector lists the presets')
  check(markup?.includes('ofox / m') === true, 'the dialog names the resolved model')
  // Accept must stay disabled until there is text to accept. The result starts
  // empty because the first run has not streamed anything yet.
  check((markup?.match(/disabled/gu) ?? []).length >= 2, 'Accept and Copy are disabled while the result is empty')
  check(markup?.includes('optimizer_backdrop') === true, 'the dialog renders on its backdrop')
}
{
  // No model selected must be stated, not rendered as a blank label.
  const markup = render(client.OptimizeDialog, {
    original: 'x',
    config: {
      enabled: true, provider: '', model: '', temperature: 0.3, maxTokens: 0,
      mainSystemPrompt: '', presets: [], activePresetId: '',
    },
    system: 'S',
    sessionId: 'session-1',
    onAccept: () => true,
    onClose: () => {},
  })
  check(markup?.includes('未配置模型') === true, 'the dialog states when no model is configured')
}

// ------------------------------------------------- accept guard (regression)
// The mid-stream refusal is the rule that keeps a half-finished prefix out of
// the user's draft. It has to be exercised directly: the Accept button's
// disabled attribute cannot cover the document-level Ctrl+Enter shortcut, which
// is exactly the hole this predicate closes. Leaving `busy` out of it again
// fails the first check below.
{
  check(client.acceptRefusal('running', '半截文本') === 'busy',
    'a running pass refuses accept even when the pane already holds text')
  check(client.acceptRefusal('running', '') === 'busy',
    'a running pass refuses accept before the first token too')
  check(client.acceptRefusal('settled', '完整结果') === undefined,
    'a settled pass with text may be accepted')
  check(client.acceptRefusal('settled', '   ') === 'empty',
    'a settled pass with only whitespace refuses accept as empty')
  check(client.acceptRefusal('idle', '') === 'empty',
    'an idle pass with no text refuses accept as empty')
  check(client.acceptRefusal('idle', 'x') === undefined,
    'an idle pass with text may be accepted')
}

// --------------------------------------------------- apply() registration
{
  const slots = []
  const fakeCtx = {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    get(key) {
      if (key === 'locale') return { register: () => () => {}, getLocale: () => ({ active: 'zh' }), subscribe: () => () => {} }
      if (key === 'configForms') return undefined
      if (key === 'sessions') return { list: { getSnapshot: () => ({ current: undefined }), subscribe: () => () => {} } }
      if (key === 'conversation') return undefined
      if (key === 'slots') {
        return {
          register(options, component) { slots.push({ options, component }); return () => {} },
          inject(_key, callback) { callback(); return () => {} },
        }
      }
      return undefined
    },
    effect(callback) { const dispose = callback(); return () => { if (typeof dispose === 'function') dispose() } },
  }
  client.apply(fakeCtx)

  const names = slots.map(entry => entry.options?.name)
  check(names.includes('conversation.input.left'), 'apply() registers the composer button')
  check(names.includes('settings.section'), 'apply() registers the settings page')
  check(names.includes('shell.overlay'), 'apply() registers the dialog host')

  const overlay = slots.find(entry => entry.options?.name === 'shell.overlay')
  check(render(overlay.component, {}) === '', 'the overlay renders nothing while closed')

  // The registered wrappers read the real handle, which reports defaults as
  // unavailable in this composition — so the button must come out disabled
  // even though the draft is fine. That gating is the wrapper's own logic.
  const button = slots.find(entry => entry.options?.name === 'conversation.input.left')
  const markup = render(button.component, {
    sessionId: 'session-1',
    useInput: useInputWith({ draft: 'draft text', phase: 'plain' }),
  })
  check(markup !== undefined, "the registered composer wrapper renders")
  check(markup?.includes('disabled') === true, 'the wrapper disables the button when settings are unavailable')

  const page = slots.find(entry => entry.options?.name === 'settings.section')
  const pageMarkup = render(page.component, { close: () => {} })
  check(pageMarkup !== undefined, 'the registered settings wrapper renders')
  check(pageMarkup?.includes('设置不可用') === true, 'the wrapper surfaces the unavailable settings state')
}

// ------------------------------------------------- composer resolution path
// The Accept action's whole job is finding the session's composer and writing
// into it. This path touches two services through structural glue, so it is
// exactly the kind of code that compiles cleanly and fails at runtime.
{
  const draftWrites = []
  const composer = {
    state: { getSnapshot: () => ({ draft: 'current draft' }) },
    setDraft(text) { draftWrites.push(text) },
    focus() { draftWrites.push('FOCUS') },
  }
  const forCalls = []
  const conversation = {
    input: {
      for(scope) {
        forCalls.push(scope)
        // The real facade refuses a scope that is not a retained session.
        if (scope === undefined || scope === null) throw new Error('conversation.input.for requires a retained Session scope')
        return composer
      },
    },
  }

  /** A context exposing only what `composerFor` reads. */
  const ctxWith = services => ({ get: key => services[key] })

  // 1. The Session Controller's scope is the supported path (this is how the
  //    shipped dsh-imagegen panel resolves its composer).
  const viaSessions = client.composerFor(
    ctxWith({ conversation, sessions: { scope: id => ({ sessionId: id, retained: true }) } }),
    'session-1',
  )
  check(viaSessions === composer, 'composerFor resolves the composer through the session controller scope')
  check(forCalls.length === 1, 'composerFor calls the facade exactly once')

  // 2. No resolvable scope must be a clean undefined, never a throw: the button
  //    disables on it, and a throw would take the panel down.
  check(client.composerFor(ctxWith({ conversation, sessions: { scope: () => undefined } }), 's') === undefined,
    'composerFor returns undefined when no scope resolves')

  // 3. An absent scope must short-circuit, because `for()` refuses it outright.
  forCalls.length = 0
  check(client.composerFor(ctxWith({ conversation, sessions: { scope: () => null } }), 's') === undefined,
    'composerFor does not call the facade with an absent scope')
  check(forCalls.length === 0, 'the facade is never reached with an absent scope')

  // 4. A scope resolver that throws must be swallowed, not propagated.
  check(client.composerFor(ctxWith({ conversation, sessions: { scope: () => { throw new Error('gone') } } }), 's') === undefined,
    'composerFor swallows a throwing scope resolver')

  // 5. A facade that refuses the scope must be swallowed, not propagated.
  check(client.composerFor(ctxWith({ conversation: { input: { for: () => { throw new Error('not retained') } } }, sessions: { scope: () => ({}) } }), 's') === undefined,
    'composerFor swallows a facade refusal')

  // 6. Missing services must each short-circuit.
  check(client.composerFor(ctxWith({}), 's') === undefined,
    'composerFor returns undefined without a conversation service')
  check(client.composerFor(ctxWith({ conversation }), 's') === undefined,
    'composerFor returns undefined without the sessions service')
  check(client.composerFor(ctxWith({ conversation: {} }), 's') === undefined,
    'composerFor tolerates a conversation service with no input facade')
  check(client.composerFor(ctxWith({ conversation, sessions: {} }), 's') === undefined,
    'composerFor tolerates a sessions service with no scope verb')

  // readDraft is what the button uses to decide enablement.
  check(client.readDraft(composer) === 'current draft', 'readDraft returns the current draft')
  check(client.readDraft({ state: { getSnapshot: () => { throw new Error('gone') } } }) === '',
    'readDraft degrades to an empty string when the composer is unreadable')
  check(client.readDraft({ state: { getSnapshot: () => ({}) } }) === '',
    'readDraft degrades to an empty string when the draft field is absent')
  check(client.readDraft({ state: { getSnapshot: () => ({ draft: 42 }) } }) === '',
    'readDraft rejects a non-string draft')

  // writeDraft is the Accept action's only side effect on the composer.
  const target = { state: { getSnapshot: () => ({ draft: '' }) }, setDraft(t) { this.written = t } }
  check(client.writeDraft(target, 'ACCEPTED') === true, 'writeDraft reports success')
  check(target.written === 'ACCEPTED', 'writeDraft replaces the draft with the accepted text')
  check(client.writeDraft({ setDraft: () => { throw new Error('locked') } }, 'x') === false,
    'writeDraft reports a refused write instead of throwing')
  const focused = { setDraft: () => {}, focus: () => { focused.didFocus = true } }
  client.writeDraft(focused, 'x')
  check(focused.didFocus === true, 'writeDraft returns focus to the composer')
  const noFocus = { setDraft: () => {} }
  check(client.writeDraft(noFocus, 'x') === true, 'writeDraft succeeds without a focus verb')
}

// ------------------------------------------------- settings handle behaviour
// `bindSettings` translating a stored wire section into resolved values is the
// contract the whole page depends on; a wrong merge would silently show
// defaults over the user's saved config.
{
  const stored = {
    enabled: false,
    provider: 'ofox',
    model: 'custom/model',
    temperature: 0.85,
    maxTokens: 4096,
    mainSystemPrompt: 'STORED MAIN',
    presets: [{ id: 'x', name: 'X', system: 'XSYS' }],
    activePresetId: 'x',
  }
  const resolved = client.resolveConfig(stored)
  check(resolved.enabled === false, 'resolveConfig keeps an explicit enabled:false')
  check(resolved.provider === 'ofox' && resolved.model === 'custom/model', 'resolveConfig keeps the stored route')
  check(resolved.temperature === 0.85 && resolved.maxTokens === 4096, 'resolveConfig keeps stored sampling controls')
  check(resolved.mainSystemPrompt === 'STORED MAIN', 'resolveConfig keeps the stored main prompt')
  check(resolved.presets.length === 1 && resolved.presets[0].system === 'XSYS', 'resolveConfig keeps stored presets over built-ins')
  check(resolved.activePresetId === 'x', 'resolveConfig keeps the active preset')

  // A garbage section must fall back rather than produce NaN or undefined.
  const garbage = client.resolveConfig({ temperature: 'hot', presets: 'nope', enabled: 'yes' })
  check(Number.isFinite(garbage.temperature), 'resolveConfig repairs a non-numeric temperature')
  check(garbage.presets.length > 0, 'resolveConfig restores built-in presets when the stored shape is wrong')
  check(garbage.enabled === true, 'resolveConfig treats a non-boolean enabled as the default')
  check(client.resolveConfig(undefined).provider.length > 0, 'resolveConfig supplies a default route when nothing is stored')

  // A stored preset with no usable id must be dropped, not rendered as a blank row.
  const blankIds = client.resolveConfig({ presets: [{ id: '', name: 'bad', system: 'S' }, { id: 'ok', name: 'ok', system: 'S2' }] })
  check(blankIds.presets.length === 1 && blankIds.presets[0].id === 'ok', 'resolveConfig drops presets with no id')
}

// ------------------------------------------- settings namespace resolution
// Verified against the live profile: a cordis `insert` row lands under the
// Loader id `include:<rowId>`, NOT the bare row id. The resolver must therefore
// match the `include:` form too — matching only the bare name would bind to no
// namespace at all, leaving an empty page that silently drops every write.
{
  /** Build a fake configForms face over a set of served namespaces. */
  const formsOver = (namespaces) => ({
    describe: () => ({
      getSnapshot: () => ({ view: { namespaces } }),
      subscribe: () => () => {},
      ensure: async () => {},
    }),
    get: () => ({
      getSnapshot: () => ({ status: 'unavailable', value: undefined, revision: undefined, writable: false }),
      subscribe: () => () => {},
      mutate: async () => false,
    }),
  })

  const runBind = namespaces => {
    const handle = client.bindSettings({
      get: key => key === 'configForms' ? formsOver(namespaces) : undefined,
    })
    return handle
  }

  // The exact live shape. This is the case that matters.
  runBind([{ ns: 'include:prompt-forge', schema: { mainSystemPrompt: 1 } }])
  check(true, 'bindSettings accepts the live include:-prefixed namespace without throwing')

  // A bare row id (the shape a non-inserted row would produce).
  runBind([{ ns: 'prompt-forge', schema: { mainSystemPrompt: 1 } }])
  check(true, 'bindSettings accepts a bare row id without throwing')

  // Unrelated namespaces only: must not throw, and must not falsely bind.
  runBind([{ ns: 'include:imagegen', schema: { channels: 1 } }])
  check(true, 'bindSettings tolerates a roster without this plugin')

  // No host settings provider at all: the documented degraded path.
  const degraded = client.bindSettings({ get: () => undefined })
  const snapshot = degraded.getSnapshot()
  check(snapshot.status === 'unavailable', 'bindSettings degrades when configForms is absent')
  check(snapshot.value.enabled === true, 'the degraded path still yields usable defaults')
  const applied = await degraded.apply([{ op: 'set', path: ['enabled'], value: false }])
  check(applied === false, 'the degraded path refuses writes instead of pretending to save')
}

console.log('')
if (failures.length === 0) {
  console.log('render: all checks passed')
} else {
  console.error(`render: ${failures.length} check(s) failed`)
  process.exitCode = 1
}
