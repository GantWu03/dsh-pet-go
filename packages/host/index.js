/**
 * dsh-companion — Host plugin.
 *
 * The only job of this process: turn (text + screenshot) into one ordinary
 * user message inside a dedicated DSH session, then relay that session's
 * assistant stream back to the floating window.
 *
 * It owns:
 *   - a loopback TCP channel to the Electron helper (one client),
 *   - the helper process lifecycle (spawn + backoff restart),
 *   - the dedicated session (create / resume / new),
 *   - the attachment save + message assembly + `agent.followup()`.
 *
 * It deliberately owns nothing else: no OCR, no coordinates, no context
 * management, no model capability probing.
 */
import net from 'node:net'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import {
  PROTOCOL_VERSION,
  CAPTURE_MODE,
  encodeFrame,
  createFrameDecoder,
} from '../shared/src/protocol.js'
import { ErrorCode, describeError } from '../shared/src/errors.js'
import { createUserMessage, textBlock, imageBlock } from '../shared/src/message.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const HELPER_DIR = join(REPO_ROOT, 'packages', 'helper')

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const COMPANION_DIR = join(DSH_HOME, 'companion')
const WORKSPACE_DIR = join(COMPANION_DIR, 'workspace')
const STATE_FILE = join(COMPANION_DIR, 'state.json')
const LOG_FILE = join(COMPANION_DIR, 'host.log')

const RESTART_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000]
const WORKSPACE_TITLE = '桌面小助手'

export const name = 'companion'
export const inject = ['attachments', 'agents']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply (ctx, config) {
  const service = new CompanionService(ctx, config ?? {})
  ctx.effect(() => {
    void service.start()
    return () => service.dispose()
  })
}

class SubmitError extends Error {
  constructor (code, detail) {
    super(detail ?? code)
    this.code = code
    this.detail = detail
  }
}

class CompanionService {
  constructor (ctx, config) {
    this.ctx = ctx
    this.config = config
    this.server = null
    this.port = 0
    this.token = randomBytes(24).toString('hex')
    this.client = null
    this.helper = null
    this.helperAttempt = 0
    this.restartTimer = null
    this.disposed = false
    this.sessionId = null
    this.startedAt = null

    this.offStream = ctx.on('agent/assistant-stream', (payload) => this.onAssistantStream(payload))
    this.offStatus = ctx.on('agent/status', (payload) => this.onAgentStatus(payload))
    this.offError = ctx.on('agent/error', (payload) => this.onAgentError(payload))
  }

  // ---------------------------------------------------------------- lifecycle

  async start () {
    try {
      await mkdir(WORKSPACE_DIR, { recursive: true })
      await this.ensureWorkspace()
      const saved = await this.readState()
      if (saved?.sessionId) {
        this.sessionId = saved.sessionId
        await this.attachSession(saved.sessionId)
      }
      await this.startServer()
      this.startedAt = Date.now()
      this.log(`listening on 127.0.0.1:${this.port}`)
      this.spawnHelper()
    } catch (error) {
      this.log(`start failed: ${error?.stack ?? error}`)
    }
  }

  dispose () {
    this.disposed = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    try { this.offStream?.() } catch {}
    try { this.offStatus?.() } catch {}
    try { this.offError?.() } catch {}
    this.dropClient()
    if (this.helper) {
      try { this.helper.kill() } catch {}
      this.helper = null
    }
    if (this.server) {
      try { this.server.close() } catch {}
      this.server = null
    }
  }

  // ------------------------------------------------------------------- server

