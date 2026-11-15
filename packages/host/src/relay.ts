/**
 * Session events to bubble frames.
 *
 * The relay only ever talks about the current session: events for any other
 * agent are dropped, which is what keeps an old answer from appearing in a
 * freshly created session.
 */
import type { HostFramePayload } from '@dsh-pet-go/shared/protocol'

import type { AgentEvent, EventPort } from './adapters/dsh.ts'
import type { Log } from './types.ts'

export interface RelayOptions {
  log: Log
  events: EventPort
  send: (frame: HostFramePayload) => void
  getSessionId: () => string | null
  /** The turn finished; the supervisor may clear its restart backoff. */
  onIdle: () => void
}

export interface Relay {
  start (): void
  stop (): void
}

export function createRelay (options: RelayOptions): Relay {
  const { log, events, send } = options
  let text = ''
  let unsubscribe: (() => void) | null = null

  const handle = (event: AgentEvent): void => {
    const sessionId = options.getSessionId()
    if (!sessionId || event.agentId !== sessionId) return
    switch (event.kind) {
      case 'stream-start':
        text = ''
        send({ type: 'answer', phase: 'start' })
        return
      case 'text-delta':
        text += event.text
        send({ type: 'answer', phase: 'delta', text: event.text })
        return
      case 'tool-call-start':
        // The model is going off to investigate; the bubble says so instead of
        // sitting empty for the next dozen tool calls.
        send({ type: 'answer', phase: 'tool' })
        return
      case 'stream-end':
        log(`answer end ok=${event.committed} text=${text.slice(0, 600).replace(/\s+/g, ' ')}`)
        send({ type: 'answer', phase: 'end', ok: event.committed })
        text = ''
        return
      case 'status': {
        send({ type: 'state', state: event.status })
        if (event.status === 'idle') options.onIdle()
        return
      }
      case 'error':
        log(`agent error: ${event.message}`)
        send({ type: 'answer', phase: 'end', ok: false, detail: event.message })
        return
    }
  }

  return {
    start (): void {
      unsubscribe = events.subscribe(handle)
    },

    stop (): void {
      try {
        unsubscribe?.()
      } catch {}
      unsubscribe = null
    },
  }
}
