// Minimal ASAR reader: parse the header and list entries matching a pattern.
import { readFileSync } from 'node:fs'

const asar = process.argv[2]
const pattern = new RegExp(process.argv[3] ?? '.', 'i')
const buffer = readFileSync(asar)

// ASAR: 8-byte pickle prefix, then a uint32 JSON length at offset 12, then JSON.
const jsonSize = buffer.readUInt32LE(12)
const header = JSON.parse(buffer.toString('utf8', 16, 16 + jsonSize))

const results = []
function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const full = `${prefix}/${name}`
    if (entry.files) walk(entry, full)
    else if (pattern.test(full)) results.push({ path: full, size: entry.size })
  }
}
walk(header, '')
results.sort((a, b) => a.path.localeCompare(b.path))
for (const r of results.slice(0, 300)) console.log(`${String(r.size).padStart(9)}  ${r.path}`)
console.log(`--- total ${results.length} matches`)
