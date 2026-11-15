import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { checkDependencyRules } from '../scripts/dep-rules.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURES = join(ROOT, 'tests', 'fixtures', 'dep-rules')

/** Violations grouped by rule, for readable assertions. */
function byRule (root) {
  const grouped = {}
  for (const violation of checkDependencyRules({ root })) {
    ;(grouped[violation.rule] ??= []).push({ ...violation, file: violation.file.split('\\').join('/') })
  }
  return grouped
}

test('the real sources satisfy every rule', () => {
  const violations = checkDependencyRules({ root: ROOT })
  assert.deepEqual(
    violations.map((violation) => `${violation.file} [${violation.rule}] ${violation.specifier}`),
    [],
  )
})

test('the passing fixture is accepted as a whole', () => {
  assert.deepEqual(checkDependencyRules({ root: join(FIXTURES, 'pass') }), [])
})

test('a cross-package relative import is rejected', () => {
  const violations = byRule(join(FIXTURES, 'fail'))
  const cross = violations['cross-package'] ?? []
  assert.ok(cross.some((violation) => violation.file.endsWith('host/src/cross.ts')))
  assert.ok(cross.some((violation) => violation.file.endsWith('shared/src/leak.js')))
})

test('shared may not import a platform package', () => {
  const violations = byRule(join(FIXTURES, 'fail'))['shared-pure'] ?? []
  assert.deepEqual(violations.map((violation) => violation.file), ['packages/shared/src/leak.js'])
})

test('adapters are only assembled by the host entry', () => {
  const violations = byRule(join(FIXTURES, 'fail'))['adapters'] ?? []
  assert.deepEqual(violations.map((violation) => violation.file), ['packages/host/src/companion.ts'])
})

test('Electron is confined to the platform modules and the helper entry', () => {
  const violations = byRule(join(FIXTURES, 'fail'))['electron'] ?? []
  assert.deepEqual(violations.map((violation) => violation.file), ['packages/helper/src/ui.ts'])
})

test('dynamic import and require are inspected too', () => {
  const dynamicRoot = join(FIXTURES, 'dynamic')
  const rules = checkDependencyRules({ root: dynamicRoot }).map((violation) => violation.rule).sort()
  assert.deepEqual(rules, ['cross-package', 'cross-package'])
})
