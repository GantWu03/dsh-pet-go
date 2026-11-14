/**
 * Read a DSH session log and print the tool-call trace.
 *
 * The file is append-only: a zstd frame per record, separated by small binary
 * headers. There is no documented public container parser here, so we locate
 * frame magic bytes and decompress each frame independently.
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
if (!file) {
  console.error('usage: node dump-session.mjs <session.v4.jsonl.zstd> [maxChars]')
  process.exit(1)
}
const maxChars = Number(process.argv[3] ?? 220)

const buffer = readFileSync(file)
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

const records = []
for (let index = 0; index < buffer.length - 4; index += 1) {
  if (buffer[index] !== MAGIC[0] || buffer[index + 1] !== MAGIC[1]
    || buffer[index + 2] !== MAGIC[2] || buffer[index + 3] !== MAGIC[3]) continue
  try {
    const out = zstdDecompressSync(buffer.subarray(index))
    records.push(out.toString('utf8'))
  } catch {}
}

const lines = records.join('\n').split('\n').filter((line) => line.trim() !== '')
console.log(`records: ${records.length}  lines: ${lines.length}`)

let step = 0
for (const line of lines) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    continue
  }
  const type = event.type
  const data = event.data ?? {}
  if (type === 'tool/call') {
    step += 1
    const args = String(data.arguments ?? '').replace(/\s+/g, ' ')
    console.log(`\n#${step} CALL ${data.name}`)
    console.log(`   args: ${args.slice(0, 400)}`)
  } else if (type === 'tool/result') {
    const text = JSON.stringify(data.message?.content ?? '').replace(/\\n/g, ' ')
    const err = data.error ? ` ERROR ${data.error.code ?? ''} ${data.error.reason ?? ''}` : ''
    console.log(`   result${err}: ${text.slice(0, maxChars)}`)
  } else if (type === 'assistant/message') {
    const blocks = data.message?.content ?? []
    const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join(' ')
    if (text.trim()) console.log(`\nASSISTANT: ${text.replace(/\s+/g, ' ').slice(0, maxChars)}`)
  }
}
