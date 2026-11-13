/**
 * dsh-companion probe — one-shot diagnostic, not part of the product.
 *
 * Answers, in one live run:
 *   U1  ctx.agents.get(id) → does the runtime face carry followup/send/status?
 *   U2  ctx.attachments.imageLimits → real deployed numbers
 *   U3  ctx.subprocess → can a plugin launch a helper process?
 *   U4  process.versions.electron → is the plugin host an Electron process?
 *   U5  end-to-end: real screenshot → saveImage → createUserMessage → followup → model answer
 *
 * Writes everything to  D:\work\dsh-companion\.probe\probe.json  (never throws into DSH).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const OUT_DIR = 'D:\\work\\dsh-companion\\.probe'
const OUT_FILE = join(OUT_DIR, 'probe.json')
const SCREEN = join(OUT_DIR, 'screen.png')

const state = {
  startedAt: new Date().toISOString(),
  phases: [],
  facts: {},
  answer: { chunks: [], joined: '', ended: false },
  errors: [],
}

async function persist () {
  try {
    await mkdir(OUT_DIR, { recursive: true })
    state.updatedAt = new Date().toISOString()
    await writeFile(OUT_FILE, JSON.stringify(state, null, 2), 'utf8')
  } catch (error) {
    // last resort: nothing else we can do from inside the host
    console.error('[companion-probe] persist failed', error)
  }
}

const phase = (name, data) => {
  state.phases.push({ name, at: new Date().toISOString(), data })
  void persist()
}

export const name = 'companion-probe'
export const inject = ['attachments', 'agents']

export function apply (ctx, config) {
  void run(ctx, config).catch((error) => {
    state.errors.push(String(error && error.stack ? error.stack : error))
    void persist()
  })
}

async function run (ctx, config) {
  phase('start', { config })

  // ---- U4: is the plugin host an Electron process? -------------------------
  state.facts.node = process.versions.node
  state.facts.electron = process.versions.electron ?? null
  state.facts.execPath = process.execPath
  state.facts.processType = process.type ?? null
  state.facts.chrome = process.versions.chrome ?? null
  try {
    const mod = await import('electron')
    const api = mod?.default ?? mod
    state.facts.electronImport = {
      ok: true,
      keys: Object.keys(mod).slice(0, 12),
      apiKeys: Object.keys(api ?? {}).slice(0, 20),
      BrowserWindow: typeof api?.BrowserWindow,
      app: typeof api?.app,
      screen: typeof api?.screen,
      globalShortcut: typeof api?.globalShortcut,
      desktopCapturer: typeof api?.desktopCapturer,
      appReady: (() => {
        try {
          return typeof api?.app?.isReady === 'function' ? api.app.isReady() : 'n/a'
        } catch (error) {
          return 'err: ' + String(error && error.message)
        }
      })(),
    }
  } catch (error) {
    state.facts.electronImport = { ok: false, error: String(error && error.message) }
  }
  phase('host-runtime', state.facts)

  // ---- U2: uploaded image limits ------------------------------------------
  try {
    state.facts.imageLimits = { ...ctx.attachments.imageLimits }
  } catch (error) {
    state.facts.imageLimits = { error: String(error && error.message) }
  }

  // ---- U3: subprocess seams ------------------------------------------------
  const sub = ctx.get ? ctx.get('subprocess') : undefined
  state.facts.subprocess = sub
    ? {
        present: true,
        spawn: typeof sub.spawn,
        resolveExecutable: typeof sub.resolveExecutable,
        terminalEnvironment: typeof sub.terminalEnvironment,
      }
    : { present: false }

  // ---- optional seams we may rely on later --------------------------------
  state.facts.services = {}
  for (const key of ['sessions', 'workspaceRegistry', 'workspaceController', 'files', 'agents', 'attachments', 'llm', 'agentDefaultModel']) {
    const svc = ctx.get ? ctx.get(key) : undefined
    state.facts.services[key] = svc === undefined ? 'absent' : typeof svc
  }
  try {
    const reg = ctx.get('workspaceRegistry')
    state.facts.workspaces = (reg?.list?.() ?? []).map(w => ({ id: w.id, title: w.title, path: w.path }))
  } catch (error) {
    state.facts.workspaces = { error: String(error && error.message) }
  }
  phase('capabilities', state.facts)

  // ---- U5: the actual pipeline -------------------------------------------
  // `@deepseek-ai/dsh-llm` is not resolvable from a workspace-linked bundle,
  // so build the message value directly (MessageBase: id + content + source).
  const createUserMessage = (input) => Object.freeze({ ...input, role: 'user', id: randomUUID() })
  phase('message-builder', { ok: typeof createUserMessage === 'function' })

  const png = await readFile(SCREEN)
  const ref = await ctx.attachments.saveImage({
    data: new Uint8Array(png),
    mediaType: 'image/png',
    name: 'probe-screen.png',
  })
  state.facts.savedAttachment = { ...ref, sourceBytes: png.byteLength }

  const sessionId = `session-${randomUUID()}`
  const defaultModel = ctx.get ? ctx.get('agentDefaultModel') : undefined
  let selection = null
  try {
    selection = defaultModel?.currentSelection?.() ?? null
  } catch (error) {
    selection = { error: String(error && error.message) }
  }
  state.facts.defaultSelection = selection
  const agentOptions = selection && selection.provider && selection.model
    ? { provider: selection.provider, model: selection.model }
    : undefined
  const handle = await ctx.agents.create({ sessionId, agentOptions })
  state.facts.createdSession = { sessionId, handleKeys: Object.keys(handle ?? {}), agentOptions }

  const agent = ctx.agents.get(sessionId)
  state.facts.agentLookup = agent
    ? {
        found: true,
        sameAsHandle: handle?.agent === agent,
        followup: typeof agent.followup,
        send: typeof agent.send,
        steer: typeof agent.steer,
        inject: typeof agent.inject,
        whenIdle: typeof agent.whenIdle,
        status: agent.status,
        hasSession: Boolean(agent.session),
        modelCurrent: (() => {
          try {
            return agent.model?.current?.() ?? null
          } catch (error) {
            return { error: String(error && error.message) }
          }
        })(),
      }
    : { found: false }

  // ---- collect the live assistant stream (this is what the bubble will use) -
  const offStream = ctx.on('agent/assistant-stream', (payload) => {
    const { agent: who, frame } = payload ?? {}
    if (!who || who.id !== sessionId) return
    if (frame?.type === 'start') {
      state.answer.startedAttempt = { attemptId: String(frame.attemptId), revision: frame.revision }
    } else if (frame?.type === 'chunk') {
      const chunk = frame.chunk
      if (chunk?.type === 'text-delta') {
        state.answer.chunks.push(chunk.text)
        state.answer.joined = state.answer.chunks.join('')
      }
    } else if (frame?.type === 'end') {
      state.answer.ended = true
      state.answer.outcome = frame.outcome
      void persist()
    }
  })

  const offStatus = ctx.on('agent/status', (payload) => {
    if (payload?.agent?.id !== sessionId) return
    state.answer.statuses = (state.answer.statuses ?? []).concat(payload.status)
  })

  const offError = ctx.on('agent/error', (payload) => {
    if (payload?.agent?.id !== sessionId) return
    state.errors.push('agent/error: ' + String(payload.error))
    void persist()
  })

  const text =
    '这是一张我此刻电脑屏幕的截图。请用一句话描述你看到的画面（提到主要窗口/颜色/文字），' +
    '并说明你是否真的看到了图像内容。'
  const message = createUserMessage({
    content: [
      { type: 'text', text },
      { type: 'image', attachment: ref },
    ],
    source: { kind: 'user' },
  })
  state.facts.message = { role: message.role, id: message.id, blocks: message.content?.map(b => b.type) }

  phase('before-followup', state.facts)
  agent.followup(message)
  phase('followup-sent', { sessionId })

  // ---- wait for the turn to settle ---------------------------------------
  const settled = new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 120_000)
    const off = ctx.on('agent/status', (payload) => {
      if (payload?.agent?.id !== sessionId) return
      if (payload.status === 'idle') {
        clearTimeout(timer)
        off()
        resolve('idle')
      }
    })
  })
  const how = await settled
  state.answer.settledBy = how
  for (const off of [offStream, offStatus, offError]) {
    try {
      off?.()
    } catch {}
  }
  phase('done', { how, answerLength: state.answer.joined.length })
  await persist()
}
