/**
 * dsh-companion — wire protocol v1 (shared by host plugin and Electron helper).
 *
 * Transport: TCP on 127.0.0.1 + newline-delimited JSON (NDJSON).
 * Every frame is one JSON object followed by "\n".
 *
 * Why not WebSocket: the host plugin runs inside DSH and cannot import npm
 * packages (verified: `ERR_MODULE_NOT_FOUND`), so a WS server would have to be
 * hand-written; a loopback TCP channel to a single client we control does not
 * need HTTP framing. See technical-design ADR-012 (supersedes ADR-007 transport).
 */
import { StringDecoder } from 'node:string_decoder'

export const PROTOCOL_VERSION = 1

/** helper -> host */
export const ClientType = /** @type {const} */ ({
  hello: 'hello',
  submit: 'submit',
  env: 'env',
  newSession: 'new-session',
  ping: 'ping',
})

/** host -> helper */
export const HostType = /** @type {const} */ ({
  welcome: 'welcome',
  result: 'result',
  state: 'state',
  answer: 'answer',
  session: 'session',
})

export const CAPTURE_MODE = /** @type {const} */ ({
  screen: 'screen',
  none: 'none',
})

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
  /**
   * @param {'FRAME_TOO_LARGE'} code
   * @param {string} message
   */
  constructor (code, message) {
    super(message)
    this.name = 'FrameError'
    this.code = code
  }
}

/**
 * Encode one frame.
 * @param {object} frame
 * @returns {string} NDJSON line
 */
export function encodeFrame (frame) {
  return JSON.stringify(frame) + '\n'
}

/**
 * Incremental NDJSON decoder.
 *
 * Accepts strings (sockets opened with `setEncoding('utf8')`) and Buffers. The
 * Buffer path goes through StringDecoder, so a multi-byte character split across
 * two TCP segments still decodes.
 *
 * @param {(frame: any) => void} onFrame
 * @param {{ maxFrameBytes?: number, onError?: (error: FrameError) => void }} [options]
 * @returns {(chunk: string | Buffer) => void}
 */
export function createFrameDecoder (onFrame, options = {}) {
  const maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES
  const onError = options.onError
  const stringDecoder = new StringDecoder('utf8')
  let buffer = ''
  /** Bytes currently buffered, kept incrementally so the check stays O(1). */
  let bufferedBytes = 0

  const overflow = () => {
    buffer = ''
    bufferedBytes = 0
    onError?.(new FrameError('FRAME_TOO_LARGE', `frame exceeded ${maxFrameBytes} bytes`))
  }

  return (chunk) => {
    const text = typeof chunk === 'string' ? chunk : stringDecoder.write(chunk)
    if (!text) return
    buffer += text
    bufferedBytes += Buffer.byteLength(text, 'utf8')

    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1
      bufferedBytes -= lineBytes
      if (line.trim() === '') continue
      if (lineBytes > maxFrameBytes) {
        onError?.(new FrameError('FRAME_TOO_LARGE', `frame exceeded ${maxFrameBytes} bytes`))
        continue
      }
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        continue // a corrupt line must never kill the channel
      }
      onFrame(frame)
    }

    // A line that never terminates is as dangerous as an endless stream of them.
    if (bufferedBytes > maxFrameBytes) overflow()
  }
}
