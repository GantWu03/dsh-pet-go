/**
 * dsh-pet-go — wire protocol v1 (shared by the DSH host plugin and the Electron
 * helper).
 *
 * Transport: TCP on 127.0.0.1 + newline-delimited JSON (NDJSON). Every frame is
 * one JSON object followed by "\n".
 *
 * Why not WebSocket: the host plugin runs inside DSH and cannot rely on npm
 * packages, so a WS server would have to be hand-written; a loopback TCP channel
 * to a single client we control does not need HTTP framing. See technical-design
 * ADR-012 (supersedes ADR-007 transport).
 *
 * The types below are the contract. `parseClientFrame` / `parseHostFrame` are the
 * runtime half: each side validates direction and required fields before acting,
 * so a malformed or misdirected frame never reaches the application.
 */
import { StringDecoder } from 'node:string_decoder'

export const PROTOCOL_VERSION = 1

export const ClientType = {
  hello: 'hello',
  submit: 'submit',
  env: 'env',
  newSession: 'new-session',
  ping: 'ping',
} as const

export const HostType = {
  welcome: 'welcome',
  result: 'result',
  state: 'state',
  answer: 'answer',
  session: 'session',
} as const

export const CAPTURE_MODE = {
  screen: 'screen',
  none: 'none',
} as const

export type CaptureMode = (typeof CAPTURE_MODE)[keyof typeof CAPTURE_MODE]

/** Machine facts the helper collects once per launch. */
export interface EnvironmentFacts {
  platform: string
  os?: string | null
  shell?: string
  pwsh7?: string | null
  python?: string | null
  node?: string | null
  home?: string
  dshHome?: string
  display?: { width: number; height: number; scale: number } | null
  scannedAt?: string
}

/** A PNG encoded for transport. */
export interface ImagePayload {
  base64: string
  mediaType: string
  width?: number
  height?: number
}

// ---------------------------------------------------------------- helper -> host

export interface HelloFrame {
  v: number
  type: 'hello'
  token: string
  platform: string
  capabilities: { capture: boolean; hotkey: boolean; bubble: boolean }
  env: EnvironmentFacts | null
}

export interface SubmitFrame {
  v: number
  type: 'submit'
  requestId: string
  text: string
  capture: { mode: CaptureMode }
  image: ImagePayload | null
}

export interface NewSessionFrame {
  v: number
  type: 'new-session'
  requestId: string
}

export interface EnvFrame {
  v: number
  type: 'env'
  env: EnvironmentFacts
}

export interface PingFrame {
  v: number
  type: 'ping'
  requestId: string
}

export type ClientFrame = HelloFrame | SubmitFrame | NewSessionFrame | EnvFrame | PingFrame

// ---------------------------------------------------------------- host -> helper

export interface WelcomeFrame {
  v: number
  type: 'welcome'
  sessionId: string | null
  model: { provider: string; model: string } | null
  state: string
  protocol: number
}

export interface ResultFrame {
  v: number
  type: 'result'
  requestId?: string
  ok: boolean
  code?: string
  detail?: string
  retryable?: boolean
  messageId?: string
  sessionId?: string
}

export interface StateFrame {
  v: number
  type: 'state'
  state: string
  detail?: string
}

export type AnswerPhase = 'start' | 'tool' | 'delta' | 'end'

export interface AnswerFrame {
  v: number
  type: 'answer'
  phase: AnswerPhase
  text?: string
  ok?: boolean
  detail?: string
}

export interface SessionFrame {
  v: number
  type: 'session'
  sessionId: string
}

export type HostFrame = WelcomeFrame | ResultFrame | StateFrame | AnswerFrame | SessionFrame

// ------------------------------------------------------------------------ codec

/**
 * Hard ceiling for one frame, in bytes.
 *
 * A full-screen PNG screenshot is a few megabytes, and DSH's own image limits
 * allow a 50MB attachment (≈67MB once base64-encoded), so the ceiling has to sit
 * above that while still bounding what a misbehaving client can make us buffer.
 */
