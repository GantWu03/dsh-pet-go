/**
 * The helper's half of the loopback channel to the DSH host plugin.
 *
 * It owns the connection state machine (one client, reconnect with a fixed
 * delay), the request table (ids, timeouts, pending promises) and frame
 * direction checks. Everything above it works with typed results: a request
 * always resolves, either with the host's answer or with a transport failure the
 * UI can show.
 */
import net from 'node:net'

import {
  PROTOCOL_VERSION,
  createFrameDecoder,
  encodeFrame,
  parseHostFrame,
} from '@dsh-pet-go/shared/protocol'
import type { CaptureMode, EnvironmentFacts, HostFrame, ImagePayload } from '@dsh-pet-go/shared/protocol'

import type { Log } from './settings.ts'

const RECONNECT_MS = 2000
const DEFAULT_TIMEOUT_MS = 45_000

export interface HostResult {
  ok: boolean
  code?: string
  detail?: string
  retryable?: boolean
  messageId?: string
  sessionId?: string
}

export type ClientRequest =
  | { type: 'submit', text: string, capture: { mode: CaptureMode }, image: ImagePayload | null }
  | { type: 'new-session' }
  | { type: 'ping' }

export interface HostClientDeps {
  port: number
  token: string
  platform: string
  log: Log
  /** Facts shipped in the hello; re-read on every reconnect. */
  getEnvironment: () => EnvironmentFacts | null
  onFrame: (frame: HostFrame) => void
  onTransport: (state: 'connected' | 'lost') => void
  /** Retry delay after a dropped connection; tests shorten it. */
  reconnectMs?: number
}

export interface HostClient {
  readonly connected: boolean
  start (): void
  stop (): void
  request (input: ClientRequest, timeoutMs?: number): Promise<HostResult>
  /** Push refreshed machine facts to the host (TTL refresh). */
  pushEnvironment (env: EnvironmentFacts): void
}

export function createHostClient (deps: HostClientDeps): HostClient {
  const { log, port, token } = deps
  const reconnectMs = deps.reconnectMs ?? RECONNECT_MS
  let socket: net.Socket | null = null
  let connected = false
  let stopped = false
  let reconnectTimer: NodeJS.Timeout | null = null
  let requestSeq = 0
  const pending = new Map<string, { resolve: (result: HostResult) => void, timer: NodeJS.Timeout }>()

  const failPending = (code: string, detail: string): void => {
    for (const [requestId, entry] of pending) {
      clearTimeout(entry.timer)
      pending.delete(requestId)
      entry.resolve({ ok: false, code, detail })
    }
  }

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, reconnectMs)
  }

  const handleFrame = (raw: unknown): void => {
    const parsed = parseHostFrame(raw)
    if (!parsed.ok) {
      log(`host frame rejected: ${parsed.reason}`)
      return
    }
    const frame = parsed.frame
    if (frame.type === 'result' && frame.requestId) {
      const entry = pending.get(frame.requestId)
      if (entry) {
        clearTimeout(entry.timer)
        pending.delete(frame.requestId)
        entry.resolve(frame)
      }
    }
    deps.onFrame(frame)
  }

  function connect (): void {
    if (stopped) return
    if (!port || !token) {
      log('missing COMPANION_PORT / COMPANION_TOKEN')
      return
    }
    const instance = net.connect(port, '127.0.0.1')
    socket = instance
    instance.setEncoding('utf8')
    instance.setNoDelay(true)
    const decode = createFrameDecoder(handleFrame, {
      // The channel is out of sync once a frame is refused; reconnecting is the
      // only safe recovery, and `close` already owns that path.
      onError: (error) => {
        log(`frame rejected: ${error.code}`)
        instance.destroy()
      },
    })

    instance.on('connect', () => {
      connected = true
      instance.write(encodeFrame({
        v: PROTOCOL_VERSION,
        type: 'hello',
        token,
        platform: deps.platform,
        capabilities: { capture: true, hotkey: true, bubble: true },
        env: deps.getEnvironment(),
      }))
      deps.onTransport('connected')
      log('host connected')
    })
    instance.on('data', (chunk) => decode(chunk))
    instance.on('error', () => {})
    instance.on('close', () => {
      if (socket === instance) socket = null
      if (connected) log('host disconnected')
      connected = false
      failPending('TRANSPORT_LOST', '和 DSH 的连接断开了')
      deps.onTransport('lost')
      scheduleReconnect()
    })
  }

  return {
    get connected (): boolean {
      return connected
    },

    start (): void {
      stopped = false
      connect()
    },

    stop (): void {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = null
      failPending('TRANSPORT_LOST', '插件已卸载')
      connected = false
      try {
        socket?.destroy()
      } catch {}
      socket = null
    },

    request (input: ClientRequest, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<HostResult> {
      return new Promise((resolve) => {
        if (!connected || !socket || socket.destroyed) {
          resolve({ ok: false, code: 'TRANSPORT_LOST', detail: '和 DSH 的连接断开了' })
          return
        }
        const requestId = `req-${Date.now().toString(36)}-${++requestSeq}`
        const timer = setTimeout(() => {
          pending.delete(requestId)
          resolve({ ok: false, code: 'TIMEOUT', detail: 'DSH 没有响应' })
        }, timeoutMs)
        pending.set(requestId, { resolve, timer })
        socket.write(encodeFrame({ v: PROTOCOL_VERSION, requestId, ...input }))
      })
    },

    pushEnvironment (env: EnvironmentFacts): void {
      if (!connected || !socket || socket.destroyed) return
      socket.write(encodeFrame({ v: PROTOCOL_VERSION, type: 'env', env }))
      log('env pushed to host (ttl refresh)')
    },
  }
}
