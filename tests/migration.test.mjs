/**
 * The one-time move from `$DSH_HOME/companion` to `$DSH_HOME/dsh-pet-go`.
 *
 * The old workspace path has to keep resolving: the companion session's cwd is
 * recorded in its header and resume cannot change it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { migrateLayout } from '../packages/host/src/migrate.ts'

async function makeLegacyTree () {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pet-migrate-'))
  const legacyDir = join(root, 'companion')
  await mkdir(join(legacyDir, 'workspace'), { recursive: true })
  await writeFile(join(legacyDir, 'workspace', 'AGENTS.md'), '# 旧指引\n', 'utf8')
  await writeFile(join(legacyDir, 'state.json'), JSON.stringify({ sessionId: 'session-old' }), 'utf8')
  await writeFile(join(legacyDir, 'host.log'), 'old log\n', 'utf8')
  return { root, legacyDir, stateDir: join(root, 'dsh-pet-go') }
}

const recorder = () => {
  const collected = []
  return { collected, log: (line) => collected.push(line) }
}

test('the legacy directory is moved once and the old path keeps resolving', async () => {
  const { legacyDir, stateDir } = await makeLegacyTree()
  const { collected, log } = recorder()
  const result = await migrateLayout({
    legacyDir,
    stateDir,
    workspaceDir: join(stateDir, 'workspace'),
    log,
  })

  assert.equal(result.migrated, true)
  assert.equal(result.legacyWorkspace, join(legacyDir, 'workspace'))
  assert.equal(await readFile(join(stateDir, 'workspace', 'AGENTS.md'), 'utf8'), '# 旧指引\n')
  assert.equal(JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8')).sessionId, 'session-old')
  assert.equal(existsSync(join(stateDir, 'host.log')), true)

  // The session header still points at the old path, so it must resolve to the
  // moved directory instead of disappearing.
  assert.equal(existsSync(join(legacyDir, 'workspace', 'AGENTS.md')), true)
  assert.ok(collected.some((line) => line.includes('junction') || line.includes('could not keep')))
})

test('a second start does not migrate again', async () => {
  const { legacyDir, stateDir } = await makeLegacyTree()
  const first = await migrateLayout({ legacyDir, stateDir, workspaceDir: join(stateDir, 'workspace'), log: recorder().log })
  assert.equal(first.migrated, true)

  const second = await migrateLayout({ legacyDir, stateDir, workspaceDir: join(stateDir, 'workspace'), log: recorder().log })
  assert.equal(second.migrated, false, 'nothing left to move')
})

test('a fresh install has nothing to migrate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pet-fresh-'))
  const result = await migrateLayout({
    legacyDir: join(root, 'companion'),
    stateDir: join(root, 'dsh-pet-go'),
    workspaceDir: join(root, 'dsh-pet-go', 'workspace'),
    log: recorder().log,
  })
  assert.deepEqual(result, { migrated: false, legacyWorkspace: null })
})
