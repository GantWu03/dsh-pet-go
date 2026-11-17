/**
 * Print the system prompt a session actually ran with, plus how many tools it saw.
 *
 * The session log is a zstd frame per record; there is no public container parser,
 * so locate frame magic bytes and decompress each frame independently.
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
if (!file) {
  console.error('usage: node show-system-prompt.mjs <session.v4.jsonl.zstd>')
  process.exit(1)
}

const buffer = readFileSync(file)
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const chunks = []
for (let i = 0; i < buffer.length - 4; i += 1) {
  if (buffer[i] !== MAGIC[0] || buffer[i + 1] !== MAGIC[1] || buffer[i + 2] !== MAGIC[2] || buffer[i + 3] !== MAGIC[3]) continue
  try { chunks.push(zstdDecompressSync(buffer.subarray(i)).toString('utf8')) } catch {}
}

const events = []
for (const line of chunks.join('\n').split('\n')) {
  if (!line.trim()) continue
  try { events.push(JSON.parse(line)) } catch {}
}

const text = (content) => (Array.isArray(content) ? content.map((c) => c?.text ?? '').join('') : String(content ?? ''))

let system = null
let toolCalls = 0
let steps = 0
for (const event of events) {
  const data = event.data ?? {}
  if (event.type === 'system/message') system = text(data.message?.content)
  if (event.type === 'tool/call') toolCalls += 1
  if (event.type === 'step/start') steps += 1
}

console.log(`file: ${file}`)
console.log(`events=${events.length} steps=${steps} toolCalls=${toolCalls}`)
if (system === null) {
  console.log('\nno system/message recorded in this session')
} else {
  console.log('\n=== system prompt (first 2000 chars) ===')
  console.log(system.slice(0, 2000))
  console.log('\n=== checks ===')
  console.log(`contains "You are a coding agent": ${system.includes('You are a coding agent')}`)
  console.log(`contains companion identity      : ${system.includes('你是持续陪伴用户的桌宠')}`)
  console.log(`contains "桌面伙伴"-style opening : ${system.includes('就像你们一起看着同一块屏幕')}`)
}
