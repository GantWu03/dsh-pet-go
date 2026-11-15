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

import type { DshAdapter, WorkspacePort } from './adapters/dsh.ts'
import { writeInstructions } from './instructions.ts'
import { migrateLayout } from './migrate.ts'
import { createRelay } from './relay.ts'
import { createSupervisor, resolveElectron, resolveHelperDir } from './runtime/supervisor.ts'
import type { Supervisor } from './runtime/supervisor.ts'
import { createSessionManager, SessionUnavailableError } from './session.ts'
import type { SessionManager } from './session.ts'
import { SubmitError, createSubmitter } from './submit.ts'
import type { Submitter } from './submit.ts'
import { createTransport } from './transport/server.ts'
import type { Connection, Transport } from './transport/server.ts'
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
  /** Where older builds kept the same files, migrated once on first start. */
  legacyDir?: string
  /** Root of the checkout, used to find the sibling helper build. */
  repoRoot: string
  /** The plugin package root, so an installed package finds its own helper. */
  packageRoot: string
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
    const { paths, adapter, workspace, legacyDir } = this.#options
    const log = this.#log
    try {
      // A moved directory keeps the old path as a junction, so the session that
      // was created under the old layout still has a working cwd.
      const migration = legacyDir
        ? await migrateLayout({ legacyDir, stateDir: paths.stateDir, workspaceDir: paths.workspaceDir, log })
        : { migrated: false, legacyWorkspace: null }
      if (this.#disposed) return

      // Drop the old registration first: the registry canonicalises paths, and a
      // row pointing at the old path now resolves to the moved directory, so
      // create() would return that stale row instead of a row for the new path.
      if (migration.migrated && migration.legacyWorkspace) {
        await workspace.remove(migration.legacyWorkspace)
        if (this.#disposed) return
      }

      await mkdir(paths.workspaceDir, { recursive: true })
      if (this.#disposed) return
      await workspace.ensure(paths.workspaceDir, WORKSPACE_TITLE)
      if (this.#disposed) return

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
      if (this.#disposed) {
        // Unloaded while restoring: nothing below should exist.
        await session.dispose()
        this.#session = null
        this.#submitter = null
        return
      }

      const token = this.#options.token ?? randomBytes(24).toString('hex')
      const transport = createTransport({
        token,
        log,
        onClient: (hello, connection) => this.#onClient(hello, connection),
        onFrame: (frame, connection) => this.#onFrame(frame, connection),
        onDisconnect: () => {},
      })
      this.#transport = transport
      const port = await transport.listen()
      if (this.#disposed) {
        // Unloaded while binding: the listener may have been created after close().
        transport.close()
        this.#transport = null
        await session.dispose()
        this.#session = null
        this.#submitter = null
        return
      }

      const electron = resolveElectron(paths.dshHome)
      const helperDir = resolveHelperDir({
        packageRoot: this.#options.packageRoot,
        repoRoot: this.#options.repoRoot,
      })
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
      this.#disposeSupervisor = () => supervisor.stop()

      const relay = createRelay({
        log,
        events: adapter.events,
        send: (frame) => transport.send(frame),
        getSessionId: () => session.sessionId,
        onIdle: () => supervisor.resetBackoff(),
      })
      relay.start()
      this.#disposeRelay = () => relay.stop()
      if (this.#disposed) {
        relay.stop()
        this.#disposeRelay = null
        supervisor.stop()
        this.#disposeSupervisor = null
        transport.close()
        this.#transport = null
        await session.dispose()
        this.#session = null
        this.#submitter = null
        return
      }

      log(`listening on 127.0.0.1:${port}`)
      // The last thing that can outlive the plugin is the child process.
      if (this.#disposed) return
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
  async #onClient (hello: HelloFrame, connection: Connection): Promise<void> {
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
    // Answer the connection that shook hands, even if another one replaced it
    // while the instructions were being written.
    this.#greet(connection)
  }

  #greet (connection: Connection): void {
    const session = this.#session
    const sessionId = session?.sessionId ?? null
    connection.send({
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

  async #onFrame (frame: ClientFrame, connection: Connection): Promise<void> {
    try {
      switch (frame.type) {
        case 'ping':
          connection.send({ type: 'result', requestId: frame.requestId, ok: true })
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
          // The "session" notice belongs to whoever asked; a reconnect gets its
          // own picture from the welcome instead.
          connection.send({ type: 'session', sessionId: agent.id })
          connection.send({ type: 'result', requestId: frame.requestId, ok: true })
          return
        }
        case 'submit': {
          const result = await this.#requireSession().usingAgent(
            async (agent) => await this.#requireSubmitter().run(frame, agent),
          )
          connection.send({
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
          connection.send({ type: 'result', ok: false, ...describeError(ErrorCode.BAD_REQUEST, 'hello already received') })
          return
      }
    } catch (error) {
      const payload = error instanceof SubmitError
        ? describeError(error.code, error.detail)
        : error instanceof SessionUnavailableError
          ? describeError(ErrorCode.AGENT_UNAVAILABLE, (error as Error)?.message)
          : describeError(ErrorCode.INTERNAL, (error as Error)?.message)
      this.#log(`request failed (${frame.type}): ${(error as Error)?.stack ?? error}`)
      connection.send({
        type: 'result',
        requestId: 'requestId' in frame ? frame.requestId : undefined,
        ok: false,
        ...payload,
      })
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