export const MAX_FRAME_BYTES = 96 * 1024 * 1024

/** A frame the channel refused to accept. */
export class FrameError extends Error {
  readonly code: 'FRAME_TOO_LARGE'

  constructor (code: 'FRAME_TOO_LARGE', message: string) {
    super(message)
    this.name = 'FrameError'
    this.code = code
  }
}

/** Encode one frame as a single NDJSON line. */
export function encodeFrame (frame: object): string {
  return JSON.stringify(frame) + '\n'
}

export interface FrameDecoderOptions {
  maxFrameBytes?: number
  onError?: (error: FrameError) => void
}

/**
 * Incremental NDJSON decoder.
 *
 * Accepts strings (sockets opened with `setEncoding('utf8')`) and Buffers. The
 * Buffer path goes through StringDecoder, so a multi-byte character split across
 * two TCP segments still decodes.
 */
export function createFrameDecoder (
  onFrame: (frame: unknown) => void,
  options: FrameDecoderOptions = {},
): (chunk: string | Buffer) => void {
  const maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES
  const onError = options.onError
  const stringDecoder = new StringDecoder('utf8')
  let buffer = ''
  /** Bytes currently buffered, kept incrementally so the check stays O(1). */
  let bufferedBytes = 0

  const refuse = (): void => {
    onError?.(new FrameError('FRAME_TOO_LARGE', `frame exceeded ${maxFrameBytes} bytes`))
  }

  return (chunk: string | Buffer): void => {
    const text = typeof chunk === 'string' ? chunk : stringDecoder.write(chunk)
    if (!text) return
    buffer += text
    bufferedBytes += Buffer.byteLength(text, 'utf8')

    let index: number
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1
      bufferedBytes -= lineBytes
      if (line.trim() === '') continue
      if (lineBytes > maxFrameBytes) {
        refuse()
        continue
      }
      let frame: unknown
      try {
        frame = JSON.parse(line)
      } catch {
        continue // a corrupt line must never kill the channel
      }
      onFrame(frame)
    }

    // A line that never terminates is as dangerous as an endless stream of them.
    if (bufferedBytes > maxFrameBytes) {
      buffer = ''
      bufferedBytes = 0
      refuse()
    }
  }
}

// ------------------------------------------------------------- runtime parsing

export type ParseResult<T> =
  | { ok: true; frame: T }
  | { ok: false; reason: string }

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString (value: unknown): value is string {
  return typeof value === 'string'
}

