/**
 * Build both halves of dsh-prompt-forge with no child processes.
 *
 * Output contract (what the DSH web profile actually loads):
 *   - `lib/index.js`  — the host half: plain ESM. Node builtins and the
 *     `@deepseek-ai/*` packages stay external and are resolved by the loader in
 *     the host process.
 *   - `lib/client.js` — the browser half: a classic, self-registering script
 *     that calls `window.__ModuleLoader__.load({ id, factory })`. Every bare
 *     import must resolve through the shell's frozen module table; anything else
 *     has to be inlined, because the browser cannot fetch it.
 *
 * Why a hand-written bundler: the native esbuild binary and esbuild-wasm both
 * spawn a helper process with piped stdio, which the DSH file sandbox refuses
 * (EPERM on spawn). The TypeScript compiler API is pure JavaScript and runs
 * in-process, so it works under the sandbox. The bundler is deliberately small:
 * two targets, one pass, no minification, no code splitting.
 *
 * Style handling: the client module system claims every `<style>` tag that
 * exists at the moment a factory first materializes, so CSS has to be installed
 * *during* materialization. Each `*.module.css` compiles to an internal module
 * that injects one tagged `<style>` on first evaluation and exports the class
 * mapping — which is both that moment and what lets teardown remove it again.
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SRC = path.join(root, 'src')
const OUT = path.join(root, 'lib')

/**
 * The id the bundle registers under.
 *
 * The client module system identifies a bundle by its resolved package name, so
 * this is read from package.json rather than repeated as a literal: a rename
 * that updated only one of the two would load the bundle under an id nothing
 * routes to, and the plugin would silently never mount.
 */
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const PACKAGE_NAME = manifest.name
if (typeof PACKAGE_NAME !== 'string' || PACKAGE_NAME === '') {
  throw new Error('package.json has no usable "name" field')
}

/**
 * Packages the browser shell seeds into its frozen module table. Only the two
 * this plugin actually imports at runtime are listed: keeping the list minimal
 * is what makes the bundle robust across shell releases, because a seeded name
 * that disappears becomes a hard load failure.
 */
const CLIENT_EXTERNALS = new Set([
  'react',
  '@deepseek-ai/dsh-client-store',
])

/** Bare specifiers the host process resolves at runtime. */
const HOST_EXTERNAL_PREFIXES = ['node:', '@deepseek-ai/', 'zod']

/** Virtual module id standing in for the automatic JSX runtime. */
const JSX_RUNTIME = '\0jsx-runtime'

/** Normalize an absolute path to a stable, posix, root-relative module id. */
function idOf(absolute) {
  return path.relative(root, absolute).split(path.sep).join('/')
}

/** Normalize an id to an absolute path. */
function fileOf(id) {
  return path.join(root, id.split('/').join(path.sep))
}

/** Whether a specifier is resolved by the host/shell rather than bundled. */
function isExternal(specifier, externals, prefixes) {
  if (externals.has(specifier)) return true
  return prefixes.some(prefix => specifier === prefix || specifier.startsWith(prefix))
}

/**
 * Whether a specifier is a path this plugin owns rather than a package name.
 * Both `./x` and a bare-looking `src/client/x` fall here, because the generated
 * ids are root-relative paths, not package specifiers.
 */
function isInternalPath(specifier) {
  if (specifier.startsWith('.')) return true
  return existsSync(path.join(root, specifier))
}

/**
 * Resolve a relative specifier against its importer.
 * @param specifier - the raw specifier text.
 * @param importerId - the importing module's id.
 * @returns the resolved module id.
 */
function resolveRelative(specifier, importerId) {
  const base = path.dirname(fileOf(importerId))
  const raw = path.resolve(base, specifier)
  const candidates = [
    raw,
    `${raw}.ts`,
    `${raw}.tsx`,
    path.join(raw, 'index.ts'),
    path.join(raw, 'index.tsx'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate) && !candidate.endsWith('.d.ts')) return idOf(candidate)
  }
  throw new Error(`cannot resolve "${specifier}" from ${importerId}`)
}

