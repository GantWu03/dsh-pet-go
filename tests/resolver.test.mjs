/**
 * Where the helper is found.
 *
 * Two layouts ship: a checkout (host package + sibling helper build) and an
 * installed package (the helper app copied next to lib/). A published install
 * that cannot find its helper loses the whole floating window, so both are
 * covered here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveHelperDir } from '../packages/host/src/runtime/supervisor.ts'

async function makeAppDir (directory) {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'main.js'), '// helper entry\n', 'utf8')
  await writeFile(join(directory, 'package.json'), '{"name":"@dsh-pet-go/helper"}\n', 'utf8')
}

test('an installed package finds the helper inside itself', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pet-pack-'))
  const packageRoot = join(root, 'node_modules', '@dsh-pet-go', 'host')
  await makeAppDir(join(packageRoot, 'helper'))

  const found = resolveHelperDir({ packageRoot, repoRoot: join(root, 'nowhere') })
  assert.equal(found, join(packageRoot, 'helper'))
})

test('a checkout finds the sibling workspace build', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'dsh-pet-repo-'))
  await makeAppDir(join(repoRoot, 'packages', 'helper', 'dist'))

  const found = resolveHelperDir({ packageRoot: join(repoRoot, 'packages', 'host'), repoRoot })
  assert.equal(found, join(repoRoot, 'packages', 'helper', 'dist'))
})

test('a missing build resolves to null instead of a broken path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pet-none-'))
  const found = resolveHelperDir({ packageRoot: join(root, 'pkg'), repoRoot: join(root, 'repo') })
  // An env override would legitimately win here; only assert when none is set.
  if (!process.env.DSH_PET_GO_HELPER) assert.equal(found, null)
})

test('an incomplete directory is not mistaken for the helper', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pet-partial-'))
  const packageRoot = join(root, 'pkg')
  await mkdir(join(packageRoot, 'helper'), { recursive: true })
  await writeFile(join(packageRoot, 'helper', 'main.js'), '// no manifest\n', 'utf8')

  const found = resolveHelperDir({ packageRoot, repoRoot: join(root, 'repo') })
  if (!process.env.DSH_PET_GO_HELPER) assert.equal(found, null)
})