  startServer () {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.onSocket(socket))
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        server.on('error', (error) => this.log(`server error: ${error?.message}`))
        this.server = server
        this.port = /** @type {net.AddressInfo} */ (server.address()).port
        resolve()
      })
    })
  }

  onSocket (socket) {
    socket.setNoDelay(true)
    socket.setEncoding('utf8')
    let greeted = false

    const drop = () => {
      try { socket.destroy() } catch {}
    }

    const decode = createFrameDecoder((frame) => {
      if (!greeted) {
        if (frame?.type !== 'hello' || frame?.token !== this.token) {
          this.log('handshake rejected')
          drop()
          return
        }
        if (frame.v !== PROTOCOL_VERSION) {
          this.send({ type: 'result', ok: false, ...describeError(ErrorCode.PROTOCOL_MISMATCH) })
          drop()
          return
        }
        greeted = true
        this.attachClient(socket)
        this.helperAttempt = 0
        this.log(`helper connected (${frame.platform ?? 'unknown'})`)
        void this.greetClient()
        return
      }
      void this.onFrame(frame)
    })

    socket.on('data', (chunk) => decode(chunk))
    socket.on('error', () => {})
    socket.on('close', () => {
      if (this.client === socket) this.client = null
    })
  }

  attachClient (socket) {
    if (this.client && this.client !== socket) {
      try { this.client.destroy() } catch {}
    }
    this.client = socket
  }

  dropClient () {
    if (this.client) {
      try { this.client.destroy() } catch {}
      this.client = null
    }
  }

  send (frame) {
    if (!this.client || this.client.destroyed) return
    try {
      this.client.write(encodeFrame({ v: PROTOCOL_VERSION, ...frame }))
    } catch (error) {
      this.log(`send failed: ${error?.message}`)
    }
  }

  async greetClient () {
    const agent = this.sessionId ? this.ctx.agents.get(this.sessionId) : undefined
    this.send({
      type: 'welcome',
      sessionId: this.sessionId,
      model: this.currentModel(),
      state: agent?.status ?? 'idle',
      protocol: PROTOCOL_VERSION,
    })
  }

  // ------------------------------------------------------------------- helper

  resolveElectron () {
    const candidates = [
      process.env.DSH_COMPANION_ELECTRON,
      'D:/实习/vibecoding/speech/node_modules/electron/dist/electron.exe',
      join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
      join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
    ].filter(Boolean)
    for (const candidate of candidates) {
      try {
        if (candidate && existsSync(candidate)) return candidate
      } catch {}
    }
    return null
  }

  spawnHelper () {
    if (this.disposed) return
    const electron = this.resolveElectron()
    if (!electron) {
      this.log('helper electron binary not found; set DSH_COMPANION_ELECTRON')
      return
    }
    const env = {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      USERPROFILE: process.env.USERPROFILE,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      COMPANION_PORT: String(this.port),
      COMPANION_TOKEN: this.token,
      COMPANION_LOG: LOG_FILE,
    }
    try {
      const child = spawn(electron, [HELPER_DIR], { stdio: 'ignore', env, windowsHide: true })
      this.helper = child
      this.log(`helper spawned pid=${child.pid}`)
      child.on('exit', (code, signal) => {
        if (this.helper === child) this.helper = null
        this.log(`helper exited code=${code} signal=${signal}`)
        if (!this.disposed) this.scheduleRestart()
      })
      child.on('error', (error) => this.log(`helper spawn error: ${error?.message}`))
    } catch (error) {
      this.log(`spawn threw: ${error?.message}`)
      this.scheduleRestart()
    }
  }

  scheduleRestart () {
    if (this.disposed) return
    const delay = RESTART_DELAYS[Math.min(this.helperAttempt, RESTART_DELAYS.length - 1)]
    this.helperAttempt += 1
    this.log(`restarting helper in ${delay}ms (attempt ${this.helperAttempt})`)
    this.send({ type: 'state', state: 'idle', detail: `浮窗正在重启（第 ${this.helperAttempt} 次）` })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.spawnHelper()
    }, delay)
  }

  // ------------------------------------------------------------------ session

  async readState () {
    try {
      return JSON.parse(await readFile(STATE_FILE, 'utf8'))
    } catch {
      return null
    }
  }

  async writeState (value) {
    try {
      await writeFile(STATE_FILE, JSON.stringify(value, null, 2), 'utf8')
    } catch (error) {
      this.log(`state write failed: ${error?.message}`)
    }
  }

  currentModel () {
    try {
      const selection = this.ctx.get('agentDefaultModel')?.currentSelection?.()
      if (!selection?.provider || !selection?.model) return null
      return { provider: selection.provider, model: selection.model }
    } catch {
      return null
    }
  }

  modelOptions () {
    const model = this.currentModel()
    if (!model) return undefined
    return { provider: model.provider, model: model.model }
  }

  async ensureWorkspace () {
    try {
      const registry = this.ctx.get('workspaceRegistry')
      if (!registry) return
      const existing = registry.list?.() ?? []
      if (existing.some((workspace) => workspace.path === WORKSPACE_DIR)) return
      await registry.create(WORKSPACE_DIR, WORKSPACE_TITLE)
      this.log('workspace registered')
    } catch (error) {
      this.log(`workspace registration skipped: ${error?.message}`)
    }
  }

  /**
   * Put the dedicated session into the companion workspace's manual order.
   * Without this row the session is persisted but never listed in the sidebar.
   * @param {string} sessionId
   */
  async attachSession (sessionId) {
    try {
      const registry = this.ctx.get('workspaceRegistry')
      if (!registry) return
      const workspace = (registry.list?.() ?? []).find((entry) => entry.path === WORKSPACE_DIR)
      if (!workspace) return
      const existing = workspace.sessionIds ?? []
      if (existing.includes(sessionId)) return
      await workspace.attachSession(sessionId)
      this.log(`session attached to workspace: ${sessionId}`)
    } catch (error) {
      this.log(`session attach skipped: ${error?.message}`)
    }
  }

  async ensureAgent () {
    if (this.sessionId) {
      const live = this.ctx.agents.get(this.sessionId)
      if (live) return live
    }
    const saved = await this.readState()
    if (saved?.sessionId) {
      try {
        const handle = await this.ctx.agents.resume({
          resumeSessionId: saved.sessionId,
          agentOptions: this.modelOptions(),
        })
        this.sessionId = handle.agent.id
        this.log(`session resumed: ${this.sessionId}`)
        await this.attachSession(this.sessionId)
        return handle.agent
      } catch (error) {
        this.log(`resume failed: ${error?.message}`)
      }
    }
    return this.createSession()
  }

  async createSession () {
    await mkdir(WORKSPACE_DIR, { recursive: true })
    const sessionId = `session-${randomUUID()}`
    const handle = await this.ctx.agents.create({
      sessionId,
      agentOptions: this.modelOptions(),
      meta: { cwd: WORKSPACE_DIR },
    })
    this.sessionId = handle.agent.id
    await this.writeState({ sessionId: this.sessionId, createdAt: Date.now() })
    await this.attachSession(this.sessionId)
    this.log(`session created: ${this.sessionId}`)
    return handle.agent
  }

  // ------------------------------------------------------------------ request

  async onFrame (frame) {
    const requestId = frame?.requestId
    try {
      switch (frame?.type) {
        case 'ping':
          this.send({ type: 'result', requestId, ok: true })
          return
        case 'new-session': {
          const agent = await this.createSession()
          this.send({ type: 'session', sessionId: agent.id })
          this.send({ type: 'result', requestId, ok: true })
          return
        }
        case 'submit':
          await this.handleSubmit(frame)
          return
        default:
          this.send({ type: 'result', requestId, ok: false, ...describeError(ErrorCode.BAD_REQUEST, String(frame?.type)) })
      }
    } catch (error) {
      const payload = error instanceof SubmitError
        ? describeError(error.code, error.detail)
        : describeError(ErrorCode.INTERNAL, error?.message)
      this.log(`request failed (${frame?.type}): ${error?.stack ?? error}`)
      this.send({ type: 'result', requestId, ok: false, ...payload })
    }
  }

  async handleSubmit (frame) {
    const text = typeof frame.text === 'string' ? frame.text.trim() : ''
    const wantsImage = frame?.capture?.mode === CAPTURE_MODE.screen && frame?.image?.base64
    if (!text && !wantsImage) {
      throw new SubmitError(ErrorCode.BAD_REQUEST, '空消息')
    }

    let agent
    try {
      agent = await this.ensureAgent()
    } catch (error) {
      throw new SubmitError(ErrorCode.AGENT_UNAVAILABLE, error?.message)
    }

    /** @type {object[]} */
    const blocks = []
    if (text) blocks.push(textBlock(text))
    if (wantsImage) {
      const bytes = Buffer.from(String(frame.image.base64), 'base64')
      let ref
      try {
        ref = await this.ctx.attachments.saveImage({
          data: new Uint8Array(bytes),
          mediaType: frame.image.mediaType || 'image/png',
          name: 'companion-screen.png',
        })
      } catch (error) {
        throw new SubmitError(ErrorCode.IMAGE_TOO_LARGE, error?.message)
      }
      blocks.push(imageBlock(ref))
    }

    const message = createUserMessage({ content: blocks, source: { kind: 'user' } })
    agent.followup(message)
    this.log(`submitted ${message.id} (${blocks.length} blocks, ${wantsImage ? 'with image' : 'text only'})`)
    this.send({ type: 'result', requestId: frame.requestId, ok: true, messageId: message.id, sessionId: agent.id })
  }

  // -------------------------------------------------------------------- relay

  onAssistantStream ({ agent, frame } = {}) {
    if (!this.sessionId || agent?.id !== this.sessionId) return
    if (frame?.type === 'start') {
      this.send({ type: 'answer', phase: 'start' })
      return
    }
    if (frame?.type === 'chunk') {
      const chunk = frame.chunk
      if (chunk?.type === 'text-delta') this.send({ type: 'answer', phase: 'delta', text: chunk.text })
      return
    }
    if (frame?.type === 'end') {
      this.send({ type: 'answer', phase: 'end', ok: frame.outcome?.kind === 'committed' })
    }
  }

  onAgentStatus ({ agent, status } = {}) {
    if (!this.sessionId || agent?.id !== this.sessionId) return
    this.send({ type: 'state', state: status })
    if (status === 'idle') this.helperAttempt = 0
  }

  onAgentError ({ agent, error } = {}) {
    if (!this.sessionId || agent?.id !== this.sessionId) return
    this.log(`agent error: ${error?.message ?? error}`)
    this.send({
      type: 'answer',
      phase: 'end',
      ok: false,
      detail: String(error?.message ?? error),
    })
  }

  // --------------------------------------------------------------------- util

  log (line) {
    const text = `[${new Date().toISOString()}] ${line}\n`
    void appendFile(LOG_FILE, text, 'utf8').catch(() => {})
  }
}
