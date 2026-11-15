/**
 * Loopback TCP transport for the host plugin.
 *
 * Owns the listener, the handshake (token, version), the single current
 * connection and every write to it. It knows nothing about sessions or
 * submissions: it validates direction and shape, then hands frames to the
 * companion. A response for a connection that has already been replaced is
 * dropped here, because "the current client" is transport state.
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

export interface TransportOptions {
  token: string
  log: Log
  /** A client completed the handshake with a valid token and version. */
  onClient: (hello: HelloFrame) => Promise<void> | void
  /** A valid frame from the current client. */
  onFrame: (frame: ClientFrame) => Promise<void> | void
  onDisconnect: () => void
}

export interface Transport {
  listen (): Promise<number>
  close (): void
  send (frame: HostFramePayload): void
  readonly port: number
  readonly connected: boolean
}

export function createTransport (options: TransportOptions): Transport {
  const { token, log } = options
  let server: net.Server | null = null
  let client: net.Socket | null = null
  let port = 0

  const reply = (socket: net.Socket, frame: HostFramePayload): void => {
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

    const decode = createFrameDecoder((raw) => {
      const parsed = parseClientFrame(raw)
      if (!parsed.ok) {
        log(`frame rejected: ${parsed.reason}`)
        // Before the handshake a bad frame means "not our client"; afterwards it
        // is an ordinary bad request answered on the existing channel.
        if (!greeted) drop()
        else reply(socket, { type: 'result', ok: false, ...describeError(ErrorCode.BAD_REQUEST, parsed.reason) })
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
          reply(socket, { type: 'result', ok: false, ...describeError(ErrorCode.PROTOCOL_MISMATCH) })
          drop()
          return
        }
        greeted = true
        if (client && client !== socket) {
          try { client.destroy() } catch {}
        }
        client = socket
        void options.onClient(frame)
        return
      }
      void options.onFrame(frame)
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
        options.onDisconnect()
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
          server = listener
          port = (listener.address() as net.AddressInfo).port
          resolve(port)
        })
      })
    },

    close (): void {
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
      if (!client || client.destroyed) return
      reply(client, frame)
    },

    get port (): number {
      return port
    },

    get connected (): boolean {
      return Boolean(client && !client.destroyed)
    },
  }
}