/** TypeScript's transpile options for the host half (real ESM, imports kept). */
const HOST_TRANSPILE = {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    // Elide type-only imports so concatenation never leaves a dangling import.
    verbatimModuleSyntax: false,
    isolatedModules: true,
    esModuleInterop: true,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
  },
  fileName: 'module.ts',
}

/** TypeScript's transpile options for the browser half (CommonJS, require kept). */
const CLIENT_TRANSPILE = {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    jsx: ts.JsxEmit.ReactJSX,
    verbatimModuleSyntax: false,
    isolatedModules: true,
    esModuleInterop: true,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
  },
  fileName: 'module.tsx',
}

/** Transpile one TS/TSX source to JavaScript text. */
function transpile(source, filePath, options) {
  const result = ts.transpileModule(source, { ...options, fileName: path.basename(filePath) })
  const diagnostics = result.diagnostics ?? []
  if (diagnostics.length > 0) {
    const text = diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')).join('; ')
    throw new Error(`${idOf(filePath)}: ${text}`)
  }
  return result.outputText
}

/**
 * Compile one CSS module into an internal JavaScript module.
 *
 * Class names are namespaced by file, so a future plugin's selectors cannot
 * collide with this one's, and the generated code injects the sheet exactly once
 * with the tag the module system uses to release it on teardown.
 * @param id - the module id (used for the namespace and the style tag).
 * @param source - the stylesheet text.
 * @returns JavaScript module source exporting the class mapping.
 */
