import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PROTOCOL_VERSION, CAPTURE_MODE, parseClientFrame, parseHostFrame } from '@dsh-pet-go/shared/protocol'

const HELLO = {
  v: PROTOCOL_VERSION,
  type: 'hello',
  token: 'secret',
  platform: 'win32/x64',
  capabilities: { capture: true, hotkey: true, bubble: true },
  env: { platform: 'win32/x64', os: 'Windows_NT' },
}

test('a well-formed hello parses with its facts', () => {
  const parsed = parseClientFrame(HELLO)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.frame.type, 'hello')
  assert.equal(parsed.frame.token, 'secret')
  assert.equal(parsed.frame.env?.platform, 'win32/x64')
})

test('hello without a token or platform is refused', () => {
  assert.equal(parseClientFrame({ ...HELLO, token: undefined }).ok, false)
  assert.equal(parseClientFrame({ ...HELLO, platform: undefined }).ok, false)
})

test('a submit frame needs a request id, text and a known capture mode', () => {
  const base = { v: 1, type: 'submit', requestId: 'req-1', text: '看这个', capture: { mode: CAPTURE_MODE.screen }, image: null }
  const parsed = parseClientFrame(base)
  assert.equal(parsed.ok, true)
  if (parsed.ok && parsed.frame.type === 'submit') {
    assert.equal(parsed.frame.capture.mode, CAPTURE_MODE.screen)
    assert.equal(parsed.frame.image, null)
  }
  assert.equal(parseClientFrame({ ...base, requestId: undefined }).ok, false)
  assert.equal(parseClientFrame({ ...base, text: undefined }).ok, false)
  assert.equal(parseClientFrame({ ...base, capture: { mode: 'video' } }).ok, false)
  assert.equal(parseClientFrame({ ...base, image: { base64: 'x' } }).ok, false)
})

test('text-only submit carries image: null, screen submit carries the payload', () => {
  const textOnly = parseClientFrame({ v: 1, type: 'submit', requestId: 'r', text: 'hi', capture: { mode: 'none' }, image: null })
  assert.equal(textOnly.ok, true)
  const withImage = parseClientFrame({
    v: 1,
    type: 'submit',
    requestId: 'r',
    text: 'hi',
    capture: { mode: 'screen' },
    image: { base64: 'AAAA', mediaType: 'image/png', width: 2562, height: 1602 },
  })
  assert.equal(withImage.ok, true)
  if (withImage.ok && withImage.frame.type === 'submit') assert.equal(withImage.frame.image?.width, 2562)
})

test('each direction rejects the other side’s frames', () => {
  assert.equal(parseClientFrame({ v: 1, type: 'welcome', sessionId: null }).ok, false)
  assert.equal(parseHostFrame(HELLO).ok, false)
})

test('unknown or malformed types are refused with a reason', () => {
  assert.equal(parseClientFrame({ v: 1, type: 'teleport' }).ok, false)
  assert.equal(parseClientFrame(null).ok, false)
  assert.equal(parseClientFrame({ type: 'ping', requestId: 'x' }).ok, false, 'version is required')
  const parsed = parseClientFrame({ v: 1, type: 'ping' })
  assert.equal(parsed.ok, false)
  if (!parsed.ok) assert.match(parsed.reason, /requestId/)
})

test('extra fields are ignored so a newer helper stays compatible', () => {
  const parsed = parseClientFrame({ ...HELLO, futureField: { nested: true } })
  assert.equal(parsed.ok, true)
})

test('welcome normalises a missing model and protocol', () => {
  const parsed = parseHostFrame({ v: 1, type: 'welcome', sessionId: null, model: null, state: 'idle', protocol: 1 })
  assert.equal(parsed.ok, true)
  if (parsed.ok && parsed.frame.type === 'welcome') {
    assert.equal(parsed.frame.sessionId, null)
    assert.equal(parsed.frame.protocol, 1)
  }
})

test('result must say whether it succeeded', () => {
  assert.equal(parseHostFrame({ v: 1, type: 'result', ok: true, requestId: 'r' }).ok, true)
  assert.equal(parseHostFrame({ v: 1, type: 'result', requestId: 'r' }).ok, false)
})

test('answer phases are closed: only start, tool, delta and end', () => {
  for (const phase of ['start', 'tool', 'delta', 'end']) {
    assert.equal(parseHostFrame({ v: 1, type: 'answer', phase }).ok, true, phase)
  }
  assert.equal(parseHostFrame({ v: 1, type: 'answer', phase: 'thinking' }).ok, false)
})

test('session and state frames keep their required fields', () => {
  assert.equal(parseHostFrame({ v: 1, type: 'session', sessionId: 'session-1' }).ok, true)
  assert.equal(parseHostFrame({ v: 1, type: 'session' }).ok, false)
  assert.equal(parseHostFrame({ v: 1, type: 'state', state: 'running' }).ok, true)
  assert.equal(parseHostFrame({ v: 1, type: 'state' }).ok, false)
})
