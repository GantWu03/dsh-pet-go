/**
 * The companion service: one helper, one dedicated session, one bubble.
 *
 * It owns coordination only. The TCP channel is `transport`, the child process
 * is `runtime/supervisor`, session selection is `session`, message assembly is
 * `submit`, the bubble stream is `relay`, and the DSH API surface is
 * `adapters/dsh`. The startup and shutdown orders below are the contract:
 *
 *   start:  workspace -> saved session -> listen -> relay -> helper
 *   stop:   relay -> supervisor -> transport -> session handles
 */
import { mkdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

import { ErrorCode, describeError } from '@dsh-pet-go/shared/errors'
import type { ClientFrame, EnvironmentFacts, HelloFrame } from '@dsh-pet-go/shared/protocol'
import { PROTOCOL_VERSION } from '@dsh-pet-go/shared/protocol'

import type { DshAdapter, LiveAgent, WorkspacePort } from './adapters/dsh.ts'
import { writeInstructions } from './instructions.ts'
import { createRelay } from './relay.ts'
import { createSupervisor, resolveElectron, resolveHelperDir } from './runtime/supervisor.ts'
import type { Supervisor } from './runtime/supervisor.ts'
import { createSessionManager } from './session.ts'
import type { SessionManager } from './session.ts'
import { SubmitError, createSubmitter } from './submit.ts'
import type { Submitter } from './submit.ts'
import { createTransport } from './transport/server.ts'
import type { Transport } from './transport/server.ts'
import type { CompanionPaths, Log } from './types.ts'

const WORKSPACE_TITLE = '桌面小助手'
const SESSION_TITLE = '桌面小助手'
/**
 * Agent preset for the dedicated session. Without one the session gets the
 * minimal tool set (working directory / worktree / workspace deps only), so the
 * model cannot read a document or run a command when the screenshot is not
 * enough. `standard` is the normal interactive preset.
 */
const SESSION_PRESET = process.env.DSH_PET_GO_PRESET || 'standard'

export interface CompanionOptions {
  config: Record<string, unknown>
  paths: CompanionPaths
  /** Root of the checkout, used to find the sibling helper build. */
  repoRoot: string
  /** DSH calls, assembled by the entry: the only place that knows DSH. */
  adapter: DshAdapter
  workspace: WorkspacePort
  log: Log
  /** Fixed transport token; tests drive the real handshake with it. */
  token?: string
  /** Pre-built helper supervisor; tests replace the child process. */
  supervisor?: Supervisor
}

export class CompanionService {
  readonly #options: CompanionOptions
  readonly #log: Log
  #transport: Transport | null = null
  #session: SessionManager | null = null
  #submitter: Submitter | null = null
  #disposeRelay: (() => void) | null = null
  #disposeSupervisor: (() => void) | null = null
  #environment: EnvironmentFacts | null = null
  #disposed = false

  constructor (options: CompanionOptions) {
    this.#options = options
    this.#log = options.log
  }

  async start (): Promise<void> {
    const { paths, adapter, workspace } = this.#options
    const log = this.#log
    try {
      await mkdir(paths.workspaceDir, { recursive: true })
      await workspace.ensure(paths.workspaceDir, WORKSPACE_TITLE)

      const session = createSessionManager({
        log,
        sessions: adapter.sessions,
        workspaceDir: paths.workspaceDir,
        workspacePath: paths.workspaceDir,
        stateFile: paths.stateFile,
        preset: SESSION_PRESET,
        title: SESSION_TITLE,
      })
      this.#session = session
      this.#submitter = createSubmitter({ log, sessions: adapter.sessions })
      await session.restore()

      const token = this.#options.token ?? randomBytes(24).toString('hex')
      const transport = createTransport({
        token,
        log,
        onClient: (hello) => this.#onClient(hello),
        onFrame: (frame) => this.#onFrame(frame),
        onDisconnect: () => {},
      })
      this.#transport = transport
      const port = await transport.listen()

      const electron = resolveElectron(paths.dshHome)
      const helperDir = resolveHelperDir(this.#options.repoRoot)
      const supervisor = this.#options.supervisor ?? createSupervisor({
        log,
        electron,
        helperDir,
        port,
        token,
        dshHome: paths.dshHome,
        logFile: paths.logFile,
        onRestartScheduled: (attempt) => {
          transport.send({ type: 'state', state: 'idle', detail: `浮窗正在重启（第 ${attempt} 次）` })
        },
      })

      const relay = createRelay({
        log,
        events: adapter.events,
        send: (frame) => transport.send(frame),
        getSessionId: () => session.sessionId,
        onIdle: () => supervisor.resetBackoff(),
      })
      relay.start()
      this.#disposeRelay = () => relay.stop()

      this.#disposeSupervisor = () => supervisor.stop()

      log(`listening on 127.0.0.1:${port}`)
      supervisor.start()
    } catch (error) {
      log(`start failed: ${(error as Error)?.stack ?? error}`)
    }
  }

  dispose (): void {
    if (this.#disposed) return
    this.#disposed = true
    // Stop taking new work first: no more frames, no restarts, no subscriptions.
    this.#disposeRelay?.()
    this.#disposeRelay = null
    this.#disposeSupervisor?.()
    this.#disposeSupervisor = null
    this.#transport?.close()
    this.#transport = null
    void this.#session?.dispose()
    this.#session = null
  }

  /** Handshake completed: remember the facts, refresh AGENTS.md, greet. */
  async #onClient (hello: HelloFrame): Promise<void> {
    this.#environment = hello.env ?? null
    this.#log(`helper connected (${hello.platform ?? 'unknown'})`)
    if (this.#environment) {
      await writeInstructions({
        env: this.#environment,
        workspaceDir: this.#options.paths.workspaceDir,
        envDir: this.#options.paths.envDir,
        log: this.#log,
      })
    }
    await this.#greet()
  }

  async #greet (): Promise<void> {
    const session = this.#session
    const sessionId = session?.sessionId ?? null
    this.#transport?.send({
      type: 'welcome',
      sessionId,
      model: this.#currentModel(),
      state: sessionId ? this.#agentStatus(sessionId) : 'idle',
      protocol: PROTOCOL_VERSION,
    })
  }

  #currentModel (): { provider: string, model: string } | null {
    try {
      return this.#options.adapter.sessions.currentModel()
    } catch {
      return null
    }
  }

  #agentStatus (sessionId: string): string {
    try {
      return this.#options.adapter.sessions.agentStatus(sessionId) ?? 'idle'
    } catch {
      return 'idle'
    }
  }

  async #onFrame (frame: ClientFrame): Promise<void> {
    try {
      switch (frame.type) {
        case 'ping':
          this.#transport?.send({ type: 'result', requestId: frame.requestId, ok: true })
          return
        case 'env':
          // Helper-side TTL refresh: facts aged out or a binary disappeared.
          this.#environment = frame.env
          this.#log('env refreshed by helper')
          await writeInstructions({
            env: frame.env,
            workspaceDir: this.#options.paths.workspaceDir,
            envDir: this.#options.paths.envDir,
            log: this.#log,
          })
          return
        case 'new-session': {
          const agent = await this.#requireSession().createNew()
          this.#transport?.send({ type: 'session', sessionId: agent.id })
          this.#transport?.send({ type: 'result', requestId: frame.requestId, ok: true })
          return
        }
        case 'submit': {
          const agent = await this.#agentForSubmit()
          const result = await this.#requireSubmitter().run(frame, agent)
          this.#transport?.send({
            type: 'result',
            requestId: frame.requestId,
            ok: true,
            messageId: result.messageId,
            sessionId: result.sessionId,
          })
          return
        }
        case 'hello':
          // A second hello on an established connection is a protocol mistake.
          this.#transport?.send({ type: 'result', ok: false, ...describeError(ErrorCode.BAD_REQUEST, 'hello already received') })
          return
      }
    } catch (error) {
      const payload = error instanceof SubmitError
        ? describeError(error.code, error.detail)
        : describeError(ErrorCode.INTERNAL, (error as Error)?.message)
      this.#log(`request failed (${frame.type}): ${(error as Error)?.stack ?? error}`)
      this.#transport?.send({
        type: 'result',
        requestId: 'requestId' in frame ? frame.requestId : undefined,
        ok: false,
        ...payload,
      })
    }
  }

  async #agentForSubmit (): Promise<LiveAgent> {
    try {
      return await this.#requireSession().current()
    } catch (error) {
      throw new SubmitError(ErrorCode.AGENT_UNAVAILABLE, (error as Error)?.message)
    }
  }

  #requireSession (): SessionManager {
    if (!this.#session) throw new Error('session manager is not ready')
    return this.#session
  }

  #requireSubmitter (): Submitter {
    if (!this.#submitter) throw new Error('submitter is not ready')
    return this.#submitter
  }
}