function compileCssModule(id, source) {
  const scope = path.basename(id, '.module.css')
  const renamed = new Map()
  const scoped = source.replace(/\.([A-Za-z_][\w-]*)(?=[^;{}]*\{)/gu, (match, name) => {
    const existing = renamed.get(name)
    if (existing !== undefined) return `.${existing}`
    const next = `${scope}_${name}`
    renamed.set(name, next)
    return `.${next}`
  })
  const mapping = Object.fromEntries([...renamed].map(([from, to]) => [from, to]))
  return [
    `"use strict";`,
    `Object.defineProperty(exports, "__esModule", { value: true });`,
    `const css = ${JSON.stringify(scoped)};`,
    `const tagId = ${JSON.stringify(`${PACKAGE_NAME}/${scope}`)};`,
    `if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {`,
    `  const style = document.createElement("style");`,
    `  style.setAttribute("data-plugin-css", tagId);`,
    `  style.textContent = css;`,
    `  document.head.appendChild(style);`,
    `}`,
    `exports.default = ${JSON.stringify(mapping)};`,
  ].join('\n')
}

/**
 * Collect every module reachable from one entry, transpiled to CommonJS.
 *
 * Relative `require(...)` calls in the emitted code drive discovery, so the
 * dependency graph comes from what the compiler actually emitted rather than
 * from a second scan of the TypeScript sources.
 * @param entryId - the entry module id.
 * @returns a map of module id to emitted CommonJS source.
 */
function collectClientModules(entryId) {
  const modules = new Map()
  const queue = [entryId]
  while (queue.length > 0) {
    const id = queue.shift()
    if (modules.has(id)) continue
    if (id === JSX_RUNTIME) {
      modules.set(id, [
        `"use strict";`,
        // Route the automatic JSX runtime through `react`, so the bundle depends
        // on one seeded module instead of two.
        `const React = require("react");`,
        `function jsx(type, props, key) {`,
        `  if (key === undefined) return React.createElement(type, props);`,
        `  return React.createElement(type, Object.assign({}, props, { key: key }));`,
        `}`,
        `exports.jsx = jsx;`,
        `exports.jsxs = jsx;`,
        `exports.Fragment = React.Fragment;`,
      ].join('\n'))
      continue
    }

    const absolute = fileOf(id)
    const source = require('node:fs').readFileSync(absolute, 'utf8')
    const emitted = id.endsWith('.module.css')
      ? compileCssModule(id, source)
      : transpile(source, absolute, CLIENT_TRANSPILE)
    modules.set(id, emitted)

    const seen = new Set()
    for (const match of emitted.matchAll(/require\((["'])([^"']+)\1\)/gu)) {
      const specifier = match[2]
      if (seen.has(specifier)) continue
      seen.add(specifier)
      if (specifier === 'react/jsx-runtime') { queue.push(JSX_RUNTIME); continue }
      if (isExternal(specifier, CLIENT_EXTERNALS, [])) continue
      if (!isInternalPath(specifier)) {
        throw new Error(`${id} imports "${specifier}", which is neither a seeded platform module nor a bundled source file; add it to CLIENT_EXTERNALS or inline it`)
      }
      const resolved = isInternalPath(specifier) && !specifier.startsWith('.')
        ? idOf(path.resolve(root, specifier))
        : resolveRelative(specifier, id)
      queue.push(resolved)
    }
  }
  return modules
}

/** Rewrite emitted common-js `require(...)` calls to internal registry lookups. */
function rewriteRelativeRequires(code, id) {
  return code.replace(/require\((["'])([^"']+)\1\)/gu, (match, quote, specifier) => {
    // The automatic JSX runtime is routed to the internal shim so the bundle
    // depends on `react` alone, which is the module the shell seeds.
    if (specifier === 'react/jsx-runtime') return `__dshRequire(${JSON.stringify(JSX_RUNTIME)})`
    if (!isInternalPath(specifier)) return match
    const resolved = specifier.startsWith('.')
      ? resolveRelative(specifier, id)
      : idOf(path.resolve(root, specifier))
    return `__dshRequire(${JSON.stringify(resolved)})`
  })
}

/** Emit the browser bundle wrapped in the loader's factory protocol. */
function emitClientBundle(modules, entryId) {
  const bodies = []
  for (const [id, code] of modules) {
    bodies.push(`${JSON.stringify(id)}: function (module, exports, require) {`)
    bodies.push(id === JSX_RUNTIME ? code : rewriteRelativeRequires(code, id))
    bodies.push('},')
  }
  return [
    'window.__ModuleLoader__.load({',
    `\tid: ${JSON.stringify(PACKAGE_NAME)},`,
    '\tfactory: (require) => {',
    '\t\tvar module = { exports: {} };',
    '\t\tvar exports = module.exports;',
    '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
    '\t\tvar __cache = new Map();',
    '\t\tvar __modules = {',
    ...bodies.map(line => `\t\t\t${line}`),
    '\t\t};',
    '\t\tfunction __dshRequire(id) {',
    '\t\t\tvar cached = __cache.get(id);',
    '\t\t\tif (cached !== undefined) return cached.exports;',
    '\t\t\tvar factory = __modules[id];',
    '\t\t\tif (factory === undefined) throw new Error(' + JSON.stringify(`${PACKAGE_NAME}: unknown bundled module `) + ' + id);',
    '\t\t\tvar record = { exports: {} };',
    '\t\t\t__cache.set(id, record);',
    '\t\t\tfactory(record, record.exports, __dshModuleRequire);',
    '\t\t\treturn record.exports;',
    '\t\t}',
    '\t\t// A bundled factory calling require() must reach the platform table for',
    '\t\t// seeded specifiers and the internal registry for everything bundled.',
    '\t\tfunction __dshModuleRequire(id) {',
    '\t\t\tif (__modules[id] !== undefined) return __dshRequire(id);',
    '\t\t\treturn require(id);',
    '\t\t}',
    '\t\t// The entry module owns the bundle\'s public exports. Dispatching it with',
    '\t\t// THIS module object (rather than a fresh record) is what makes the',
    '\t\t// loader see the real export surface.',
    `\t\tvar __entryFactory = __modules[${JSON.stringify(entryId)}];`,
    `\t\tif (__entryFactory === undefined) throw new Error(${JSON.stringify(`${PACKAGE_NAME}: entry module ${entryId} is missing from the bundle`)});`,
    `\t\t__cache.set(${JSON.stringify(entryId)}, module);`,
    '\t\t__entryFactory(module, exports, __dshModuleRequire);',
    '\t\treturn module.exports;',
    '\t}',
    '});',
    '',
  ].join('\n')
}

/**
 * Emit the host half as one ESM file.
 *
 * The host graph is a shallow tree with no cycles, so the modules concatenate
 * in dependency order: internal imports are dropped, external imports are
 * hoisted once, and the entry's public names are re-exported. This avoids a
 * runtime registry in the host, where a plain ESM module is what the loader
 * expects to import.
 */
function emitHostBundle(entryId) {
  const ordered = []
  const visited = new Set()
  /** Depth-first walk so a dependency always precedes its consumer. */
  const visit = (id) => {
    if (visited.has(id)) return
    visited.add(id)
    const absolute = fileOf(id)
    const source = require('node:fs').readFileSync(absolute, 'utf8')
    const emitted = transpile(source, absolute, { ...HOST_TRANSPILE, fileName: path.basename(absolute) })
    for (const match of emitted.matchAll(/^import\s[^;]*?from\s*(["'])([^"']+)\1;?$/gmu)) {
      const specifier = match[2]
      if (specifier.startsWith('.')) visit(resolveRelative(specifier, id))
    }
    ordered.push({ id, source, emitted })
  }
  visit(entryId)

  const externalImports = new Map()
  const chunks = []
  const exported = new Set()

  for (const { id, emitted } of ordered) {
    const kept = []
    for (const line of emitted.split('\n')) {
      const importMatch = /^import\s[^;]*?from\s*(["'])([^"']+)\1;?$/u.exec(line)
      if (importMatch !== null) {
        const specifier = importMatch[2]
        if (!specifier.startsWith('.')) externalImports.set(line, true)
        continue
      }
      const exportMatch = /^export\s+(?:declare\s+)?(const|let|var|function|class|async function)\s+([A-Za-z_$][\w$]*)/u.exec(line)
      if (exportMatch !== null) {
        exported.add(exportMatch[2])
        kept.push(line.replace(/^export\s+/u, ''))
        continue
      }
      if (/^export\s*\{/u.test(line)) {
        for (const name of line.replace(/^export\s*\{|\}\s*;?\s*$/gu, '').split(',')) {
          const trimmed = name.trim().split(/\s+as\s+/u).pop()?.trim()
          if (trimmed !== undefined && trimmed !== '') exported.add(trimmed)
        }
        continue
      }
      if (/^export\s+(interface|type)\s/u.test(line)) continue
      kept.push(line)
    }
    chunks.push(`// ---- ${id} ----`)
    chunks.push(kept.join('\n'))
  }

  const publicNames = ['name', 'inject', 'Config', 'apply', 'composeUserContent', 'resolveSystemPrompt', 'isChatModel', 'listProviderGroups', 'resolveSettingsNamespaceCompat', 'installSettingsSectionCompat', 'settingsNamespaceCompat', 'entryNamespaceOf', 'llmStream']
  const present = publicNames.filter(name => exported.has(name))

  return [
    ...externalImports.keys(),
    '',
    ...chunks,
    '',
    ...present.length === 0 ? [] : [`export { ${present.join(', ')} };`],
    '',
  ].join('\n')
}

/** One full build of both halves. */
async function buildAll() {
  await rm(OUT, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })

  const hostEntry = 'src/index.ts'
  await writeFile(path.join(OUT, 'index.js'), emitHostBundle(hostEntry))

  const clientEntry = 'src/client/index.tsx'
  const modules = collectClientModules(clientEntry)
  await writeFile(path.join(OUT, 'client.js'), emitClientBundle(modules, clientEntry))

  return { hostModules: 1, clientModules: modules.size }
}

const stats = await buildAll()
console.log(`built lib/index.js and lib/client.js (${stats.clientModules} bundled client modules)`)
