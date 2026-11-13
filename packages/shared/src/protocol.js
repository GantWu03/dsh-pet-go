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

export const PROTOCOL_VERSION = 1

/** helper -> host */
export const ClientType = /** @type {const} */ ({
  hello: 'hello',
  submit: 'submit',
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
 * Encode one frame.
 * @param {object} frame
 * @returns {string} NDJSON line
 */
export function encodeFrame (frame) {
  return JSON.stringify(frame) + '\n'
}

/**
 * Incremental NDJSON decoder.
 * @param {(frame: any) => void} onFrame
 * @returns {(chunk: string | Buffer) => void}
 */
export function createFrameDecoder (onFrame) {
  let buffer = ''
  return (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.trim() === '') continue
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        continue // a corrupt line must never kill the channel
      }
      onFrame(frame)
    }
    // guard against a runaway frame (a client we do not control could flood us)
    if (buffer.length > 64 * 1024 * 1024) buffer = ''
  }
}
