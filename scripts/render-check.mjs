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
 *
 * v2 note — the modal is gone. `OptimizeDialog` and its `shell.overlay` host
 * were retired in favour of `InlinePanel` inside `conversation.input.overlay`.
 * Every assertion that could only describe the modal (side-by-side panes,
 * `role="dialog"`, `aria-modal`, the `Ctrl+↵` advertisement, the backdrop, the
 * overlay-closed render) was deleted rather than re-pointed, because those
 * properties are the ones the redesign deliberately removed. The replacement
 * assertions below encode INTERFACE-v2.md §2 contracts 1–8.
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

// The clipboard is a browser capability; the panel's Copy path only needs a
// promise-returning verb so it can be driven without a permissions dialog.
// Node 24 ships a real read-only `navigator`, so it is redefined rather than
// assigned.
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  writable: true,
  value: { clipboard: { writeText: async () => {} } },
})

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
// v2 adds a second stylesheet for the inline panel; it must be injected too, or
// the panel renders as unstyled text on top of the composer.
check(injected.includes('dsh-prompt-forge/inline'), 'the inline panel stylesheet is injected on module load')
const allCss = injectedStyles.map(style => style.textContent).join('\n')
check(allCss.includes('inline_panel'), 'the inline stylesheet carries its own namespaced class names')
// The panel is a viewport-centred floating layer, not a child hung off the
// composer's top edge. A long draft scrolls that edge above the viewport, so
// anchoring there would hide the panel; `fixed` + `inset: 0` + `margin: auto`
// centres it on every scroll position while still keeping it out of layout.
check(
  /\.inline_panel\s*\{[^}]*position:\s*fixed/u.test(allCss)
    && /\.inline_panel\s*\{[^}]*inset:\s*0/u.test(allCss)
    && /\.inline_panel\s*\{[^}]*margin:\s*auto/u.test(allCss)
    && !/bottom:\s*calc\(100%\s*\+\s*8px\)/u.test(allCss),
  'the panel is fixed and centred in the viewport instead of hanging off the composer',
)
check(/\.inline_panel\s*\{[^}]*height:\s*min\(42vh,\s*360px\)/u.test(allCss), 'the panel uses the frozen min(42vh, 360px) height')

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

  // The v1 mount point must be gone from the shipped bundle, not merely unused:
  // a leftover `shell.overlay` registration would paint the retired modal again.
  check(!bundleText.includes('shell.overlay'), 'the bundle no longer references the retired shell.overlay slot')
  check(!bundleText.includes('OptimizeDialog'), 'the bundle no longer ships the retired modal component')
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

// ------------------------------------------------- accept guard (pure rule)
// The mid-stream refusal is the rule that keeps a half-finished prefix out of
// the user's draft. In v2 it lives in its own module (`accept-guard.ts`) and is
// shared by the Accept button's disabled state and the accept handler, so the
// two can never disagree. Leaving `busy` out of it again fails these checks —
// and the interactive contract-2/7 checks further below fail with it.
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

// ------------------------------------------------ write-back risk (M4 pure fn)
// `writeNeedsConfirm` decides whether Accept has to ask first, because a
// whole-draft `setDraft` flattens `@` reference chips into plain text and
// orphans attachments. It must count *either* signal, and it must not be
// fooled into confirming for a non-finite count.
{
  check(client.writeNeedsConfirm(0, 0) === false, 'writeNeedsConfirm allows a draft with no references or attachments')
  check(client.writeNeedsConfirm(1, 0) === true, 'writeNeedsConfirm asks first when a reference is present')
  check(client.writeNeedsConfirm(0, 2) === true, 'writeNeedsConfirm asks first when attachments are present')
  check(client.writeNeedsConfirm(-1, NaN) === false, 'writeNeedsConfirm treats non-positive and non-finite counts as none')
  check(client.writeNeedsConfirm(3, 1) === true, 'writeNeedsConfirm asks first when both signals are present')
  check(client.writeNeedsConfirm(Infinity, 0) === false, 'writeNeedsConfirm treats a non-finite reference count as none')
  check(client.writeNeedsConfirm(0.4, 0) === true, 'writeNeedsConfirm still asks first for a fractional positive count')
}

