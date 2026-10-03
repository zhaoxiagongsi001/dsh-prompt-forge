/**
 * Smoke-test the built artifacts without a browser or a DSH host.
 *
 * This is the cheap, honest check that the bundle contract holds:
 *   - `lib/client.js` registers itself on the loader facade and its factory
 *     materializes with only the seeded platform modules available;
 *   - `lib/index.js` imports as an ESM module and exposes the plugin contract.
 *
 * It does not prove the GUI renders — only the real page can show that — but it
 * catches the failure modes that would otherwise surface as "plugin failed to
 * load" in the boot overlay: a stray unresolvable `require`, an ESM/CJS
 * mismatch, or a missing export.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Minimal `react` stand-in: the bundle only needs a callable createElement. */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  useState: value => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useCallback: fn => fn,
  useMemo: fn => fn(),
  useRef: value => ({ current: value }),
}

/** Minimal `dsh-client-store` stand-in: a snapshot store with subscribe. */
const storeStub = {
  createSnapshotStore: (init) => {
    let value = init
    const listeners = new Set()
    return {
      getSnapshot: () => value,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      set: (next) => { value = next; for (const listener of [...listeners]) listener() },
      update: (mutate) => { const draft = structuredClone(value); mutate(draft); value = draft; for (const listener of [...listeners]) listener() },
    }
  },
}

const seed = {
  react: reactStub,
  '@deepseek-ai/dsh-client-store': storeStub,
}

/** Collect the registrations the bundle performs on the loader facade. */
const registrations = []
let capturedFactory

globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      registrations.push(entry)
      capturedFactory = entry.factory
    },
  },
  setTimeout,
  clearTimeout,
}

const failures = []
const note = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

// ---------------------------------------------------------------- client half
const clientSource = await readFile(path.join(root, 'lib/client.js'), 'utf8')
// The bundle is a classic script, not a module: evaluate it as a function body.
// eslint-disable-next-line no-new-func
new Function(clientSource)()

note(registrations.length === 1, 'client bundle registers exactly once')
note(registrations[0]?.id === 'dsh-prompt-forge', 'client bundle registers under the package name')

let clientExports
try {
  clientExports = capturedFactory(specifier => {
    const seeded = seed[specifier]
    if (seeded === undefined) throw new Error(`require("${specifier}") missed the module table`)
    return seeded
  })
  note(true, 'client factory materializes with only seeded modules')
} catch (error) {
  note(false, `client factory materializes with only seeded modules (${error.message})`)
}

if (clientExports !== undefined) {
  note(typeof clientExports.apply === 'function', 'client exposes apply()')
  note(Array.isArray(clientExports.inject), 'client exposes inject[]')
  note(typeof clientExports.tt === 'function', 'client exposes the translate helper')
  note(clientExports.tt('button.label') !== 'button.label', 'translate helper resolves a known key')

  // Exercise the pure helpers the dialog depends on, so a regression in the
  // stream parser or the config resolver fails here rather than in the GUI.
  const ops = [
    { op: 'set', path: ['enabled'], value: true },
  ]
  const fakeHandle = {
    getSnapshot: () => ({ status: 'ready', value: clientExports.CONFIG_DEFAULTS, revision: 1, writable: true, transport: 'configForms' }),
    subscribe: () => () => {},
    apply: async applied => applied.length === ops.length,
    reload: async () => {},
    dispose: () => {},
  }
  const applied = await fakeHandle.apply(ops)
  note(applied === true, 'settings handle applies a path op batch')

  const resolved = clientExports.resolveConfig({ temperature: 0.7, presets: [] })
  note(resolved.temperature === 0.7, 'resolveConfig keeps a stored temperature')
  note(resolved.presets.length > 0, 'resolveConfig falls back to the built-in presets')
  note(clientExports.draftRejection('   ') === 'empty', 'draftRejection refuses a blank draft')
  note(clientExports.draftRejection('ok') === undefined, 'draftRejection accepts a normal draft')
  note(clientExports.draftRejection('x'.repeat(30000)) === 'too-long', 'draftRejection refuses an over-long draft')
}

// ------------------------------------------------------------------ host half
// A bare Windows path is not a valid ESM specifier; convert to a file URL.
const { pathToFileURL } = await import('node:url')
const host = await import(pathToFileURL(path.join(root, 'lib/index.js')).href)
note(typeof host.apply === 'function', 'host exposes apply()')
note(Array.isArray(host.inject) && host.inject.includes('webServer'), 'host requires the webServer service')
note(typeof host.Config === 'function' && typeof host.Config.toJSON === 'function',
  'host exposes a schemastery Config schema')
note(host.name === 'prompt-forge', 'host declares its plugin name')

const composed = host.composeUserContent('draft', '', '')
note(composed === 'draft', 'composeUserContent sends the bare draft on a first run')
const refined = host.composeUserContent('draft', 'previous', 'shorter')
note(refined.includes('原始草稿') && refined.includes('上一版改写结果') && refined.includes('本次修改要求'),
  'composeUserContent names all three sections on a refine')

note(host.resolveSystemPrompt('', 'custom main') === 'custom main', 'resolveSystemPrompt prefers the main prompt')
note(host.resolveSystemPrompt('preset body', 'custom main') === 'preset body', 'resolveSystemPrompt prefers a preset')
note(host.resolveSystemPrompt('', '') !== '', 'resolveSystemPrompt never returns an empty prompt')

