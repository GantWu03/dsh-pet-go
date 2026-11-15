/**
 * The host plugin end to end, without DSH and without Electron.
 *
 * A fake DSH provides sessions, attachments and the agent event stream; the real
 * transport, session manager, submitter and relay run unchanged over a real
 * loopback TCP connection, so the handshake, frame shapes and lifecycle are the
 * shipped code.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { encodeFrame, createFrameDecoder } from '@dsh-pet-go/shared/protocol'
import { CompanionService } from '../packages/host/src/companion.ts'

const TOKEN = 'test-token'

/** A fake DSH: sessions in memory, attachments recorded, events pushed on demand. */
function createFakeDsh () {
  const agents = new Map()
  const submitted = []
  const attached = []
  const images = []
  const listeners = new Set()
  const state = { createCount: 0, failCreate: false, failImage: false }

  const makeHandle = (id) => {
    const agent = {
      id,
      status: 'idle',
      granted: false,
      appended: [],
      session: { append: (type, payload) => agent.appended.push({ type, payload }) },
      followup: () => {},
      dispose: async () => { agents.delete(id) },
    }
    agents.set(id, agent)
    return { agent, dispose: agent.dispose }
  }

  return {
    submitted,
    attached,
    images,
    state,
    sessions: {
      currentModel: () => ({ provider: 'fake-provider', model: 'fake-model' }),
      resume: async (id) => makeHandle(id),
      create: async ({ sessionId }) => {
        state.createCount += 1
        if (state.failCreate) throw new Error('create boom')
        return makeHandle(sessionId)
      },
      liveAgent: (id) => agents.get(id) ?? null,
      agentStatus: (id) => agents.get(id)?.status ?? 'idle',
      grantFullAccess: (agent) => { agent.granted = true },
      attachToWorkspace: async (id) => { attached.push(id) },
      rename: async () => {},
      followup: (agent, message) => { submitted.push({ agentId: agent.id, message }) },
      saveImage: async (input) => {
        if (state.failImage) throw new Error('image too big')
        images.push(input)
        return { id: `att-${images.length}` }
      },
    },
    events: {
      subscribe (listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    emit (event) {
      for (const listener of listeners) listener(event)
    },
  }
}

/** One connected test client with frame waiting. */
function createClient (port) {
  const socket = net.connect(port, '127.0.0.1')
  socket.setEncoding('utf8')
  const frames = []
  const decode = createFrameDecoder((frame) => frames.push(frame))
  socket.on('data', (chunk) => decode(chunk))
  socket.on('error', () => {})
  let closed = false
  socket.on('close', () => { closed = true })

  return {
    frames,
    send: (frame) => socket.write(encodeFrame({ v: 1, ...frame })),
    raw: (text) => socket.write(text),
    isClosed: () => closed,
    async waitFor (predicate, label = 'frame', timeoutMs = 2000) {
      const started = Date.now()
      while (Date.now() - started < timeoutMs) {
        const found = frames.find(predicate)
        if (found) return found
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      throw new Error(`timed out waiting for ${label}; saw ${JSON.stringify(frames)}`)
    },
    close: () => socket.destroy(),
  }
}

async function startCompanion (options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pet-integration-'))
  const fake = createFakeDsh()
  const lines = []
  const service = new CompanionService({
    config: {},
    paths: {
      dshHome: root,
      companionDir: join(root, 'companion'),
      workspaceDir: join(root, 'companion', 'workspace'),
      envDir: join(root, 'state'),
      stateFile: join(root, 'companion', 'state.json'),
      logFile: join(root, 'companion', 'host.log'),
    },
    repoRoot: join(root, 'repo'),
    adapter: { sessions: fake.sessions, events: fake.events },
    workspace: { ensure: async () => {} },
    log: (line) => lines.push(line),
    token: TOKEN,
    supervisor: { start: () => {}, stop: () => {}, resetBackoff: () => {} },
    ...options,
  })
  await service.start()
  const listening = lines.find((line) => line.startsWith('listening on 127.0.0.1:'))
  assert.ok(listening, `service did not listen: ${lines.join(' / ')}`)
  const port = Number(listening.split(':').pop())
  return { service, fake, lines, port }
}

/** Run against a live service; the service is always disposed afterwards. */
async function withCompanion (run) {
  const harness = await startCompanion()
  try {
    return await run(harness)
  } finally {
    harness.service.dispose()
  }
}

/** A connected, greeted client (welcome may still be arriving). */
async function withClient (run, hello = {}) {
  return await withCompanion(async (harness) => {
    const client = createClient(harness.port)
    try {
      client.send({
        type: 'hello',
        token: TOKEN,
        platform: 'test/x64',
        capabilities: { capture: true, hotkey: true, bubble: true },
        env: { platform: 'test/x64', os: 'FakeOS' },
        ...hello,
      })
      return await run({ ...harness, client })
    } finally {
      client.close()
    }
  })
}

/** A connection that has not said anything yet. */
async function withRawClient (run) {
  return await withCompanion(async (harness) => {
    const client = createClient(harness.port)
    try {
      return await run({ ...harness, client })
    } finally {
      client.close()
    }
  })
}

/** Submit a text question and return the submission result. */
async function submitText (client, requestId, text = '嗨') {
  client.send({ type: 'submit', requestId, text, capture: { mode: 'none' }, image: null })
  return await client.waitFor((frame) => frame.type === 'result' && frame.requestId === requestId, 'submit result')
}

test('the handshake answers a welcome with the model and protocol', async () => {
  await withClient(async ({ client, fake }) => {
    const welcome = await client.waitFor((frame) => frame.type === 'welcome', 'welcome')
    assert.equal(welcome.protocol, 1)
    assert.equal(welcome.sessionId, null, 'no session yet: the helper sees an empty session')
    assert.deepEqual(welcome.model, { provider: 'fake-provider', model: 'fake-model' })
    assert.equal(welcome.state, 'idle')
    assert.equal(fake.submitted.length, 0)
  })
})

test('a wrong token is refused by closing the connection', async () => {
  await withRawClient(async ({ client }) => {
    client.send({ type: 'hello', token: 'wrong', platform: 'test/x64', capabilities: { capture: true, hotkey: true, bubble: true }, env: null })
    const started = Date.now()
    while (!client.isClosed() && Date.now() - started < 1000) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(client.isClosed(), true)
    assert.deepEqual(client.frames.filter((frame) => frame.type === 'welcome'), [])
  })
})

test('a protocol mismatch is answered before the connection closes', async () => {
  await withRawClient(async ({ client }) => {
    client.send({ v: 2, type: 'hello', token: TOKEN, platform: 'test/x64', capabilities: { capture: true, hotkey: true, bubble: true }, env: null })
    const result = await client.waitFor((frame) => frame.type === 'result', 'mismatch result')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'PROTOCOL_MISMATCH')
  })
})

test('a text submission becomes one user message and is acknowledged', async () => {
  await withClient(async ({ client, fake }) => {
    await client.waitFor((frame) => frame.type === 'welcome', 'welcome')
    client.send({ type: 'submit', requestId: 'req-1', text: '  这个怎么读  ', capture: { mode: 'none' }, image: null })
    const result = await client.waitFor((frame) => frame.type === 'result' && frame.requestId === 'req-1', 'submit result')

    assert.equal(result.ok, true)
    assert.ok(result.messageId)
    assert.ok(result.sessionId)
    const { message } = fake.submitted[0]
    assert.equal(message.role, 'user')
    assert.deepEqual(message.content, [{ type: 'text', text: '这个怎么读' }])

    const agent = fake.sessions.liveAgent(result.sessionId)
    assert.equal(agent.granted, true, 'the session gets full access')
    assert.ok(fake.attached.includes(result.sessionId), 'and it is registered in the workspace')
  })
})

test('a screenshot submission carries an attachment block', async () => {
  await withClient(async ({ client, fake }) => {
    await client.waitFor((frame) => frame.type === 'welcome', 'welcome')
    const png = Buffer.from('fake-png-bytes').toString('base64')
    client.send({
      type: 'submit',
      requestId: 'req-img',
      text: '看这个',
      capture: { mode: 'screen' },
      image: { base64: png, mediaType: 'image/png', width: 10, height: 20 },
    })
    const result = await client.waitFor((frame) => frame.type === 'result' && frame.requestId === 'req-img', 'submit result')
    assert.equal(result.ok, true)
    assert.equal(fake.images.length, 1)
    assert.equal(fake.images[0].mediaType, 'image/png')
    assert.equal(fake.images[0].name, 'companion-screen.png')
    assert.equal(Buffer.from(fake.images[0].data).toString(), 'fake-png-bytes')
    assert.deepEqual(fake.submitted[0].message.content.map((block) => block.type), ['text', 'image'])
  })
})

test('an empty submission is a bad request, not an image failure', async () => {
  await withClient(async ({ client, fake }) => {
    await client.waitFor((frame) => frame.type === 'welcome', 'welcome')
    client.send({ type: 'submit', requestId: 'req-empty', text: '   ', capture: { mode: 'none' }, image: null })
    const result = await client.waitFor((frame) => frame.type === 'result' && frame.requestId === 'req-empty', 'result')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'BAD_REQUEST')
    assert.equal(result.retryable, false)
    assert.equal(fake.submitted.length, 0)
  })
})

test('a failed attachment save is reported as an image failure', async () => {
  await withClient(async ({ client, fake }) => {
    fake.state.failImage = true
    await client.waitFor((frame) => frame.type === 'welcome', 'welcome')
    client.send({
      type: 'submit',
      requestId: 'req-big',
      text: '看图',
      capture: { mode: 'screen' },
      image: { base64: Buffer.from('x').toString('base64'), mediaType: 'image/png' },
    })
    const result = await client.waitFor((frame) => frame.type === 'result' && frame.requestId === 'req-big', 'result')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'IMAGE_TOO_LARGE')
    assert.equal(fake.submitted.length, 0)
  })
})

