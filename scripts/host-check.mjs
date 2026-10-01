/**
 * Exercise the host half's route family against a real HTTP server.
 *
 * This is the integration check the smoke test cannot be: it drives `apply()`
 * with a fake plugin context, starts the real web server, and asserts on actual
 * HTTP responses — the loopback fence, the SSE framing, the chunk normalization,
 * and every refusal branch. If this passes, a failure in the GUI is a client
 * problem, not a host problem.
 */
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const host = await import(pathToFileURL(path.join(root, 'lib/index.js')).href)

const failures = []
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

/**
 * Wire the routes onto a real server by replaying the registrations `apply()`
 * performs. The fake context records them instead of resolving real services.
 */
const routes = []
const effects = []

/** A streamed response the fake LLM returns for one scripted call. */
let llmScript = () => []

const fakeLlm = {
  listProviders: () => [
    { id: 'ofox', name: 'OFOX' },
    { id: 'empty', name: 'Broken gateway' },
  ],
  listModels: async provider => {
    if (provider === 'empty') throw new Error('gateway unreachable')
    return [
      { provider: 'ofox', id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
      { provider: 'ofox', id: 'openai/gpt-image-2.5', name: 'GPT Image' },
      { provider: 'ofox', id: 'text-embedding-3', name: 'Embedding' },
    ]
  },
  stream: options => ({
    async *[Symbol.asyncIterator]() {
      for (const chunk of llmScript(options)) yield chunk
    },
  }),
}

/** Build the minimal context surface `apply()` touches. */
function makeContext() {
  const context = {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    fiber: { uid: 1 },
    get(key) {
      if (key === 'llm') return fakeLlm
      return undefined
    },
    inject(_services, callback) {
      callback(context)
      return () => {}
    },
    effect(callback) {
      const dispose = typeof callback === 'function' ? callback() : undefined
      if (typeof dispose === 'function') effects.push(dispose)
      return () => {}
    },
    // The routes arrive here, because `webServer` is the one injected service.
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  return context
}

host.apply(makeContext(), { provider: 'ofox', model: 'deepseek/deepseek-v4.1-flash' })

check(routes.length === 2, `apply() registers exactly two routes (got ${routes.length})`)
check(routes.some(route => route.path.endsWith('/models')), 'apply() registers the model directory route')
check(routes.some(route => route.path.endsWith('/optimize')), 'apply() registers the optimize route')

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const route = routes.find(candidate => candidate.path === url.pathname)
  if (route === undefined) {
    res.writeHead(404).end('not found')
    return
  }
  void route.handler(req, res)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

/** Read one SSE response into an array of parsed events. */
async function readEvents(response) {
  const text = await response.text()
  const events = []
  for (const block of text.split(/\n\n/)) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue
      try { events.push(JSON.parse(line.slice(5).trim())) } catch { /* comment frame */ }
    }
  }
  return events
}

// ------------------------------------------------------------ model directory
{
  const response = await fetch(`${base}/api/dsh-prompt-forge/models`)
  const body = await response.json()
  check(response.status === 200, 'GET /models answers 200')
  check(body.ok === true, 'GET /models reports ok')
  check(Array.isArray(body.providers) && body.providers.length === 2, 'GET /models lists both providers')
  const ofox = body.providers?.find(provider => provider.id === 'ofox')
  check(ofox?.models.some(model => model.id === 'deepseek/deepseek-v4.1-flash'), 'GET /models keeps the chat model')
  check(!ofox?.models.some(model => model.id === 'openai/gpt-image-2.5'), 'GET /models drops the image model')
  check(!ofox?.models.some(model => model.id === 'text-embedding-3'), 'GET /models drops the embedding model')
  const broken = body.providers?.find(provider => provider.id === 'empty')
  check(broken !== undefined && broken.models.length === 0, 'GET /models degrades a broken gateway to an empty row instead of failing')
}