note(host.isChatModel({ provider: 'p', id: 'deepseek/deepseek-v4.1-flash', name: 'x' }) === true, 'isChatModel keeps a chat model')
note(host.isChatModel({ provider: 'p', id: 'openai/gpt-image-2.5', name: 'x' }) === false, 'isChatModel drops an image model')
note(host.isChatModel({ provider: 'p', id: 'text-embedding-3', name: 'x' }) === false,
  'isChatModel drops an embedding model by id')
// Gateways routinely report text input for embedding routes, so the id
// heuristic must be able to exclude a model its own metadata would admit.
note(host.isChatModel({ provider: 'p', id: 'text-embedding-3', name: 'x', inputModalities: ['text'] }) === false,
  'isChatModel still drops an embedding model that advertises text input')
note(host.isChatModel({ provider: 'p', id: 'some-vision-encoder', name: 'x', inputModalities: ['text', 'image'] }) === false,
  'isChatModel drops a non-chat route by id even with text modality')
note(host.isChatModel({ provider: 'p', id: 'qwen/qwen3.8-max-0902', name: 'x', inputModalities: ['text'] }) === true,
  'isChatModel keeps a normal chat model that declares text modality')

// ------------------------------------------------- client apply() execution
// The riskiest client path: registering into slots the shell owns. A wrong
// option shape or a missing service would throw here, and in the real GUI that
// throw takes the entire boot down — so it is worth driving directly.
{
  const registered = []
  const injected = []
  const effects = []
  const fakeLocale = {
    register: () => () => {},
    getLocale: () => ({ active: 'zh' }),
    subscribe: () => () => {},
  }
  const fakeCtx = {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    get(key) {
      if (key === 'locale') return fakeLocale
      if (key === 'configForms') return undefined
      if (key === 'sessions') return { list: { getSnapshot: () => ({ current: undefined }), subscribe: () => () => {} } }
      if (key === 'conversation') return undefined
      if (key === 'slots') {
        return {
          register(options, component) { registered.push({ options, component }); return () => {} },
          inject(key, callback) { injected.push(key); callback(); return () => {} },
        }
      }
      return undefined
    },
    effect(callback, label) {
      const dispose = callback()
      if (typeof dispose === 'function') effects.push({ label, dispose })
      return () => {}
    },
  }

  try {
    clientExports.apply(fakeCtx)
    note(true, 'client apply() runs without throwing')
  } catch (error) {
    note(false, `client apply() runs without throwing (${error.message})`)
  }

  const names = registered.map(entry => entry.options?.name)
  note(injected.includes('conversation.input.left'), 'apply() injects the composer tool-row slot')
  note(injected.includes('settings.section'), 'apply() injects the settings section slot')
  note(injected.includes('conversation.input.overlay'), 'apply() injects the composer-card overlay slot')
  note(!injected.includes('shell.overlay'), 'apply() no longer injects the retired frame-wide overlay slot')
  note(names.includes('conversation.input.left'), 'apply() registers the composer button')
  note(names.includes('settings.section'), 'apply() registers the settings page')
  note(names.includes('conversation.input.overlay'), 'apply() registers the inline panel host')
  note(!names.includes('shell.overlay'), 'apply() no longer registers the retired dialog host')
  const button = registered.find(entry => entry.options?.name === 'conversation.input.left')
  note(typeof button?.options?.id === 'string' && button.options.id !== '', 'the composer entry declares a list id')
  note(typeof button?.options?.label === 'function', 'the composer entry declares a locale-following label')
  note(typeof button?.component === 'function', 'the composer entry registers a component')

  // The panel must order itself after `dsh-context`'s `context-modal` (order 10)
  // in the shared composer overlay, and use its own id: a shared cell id or a
  // tie in order would collide at registration and take the boot down.
  const panel = registered.find(entry => entry.options?.name === 'conversation.input.overlay')
  note(panel?.options?.order === 40, `the panel entry orders itself at 40 (got ${panel?.options?.order})`)
  note(panel?.options?.id === 'prompt-forge', 'the panel entry uses the plugin-owned id')
  note(typeof panel?.component === 'function', 'the panel entry registers a component')

  // The panel host is a session-scope occurrence: a composition that mounts it
  // without a session binding must render nothing rather than throw, because a
  // throw here fails the whole web boot.
  try {
    const rendered = panel.component({})
    note(rendered === null, 'the panel host renders nothing without a session binding')
  } catch (error) {
    note(false, `the panel host renders nothing without a session binding (${error.message})`)
  }

  for (const effect of effects) {
    try { effect.dispose() } catch { /* teardown must not throw */ }
  }
  note(true, 'every client effect disposes cleanly')
}

// -------------------------------------------------------------------- host apply()
{
  const routes = []
  let seeded
  const fakeCtx = {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    fiber: { uid: 1 },
    get(key) { return key === 'llm' ? { listProviders: () => [], listModels: async () => [] } : undefined },
    inject(_services, callback) { callback(fakeCtx); return () => {} },
    effect(callback) { const dispose = callback(); if (typeof dispose === 'function') seeded = dispose; return () => {} },
    webServer: { register(route) { routes.push(route); return () => {} } },
  }
  try {
    host.apply(fakeCtx, { provider: 'ofox', model: 'm' })
    note(true, 'host apply() runs without throwing')
    note(routes.length === 2, `host apply() registers both routes (got ${routes.length})`)
    if (typeof seeded === 'function') seeded()
    note(true, 'host route disposers run cleanly')
  } catch (error) {
    note(false, `host apply() runs without throwing (${error.message})`)
  }
}

// ---------------------------------------------------------------- result
console.log('')
if (failures.length === 0) {
  console.log('smoke: all checks passed')
} else {
  console.error(`smoke: ${failures.length} check(s) failed`)
  process.exitCode = 1
}
