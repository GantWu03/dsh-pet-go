/**
 * Message construction.
 *
 * DSH exposes `createUserMessage()` from `@deepseek-ai/dsh-llm`, but a
 * workspace-linked bundle cannot resolve that package (`ERR_MODULE_NOT_FOUND`),
 * so this module rebuilds the same runtime value. The shape was verified live
 * against DSH 0.2.2-rc.2 (see docs/baseline.md):
 *
 *   UserMessage = { id, role: 'user', content: ContentBlock[], source }
 *
 * Dropping `role` makes the DeepSeek adapter reject the request with
 * "supports images only in user messages and tool results", so it is not
 * optional here.
 */
import { randomUUID } from 'node:crypto'

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ImageBlock {
  type: 'image'
  attachment: object
}

export type ContentBlock = TextBlock | ImageBlock

export interface UserMessage {
  id: string
  role: 'user'
  content: readonly ContentBlock[]
  source: { kind: string }
}

export function textBlock (text: string): TextBlock {
  return { type: 'text', text }
}

export function imageBlock (attachment: object): ImageBlock {
  return { type: 'image', attachment }
}

/** Build one user message carrying text and/or images. */
export function createUserMessage (input: { content: ContentBlock[], source?: { kind: string } }): UserMessage {
  const content = input.content.filter(Boolean)
  if (content.length === 0) throw new Error('a user message needs at least one content block')
  return Object.freeze({
    id: randomUUID(),
    role: 'user' as const,
    content: Object.freeze(content.map((block) => Object.freeze({ ...block }))),
    source: Object.freeze(input.source ?? { kind: 'user' }),
  })
}
