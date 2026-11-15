/**
 * Loopback TCP transport for the host plugin.
 *
 * Owns the listener, the handshake (token, version), the current connection and
 * every write to it. It knows nothing about sessions or submissions: it validates
 * direction and shape, then hands frames to the companion.
 *
 * Two rules live here because they are connection state:
 *   - a reply goes to the connection that asked, never to "whoever is current";
 *   - a response whose connection has been replaced is dropped, and the new
 *     connection gets only its own welcome.
 */
import net from 'node:net'

import {
  PROTOCOL_VERSION,
  encodeFrame,
  createFrameDecoder,
  parseClientFrame,
} from '@dsh-pet-go/shared/protocol'
import type { ClientFrame, HelloFrame, HostFramePayload } from '@dsh-pet-go/shared/protocol'
import { ErrorCode, describeError } from '@dsh-pet-go/shared/errors'

import type { Log } from '../types.ts'

/** A reply channel bound to one socket. */
export interface Connection {
  /**
   * Send to this connection only. Silently ignored once the socket is gone, so a
   * request that finishes after a reconnect cannot answer the new client.
   */
  send (frame: HostFramePayload): void
  close (): void
}

export interface TransportOptions {
  token: string
  log: Log
  /** A client completed the handshake with a valid token and version. */
  onClient: (hello: HelloFrame, connection: Connection) => Promise<void> | void
  /** A valid frame from a connected client. */
  onFrame: (frame: ClientFrame, connection: Connection) => Promise<void> | void
  onDisconnect: (connection: Connection) => void
}

export interface Transport {
  listen (): Promise<number>
  close (): void
  /** Broadcast to the current connection (relay frames, restart notices). */
  send (frame: HostFramePayload): void
  readonly port: number
  readonly connected: boolean
}

export function createTransport (options: TransportOptions): Transport {
  const { token, log } = options
  let server: net.Server | null = null
  let client: net.Socket | null = null
  let port = 0
  let closed = false

  const writeTo = (socket: net.Socket, frame: HostFramePayload): void => {
    if (socket.destroyed) return
    try {
      socket.write(encodeFrame({ v: PROTOCOL_VERSION, ...frame }))
    } catch (error) {
      log(`send failed: ${(error as Error)?.message}`)
    }
  }

  const onSocket = (socket: net.Socket): void => {
    socket.setNoDelay(true)
    socket.setEncoding('utf8')
    let greeted = false

    const drop = (): void => {
      try {
        socket.destroy()
      } catch {}
    }

    const connection: Connection = {
      send: (frame) => writeTo(socket, frame),
      close: drop,
    }

    const decode = createFrameDecoder((raw) => {
      const parsed = parseClientFrame(raw)
      if (!parsed.ok) {
        log(`frame rejected: ${parsed.reason}`)
        // Before the handshake a bad frame means "not our client"; afterwards it
        // is an ordinary bad request answered on the same connection.
        if (!greeted) drop()
        else connection.send({ type: 'result', ok: false, ...describeError(ErrorCode.BAD_REQUEST, parsed.reason) })
        return
      }
      const frame = parsed.frame
      if (!greeted) {
        if (frame.type !== 'hello' || frame.token !== token) {
          log('handshake rejected')
          drop()
          return
        }
        if (frame.v !== PROTOCOL_VERSION) {
          connection.send({ type: 'result', ok: false, ...describeError(ErrorCode.PROTOCOL_MISMATCH) })
          drop()
          return
        }
        greeted = true
        if (client && client !== socket) {
          try { client.destroy() } catch {}
        }
        client = socket
        Promise.resolve(options.onClient(frame, connection)).catch((error) => {
          log(`client setup failed: ${(error as Error)?.message ?? error}`)
        })
        return
      }
      Promise.resolve(options.onFrame(frame, connection)).catch((error) => {
        log(`frame dispatch failed: ${(error as Error)?.message ?? error}`)
      })
    }, {
      // An oversized or runaway frame is a connection-level problem: the stream
      // is already out of sync, so drop it and let the helper reconnect.
      onError: (error) => {
        log(`frame rejected: ${error.code}`)
        drop()
      },
    })

    socket.on('data', (chunk) => decode(chunk))
    socket.on('error', () => {})
    socket.on('close', () => {
      if (client === socket) {
        client = null
        options.onDisconnect(connection)
      }
    })
  }

  return {
    listen (): Promise<number> {
      return new Promise((resolve, reject) => {
        const listener = net.createServer(onSocket)
        listener.once('error', reject)
        listener.listen(0, '127.0.0.1', () => {
          listener.removeListener('error', reject)
          listener.on('error', (error: Error) => log(`server error: ${error?.message}`))
          port = (listener.address() as net.AddressInfo).port
          if (closed) {
            // close() ran while we were binding: the service is already gone, so
            // do not leave a listening socket behind.
            try { listener.close() } catch {}
            resolve(port)
            return
          }
          server = listener
          resolve(port)
        })
      })
    },

    close (): void {
      closed = true
      if (client) {
        try { client.destroy() } catch {}
        client = null
      }
      if (server) {
        try { server.close() } catch {}
        server = null
      }
    },

    send (frame: HostFramePayload): void {
      if (!client) return
      writeTo(client, frame)
    },

    get port (): number {
      return port
    },

    get connected (): boolean {
      return Boolean(client && !client.destroyed)
    },
  }
}
