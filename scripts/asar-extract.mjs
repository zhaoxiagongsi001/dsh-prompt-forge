// Minimal ASAR extractor: pull one entry (or all entries matching a pattern) out of an asar.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const asar = process.argv[2]
const pattern = new RegExp(process.argv[3] ?? '.', 'i')
const outRoot = resolve(process.argv[4] ?? '.')

const buffer = readFileSync(asar)
const jsonSize = buffer.readUInt32LE(12)
const header = JSON.parse(buffer.toString('utf8', 16, 16 + jsonSize))
// File data begins after the 8-byte pickle prefix + the header JSON payload.
const dataStart = 8 + buffer.readUInt32LE(4)

const results = []
function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const full = `${prefix}/${name}`
    if (entry.files) walk(entry, full)
    else if (pattern.test(full)) results.push({ path: full, size: entry.size, offset: Number(entry.offset) })
  }
}
walk(header, '')

let written = 0
for (const entry of results) {
  const target = join(outRoot, entry.path.replace(/^\//, ''))
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, buffer.subarray(dataStart + entry.offset, dataStart + entry.offset + entry.size))
  written += 1
}
console.log(`extracted ${written} file(s) to ${outRoot}`)
