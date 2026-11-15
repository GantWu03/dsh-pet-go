/**
 * The DSH side of the host plugin.
 *
 * Everything that knows DSH's own API lives here: `ctx.agents`, session presets,
 * approval policy, the workspace registry, session naming, attachment storage and
 * the agent event stream. Above this module the plugin works with the small types
 * declared below, so a DSH change has one place to adapt.
 *
 * The event payloads are normalised on the way in (`AgentEvent`), because the raw
 * shapes are nested and version-specific.
 */
import type { UserMessage } from '@dsh-pet-go/shared/message'

export interface ModelSelection {
  provider: string
  model: string
}

export interface LiveAgent {
  id: string
  session: { append (type: string, payload?: unknown): void }
}

export interface AgentHandle {
  agent: LiveAgent
  dispose?: () => Promise<void> | void
}

export interface WorkspaceEntry {
  path?: string
  sessionIds?: string[]
  attachSession (sessionId: string): Promise<void>
}

export interface SaveImageInput {
  data: Uint8Array
  mediaType: string
  name: string
}

export interface SessionPort {
  currentModel (): ModelSelection | null
  resume (sessionId: string): Promise<AgentHandle>
  create (input: { sessionId: string, cwd: string, preset: string }): Promise<AgentHandle>
  liveAgent (sessionId: string): LiveAgent | null
  agentStatus (agentId: string): string | null
  /** Full machine access for the dedicated session, recorded on the session. */
  grantFullAccess (agent: LiveAgent): void
  /** Put the session into the companion workspace's manual order. */
  attachToWorkspace (sessionId: string, workspacePath: string): Promise<void>
  rename (sessionId: string, title: string): Promise<void>
  followup (agent: LiveAgent, message: UserMessage): void
  saveImage (input: SaveImageInput): Promise<object>
}

export type AgentEvent =
  | { kind: 'stream-start', agentId: string }
  | { kind: 'text-delta', agentId: string, text: string }
  | { kind: 'tool-call-start', agentId: string }
  | { kind: 'stream-end', agentId: string, committed: boolean }
  | { kind: 'status', agentId: string, status: string }
  | { kind: 'error', agentId: string, message: string }

export interface EventPort {
  /** @returns an unsubscribe function. */
  subscribe (listener: (event: AgentEvent) => void): () => void
}

export interface DshAdapter {
  sessions: SessionPort
  events: EventPort
}

/**
 * The Cordis context, narrowed to what this plugin calls. It is declared here so
 * the rest of the plugin never depends on DSH's own types.
 */
export interface DshContext {
  agents: {
    get (id: string): LiveAgent | undefined
    resume (input: { resumeSessionId: string, agentOptions?: ModelSelection }): Promise<AgentHandle>
    create (input: {
      sessionId: string
      agentOptions?: ModelSelection
      meta?: { cwd?: string, agentPreset?: string }
      setup?: (agentCtx: unknown) => Promise<void>
    }): Promise<AgentHandle>
  }
  attachments: {
    saveImage (input: SaveImageInput): Promise<object>
  }
  // DSH services are looked up by name; each accessor below casts the one it uses.
  get (name: string): unknown
  on (event: string, listener: (payload: unknown) => void): () => void
}

interface AgentPresetsService {
  mount (agentContext: unknown, preset: string): Promise<{ id: string }>
}

interface ApprovalService {
  setPolicy (agent: LiveAgent, policy: 'never' | 'ask'): void
}

interface WorkspaceRegistryService {
  list?: () => WorkspaceEntry[]
  create (path: string, title: string): Promise<unknown>
}

interface AgentDefaultModelService {
  currentSelection?: () => { provider?: string, model?: string } | null
}

interface SessionControllerService {
  rename?: (input: { sessionId: string, title: string } | string, title?: string) => Promise<void>
}

export interface DshAdapterOptions {
  log: (line: string) => void
}

/** Event names the companion listens to, kept together with their normalisers. */
const STREAM_EVENT = 'agent/assistant-stream'
const STATUS_EVENT = 'agent/status'
const ERROR_EVENT = 'agent/error'

