/**
 * The transport's own lifecycle guarantees, without the companion on top:
 * a close that lands while the listener is still binding must not leave a
 * socket behind, and replies must target the connection they belong to.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

import { createFrameDecoder, encodeFrame } from '@dsh-pet-go/shared/protocol'
import { createTransport } from '../packages/host/src/transport/server.ts'

function createBareTransport (overrides = {}) {
  return createTransport({
    token: 'token',
    log: () => {},
    onClient: () => {},
    onFrame: () => {},
    onDisconnect: () => {},
    ...overrides,
  })
}

/** Resolve to the connection error, or null when something accepted it. */
function probe (port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(new Error('connect timed out'))
    }, 2000)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(null)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      resolve(error)
    })
  })
}

const HELLO = {
  v: 1,
  type: 'hello',
  token: 'token',
  platform: 'test',
  capabilities: { capture: true, hotkey: true, bubble: true },
  env: null,
}

/** Connect and collect decoded frames. */
async function connect (port) {
  const socket = net.connect(port, '127.0.0.1')
  socket.setEncoding('utf8')
  const frames = []
  const decode = createFrameDecoder((frame) => frames.push(frame))
  socket.on('data', (chunk) => decode(chunk))
  socket.on('error', () => {})
  await new Promise((resolve) => socket.once('connect', resolve))
  return {
    socket,
    frames,
    send: (frame) => socket.write(encodeFrame(frame)),
    close: () => socket.destroy(),
  }
}

test('closing while the listener is still binding leaves nothing listening', async () => {
  const transport = createBareTransport()
  const listening = transport.listen()
  transport.close()
  const port = await listening
  const error = await probe(port)
  assert.ok(error, 'the port must not accept connections after close()')
})

test('a reply goes to the connection that asked, not to a later one', async () => {
  let releaseReply
  const replyGate = new Promise((resolve) => { releaseReply = resolve })
  const transport = createBareTransport({
    onClient: (_hello, connection) => {
      connection.send({ type: 'welcome', sessionId: null, model: null, state: 'idle', protocol: 1 })
    },
    onFrame: (frame, connection) => {
      // Answer once the test has replaced the connection.
      void replyGate.then(() => {
        connection.send({ type: 'result', requestId: frame.requestId, ok: true })
      })
    },
  })
  const port = await transport.listen()
  const first = await connect(port)
  try {
    first.send(HELLO)
    await new Promise((resolve) => setTimeout(resolve, 20))
    first.send({ v: 1, type: 'ping', requestId: 'req-1' })

    // A second connection replaces the first while the reply is still pending.
    const second = await connect(port)
    try {
      second.send(HELLO)
      const started = Date.now()
      while (!second.frames.some((frame) => frame.type === 'welcome') && Date.now() - started < 2000) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      assert.ok(second.frames.some((frame) => frame.type === 'welcome'), 'the replacement is attached')

      releaseReply()
      await new Promise((resolve) => setTimeout(resolve, 80))

      assert.deepEqual(second.frames.map((frame) => frame.type), ['welcome'], 'the new connection sees only its own welcome')
      assert.equal(first.frames.some((frame) => frame.type === 'result'), false, 'the answer was dropped with its connection')
    } finally {
      second.close()
    }
  } finally {
    first.close()
    transport.close()
  }
})
