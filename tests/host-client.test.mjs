/**
 * The helper's host client against a local TCP server.
 *
 * These exercise the parts that are hard to see on screen: request/response
 * association, timeouts, an immediate failure when the channel drops, reconnect,
 * and a garbage frame that must not take the channel down.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

import { encodeFrame, createFrameDecoder } from '@dsh-pet-go/shared/protocol'
import { createHostClient } from '../packages/helper/src/host-client.ts'

/** Start a loopback server whose per-connection behaviour is the test. */
async function startServer (onConnection) {
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8')
    const decode = createFrameDecoder((frame) => receiver(frame, socket))
    socket.on('data', (chunk) => decode(chunk))
    socket.on('error', () => {})
  })
  const received = []
  const connections = []
  const receiver = (frame, socket) => {
    if (!connections.includes(socket)) connections.push(socket)
    received.push(frame)
    onConnection?.(frame, socket, received, connections)
  }
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    port,
    received,
    connections,
    async close () {
      for (const socket of connections) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** Poll until `predicate` is true, or fail the test after `timeoutMs`. */
async function waitFor (predicate, message, timeoutMs = 2000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${message}`)
}

function makeClient (options) {
  const frames = []
  const states = []
  const client = createHostClient({
    log: () => {},
    getEnvironment: () => ({ platform: 'test' }),
    onFrame: (frame) => frames.push(frame),
    onTransport: (state) => states.push(state),
    reconnectMs: 20,
    ...options,
  })
  return { client, frames, states }
}

test('the hello carries the token and the first request resolves by request id', async () => {
  const server = await startServer((frame, socket) => {
    if (frame.type !== 'submit') return
    socket.write(encodeFrame({
      v: 1,
      type: 'result',
      requestId: frame.requestId,
      ok: true,
      messageId: 'msg-1',
      sessionId: 'session-1',
    }))
  })
  const { client, states } = makeClient({ port: server.port, token: 'secret', platform: 'test/x64' })
  client.start()
  await waitFor(() => states.includes('connected'), 'connect')
  assert.deepEqual(server.received[0], {
    v: 1,
    type: 'hello',
    token: 'secret',
    platform: 'test/x64',
    capabilities: { capture: true, hotkey: true, bubble: true },
    env: { platform: 'test' },
  })

  const result = await client.request({ type: 'submit', text: 'hi', capture: { mode: 'none' }, image: null })
  assert.equal(result.ok, true)
  assert.equal(result.messageId, 'msg-1')
  assert.equal(result.sessionId, 'session-1')
  assert.ok(server.received[1].requestId, 'the request carries an id')

  client.stop()
  await server.close()
})

test('concurrent requests resolve their own answers', async () => {
  const server = await startServer((frame, socket) => {
    if (frame.type !== 'ping') return
    // Answer out of order: the second one first.
    socket.write(encodeFrame({ v: 1, type: 'result', requestId: frame.requestId, ok: frame.requestId.endsWith('1') }))
  })
  const { client, states } = makeClient({ port: server.port, token: 't', platform: 'test' })
  client.start()
  await waitFor(() => states.includes('connected'), 'connect')

  const [first, second] = await Promise.all([
    client.request({ type: 'ping' }),
    client.request({ type: 'ping' }),
  ])
  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  client.stop()
  await server.close()
})

test('no answer within the timeout resolves a retryable failure', async () => {
  const server = await startServer(() => {})
  const { client, states } = makeClient({ port: server.port, token: 't', platform: 'test' })
  client.start()
  await waitFor(() => states.includes('connected'), 'connect')
  const result = await client.request({ type: 'ping' }, 40)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'TIMEOUT')
  client.stop()
  await server.close()
})

test('a request made before connecting fails immediately, not after the timeout', async () => {
  const { client } = makeClient({ port: 1, token: 't', platform: 'test' })
  const result = await client.request({ type: 'ping' }, 5000)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'TRANSPORT_LOST')
})

test('a dropped connection fails pending requests right away', async () => {
  const server = await startServer((frame, socket) => {
    if (frame.type === 'ping') socket.destroy()
  })
  const { client, states } = makeClient({ port: server.port, token: 't', platform: 'test' })
  client.start()
  await waitFor(() => states.includes('connected'), 'connect')
  const startedAt = Date.now()
  const result = await client.request({ type: 'ping' }, 3000)
  assert.equal(result.code, 'TRANSPORT_LOST')
  assert.ok(Date.now() - startedAt < 1000, 'must not wait for the timeout')
  assert.ok(states.includes('lost'))
  client.stop()
  await server.close()
})

test('the client reconnects after a drop', async () => {
  const server = await startServer((frame, socket, received) => {
    if (frame.type === 'hello' && received.filter((item) => item.type === 'hello').length === 1) {
      socket.destroy()
    }
  })
  const { client, states } = makeClient({ port: server.port, token: 't', platform: 'test' })
  client.start()
  await waitFor(() => server.received.filter((frame) => frame.type === 'hello').length >= 2, 'second hello')
  assert.deepEqual(states.slice(0, 3), ['connected', 'lost', 'connected'])
  assert.ok(client.connected)
  client.stop()
  await server.close()
})

test('stop() ends reconnection and fails whatever was pending', async () => {
  const server = await startServer(() => {})
  const { client, states } = makeClient({ port: server.port, token: 't', platform: 'test' })
  client.start()
  await waitFor(() => states.includes('connected'), 'connect')
  const pending = client.request({ type: 'ping' }, 5000)
  client.stop()
  const result = await pending
  assert.equal(result.code, 'TRANSPORT_LOST')
  assert.equal(client.connected, false)
  const helloCount = server.received.filter((frame) => frame.type === 'hello').length
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(server.received.filter((frame) => frame.type === 'hello').length, helloCount, 'no reconnect after stop')
  await server.close()
})

test('a malformed frame is logged and skipped, the next answer still arrives', async () => {
  const logs = []
  const server = await startServer((frame, socket) => {
    if (frame.type !== 'ping') return
    socket.write('{not json}\n')
    socket.write(encodeFrame({ v: 1, type: 'nonsense' }))
    socket.write(encodeFrame({ v: 1, type: 'result', requestId: frame.requestId, ok: true }))
  })
  const { client, states } = makeClient({
    port: server.port,
    token: 't',
    platform: 'test',
    log: (line) => logs.push(line),
  })
  client.start()
  await waitFor(() => states.includes('connected'), 'connect')
  const result = await client.request({ type: 'ping' })
  assert.equal(result.ok, true)
  assert.ok(logs.some((line) => line.includes('host frame rejected')))
  client.stop()
  await server.close()
})

test('an answer frame reaches the application untouched', async () => {
  const server = await startServer((frame, socket) => {
    if (frame.type !== 'ping') return
    socket.write(encodeFrame({ v: 1, type: 'answer', phase: 'delta', text: '你好' }))
    socket.write(encodeFrame({ v: 1, type: 'result', requestId: frame.requestId, ok: true }))
  })
  const { client, frames, states } = makeClient({ port: server.port, token: 't', platform: 'test' })
  client.start()
  await waitFor(() => states.includes('connected'), 'connect')
  await client.request({ type: 'ping' })
  const answer = frames.find((frame) => frame.type === 'answer')
  assert.deepEqual(answer, { v: 1, type: 'answer', phase: 'delta', text: '你好', ok: undefined, detail: undefined })
  client.stop()
  await server.close()
})
