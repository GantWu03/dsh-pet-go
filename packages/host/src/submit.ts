/**
 * Turning one submit frame into one ordinary user message.
 *
 * The screenshot is saved as an attachment first, then text and image become the
 * content blocks of a single message. Nothing here inspects the image or the
 * screen: what the model sees is exactly what was captured.
 */
import { ErrorCode } from '@dsh-pet-go/shared/errors'
import { imageBlock, textBlock, createUserMessage } from '@dsh-pet-go/shared/message'
import type { SubmitFrame } from '@dsh-pet-go/shared/protocol'
import { CAPTURE_MODE } from '@dsh-pet-go/shared/protocol'

import type { LiveAgent, SessionPort } from './adapters/dsh.ts'
import type { Log } from './types.ts'

export class SubmitError extends Error {
  readonly code: string
  readonly detail?: string

  constructor (code: string, detail?: string) {
    super(detail ?? code)
    this.name = 'SubmitError'
    this.code = code
    this.detail = detail
  }
}

export interface SubmitResult {
  messageId: string
  sessionId: string
}

export interface Submitter {
  run (frame: SubmitFrame, agent: LiveAgent): Promise<SubmitResult>
}

export interface SubmitterOptions {
  log: Log
  sessions: SessionPort
}

export function createSubmitter (options: SubmitterOptions): Submitter {
  const { log, sessions } = options

  return {
    async run (frame: SubmitFrame, agent: LiveAgent): Promise<SubmitResult> {
      const text = typeof frame.text === 'string' ? frame.text.trim() : ''
      const wantsImage = frame.capture?.mode === CAPTURE_MODE.screen && Boolean(frame.image?.base64)
      if (!text && !wantsImage) throw new SubmitError(ErrorCode.BAD_REQUEST, '空消息')

      const blocks = []
      if (text) blocks.push(textBlock(text))
      if (wantsImage && frame.image) {
        const bytes = Buffer.from(String(frame.image.base64), 'base64')
        let attachment: object
        try {
          attachment = await sessions.saveImage({
            data: new Uint8Array(bytes),
            mediaType: frame.image.mediaType || 'image/png',
            name: 'companion-screen.png',
          })
        } catch (error) {
          throw new SubmitError(ErrorCode.IMAGE_TOO_LARGE, (error as Error)?.message)
        }
        blocks.push(imageBlock(attachment))
      }

      const message = createUserMessage({ content: blocks, source: { kind: 'user' } })
      sessions.followup(agent, message)
      log(`submitted ${message.id} (${blocks.length} blocks, ${wantsImage ? 'with image' : 'text only'})`)
      return { messageId: message.id, sessionId: agent.id }
    },
  }
}
