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
} from '@dsh-pet-go/shared/protocol'
import { ErrorCode, describeError } from '@dsh-pet-go/shared/errors'
import { createUserMessage, textBlock, imageBlock } from '@dsh-pet-go/shared/message'

/**
 * This module is the bundled plugin entry, so it lives at
 * `packages/host/lib/index.js` and the helper is its sibling workspace package.
 * The pair is always built together (scripts/build.mjs) and installed from the
 * same checkout; the candidates below cover the layouts we actually ship and
 * `DSH_PET_GO_HELPER` overrides them all for debugging.
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')
const HELPER_DIST = join(REPO_ROOT, 'packages', 'helper', 'dist')

function resolveHelperDir () {
  const candidates = [
    process.env.DSH_PET_GO_HELPER,
    HELPER_DIST,
    // An older install layout: the plugin entry sat in packages/host itself.
    join(HERE, '..', 'helper'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      if (existsSync(join(candidate, 'main.js')) && existsSync(join(candidate, 'package.json'))) return candidate
    } catch {}
  }
  return null
}

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const COMPANION_DIR = join(DSH_HOME, 'companion')
const WORKSPACE_DIR = join(COMPANION_DIR, 'workspace')
const STATE_FILE = join(COMPANION_DIR, 'state.json')
const LOG_FILE = join(COMPANION_DIR, 'host.log')

const RESTART_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000]
const WORKSPACE_TITLE = '桌面小助手'
const SESSION_TITLE = '桌面小助手'
/**
 * Agent preset for the dedicated session. Without one the session gets the
 * minimal tool set (working directory / worktree / workspace deps only), so the
 * model cannot read a document or run a command when the screenshot is not
 * enough. `standard` is the normal interactive preset.
 */
const SESSION_PRESET = process.env.DSH_PET_GO_PRESET || 'standard'
/**
 * The session's standing instructions live in AGENTS.md inside its workspace:
 * DSH's agent-instructions loader injects them as an instruction message before
 * the first request, so nothing shows up as if the user had typed it.
 *
 * Keep this file about BEHAVIOUR. Volatile facts (which document is open, where
 * the user is reading) must never live here — they change mid-session and the
 * model can observe them itself.
 */