export function createDshAdapter (ctx: DshContext, options: DshAdapterOptions): DshAdapter {
  const { log } = options
  const get = <T>(name: string): T | undefined => ctx.get(name) as T | undefined

  const sessions: SessionPort = {
    currentModel (): ModelSelection | null {
      try {
        const selection = get<AgentDefaultModelService>('agentDefaultModel')?.currentSelection?.()
        if (!selection?.provider || !selection?.model) return null
        return { provider: selection.provider, model: selection.model }
      } catch {
        return null
      }
    },

    async resume (sessionId: string): Promise<AgentHandle> {
      const model = this.currentModel()
      return await ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: model ?? undefined,
      })
    },

    async create ({ sessionId, cwd, preset }): Promise<AgentHandle> {
      const model = this.currentModel()
      const presets = get<AgentPresetsService>('agentPresets')
      const handle = await ctx.agents.create({
        sessionId,
        agentOptions: model ?? undefined,
        meta: { cwd, agentPreset: preset },
        // `meta.agentPreset` only records the label in the session header; the
        // actual capability composition is mounted here, from the agent's own
        // setup context. Without this the session gets the plugin-context tool
        // set (working directory / worktree / deps) instead of a real preset.
        setup: presets
          ? async (agentContext: unknown) => {
              try {
                const mounted = await presets.mount(agentContext, preset)
                log(`preset mounted: ${mounted.id}`)
              } catch (error) {
                log(`preset mount failed: ${(error as Error)?.message}`)
              }
            }
          : undefined,
      })
      return handle
    },

    liveAgent (sessionId: string): LiveAgent | null {
      try {
        return ctx.agents.get(sessionId) ?? null
      } catch {
        return null
      }
    },

    agentStatus (agentId: string): string | null {
      const agent = this.liveAgent(agentId) as (LiveAgent & { status?: string }) | null
      return agent?.status ?? null
    },

    grantFullAccess (agent: LiveAgent): void {
      try {
        // Recorded as the session's own event, so it survives resume.
        agent.session.append('sandbox/mode', { mode: 'danger-full-access' })
      } catch (error) {
        log(`sandbox mode failed: ${(error as Error)?.message}`)
      }
      try {
        // Nobody can answer an approval prompt for a plugin-driven session: an
        // 'ask' policy would park the turn forever. Full access is already granted.
        get<ApprovalService>('approval')?.setPolicy(agent, 'never')
      } catch (error) {
        log(`approval policy failed: ${(error as Error)?.message}`)
      }
      log('permissions: sandbox=danger-full-access approval=never')
    },

    async attachToWorkspace (sessionId: string, workspacePath: string): Promise<void> {
      try {
        const registry = get<WorkspaceRegistryService>('workspaceRegistry')
        if (!registry) return
        const workspace = (registry.list?.() ?? []).find((entry) => entry.path === workspacePath)
        if (!workspace) return
        const existing = workspace.sessionIds ?? []
        if (existing.includes(sessionId)) return
        await workspace.attachSession(sessionId)
        log(`session attached to workspace: ${sessionId}`)
      } catch (error) {
        log(`session attach skipped: ${(error as Error)?.message}`)
      }
    },

    async rename (sessionId: string, title: string): Promise<void> {
      try {
        const controller = get<SessionControllerService>('sessionController')
        if (!controller?.rename) return
        try {
          await controller.rename({ sessionId, title })
        } catch (first) {
          // The verb answers positional arguments in some builds.
          try {
            await controller.rename(sessionId, title)
          } catch (second) {
            log(`session rename skipped: ${(first as Error)?.message} / ${(second as Error)?.message}`)
            return
          }
        }
        log('session renamed')
      } catch (error) {
        log(`session rename skipped: ${(error as Error)?.message}`)
      }
    },

    followup (agent: LiveAgent, message: UserMessage): void {
      ;(agent as LiveAgent & { followup (message: UserMessage): void }).followup(message)
    },

    async saveImage (input: SaveImageInput): Promise<object> {
      return await ctx.attachments.saveImage(input)
    },
  }

  const events: EventPort = {
    subscribe (listener: (event: AgentEvent) => void): () => void {
      const offStream = ctx.on(STREAM_EVENT, (payload) => {
        const { agent, frame } = payload as { agent?: { id?: string }, frame?: Record<string, unknown> }
        const agentId = agent?.id
        if (!agentId || !frame) return
        if (frame.type === 'start') {
          listener({ kind: 'stream-start', agentId })
          return
        }
        if (frame.type === 'chunk') {
          const chunk = frame.chunk as { type?: string, text?: string, blockType?: string } | undefined
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
            listener({ kind: 'text-delta', agentId, text: chunk.text })
          } else if (chunk?.type === 'block-start' && chunk.blockType === 'tool-call') {
            listener({ kind: 'tool-call-start', agentId })
          }
          return
        }
        if (frame.type === 'end') {
          const outcome = frame.outcome as { kind?: string } | undefined
          listener({ kind: 'stream-end', agentId, committed: outcome?.kind === 'committed' })
        }
      })
      const offStatus = ctx.on(STATUS_EVENT, (payload) => {
        const { agent, status } = payload as { agent?: { id?: string }, status?: string }
        if (!agent?.id || typeof status !== 'string') return
        listener({ kind: 'status', agentId: agent.id, status })
      })
      const offError = ctx.on(ERROR_EVENT, (payload) => {
        const { agent, error } = payload as { agent?: { id?: string }, error?: unknown }
        if (!agent?.id) return
        const message = (error as Error)?.message ?? String(error)
        listener({ kind: 'error', agentId: agent.id, message })
      })
      return () => {
        try { offStream() } catch {}
        try { offStatus() } catch {}
        try { offError() } catch {}
      }
    },
  }

  return { sessions, events }
}

// Workspace helpers: the registry is used by both session changes and startup.
export interface WorkspacePort {
  ensure (path: string, title: string): Promise<void>
}

export function createWorkspacePort (ctx: DshContext, log: (line: string) => void): WorkspacePort {
  return {
    async ensure (path: string, title: string): Promise<void> {
      try {
        const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryService | undefined
        if (!registry) return
        const existing = registry.list?.() ?? []
        if (existing.some((workspace) => workspace.path === path)) return
        await registry.create(path, title)
        log('workspace registered')
      } catch (error) {
        log(`workspace registration skipped: ${(error as Error)?.message}`)
      }
    },
  }
}