function isNumber (value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function fail<T> (reason: string): ParseResult<T> {
  return { ok: false, reason }
}

/**
 * Validate one inbound helper frame: right direction, known type, required
 * fields present. Unknown extra fields are ignored (forward compatibility).
 */
export function parseClientFrame (value: unknown): ParseResult<ClientFrame> {
  if (!isRecord(value)) return fail('frame is not an object')
  const type = value.type
  if (!isString(type)) return fail('frame has no type')
  if (!isNumber(value.v)) return fail('frame has no version')
  switch (type) {
    case ClientType.hello:
      if (!isString(value.token)) return fail('hello without token')
      if (!isString(value.platform)) return fail('hello without platform')
      if (value.env !== null && value.env !== undefined && !isRecord(value.env)) return fail('hello env is not an object')
      return {
        ok: true,
        frame: {
          v: value.v,
          type: 'hello',
          token: value.token,
          platform: value.platform,
          capabilities: isRecord(value.capabilities)
            ? {
                capture: value.capabilities.capture === true,
                hotkey: value.capabilities.hotkey === true,
                bubble: value.capabilities.bubble === true,
              }
            : { capture: false, hotkey: false, bubble: false },
          env: (value.env ?? null) as EnvironmentFacts | null,
        },
      }
    case ClientType.submit: {
      if (!isString(value.requestId)) return fail('submit without requestId')
      if (!isString(value.text)) return fail('submit without text')
      const capture = isRecord(value.capture) ? value.capture.mode : undefined
      if (capture !== CAPTURE_MODE.screen && capture !== CAPTURE_MODE.none) return fail('submit with unknown capture mode')
      const image = value.image ?? null
      if (image !== null) {
        if (!isRecord(image)) return fail('submit image is not an object')
        if (!isString(image.base64) || !isString(image.mediaType)) return fail('submit image is incomplete')
      }
      return {
        ok: true,
        frame: {
          v: value.v,
          type: 'submit',
          requestId: value.requestId,
          text: value.text,
          capture: { mode: capture },
          image: image === null ? null : (image as unknown as ImagePayload),
        },
      }
    }
    case ClientType.newSession:
      if (!isString(value.requestId)) return fail('new-session without requestId')
      return { ok: true, frame: { v: value.v, type: 'new-session', requestId: value.requestId } }
    case ClientType.env:
      if (!isRecord(value.env)) return fail('env without facts')
      return { ok: true, frame: { v: value.v, type: 'env', env: value.env as unknown as EnvironmentFacts } }
    case ClientType.ping:
      if (!isString(value.requestId)) return fail('ping without requestId')
      return { ok: true, frame: { v: value.v, type: 'ping', requestId: value.requestId } }
    default:
      return fail(`unknown client frame type: ${type}`)
  }
}

/** Validate one inbound host frame. See `parseClientFrame`. */
export function parseHostFrame (value: unknown): ParseResult<HostFrame> {
  if (!isRecord(value)) return fail('frame is not an object')
  const type = value.type
  if (!isString(type)) return fail('frame has no type')
  if (!isNumber(value.v)) return fail('frame has no version')
  switch (type) {
    case HostType.welcome:
      return {
        ok: true,
        frame: {
          v: value.v,
          type: 'welcome',
          sessionId: isString(value.sessionId) ? value.sessionId : null,
          model: isRecord(value.model) && isString(value.model.provider) && isString(value.model.model)
            ? { provider: value.model.provider, model: value.model.model }
            : null,
          state: isString(value.state) ? value.state : 'idle',
          protocol: isNumber(value.protocol) ? value.protocol : 0,
        },
      }
    case HostType.result:
      if (typeof value.ok !== 'boolean') return fail('result without ok')
      return {
        ok: true,
        frame: {
          v: value.v,
          type: 'result',
          requestId: isString(value.requestId) ? value.requestId : undefined,
          ok: value.ok,
          code: isString(value.code) ? value.code : undefined,
          detail: isString(value.detail) ? value.detail : undefined,
          retryable: value.retryable === true,
          messageId: isString(value.messageId) ? value.messageId : undefined,
          sessionId: isString(value.sessionId) ? value.sessionId : undefined,
        },
      }
    case HostType.state:
      if (!isString(value.state)) return fail('state without state')
      return {
        ok: true,
        frame: {
          v: value.v,
          type: 'state',
          state: value.state,
          detail: isString(value.detail) ? value.detail : undefined,
        },
      }
    case HostType.answer: {
      const phase = value.phase
      if (phase !== 'start' && phase !== 'tool' && phase !== 'delta' && phase !== 'end') return fail('answer with unknown phase')
      return {
        ok: true,
        frame: {
          v: value.v,
          type: 'answer',
          phase,
          text: isString(value.text) ? value.text : undefined,
          ok: typeof value.ok === 'boolean' ? value.ok : undefined,
          detail: isString(value.detail) ? value.detail : undefined,
        },
      }
    }
    case HostType.session:
      if (!isString(value.sessionId)) return fail('session without sessionId')
      return { ok: true, frame: { v: value.v, type: 'session', sessionId: value.sessionId } }
    default:
      return fail(`unknown host frame type: ${type}`)
  }
}
