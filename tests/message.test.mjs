import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createUserMessage, textBlock, imageBlock } from '@dsh-pet-go/shared/message'

test('a user message without `role` would be rejected by DSH, so it is always set', () => {
  const message = createUserMessage({ content: [textBlock('hi')] })
  assert.equal(message.role, 'user')
  assert.equal(typeof message.id, 'string')
  assert.ok(message.id.length > 0)
  assert.deepEqual(message.content, [{ type: 'text', text: 'hi' }])
  assert.deepEqual(message.source, { kind: 'user' })
})

test('every message gets its own id', () => {
  const first = createUserMessage({ content: [textBlock('a')] })
  const second = createUserMessage({ content: [textBlock('a')] })
  assert.notEqual(first.id, second.id)
})

test('content blocks are copied and frozen, so later edits cannot leak in', () => {
  const block = textBlock('original')
  const message = createUserMessage({ content: [block] })
  block.text = 'mutated'
  assert.equal(message.content[0].text, 'original')
  assert.ok(Object.isFrozen(message))
  assert.ok(Object.isFrozen(message.content))
  assert.ok(Object.isFrozen(message.content[0]))
})

test('falsy blocks are dropped; an empty message is refused', () => {
  const message = createUserMessage({ content: [textBlock('only'), null, undefined] })
  assert.equal(message.content.length, 1)
  assert.throws(() => createUserMessage({ content: [] }), /at least one content block/)
})

test('image blocks wrap an attachment reference unchanged', () => {
  const attachment = { kind: 'image', id: 'att-1' }
  assert.deepEqual(imageBlock(attachment), { type: 'image', attachment })
})

test('text then image is the order the model reads', () => {
  const message = createUserMessage({
    content: [textBlock('看这个'), imageBlock({ id: 'att-1' })],
    source: { kind: 'user' },
  })
  assert.deepEqual(message.content.map((block) => block.type), ['text', 'image'])
})
