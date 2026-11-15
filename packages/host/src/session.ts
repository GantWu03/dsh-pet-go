/**
 * The dedicated companion session: which one is current, how it is created or
 * resumed, and what happens when the user asks for a new one.
 *
 * Two invariants:
 *   - restore, create and switch are serialised, so two submissions cannot race
 *     a session change;
 *   - a new session only becomes current after its handle is in hand, so a
 *     failed switch leaves the previous usable session in place.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

import type { AgentHandle, LiveAgent, SessionPort } from './adapters/dsh.ts'
import type { Log } from './types.ts'

export interface SessionOptions {
  log: Log
  sessions: SessionPort
  workspaceDir: string
  stateFile: string
  preset: string
  title: string
  /** Directory of the workspace the session belongs to (same as workspaceDir). */
  workspacePath: string
}

export interface SessionManager {
  readonly sessionId: string | null
  /** Register the workspace and adopt the saved session id, if any. */
  restore (): Promise<void>
  /** The agent to submit to: current, resumed, or freshly created. */
  current (): Promise<LiveAgent>
  /** Create a new session and switch to it. */
  createNew (): Promise<LiveAgent>
  dispose (): Promise<void>
}

export function createSessionManager (options: SessionOptions): SessionManager {
  const { log, sessions } = options
  let sessionId: string | null = null
  let handle: AgentHandle | null = null
  /** Serialises restore/create/switch; a rejected step does not block the next. */
  let queue: Promise<unknown> = Promise.resolve()

  const serialize = <T>(step: () => Promise<T>): Promise<T> => {
    const run = queue.then(step, step)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  const readSavedSessionId = async (): Promise<string | null> => {
    try {
      const saved = JSON.parse(await readFile(options.stateFile, 'utf8')) as { sessionId?: string }
      return saved?.sessionId ?? null
    } catch {
      return null
    }
  }

  const writeSavedSession = async (): Promise<void> => {
    if (!sessionId) return
    try {
      await writeFile(options.stateFile, JSON.stringify({ sessionId, createdAt: Date.now() }, null, 2), 'utf8')
    } catch (error) {
      log(`state write failed: ${(error as Error)?.message}`)
    }
  }

  /** Make a handle current: grant access, register it, name it. */
  const adopt = async (next: AgentHandle): Promise<LiveAgent> => {
    const previous = handle
    sessionId = next.agent.id
    handle = next
    sessions.grantFullAccess(next.agent)
    await writeSavedSession()
    await sessions.attachToWorkspace(next.agent.id, options.workspacePath)
    await sessions.rename(next.agent.id, options.title)
    if (previous && previous !== next) {
      // The session id is persisted in DSH, so releasing our handle does not lose
      // it; keeping the old one alive would leak a second subscription.
      try {
        await previous.dispose?.()
      } catch (error) {
        log(`old session dispose failed: ${(error as Error)?.message}`)
      }
    }
    return next.agent
  }

  const resume = async (target: string): Promise<LiveAgent> => {
    const resumed = await sessions.resume(target)
    log(`session resumed: ${resumed.agent.id}`)
    return await adopt(resumed)
  }

  const create = async (): Promise<LiveAgent> => {
    await mkdir(options.workspaceDir, { recursive: true })
    const created = await sessions.create({
      sessionId: `session-${randomUUID()}`,
      cwd: options.workspaceDir,
      preset: options.preset,
    })
    log(`session created: ${created.agent.id}`)
    return await adopt(created)
  }

  return {
    get sessionId (): string | null {
      return sessionId
    },

    async restore (): Promise<void> {
      await serialize(async () => {
        await mkdir(options.workspaceDir, { recursive: true })
        const saved = await readSavedSessionId()
        if (!saved) return
        sessionId = saved
        // The session row has to exist in the workspace before it can be listed.
        await sessions.attachToWorkspace(saved, options.workspacePath)
      })
    },

    async current (): Promise<LiveAgent> {
      return await serialize(async () => {
        if (sessionId) {
          const live = sessions.liveAgent(sessionId)
          if (live) return live
          try {
            return await resume(sessionId)
          } catch (error) {
            log(`resume failed: ${(error as Error)?.message}`)
          }
        }
        const saved = await readSavedSessionId()
        if (saved && saved !== sessionId) {
          sessionId = saved
          try {
            return await resume(saved)
          } catch (error) {
            log(`resume failed: ${(error as Error)?.message}`)
          }
        }
        return await create()
      })
    },

    async createNew (): Promise<LiveAgent> {
      return await serialize(create)
    },

    async dispose (): Promise<void> {
      const current = handle
      handle = null
      try {
        await current?.dispose?.()
      } catch {}
    },
  }
}