// ---------------------------------------------------------------- refusals
{
  const wrongMethod = await fetch(`${base}/api/dsh-prompt-forge/models`, { method: 'POST' })
  check(wrongMethod.status === 405, 'GET-only route refuses POST with 405')

  const empty = await fetch(`${base}/api/dsh-prompt-forge/optimize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '   ', system: 'x' }),
  })
  const emptyBody = await empty.json()
  check(empty.status === 400 && emptyBody.code === 'empty-draft', 'optimize refuses an empty draft with a readable code')

  const tooLong = await fetch(`${base}/api/dsh-prompt-forge/optimize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'x'.repeat(20001), system: 'x' }),
  })
  const tooLongBody = await tooLong.json()
  check(tooLong.status === 400 && tooLongBody.code === 'draft-too-long', 'optimize refuses an over-long draft rather than truncating')

  const badJson = await fetch(`${base}/api/dsh-prompt-forge/optimize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json',
  })
  check(badJson.status === 400, 'optimize refuses an unreadable body')

  const getOptimize = await fetch(`${base}/api/dsh-prompt-forge/optimize`)
  check(getOptimize.status === 405, 'POST-only route refuses GET with 405')
}

// ------------------------------------------------------------- happy stream
{
  llmScript = () => [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Hello ' },
    { type: 'reasoning-delta', index: 1, text: 'SECRET SCRATCHPAD' },
    { type: 'text-delta', index: 0, text: 'world' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const response = await fetch(`${base}/api/dsh-prompt-forge/optimize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'draft text', system: 'SYS' }),
  })
  check(response.headers.get('content-type')?.startsWith('text/event-stream') === true, 'optimize answers an event stream')
  const events = await readEvents(response)
  check(events[0]?.type === 'start' && events[0].provider === 'ofox', 'the stream opens with a start frame naming the route')
  const deltas = events.filter(event => event.type === 'delta').map(event => event.text).join('')
  check(deltas === 'Hello world', `the stream carries visible text only (got ${JSON.stringify(deltas)})`)
  check(!JSON.stringify(events).includes('SECRET SCRATCHPAD'), 'reasoning deltas never reach the client')
  const done = events.find(event => event.type === 'done')
  check(done?.text === 'Hello world', 'the terminal frame carries the assembled text')
  check(done?.aborted === undefined, 'a clean run is not marked aborted')
}

// ----------------------------------------------------------- upstream failure
{
  llmScript = () => [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'finish', reason: { kind: 'error', failure: { code: 'rate_limit', message: 'upstream is rate limited' } } },
  ]
  const response = await fetch(`${base}/api/dsh-prompt-forge/optimize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'draft', system: 'SYS' }),
  })
  const events = await readEvents(response)
  const error = events.find(event => event.type === 'error')
  check(error?.code === 'rate_limit', 'an upstream failure reaches the client with its own code')
  check(error?.message === 'upstream is rate limited', 'an upstream failure reaches the client with its message')
  check(events.every(event => event.type !== 'done'), 'a failed run emits no done frame')
}

// --------------------------------------------------------- aborted upstream
{
  llmScript = () => [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'partial' },
    { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } } },
  ]
  const response = await fetch(`${base}/api/dsh-prompt-forge/optimize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'draft', system: 'SYS' }),
  })
  const events = await readEvents(response)
  const done = events.find(event => event.type === 'done')
  check(done?.aborted === true, 'an aborted run is reported as aborted, not as a failure')
  check(done?.text === 'partial', 'an aborted run keeps the text it already streamed')
}

// ------------------------------------------------------ refine request shape
{
  let captured
  llmScript = options => {
    captured = options
    return [
      { type: 'text-delta', index: 0, text: 'ok' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
  }
  await fetch(`${base}/api/dsh-prompt-forge/optimize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'original', system: 'SYS PROMPT', previous: 'first pass', instruction: 'make it shorter' }),
  })
  const userText = captured?.messages?.[0]?.content?.[0]?.text ?? ''
  check(captured?.system === 'SYS PROMPT', 'the resolved system prompt is passed through verbatim')
  check(captured?.provider === 'ofox' && captured?.model === 'deepseek/deepseek-v4.1-flash', 'the configured route is used')
  check(userText.includes('original') && userText.includes('first pass') && userText.includes('make it shorter'),
    'a refine sends the draft, the previous pass, and the instruction')
}

// ------------------------------------------------------------------ teardown
await new Promise(resolve => server.close(resolve))

console.log('')
if (failures.length === 0) {
  console.log('host integration: all checks passed')
} else {
  console.error(`host integration: ${failures.length} check(s) failed`)
  process.exitCode = 1
}
