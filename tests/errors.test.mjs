import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ErrorCode, describeError } from '@dsh-pet-go/shared/errors'

const CODES = Object.values(ErrorCode)

test('every error code answers with a code, a sentence and a retry flag', () => {
  for (const code of CODES) {
    const described = describeError(code)
    assert.equal(described.code, code)
    assert.equal(typeof described.detail, 'string')
    assert.ok(described.detail.length > 0, `${code} needs a user-facing sentence`)
    assert.equal(typeof described.retryable, 'boolean')
  }
})

test('retryable is limited to failures the user can retry as-is', () => {
  const retryable = CODES.filter((code) => describeError(code).retryable).sort()
  assert.deepEqual(retryable, ['AGENT_UNAVAILABLE', 'CAPTURE_EMPTY', 'DSH_NOT_READY', 'TRANSPORT_LOST'])
})

test('detail is appended to the sentence, not used instead of it', () => {
  const described = describeError(ErrorCode.IMAGE_TOO_LARGE, 'max 50MB')
  assert.match(described.detail, /^这张图太大了/)
  assert.match(described.detail, /max 50MB/)
})

test('an unknown code falls back to the internal sentence but keeps the code', () => {
  const described = describeError('SOMETHING_NEW')
  assert.equal(described.code, 'SOMETHING_NEW')
  assert.equal(described.detail, '内部错误')
  assert.equal(described.retryable, false)
})
