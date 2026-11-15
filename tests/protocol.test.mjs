import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PROTOCOL_VERSION,
  ClientType,
  HostType,
  CAPTURE_MODE,
  MAX_FRAME_BYTES,
  FrameError,
  encodeFrame,
  createFrameDecoder,
} from '@dsh-pet-go/shared/protocol'

/** Collect frames a decoder emits, so assertions read as data. */
function collect (options = {}) {
  const frames = []
  const errors = []
  const decode = createFrameDecoder((frame) => frames.push(frame), {
    ...options,
    onError: (error) => errors.push(error),
  })
  return { frames, errors, decode }
}

test('v1 constants cover both directions', () => {
  assert.equal(PROTOCOL_VERSION, 1)
  assert.deepEqual(Object.values(ClientType).sort(), ['env', 'hello', 'new-session', 'ping', 'submit'])
  assert.deepEqual(Object.values(HostType).sort(), ['answer', 'result', 'session', 'state', 'welcome'])
  assert.deepEqual(Object.values(CAPTURE_MODE).sort(), ['none', 'screen'])
})

test('encodeFrame is one JSON line and round-trips', () => {
  const frame = { v: 1, type: 'submit', requestId: 'req-1', text: '看一下这个' }
  const line = encodeFrame(frame)
  assert.ok(line.endsWith('\n'))
  assert.equal(line.slice(0, -1).includes('\n'), false)
  const { frames, decode } = collect()
  decode(line)
  assert.deepEqual(frames, [frame])
})

test('several frames in one chunk are all delivered', () => {
  const { frames, decode } = collect()
  decode(encodeFrame({ type: 'ping', requestId: 'a' }) + encodeFrame({ type: 'ping', requestId: 'b' }))
  assert.deepEqual(frames.map((frame) => frame.requestId), ['a', 'b'])
})

test('a frame split across chunks is delivered once', () => {
  const { frames, decode } = collect()
  const line = encodeFrame({ type: 'welcome', sessionId: 'session-1', protocol: 1 })
  for (const piece of [line.slice(0, 5), line.slice(5, 17), line.slice(17)]) decode(piece)
  assert.deepEqual(frames, [{ type: 'welcome', sessionId: 'session-1', protocol: 1 }])
})

test('a multi-byte character split across Buffer chunks still decodes', () => {
  const { frames, decode } = collect()
  const bytes = Buffer.from(encodeFrame({ type: 'submit', text: '你好呀' }), 'utf8')
  // Split inside the first Chinese character (3 bytes) to exercise StringDecoder.
  const cut = bytes.indexOf(Buffer.from('你', 'utf8')) + 1
  decode(bytes.subarray(0, cut))
  decode(bytes.subarray(cut))
  assert.deepEqual(frames, [{ type: 'submit', text: '你好呀' }])
})

test('corrupt and blank lines are skipped without losing the channel', () => {
  const { frames, decode } = collect()
  decode('\n')
  decode('{not json}\n')
  decode(encodeFrame({ type: 'ping', requestId: 'after' }))
  assert.deepEqual(frames, [{ type: 'ping', requestId: 'after' }])
})

test('a pending line over the limit is refused and the channel recovers', () => {
  const { frames, errors, decode } = collect({ maxFrameBytes: 64 })
  decode('x'.repeat(65))
  assert.equal(errors.length, 1)
  assert.ok(errors[0] instanceof FrameError)
  assert.equal(errors[0].code, 'FRAME_TOO_LARGE')
  decode(encodeFrame({ type: 'ping', requestId: 'after' }))
  assert.deepEqual(frames, [{ type: 'ping', requestId: 'after' }])
})

test('a complete line over the limit is refused', () => {
  const { frames, errors, decode } = collect({ maxFrameBytes: 32 })
  decode(encodeFrame({ type: 'submit', text: 'y'.repeat(64) }) + '\n')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, 'FRAME_TOO_LARGE')
  assert.deepEqual(frames, [])
})

test('the ceiling leaves room for the largest screenshot DSH accepts', () => {
  // DSH imageLimits.maxImageBytes is 50MB; base64 inflates by 4/3.
  const base64OfLargestImage = 50 * 1024 * 1024 * (4 / 3)
  assert.ok(MAX_FRAME_BYTES > base64OfLargestImage)
})