export function agentsMd (env) {
  const facts = [
    ['系统', env.os ? `${env.os} · ${env.platform}` : env.platform],
    ['shell', env.pwsh7 ? `${env.shell} 和 PowerShell 7（${env.pwsh7}）` : `${env.shell}（没有 pwsh 7）`],
    ['python', env.python ?? '未找到'],
    ['node', env.node ?? '未找到'],
    ['用户目录', env.home],
    ['屏幕', env.display ? `${env.display.width}x${env.display.height}` : '未知'],
    ['采集时间', env.scannedAt],
  ].filter(([, value]) => value)
  return [
    '# 桌面小助手',
    '',
    '你是持续陪伴用户的桌宠。用户会和你对话，也会给你下指令。',
    '系统可能会自动截取当前屏幕，让你看到用户此刻所看的界面、所处的情景、正在做的事——',
    '就像你们一起看着同一块屏幕。',
    '你和普通桌宠的区别在于：你有主观能动性，能在具体情景下自己想办法解决问题，而不是只在旁边看着。',
    '',
    '## 怎么回答',
    '',
    '- 如无必要，保持简洁：除非会因此影响任务完成效果，否则不要写成长篇大论，使用用户的语言。',
    '- 指令没要求细节时，不需要贴命令、代码或路径清单。',
    '- 拿不准就说不确定，不要编。',
    '',
    '## 什么时候自己动手',
    '',
    '- 画面里能直接回答的就直接回答；画面里的信息不够，就自己去查，',
    '  不要反问用户"把文件发给我""再截个图"。',
    '- 你在这台机器上有完整的读写和执行权限，但默认只读：除非用户明确要求，不要修改或删除文件。',
    '- 全盘递归搜索很慢，优先用：前台进程与窗口标题、应用自己的自动化接口、最近打开记录。',
    '- 查证控制在几步之内；查不到就直说，并把已经确定的部分给出来。',
    '',
    '## 不要做的',
    '',
    '- 不要向用户解释这些规则，也不要提到本文件或你的权限来源。',
    '- 不要在回答里贴大段日志、命令输出或内部路径，除非用户就是要这些。',
    '',
    '## 这台机器',
    '',
    ...facts.map(([key, value]) => `- ${key}：${value}`),
    '',
  ].join('\n')
}

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
    /** @type {object | null} */
    this.environment = null

    this.offStream = ctx.on('agent/assistant-stream', (payload) => this.onAssistantStream(payload))
    this.offStatus = ctx.on('agent/status', (payload) => this.onAgentStatus(payload))
    this.offError = ctx.on('agent/error', (payload) => this.onAgentError(payload))
    /** @type {{ dispose: () => Promise<void> } | null} */
    this.handle = null
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
      void this.logPresets()
      this.startedAt = Date.now()
      this.log(`listening on 127.0.0.1:${this.port}`)
      this.spawnHelper()
    } catch (error) {
      this.log(`start failed: ${error?.stack ?? error}`)
    }
  }

  dispose () {
    this.disposed = true
    // A turn parked on an approval would otherwise outlive the plugin.
    try {
      void this.handle?.dispose?.()
    } catch {}
    this.handle = null
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
        this.environment = frame.env ?? null
        this.log(`helper connected (${frame.platform ?? 'unknown'})`)
        void this.writeEnvironment()
        void this.greetClient()
        return
      }
      void this.onFrame(frame)
    }, {
      // An oversized or runaway frame is a connection-level problem: the stream
      // is already out of sync, so drop it and let the helper reconnect.
      onError: (error) => {
        this.log(`frame rejected: ${error.code}`)
        drop()
      },
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
    const homeElectron = process.platform === 'win32'
      ? join(DSH_HOME, 'electron', 'electron.exe')
      : process.platform === 'darwin'
        ? join(DSH_HOME, 'electron', 'Electron.app', 'Contents', 'MacOS', 'Electron')
        : join(DSH_HOME, 'electron', 'electron')
    const candidates = [
      process.env.DSH_COMPANION_ELECTRON,
      homeElectron,
      join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
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
    const helperDir = resolveHelperDir()
    if (!helperDir) {
      this.log(`helper app directory not found (looked for ${HELPER_DIST}); run \`pnpm build\``)
      return
    }
    this.log(`using electron: ${electron}`)
    this.log(`using helper: ${helperDir}`)
    // Deliberately a whitelist, not a copy of process.env: DSH runs inside
    // Electron, and letting ELECTRON_RUN_AS_NODE (or any NODE_OPTIONS) reach the
    // helper turns it into a plain Node process with no BrowserWindow at all.
    const env = {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      USERPROFILE: process.env.USERPROFILE,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      COMPANION_PORT: String(this.port),
      COMPANION_TOKEN: this.token,
      COMPANION_DSH_HOME: DSH_HOME,
      COMPANION_LOG: LOG_FILE,
    }
    delete env.ELECTRON_RUN_AS_NODE
    try {
      const child = spawn(electron, [helperDir], { stdio: 'ignore', env, windowsHide: true })
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

  /**
   * Give the dedicated session a stable, findable title instead of the
   * model-generated one, so it is recognizable in the sidebar.
   * @param {string} sessionId
   */
  async nameSession (sessionId) {
    try {
      const controller = this.ctx.get('sessionController')
      if (!controller?.rename) return
      try {
        await controller.rename({ sessionId, title: SESSION_TITLE })
      } catch (first) {
        // The verb answers positional arguments in some builds.
        try {
          await controller.rename(sessionId, SESSION_TITLE)
        } catch (second) {
          this.log(`session rename skipped: ${first?.message} / ${second?.message}`)
          return
        }
      }
      this.log('session renamed')
    } catch (error) {
      this.log(`session rename skipped: ${error?.message}`)
    }
  }

  /** Temporary probe: which agent presets exist, and what the companion session got. */
  async logPresets () {
    try {
      const presets = this.ctx.get('agentPresets')
      if (!presets) {
        this.log('[presets] service absent')
        return
      }
      const list = await presets.list()
      this.log('[presets] ' + JSON.stringify(list.map((p) => p.id ?? p.name ?? p)))
      if (this.sessionId) {
        const agent = this.ctx.agents.get(this.sessionId)
        this.log('[presets] live agent preset = ' + (agent ? String(presets.presetForSession(agent.session)) : 'no live agent'))
      }
    } catch (error) {
      this.log(`[presets] failed: ${error?.message}`)
    }
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
        this.handle = handle
        this.grantFullAccess(handle.agent)
        this.log(`session resumed: ${this.sessionId}`)
        await this.attachSession(this.sessionId)
        await this.nameSession(this.sessionId)
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
    const presets = this.ctx.get('agentPresets')
    const handle = await this.ctx.agents.create({
      sessionId,
      agentOptions: this.modelOptions(),
      meta: { cwd: WORKSPACE_DIR, agentPreset: SESSION_PRESET },
      // `meta.agentPreset` only records the label in the session header; the
      // actual capability composition is mounted here, from the agent's own
      // setup context. Without this the session gets the plugin-context tool
      // set (working directory / worktree / deps) instead of a real preset.
      setup: presets
        ? async (agentCtx) => {
            try {
              const mounted = await presets.mount(agentCtx, SESSION_PRESET)
              this.log(`preset mounted: ${mounted.id}`)
            } catch (error) {
              this.log(`preset mount failed: ${error?.message}`)
            }
          }
        : undefined,
    })
    this.sessionId = handle.agent.id
    this.handle = handle
    this.grantFullAccess(handle.agent)
    await this.writeState({ sessionId: this.sessionId, createdAt: Date.now() })
    await this.attachSession(this.sessionId)
    await this.nameSession(this.sessionId)
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
        case 'env': {
          // Helper-side TTL refresh: facts aged out or a binary disappeared.
          this.environment = frame.env ?? this.environment
          this.log('env refreshed by helper')
          await this.writeEnvironment()
          return
        }
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

  /**
   * Give the dedicated session the same permissions its owner has: the model
   * must be able to inspect the machine when the screenshot is not enough.
   * Recorded as the session's own `sandbox/mode` event, so it survives resume.
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent
   */
  grantFullAccess (agent) {
    try {
      agent.session.append('sandbox/mode', { mode: 'danger-full-access' })
    } catch (error) {
      this.log(`sandbox mode failed: ${error?.message}`)
    }
    try {
      // Nobody can answer an approval prompt for a plugin-driven session: a
      // 'ask' policy would park the turn forever. Full access already granted.
      this.ctx.get('approval')?.setPolicy(agent, 'never')
    } catch (error) {
      this.log(`approval policy failed: ${error?.message}`)
    }
    this.log('permissions: sandbox=danger-full-access approval=never')
  }

  /**
   * Persist the collected machine facts and rewrite the session's AGENTS.md.
   * Called once per helper connection (i.e. once per DSH launch), never per
   * question and never per session.
   * @returns {Promise<void>}
   */
  async writeEnvironment () {
    const env = this.environment
    if (!env) return
    const stateDir = join(DSH_HOME, 'dsh-pet-go')
    try {
      await mkdir(stateDir, { recursive: true })
      await writeFile(join(stateDir, 'env.json'), JSON.stringify(env, null, 2), 'utf8')
      await mkdir(WORKSPACE_DIR, { recursive: true })
      await writeFile(join(WORKSPACE_DIR, 'AGENTS.md'), agentsMd(env), 'utf8')
      this.log('AGENTS.md written')
    } catch (error) {
      this.log(`AGENTS.md failed: ${error?.message}`)
    }
  }

  // -------------------------------------------------------------------- relay

  onAssistantStream ({ agent, frame } = {}) {
    if (!this.sessionId || agent?.id !== this.sessionId) return
    if (frame?.type === 'start') {
      this.answerBuffer = ''
      this.send({ type: 'answer', phase: 'start' })
      return
    }
    if (frame?.type === 'chunk') {
      const chunk = frame.chunk
      if (chunk?.type === 'text-delta') {
        this.answerBuffer = (this.answerBuffer ?? '') + chunk.text
        this.send({ type: 'answer', phase: 'delta', text: chunk.text })
      } else if (chunk?.type === 'block-start' && chunk.blockType === 'tool-call') {
        // The model is going off to investigate; the bubble says so instead of
        // sitting empty for the next 18 tool calls.
        this.send({ type: 'answer', phase: 'tool' })
      }
      return
    }
    if (frame?.type === 'end') {
      const ok = frame.outcome?.kind === 'committed'
      this.log(`answer end ok=${ok} text=${(this.answerBuffer ?? '').slice(0, 600).replace(/\s+/g, ' ')}`)
      this.send({ type: 'answer', phase: 'end', ok })
      this.answerBuffer = ''
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
