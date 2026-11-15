#!/usr/bin/env node
/**
 * Enforce the architecture's dependency rules on the real sources.
 * Exits non-zero (and prints every violation) when a rule is broken.
 */
import { fileURLToPath } from 'node:url'
import { checkDependencyRules } from './dep-rules.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const violations = checkDependencyRules({ root })

if (violations.length === 0) {
  console.log('dependency rules: ok')
  process.exit(0)
}

console.error(`dependency rules: ${violations.length} violation(s)`)
for (const violation of violations) {
  console.error(`  ${violation.file} [${violation.rule}] ${violation.specifier} — ${violation.message}`)
}
process.exit(1)