// ------------------------------------------------ inline panel: source shape
// Contract 5 is a *negative* property (no global keyboard shortcuts at all) —
// the kind of thing that is easy to state and impossible to notice regressing,
// so it is asserted against the component source as well as its markup.
//
// Note on `Ctrl`: the panel legitimately *mentions* Ctrl twice — once in the
// comment that explains why v1's Ctrl+Enter binding had to go, and once as
// `!event.ctrlKey` guarding its own refine input's Enter key (that input's own
// submit key, explicitly allowed by the interaction spec). What must never come
// back is an *active* binding or an advertised hint, so the assertions below
// target the binding surfaces and the rendered text rather than the substring.
{
  const raw = readFileSync(path.join(root, 'src/client/InlinePanel.tsx'), 'utf8')
  // Comments explain *why* the Ctrl+Enter binding was removed; they are not the
  // implementation. Strip them so the checks below describe live code only.
  const source = raw.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
  check(!source.includes('document.addEventListener'), 'the panel binds no document-level listener')
  check(!source.includes('window.addEventListener'), 'the panel binds no window-level listener')
  check(!/addEventListener\(\s*['"]key/u.test(source), 'the panel binds no keydown/keyup handler at all')
  check(!/<kbd/u.test(source), 'the panel renders no <kbd> element')
  // A shortcut hint is an *advertised* key chord. `Ctrl+Enter` / `⌘` are exactly
  // the strings v1 printed next to Accept.
  check(!/Ctrl\+|Cmd\+|⌘/u.test(source), 'the panel advertises no key chord')
  // The refine input's Enter must explicitly refuse the modifiers, so it can
  // never become a second Ctrl+Enter accept path.
  check(/!event\.ctrlKey/u.test(source) && /!event\.metaKey/u.test(source),
    'the refine input\'s Enter key explicitly refuses Ctrl/Meta')
  // The retired modal must not creep back in as the implementation source.
  check(!source.includes('OptimizeDialog'), 'the panel does not import the retired modal')
  check(source.includes("from './accept-guard.ts'"), 'the panel takes the accept gate from its shared module')
}

// ------------------------------------ inline panel: interactive hook runtime
/**
 * A minimal but *real* React hook runtime.
 *
 * Contracts 1, 3, 4, 6 and 7 are behavioural: they are about what happens on
 * mount, when a button is clicked, and when a write is refused. Static markup
 * cannot express any of them — `renderToStaticMarkup` never runs an effect and
 * never invokes a handler — so asserting them against a static string would be
 * an assertion that can never catch the regression it claims to guard. This
 * runtime renders function components recursively, runs effects with real
 * dependency comparison, supports state updates, and sweeps unmounted
 * instances so their cleanup (the abort) actually fires.
 */
const panels = (() => {
  const dispatcherRef = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
  const sameDeps = (a, b) => a !== undefined && b !== undefined && a.length === b.length
    && a.every((value, index) => Object.is(value, b[index]))

  /** @returns a renderer whose `render` commits synchronously. */
  function createRenderer() {
    const instances = new Map()
    let dirty = false
    let visited = new Set()

    const dispatcherFor = instance => ({
      useState(init) {
        const index = instance.cursor++
        if (!(index in instance.hooks)) instance.hooks[index] = { value: typeof init === 'function' ? init() : init }
        const slot = instance.hooks[index]
        return [slot.value, next => {
          const value = typeof next === 'function' ? next(slot.value) : next
          if (!Object.is(value, slot.value)) { slot.value = value; dirty = true }
        }]
      },
      useRef(init) {
        const index = instance.cursor++
        if (!(index in instance.hooks)) instance.hooks[index] = { current: init }
        return instance.hooks[index]
      },
      useMemo(fn, deps) {
        const index = instance.cursor++
        const slot = instance.hooks[index]
        if (slot === undefined || !sameDeps(slot.deps, deps)) instance.hooks[index] = { deps, value: fn() }
        return instance.hooks[index].value
      },
      useCallback(fn, deps) {
        const index = instance.cursor++
        const slot = instance.hooks[index]
        if (slot === undefined || !sameDeps(slot.deps, deps)) instance.hooks[index] = { deps, value: fn }
        return instance.hooks[index].value
      },
      useEffect(create, deps) {
        const index = instance.cursor++
        instance.pending.push({ index, create, deps })
      },
      useLayoutEffect(create, deps) {
        const index = instance.cursor++
        instance.pending.push({ index, create, deps })
      },
    })

    const renderNode = (node, key) => {
      if (node === null || node === undefined || typeof node === 'boolean') return null
      if (typeof node === 'string' || typeof node === 'number') return node
      if (Array.isArray(node)) return node.map((child, index) => renderNode(child, `${key}.${index}`))
      if (node.type === React.Fragment) return renderNode(node.props?.children, key)
      if (typeof node.type === 'string') {
        return { ...node, props: { ...node.props, children: renderNode(node.props?.children, `${key}>${node.type}`) } }
      }
      if (typeof node.type === 'function' && node.type !== React.Fragment) {
        // An explicit `key` makes two occurrences of the same component two
        // distinct instances, which is what the framework does per session.
        const instanceKey = `${key}>${node.type.name || 'anon'}#${node.key ?? ''}`
        let instance = instances.get(instanceKey)
        if (instance === undefined) {
          instance = { hooks: [], cleanups: new Map(), pending: [], cursor: 0 }
          instances.set(instanceKey, instance)
        }
        visited.add(instanceKey)
        instance.cursor = 0
        instance.pending = []
        dispatcherRef.current = dispatcherFor(instance)
        let output
        try { output = node.type(node.props ?? {}) } finally { dispatcherRef.current = null }
        for (const effect of instance.pending) {
          const prev = instance.cleanups.get(effect.index)
          if (prev !== undefined && sameDeps(prev.deps, effect.deps)) continue
          if (prev !== undefined) { prev.cleanup?.(); instance.cleanups.delete(effect.index) }
          const cleanup = effect.create()
          instance.cleanups.set(effect.index, { deps: effect.deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined })
        }
        return renderNode(output, `${instanceKey}#`)
      }
      return null
    }

    return {
      render(Component, props, key) {
        let tree
        let guard = 0
        do {
          dirty = false
          visited = new Set()
          tree = renderNode(React.createElement(Component, { ...props, key }), 'root')
        } while (dirty && ++guard < 80)
        // Mark and sweep: anything that vanished unmounted, and its cleanup runs.
        for (const [instanceKey, instance] of [...instances]) {
          if (visited.has(instanceKey)) continue
          for (const [, entry] of instance.cleanups) entry.cleanup?.()
          instance.cleanups.clear()
          instances.delete(instanceKey)
        }
        return tree
      },
    }
  }

  function* walk(node) {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (Array.isArray(node)) { for (const child of node) yield* walk(child); return }
    if (typeof node !== 'object') return
    yield node
    if (node.__rendered !== undefined) yield* walk(node.__rendered)
    if (node.props?.children !== undefined) yield* walk(node.props.children)
  }

  const textOf = node => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join('')
    if (typeof node === 'object') {
      return (node.__rendered === undefined ? '' : textOf(node.__rendered)) + textOf(node.props?.children)
    }
    return ''
  }

  return {
    walk,
    textOf,
    /** Find a `<button>` by its visible label. */
    button(tree, label) {
      for (const node of walk(tree)) {
        if (node.type === 'button' && textOf(node).trim() === label) return node
      }
      return undefined
    },
    /** Find a `<button>` by its accessible name (some buttons are icon-only). */
    buttonByLabel(tree, label) {
      for (const node of walk(tree)) {
        if (node.type === 'button' && node.props?.['aria-label'] === label) return node
      }
      return undefined
    },
    /** Find the first node of a given intrinsic type. */
    element(tree, type) {
      for (const node of walk(tree)) if (node.type === type) return node
      return undefined
    },
    /** Whether a panel actually mounted in this tree. */
    mounted(tree) {
      for (const node of walk(tree)) if (node.props?.role === 'region') return true
      return false
    },
    /** Whether any node in the tree carries the given prop. */
    hasProp(tree, name) {
      for (const node of walk(tree)) if (node.props?.[name] !== undefined) return true
      return false
    },
    text: textOf,
    createRenderer,
  }
})()

/** Resolve after queued microtasks and timers the panel may have scheduled. */
const settle = () => new Promise(resolve => setImmediate(resolve))

/**
 * A controllable SSE stream standing in for the optimize route.
 *
 * It is abort-aware on purpose: aborting the request mid-read must reject the
 * way the real `fetch` body does, or contract 4 would pass vacuously.
 */
const createRunStream = signal => {
  const encoder = new TextEncoder()
  const queue = []
  let waiter
  let closed = false
  let failure
  const wake = () => { if (waiter !== undefined) { const resume = waiter; waiter = undefined; resume() } }
  signal?.addEventListener?.('abort', () => { failure = new Error('The operation was aborted.'); wake() })
  return {
    delta: text => { queue.push(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text })}\n\n`)); wake() },
    done: text => { queue.push(encoder.encode(`data: ${JSON.stringify({ type: 'done', text })}\n\n`)); wake() },
    end: () => { closed = true; wake() },
    response: {
      ok: true,
      body: {
        getReader: () => ({
          async read() {
            for (;;) {
              if (signal?.aborted === true) throw new Error('The operation was aborted.')
              if (failure !== undefined) throw failure
              if (queue.length > 0) return { done: false, value: queue.shift() }
              if (closed) return { done: true, value: undefined }
              await new Promise(resolve => { waiter = resolve })
            }
          },
        }),
      },
    },
  }
}

/** Install a fetch stub; returns the recorded calls with their streams. */
const installFetch = () => {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const stream = createRunStream(init.signal)
    calls.push({ url, init, stream })
    return stream.response
  }
  return calls
}

/** The panel fixture config used throughout the interactive checks. */
const panelConfig = {
  enabled: true,
  provider: 'ofox',
  model: 'MODEL-X',
  temperature: 0.3,
  maxTokens: 0,
  mainSystemPrompt: 'MAIN',
  presets: [{ id: 'coding', name: '编码任务', system: 'CODING' }],
  activePresetId: 'coding',
}

/** One mounted panel plus the events it produced. */
function mountPanel(overrides = {}) {
  const calls = installFetch()
  const events = { writes: [], closes: 0 }
  const props = {
    original: 'ORIGINAL DRAFT TEXT',
    config: panelConfig,
    sessionId: 'session-1',
    onWrite: text => { events.writes.push(text); return true },
    onClose: () => { events.closes += 1 },
    hasReferences: false,
    ...overrides,
  }
  const renderer = panels.createRenderer()
  const renderPanel = () => renderer.render(client.InlinePanel, props)
  return { calls, events, props, renderPanel }
}

// ------------------------------------------------- contract 1: mount runs once
{
  const { calls, renderPanel } = mountPanel()
  const tree = renderPanel()
  await settle()
  const afterMount = renderPanel()
  check(calls.length === 1, `mounting the panel starts exactly one run (got ${calls.length})`)
  check(calls[0]?.url === '/api/dsh-prompt-forge/optimize', 'the run targets the plugin optimize route')
  const body = JSON.parse(calls[0]?.init?.body ?? '{}')
  check(body.text === 'ORIGINAL DRAFT TEXT', 'the run sends the frozen original draft')
  check(body.system === 'CODING', 'the run sends the selected preset as the system prompt')
  check(calls[0]?.init?.signal !== undefined, 'the run carries an AbortSignal')
  // Re-rendering with identical props must not start a second run.
  const before = calls.length
  renderPanel()
  await settle()
  renderPanel()
  check(calls.length === before, 'a re-render with unchanged props does not start another run')
  // The first frame is already in flight: the result pane is read-only and Stop
  // is offered, which is only true once the run is genuinely running.
  const result = panels.element(afterMount, 'textarea')
  check(result?.props.placeholder === '正在优化…', 'the empty result pane shows the running placeholder')
  check(result?.props.readOnly === true, 'the result pane is read-only from the first frame')
  check(panels.button(afterMount, '停止') !== undefined, 'the running panel offers Stop')
}

// ------------------------------- contract 2 + 7: mid-stream state and gating
{
  const { calls, events, renderPanel } = mountPanel()
  renderPanel()
  await settle()
  calls[0].stream.delta('半截文本')
  await settle()
  const tree = renderPanel()

  // Contract 2: the pure rule refuses, and the button agrees with it.
  check(client.acceptRefusal('running', '半截文本') === 'busy', 'the accept rule refuses a running pass that already holds text')
  const accept = panels.button(tree, '采纳')
  check(accept !== undefined, 'the running panel still shows the Accept button')
  check(accept?.props.disabled === true, 'Accept is disabled while the run is in flight')

  // Contract 7: read-only result, disabled preset and refine, visible Stop.
  const result = panels.element(tree, 'textarea')
  check(result?.props.readOnly === true, 'the result pane is read-only while streaming')
  check(result?.props.value === '半截文本', 'the streamed delta reaches the result pane')
  check(panels.element(tree, 'select')?.props.disabled === true, 'the preset picker is disabled while streaming')
  check(panels.element(tree, 'input')?.props.disabled === true, 'the refine input is disabled while streaming')
  check(panels.button(tree, '继续微调')?.props.disabled === true, 'the refine action is disabled while streaming')
  check(panels.button(tree, '停止') !== undefined, 'Stop is visible while streaming')
  check(panels.button(tree, '重新优化') === undefined, 'Run again is hidden while streaming')
  // Copy stays available mid-stream on purpose, so a user can rescue a partial
  // answer after stopping.
  check(panels.button(tree, '复制')?.props.disabled === false, 'Copy stays enabled once there is text to copy')
  check(panels.button(tree, '复制') !== undefined, 'Copy is offered on the running panel')

  // The terminal frame settles the run and re-opens the controls.
  calls[0].stream.done('半截文本')
  calls[0].stream.end()
  await settle()
  const settled = renderPanel()
  check(panels.button(settled, '采纳')?.props.disabled === false, 'Accept is enabled once the run settles with text')
  check(panels.button(settled, '停止') === undefined, 'Stop disappears once the run settles')
  check(panels.button(settled, '重新优化') !== undefined, 'Run again appears once the run settles')
  check(panels.element(settled, 'textarea')?.props.readOnly === false, 'the result pane becomes editable once settled')
  check(events.writes.length === 0, 'streaming never writes back to the draft')
}

// ------------------------- contract 3: a refused write keeps the panel open
{
  const { calls, events, renderPanel } = mountPanel({
    onWrite: text => { events.writes.push(text); return false },
  })
  renderPanel()
  await settle()
  calls[0].stream.delta('RESULT')
  calls[0].stream.done('RESULT')
  calls[0].stream.end()
  await settle()
  const settled = renderPanel()
  check(panels.button(settled, '采纳')?.props.disabled === false, 'Accept is available before the refused write')
  panels.button(settled, '采纳')?.props.onClick()
  const after = renderPanel()
  check(events.writes.length === 1, 'the refused write was still attempted once')
  check(events.writes[0] === 'RESULT', 'the write is attempted with the trimmed result')
  check(events.closes === 0, 'a refused write does not collapse the panel')
  check([...panels.walk(after)].some(node => node.props?.role === 'region'), 'the panel is still mounted after a refused write')
  check(panels.text(after).includes('没能写入输入框'), 'a refused write reports a visible error')
}

// --------------------------- contract 3b: a successful write collapses it
{
  const { calls, events, renderPanel } = mountPanel()
  renderPanel()
  await settle()
  calls[0].stream.delta('RESULT')
  calls[0].stream.done('RESULT')
  calls[0].stream.end()
  await settle()
  panels.button(renderPanel(), '采纳')?.props.onClick()
  renderPanel()
  check(events.writes.length === 1, 'a successful accept writes exactly once')
  check(events.closes === 1, 'a successful accept collapses the panel')
  check(events.writes[0] === 'RESULT', 'the accepted text is the settled result')
}

// --------------------- contract 4: closing aborts the request in flight
{
  // Close has to be observed in a tree that can actually unmount the panel:
  // the ✕ only asks the host to retire the session bucket, and it is the
  // resulting unmount whose cleanup aborts the request. A standalone renderer
  // would leave the panel mounted forever and never exercise the abort.
  const calls = installFetch()
  const Host = ({ open }) => open
    ? React.createElement(client.InlinePanel, {
      original: 'ORIGINAL DRAFT TEXT',
      config: panelConfig,
      sessionId: 'session-close',
      onWrite: () => true,
      onClose: () => {},
      hasReferences: false,
    })
    : null
  // The ✕ button lives inside the panel; expose the close click by rendering
  // the panel through a host that mirrors the production host's own retire.
  const hosted = panels.createRenderer()
  let open = true
  const ClosingHost = () => {
    if (!open) return null
    return React.createElement(client.InlinePanel, {
      original: 'ORIGINAL DRAFT TEXT',
      config: panelConfig,
      sessionId: 'session-close',
      onWrite: () => true,
      onClose: () => { open = false },
      hasReferences: false,
    })
  }
  let tree = hosted.render(ClosingHost, {})
  await settle()
  const signal = calls[0].init.signal
  check(signal.aborted === false, 'the request is live while the panel is open')
  check(calls.length === 1, 'closing starts from exactly one in-flight run')
  panels.buttonByLabel(tree, '关闭面板')?.props.onClick()
  tree = hosted.render(ClosingHost, {})
  check([...panels.walk(tree)].every(node => node.props?.role !== 'region'), 'closing the panel unmounts it')
  check(signal.aborted === true, 'closing the panel aborts the request in flight')
}

// ------------- contract 4b: the unmount path aborts without a close click
{
  const { calls } = mountPanel()
  // Render through a throwaway host tree, then unmount by rendering a tree that
  // no longer contains the panel. The sweep must run the panel's cleanup.
  const hosted = panels.createRenderer()
  const Host = ({ open }) => open ? React.createElement(client.InlinePanel, {
    original: 'X',
    config: panelConfig,
    sessionId: 'session-abort',
    onWrite: () => true,
    onClose: () => {},
    hasReferences: false,
  }) : null
  hosted.render(Host, { open: true })
  await settle()
  const signal = calls[0].init.signal
  check(signal.aborted === false, 'the request is live while the panel is mounted in a host tree')
  hosted.render(Host, { open: false })
  check(signal.aborted === true, 'unmounting the panel aborts the request in flight')
  // Rendering nothing is how the real host retires a session's bucket.
  check(calls.length === 1, 'aborting on unmount did not start a replacement run')
}

// --------------------- contract 6: references force a second confirmation
{
  const { calls, events, renderPanel } = mountPanel({ hasReferences: true })
  renderPanel()
  await settle()
  calls[0].stream.delta('RESULT')
  calls[0].stream.done('RESULT')
  calls[0].stream.end()
  await settle()
  const settled = renderPanel()
  check(panels.text(settled).includes('含引用，采纳前会先确认'), 'the panel warns that references will be confirmed first')
  panels.button(settled, '采纳')?.props.onClick()
  const confirming = renderPanel()
  check(panels.text(confirming).includes('采纳将替换整段草稿'), 'Accept with references opens the confirmation step')
  check(events.writes.length === 0, 'the confirmation step does not write back')
  check(events.closes === 0, 'the confirmation step does not collapse the panel')
  check(panels.button(confirming, '仍然采纳') !== undefined, 'the confirmation offers a confirm action')
  check(panels.button(confirming, '取消') !== undefined, 'the confirmation offers a cancel action')
  panels.button(confirming, '仍然采纳')?.props.onClick()
  renderPanel()
  check(events.writes.length === 1, 'confirming writes back exactly once')
  check(events.writes[0] === 'RESULT', 'the confirmed write carries the result')
  check(events.closes === 1, 'confirming collapses the panel')
}

// --------------------- contract 6b: cancelling writes nothing at all
{
  const { calls, events, renderPanel } = mountPanel({ hasReferences: true })
  renderPanel()
  await settle()
  calls[0].stream.delta('RESULT')
  calls[0].stream.done('RESULT')
  calls[0].stream.end()
  await settle()
  panels.button(renderPanel(), '采纳')?.props.onClick()
  const confirming = renderPanel()
  panels.button(confirming, '取消')?.props.onClick()
  const back = renderPanel()
  check(events.writes.length === 0, 'cancelling the confirmation writes nothing')
  check(events.closes === 0, 'cancelling the confirmation keeps the panel open')
  check(panels.text(back).includes('采纳将替换整段草稿') === false, 'cancelling dismisses the confirmation')
  check(panels.button(back, '采纳')?.props.disabled === false, 'Accept is available again after cancelling')
}

// --------- contract 6c: without references, Accept writes straight through
{
  const { calls, events, renderPanel } = mountPanel({ hasReferences: false })
  renderPanel()
  await settle()
  calls[0].stream.delta('RESULT')
  calls[0].stream.done('RESULT')
  calls[0].stream.end()
  await settle()
  panels.button(renderPanel(), '采纳')?.props.onClick()
  check(events.writes.length === 1, 'Accept without references writes immediately')
  check(panels.text(renderPanel()).includes('含引用，采纳前会先确认') === false, 'the reference warning is absent without references')
}

// ------------- contract 1b: the preset picker re-runs an untouched first pass
{
  const { calls, renderPanel } = mountPanel()
  renderPanel()
  await settle()
  const before = calls.length
  const tree = renderPanel()
  const select = panels.element(tree, 'select')
  select?.props.onChange({ target: { value: '' } })
  await settle()
  renderPanel()
  check(calls.length === before + 1, 'switching the preset re-runs the optimization')
  const body = JSON.parse(calls[calls.length - 1]?.init?.body ?? '{}')
  check(body.system === 'MAIN', 'the re-run uses the newly selected main prompt')
}

// --------------------- contract 8: region semantics, never a modal dialog
{
  const { calls, renderPanel } = mountPanel()
  const tree = renderPanel()
  check(tree?.props?.role === 'region', 'the panel root carries role="region"')
  check(tree?.props?.role !== 'dialog', 'the panel root is not a dialog')
  check(tree?.props?.['aria-label'] === '提示词优化面板', 'the panel root names itself with the region label')
  check(panels.hasProp(tree, 'aria-modal') === false, 'the panel is not marked modal in its open state')
  // Guard against a vacuous pass: "no node is a dialog" would also hold for an
  // empty tree, so the panel's presence is asserted first.
  check(panels.mounted(tree), 'the panel is mounted when checking its dialog semantics')
  check([...panels.walk(tree)].every(node => node.props?.role !== 'dialog'), 'no node in the panel claims dialog semantics')
  check(panels.element(tree, 'kbd') === undefined, 'the panel has no <kbd> element')
  check(panels.text(tree).includes('Ctrl') === false, 'the panel renders no Ctrl hint')
  // The confirmation is an inline overlay, not the panel becoming a dialog.
  calls[0].stream.delta('RESULT')
  calls[0].stream.done('RESULT')
  calls[0].stream.end()
  await settle()
  const withRefs = mountPanel({ hasReferences: true })
  withRefs.renderPanel()
  await settle()
  withRefs.calls[0].stream.delta('RESULT')
  withRefs.calls[0].stream.done('RESULT')
  withRefs.calls[0].stream.end()
  await settle()
  panels.button(withRefs.renderPanel(), '采纳')?.props.onClick()
  const confirming = withRefs.renderPanel()
  check(confirming?.props?.role === 'region', 'the panel root keeps role="region" while confirming')
  check(panels.mounted(confirming), 'the panel is still mounted while confirming')
  check([...panels.walk(confirming)].every(node => node.props?.role !== 'dialog'), 'the confirmation does not turn the panel into a dialog')
}

// --------------------- the model label states when nothing is configured
{
  const { renderPanel } = mountPanel({
    config: { ...panelConfig, provider: '', model: '', activePresetId: '' },
  })
  const tree = renderPanel()
  check(panels.text(tree).includes('未配置模型'), 'the panel states when no model is configured')
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
  check(names.includes('conversation.input.overlay'), 'apply() registers the inline panel into the composer overlay')
  check(!names.includes('shell.overlay'), 'apply() no longer registers the retired shell.overlay host')

  const panelEntry = slots.find(entry => entry.options?.name === 'conversation.input.overlay')
  check(panelEntry?.options?.id === 'prompt-forge', 'the panel entry uses the plugin-owned id')
  check(panelEntry?.options?.order === 40, `the panel entry orders itself at 40 (got ${panelEntry?.options?.order})`)
  // `dsh-context` already occupies this slot at order 10; ordering after it and
  // using a distinct id is what keeps both panels mounting.
  check(panelEntry?.options?.order > 10, 'the panel orders itself behind the shipped context modal')
  check(typeof panelEntry?.options?.label === 'function', 'the panel entry declares a locale-following label')
  check(typeof panelEntry?.component === 'function', 'the panel entry registers a component')

  // A composition that mounts the entry without a session binding must render
  // nothing rather than throw: a throw here fails the whole web boot.
  check(render(panelEntry.component, {}) === '', 'the panel entry renders nothing without a session binding')

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

/**
 * Build a `ctx` whose settings belong to this plugin and are already resolved.
 *
 * The real `bindSettings` starts at `status: 'loading'` with the built-in
 * presets and swaps in the stored section after `describe().ensure()` settles.
 * That swap changes the resolved system prompt, which legitimately restarts the
 * panel's first run. Waiting for the handle to reach `ready` before the panel
 * mounts keeps these host-path checks about the *panel*, not about a settings
 * race — the restart behaviour itself is asserted separately above.
 * @param registered - receives the slot registrations `apply()` performs.
 * @returns the two entries the host checks drive.
 */
const applyWithResolvedSettings = registered => {
  const ctx = {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    get(key) {
      if (key === 'locale') return { register: () => () => {}, getLocale: () => ({ active: 'zh' }), subscribe: () => () => {} }
      if (key === 'configForms') {
        return {
          describe: () => ({
            getSnapshot: () => ({ view: { namespaces: [{ ns: 'include:prompt-forge', schema: { mainSystemPrompt: 1 } }] } }),
            subscribe: () => () => {},
            ensure: async () => {},
          }),
          get: () => ({
            getSnapshot: () => ({ status: 'ready', value: panelConfig, revision: 3, writable: true }),
            subscribe: () => () => {},
            mutate: async () => true,
          }),
        }
      }
      if (key === 'sessions') return { list: { getSnapshot: () => ({ current: undefined }), subscribe: () => () => {} } }
      if (key === 'conversation') return undefined
      if (key === 'slots') {
        return {
          register(options, component) { registered.push({ options, component }); return () => {} },
          inject(_key, callback) { callback(); return () => {} },
        }
      }
      return undefined
    },
    effect(callback) { const dispose = callback(); return () => { if (typeof dispose === 'function') dispose() } },
  }
  client.apply(ctx)
  return {
    overlay: registered.find(entry => entry.options.name === 'conversation.input.overlay'),
    button: registered.find(entry => entry.options.name === 'conversation.input.left'),
  }
}

/** Wait until the bound settings handle has left the loading state. */
const settleSettings = async () => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await settle()
  }
}

// ---------------------------------- apply(): the panel host writes back live
// The registered overlay occurrence is the production path: it owns the
// session bucket, decides `hasReferences` from live input, and performs the
// write. Driving it end to end is the only way to prove the *host* half of the
// contract (frozen draft, references detection, refused write).
{
  const registered = []
  const { overlay, button } = applyWithResolvedSettings(registered)
  await settleSettings()
  const calls = installFetch()
  const state = { draft: 'LIVE DRAFT', phase: 'plain', occurrences: [], attachmentIds: [] }
  const useInput = selector => selector(state)
  const written = []
  const inputActions = { setDraft: text => { written.push(text) } }
  const renderer = panels.createRenderer()

  // 1. Open through the real button, which freezes the draft into the bucket.
  const buttonTree = renderer.render(button.component, { sessionId: 'session-1', useInput })
  const optimize = panels.button(buttonTree, '优化')
  check(optimize !== undefined, 'the registered composer button renders its Optimize control')
  check(optimize?.props.disabled === false, 'the registered button is enabled for a non-empty draft')
  optimize?.props.onClick()

  // 2. The overlay occurrence mounts the panel for that same session.
  let tree = renderer.render(overlay.component, { sessionId: 'session-1', useInput, inputActions })
  await settle()
  tree = renderer.render(overlay.component, { sessionId: 'session-1', useInput, inputActions })
  check([...panels.walk(tree)].some(node => node.props?.role === 'region'), 'the overlay occurrence mounts the panel after Open')
  // The settings handle reaches `ready` before this panel mounts, so exactly one
  // run starts — the settings-driven restart is covered by its own check.
  check(calls.length === 1, `the mounted panel starts its run (got ${calls.length})`)
  check(panels.text(tree).includes('LIVE DRAFT') === false, 'the frozen draft stays collapsed until the user asks for it')

  // 3. Typing after Open must not change what the panel optimizes.
  state.draft = 'TYPED LATER'
  tree = renderer.render(overlay.component, { sessionId: 'session-1', useInput, inputActions })
  const fold = [...panels.walk(tree)].find(node => node.type === 'button' && panels.text(node).includes('查看原文'))
  check(fold !== undefined, 'the panel offers a collapsed original draft')
  fold?.props.onClick()
  tree = renderer.render(overlay.component, { sessionId: 'session-1', useInput, inputActions })
  check(panels.text(tree).includes('LIVE DRAFT'), 'the panel shows the draft frozen at open time')
  check(panels.text(tree).includes('TYPED LATER') === false, 'typing after open does not leak into the panel')

  // 4. Accept through the host writes to the composer and retires the bucket.
  calls[0].stream.delta('HOST RESULT')
  calls[0].stream.done('HOST RESULT')
  calls[0].stream.end()
  await settle()
  tree = renderer.render(overlay.component, { sessionId: 'session-1', useInput, inputActions })
  panels.button(tree, '采纳')?.props.onClick()
  tree = renderer.render(overlay.component, { sessionId: 'session-1', useInput, inputActions })
  check(written.length === 1, 'the host writes the accepted text into the composer')
  check(written[0] === 'HOST RESULT', 'the host writes the accepted result text')
  check([...panels.walk(tree)].every(node => node.props?.role !== 'region'), 'the host collapses the panel after a successful write')
}

// ------------------- apply(): the host detects references and gates the write
{
  const registered = []
  const { overlay, button } = applyWithResolvedSettings(registered)
  await settleSettings()
  const calls = installFetch()
  const written = []
  const inputActions = { setDraft: text => { written.push(text) } }
  const renderer = panels.createRenderer()

  // A draft carrying an attachment: `occurrences` is empty, `attachmentIds` is not.
  const state = { draft: 'DRAFT WITH ATTACHMENT', phase: 'plain', occurrences: [], attachmentIds: ['att-1'] }
  const useInput = selector => selector(state)
  renderer.render(button.component, { sessionId: 'session-7', useInput })
  panels.button(renderer.render(button.component, { sessionId: 'session-7', useInput }), '优化')?.props.onClick()
  let tree = renderer.render(overlay.component, { sessionId: 'session-7', useInput, inputActions })
  await settle()
  tree = renderer.render(overlay.component, { sessionId: 'session-7', useInput, inputActions })
  check(panels.text(tree).includes('含引用，采纳前会先确认'), 'the host reports references detected from live input state')
  calls[0].stream.delta('HOST RESULT')
  calls[0].stream.done('HOST RESULT')
  calls[0].stream.end()
  await settle()
  tree = renderer.render(overlay.component, { sessionId: 'session-7', useInput, inputActions })
  panels.button(tree, '采纳')?.props.onClick()
  tree = renderer.render(overlay.component, { sessionId: 'session-7', useInput, inputActions })
  check(written.length === 0, 'the host does not write while the confirmation is pending')
  check(panels.text(tree).includes('采纳将替换整段草稿'), 'the host routes an attachment-bearing draft through the confirmation')
  panels.button(tree, '仍然采纳')?.props.onClick()
  tree = renderer.render(overlay.component, { sessionId: 'session-7', useInput, inputActions })
  check(written.length === 1 && written[0] === 'HOST RESULT', 'confirming through the host writes the result once')
}

// ------------------- apply(): a session that refuses the write stays open
{
  const registered = []
  const { overlay, button } = applyWithResolvedSettings(registered)
  await settleSettings()
  const calls = installFetch()
  // The composer facade is gone: every write throws, exactly as a session that
  // stopped being retained behaves.
  const inputActions = { setDraft: () => { throw new Error('session is no longer writable') } }
  const renderer = panels.createRenderer()
  const state = { draft: 'DRAFT', phase: 'plain', occurrences: [], attachmentIds: [] }
  const useInput = selector => selector(state)
  renderer.render(button.component, { sessionId: 'session-8', useInput })
  panels.button(renderer.render(button.component, { sessionId: 'session-8', useInput }), '优化')?.props.onClick()
  let tree = renderer.render(overlay.component, { sessionId: 'session-8', useInput, inputActions })
  await settle()
  tree = renderer.render(overlay.component, { sessionId: 'session-8', useInput, inputActions })
  calls[0].stream.delta('HOST RESULT')
  calls[0].stream.done('HOST RESULT')
  calls[0].stream.end()
  await settle()
  tree = renderer.render(overlay.component, { sessionId: 'session-8', useInput, inputActions })
  panels.button(tree, '采纳')?.props.onClick()
  tree = renderer.render(overlay.component, { sessionId: 'session-8', useInput, inputActions })
  check(panels.text(tree).includes('没能写入输入框'), 'the host surfaces a refused write as a visible error')
  check([...panels.walk(tree)].some(node => node.props?.role === 'region'), 'the host keeps the panel open when the write is refused')
}

// ------------------- apply(): sessions are bucketed, so drafts cannot cross
{
  const registered = []
  const { overlay, button } = applyWithResolvedSettings(registered)
  await settleSettings()
  installFetch()
  // The button and the panel tree need separate renderers. A renderer sweeps
  // any instance it did not visit in the current pass — which is correct React
  // unmount behaviour — so re-rendering the button through the same renderer
  // would unmount both panel occurrences (and, via their cleanups, retire both
  // session buckets) before they were even inspected.
  const buttonRenderer = panels.createRenderer()
  const hostRenderer = panels.createRenderer()
  const stateA = { draft: 'DRAFT-A', phase: 'plain', occurrences: [], attachmentIds: [] }
  const stateB = { draft: 'DRAFT-B', phase: 'plain', occurrences: [], attachmentIds: [] }
  const useInputA = selector => selector(stateA)
  const useInputB = selector => selector(stateB)
  const actions = { setDraft: () => {} }

  const openFor = session => {
    const useInput = session === 'A' ? useInputA : useInputB
    const tree = buttonRenderer.render(button.component, { sessionId: session, useInput })
    panels.button(tree, '优化')?.props.onClick()
  }

  // Both occurrences are rendered in the same pass, which is the shape the
  // framework produces for two sessions that each have a composer card. Each
  // gets its own instance because the framework keys entries by session.
  const renderBoth = () => hostRenderer.render(
    () => React.createElement(
      React.Fragment,
      null,
      ['A', 'B'].map(session => React.createElement(overlay.component, {
        key: session,
        sessionId: session,
        useInput: session === 'A' ? useInputA : useInputB,
        inputActions: actions,
      })),
    ),
    {},
  )
  const countRegions = tree => [...panels.walk(tree)].filter(node => node.props?.role === 'region').length

  // Open only session A.
  openFor('A')
  await settle()
  let tree = renderBoth()
  check(countRegions(tree) === 1, `only the opened session renders a panel (got ${countRegions(tree)})`)
  let folds = [...panels.walk(tree)].filter(node => node.type === 'button' && panels.text(node).includes('查看原文'))
  folds.forEach(fold => fold.props.onClick())
  tree = renderBoth()
  check(panels.text(tree).includes('DRAFT-A'), 'session A shows its own captured draft')

  // Open B as well: both must coexist, each with its own draft.
  openFor('B')
  await settle()
  tree = renderBoth()
  check(countRegions(tree) === 2, `both opened sessions render their own panel (got ${countRegions(tree)})`)
  // Every panel owns a fold toggle; its label flips between the two states.
  // Session A's was expanded in the step above, so only the still-collapsed
  // toggles may be clicked — clicking an expanded one would close it again.
  folds = [...panels.walk(tree)].filter(node => node.type === 'button' && panels.text(node).includes('查看原文'))
  check(folds.length === 1, `each panel offers its own original-draft toggle (one left collapsed: ${folds.length})`)
  for (const fold of folds) fold.props.onClick()
  tree = renderBoth()
  const text = panels.text(tree)
  check(text.includes('DRAFT-A') && text.includes('DRAFT-B'), 'each session shows its own draft side by side')
  // The count of each draft must be exactly 1: a crossed bucket would show one
  // draft twice and hide the other.
  check((text.match(/DRAFT-A/gu) ?? []).length === 1, 'session A\'s draft appears exactly once (no cross-contamination)')
  check((text.match(/DRAFT-B/gu) ?? []).length === 1, 'session B\'s draft appears exactly once (no cross-contamination)')
}

// ------------------------------------------------- composer resolution path
// `composer.ts` is no longer on the write path (the slot hands the occurrence
// its own `inputActions`), but it is still exported and still tested: the
// exported helpers are part of the bundle's public surface.
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