test('a new session replaces the current one and old events stop reaching the bubble', async () => {
  await withClient(async ({ client, fake }) => {
    await client.waitFor((frame) => frame.type === 'welcome', 'welcome')
    const first = await submitText(client, 'req-old', '第一句')

    client.send({ type: 'new-session', requestId: 'req-new' })
    const sessionFrame = await client.waitFor((frame) => frame.type === 'session', 'session frame')
    const result = await client.waitFor((frame) => frame.type === 'result' && frame.requestId === 'req-new', 'new result')
    assert.equal(result.ok, true)
    assert.notEqual(sessionFrame.sessionId, first.sessionId)

    const before = client.frames.length
    fake.emit({ kind: 'stream-start', agentId: first.sessionId })
    fake.emit({ kind: 'text-delta', agentId: first.sessionId, text: '旧回答' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(client.frames.length, before, 'a late event for the old session must not appear')

    fake.emit({ kind: 'stream-start', agentId: sessionFrame.sessionId })
    const answer = await client.waitFor((frame) => frame.type === 'answer', 'answer start')
    assert.equal(answer.phase, 'start')
  })
})

test('a failed session creation keeps the usable session', async () => {
  await withClient(async ({ client, fake }) => {
    await client.waitFor((frame) => frame.type === 'welcome', 'welcome')
    const first = await submitText(client, 'req-1', '你好')

    fake.state.failCreate = true
    client.send({ type: 'new-session', requestId: 'req-new' })
    const failed = await client.waitFor((frame) => frame.type === 'result' && frame.requestId === 'req-new', 'new result')
    assert.equal(failed.ok, false)

    const second = await submitText(client, 'req-2', '还在吗')
    assert.equal(second.ok, true)
    assert.equal(second.sessionId, first.sessionId, 'the previous session is still the target')
  })
})

test('the assistant stream becomes bubble frames', async () => {
  await withClient(async ({ client, fake }) => {
    await client.waitFor((frame) => frame.type === 'welcome', 'welcome')
    const submitted = await submitText(client, 'req-1', '查一下')

    fake.emit({ kind: 'stream-start', agentId: submitted.sessionId })
    fake.emit({ kind: 'tool-call-start', agentId: submitted.sessionId })
    fake.emit({ kind: 'text-delta', agentId: submitted.sessionId, text: '正在' })
    fake.emit({ kind: 'text-delta', agentId: submitted.sessionId, text: '查看' })
    fake.emit({ kind: 'stream-end', agentId: submitted.sessionId, committed: true })

    await client.waitFor(() => client.frames.filter((frame) => frame.type === 'answer').length >= 5, 'answer frames')
    const answers = client.frames.filter((frame) => frame.type === 'answer')
    assert.deepEqual(answers.map((frame) => frame.phase), ['start', 'tool', 'delta', 'delta', 'end'])
    assert.equal(answers.at(-1).ok, true)
    assert.deepEqual(answers.filter((frame) => frame.phase === 'delta').map((frame) => frame.text), ['正在', '查看'])
  })
})

test('status and errors reach the bubble as state and end frames', async () => {
  await withClient(async ({ client, fake }) => {
    await client.waitFor((frame) => frame.type === 'welcome', 'welcome')
    const submitted = await submitText(client, 'req-1', '嗨')

    fake.emit({ kind: 'status', agentId: submitted.sessionId, status: 'running' })
    const state = await client.waitFor((frame) => frame.type === 'state', 'state frame')
    assert.equal(state.state, 'running')

    fake.emit({ kind: 'error', agentId: submitted.sessionId, message: '模型超时' })
    const ended = await client.waitFor((frame) => frame.type === 'answer' && frame.phase === 'end', 'end frame')
    assert.equal(ended.ok, false)
    assert.equal(ended.detail, '模型超时')
  })
})

test('garbled JSON is ignored while a structurally invalid frame is a bad request', async () => {
  await withClient(async ({ client }) => {
    await client.waitFor((frame) => frame.type === 'welcome', 'welcome')

    client.raw('{not json}\n')
    client.send({ type: 'teleport', requestId: 'req-weird' })
    const result = await client.waitFor((frame) => frame.type === 'result' && frame.ok === false, 'bad request result')
    assert.equal(result.code, 'BAD_REQUEST')

    // The channel is still usable after both kinds of bad input.
    client.send({ type: 'ping', requestId: 'req-ping' })
    const pong = await client.waitFor((frame) => frame.type === 'result' && frame.requestId === 'req-ping', 'ping result')
    assert.equal(pong.ok, true)
  })
})

test('the env frame refreshes AGENTS.md', async () => {
  await withClient(async ({ client, lines }) => {
    await client.waitFor((frame) => frame.type === 'welcome', 'welcome')
    client.send({ type: 'env', env: { platform: 'test/x64', os: 'FakeOS 2', home: '/home/test' } })
    const started = Date.now()
    while (!lines.includes('AGENTS.md written') && Date.now() - started < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.ok(lines.includes('AGENTS.md written'))
  })
})

test('a restored session is resumed instead of created again', async () => {
  // First run creates a session and persists its id.
  const root = await mkdtemp(join(tmpdir(), 'dsh-pet-restore-'))
  const paths = {
    dshHome: root,
    companionDir: join(root, 'companion'),
    workspaceDir: join(root, 'companion', 'workspace'),
    envDir: join(root, 'state'),
    stateFile: join(root, 'companion', 'state.json'),
    logFile: join(root, 'companion', 'host.log'),
  }
  const firstFake = createFakeDsh()
  const first = new CompanionService({
    config: {},
    paths,
    repoRoot: join(root, 'repo'),
    adapter: { sessions: firstFake.sessions, events: firstFake.events },
    workspace: { ensure: async () => {} },
    log: () => {},
    token: TOKEN,
    supervisor: { start: () => {}, stop: () => {}, resetBackoff: () => {} },
  })
  await first.start()
  const lines = []
  const secondFake = createFakeDsh()
  first.dispose()

  // Rewrite state with the session id the first run produced.
  const { writeFile } = await import('node:fs/promises')
  await writeFile(paths.stateFile, JSON.stringify({ sessionId: 'session-saved' }), 'utf8')
  const second = new CompanionService({
    config: {},
    paths,
    repoRoot: join(root, 'repo'),
    adapter: { sessions: secondFake.sessions, events: secondFake.events },
    workspace: { ensure: async () => {} },
    log: (line) => lines.push(line),
    token: TOKEN,
    supervisor: { start: () => {}, stop: () => {}, resetBackoff: () => {} },
  })
  await second.start()
  const port = Number(lines.find((line) => line.startsWith('listening on 127.0.0.1:')).split(':').pop())
  const client = createClient(port)
  try {
    client.send({ type: 'hello', token: TOKEN, platform: 'test/x64', capabilities: { capture: true, hotkey: true, bubble: true }, env: null })
    await client.waitFor((frame) => frame.type === 'welcome', 'welcome')
    await submitText(client, 'req-restore')
    assert.equal(secondFake.state.createCount, 0, 'the saved session is resumed, not recreated')
    assert.equal(secondFake.submitted[0].agentId, 'session-saved')
  } finally {
    client.close()
    second.dispose()
  }
})
