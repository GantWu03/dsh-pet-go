/**
 * Message construction.
 *
 * DSH exposes `createUserMessage()` from `@deepseek-ai/dsh-llm`, but a
 * workspace-linked bundle cannot resolve that package (`ERR_MODULE_NOT_FOUND`),
 * so this module rebuilds the same runtime value. The shape was verified live
 * against DSH 0.2.2-rc.2 (see PLAN.md, "M-1.5 实测结论"):
 *
 *   UserMessage = { id, role: 'user', content: ContentBlock[], source: MessageSource }
 *
 * Dropping `role` makes the DeepSeek adapter reject the request with
 * "supports images only in user messages and tool results", so it is not
 * optional here.
 */
import { randomUUID } from 'node:crypto'

/**
 * @param {string} text
 * @returns {{ type: 'text', text: string }}
 */
export function textBlock (text) {
  return { type: 'text', text }
}

/**
 * @param {import('./protocol.js').ImageAttachmentRef} attachment
 * @returns {{ type: 'image', attachment: object }}
 */
export function imageBlock (attachment) {
  return { type: 'image', attachment }
}

/**
 * Build one user message carrying text and/or images.
 * @param {{ content: object[], source?: { kind: string } }} input
 * @returns {{ id: string, role: 'user', content: object[], source: { kind: string } }}
 */
export function createUserMessage (input) {
  const content = input.content.filter(Boolean)
  if (content.length === 0) throw new Error('a user message needs at least one content block')
  return Object.freeze({
    id: randomUUID(),
    role: /** @type {'user'} */ ('user'),
    content: Object.freeze(content.map((block) => Object.freeze({ ...block }))),
    source: Object.freeze(input.source ?? { kind: 'user' }),
  })
}
