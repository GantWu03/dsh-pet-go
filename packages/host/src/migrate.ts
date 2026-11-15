/**
 * One-time move from `$DSH_HOME/companion` to `$DSH_HOME/dsh-pet-go`.
 *
 * The session's working directory is recorded in its session header and cannot
 * be changed on resume (`ResumeAgentOptions` has no cwd). Moving the directory
 * alone would leave the existing companion session pointing at a path that no
 * longer exists, which breaks both the AGENTS.md injection and its tools. So the
 * old path is kept as a junction to the new directory: the resumed session keeps
 * working, while everything new uses the canonical path.
 */
import { existsSync } from 'node:fs'
import { cp, mkdir, rename, rm, stat, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { Log } from './types.ts'

export interface MigrationInput {
  legacyDir: string
  stateDir: string
  workspaceDir: string
  log: Log
}

export interface MigrationResult {
  migrated: boolean
  /** The old workspace path, when it was moved (used to clean up the old row). */
  legacyWorkspace: string | null
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Move a file or directory, falling back to copy+delete across handles. */
async function move (from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
    return
  } catch {}
  await cp(from, to, { recursive: true })
  await rm(from, { recursive: true, force: true })
}

/**
 * Keep the old path usable. Best effort: a failure only means the resumed
 * session's cwd is gone, which the caller reports.
 */
async function linkBack (legacyPath: string, target: string): Promise<boolean> {
  try {
    await symlink(target, legacyPath, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch {
    return false
  }
}

export async function migrateLayout (input: MigrationInput): Promise<MigrationResult> {
  const { legacyDir, stateDir, workspaceDir, log } = input
  const legacyWorkspace = join(legacyDir, 'workspace')
  const result: MigrationResult = { migrated: false, legacyWorkspace: null }

  const legacyExists = await exists(legacyWorkspace)
  const targetExists = await exists(workspaceDir)
  if (!legacyExists || targetExists) return result

  try {
    await mkdir(stateDir, { recursive: true })
    await move(legacyWorkspace, workspaceDir)
    result.migrated = true
    result.legacyWorkspace = legacyWorkspace

    const linked = await linkBack(legacyWorkspace, workspaceDir)
    log(linked
      ? `workspace moved to ${workspaceDir}; ${legacyWorkspace} kept as a junction for the existing session`
      : `workspace moved to ${workspaceDir}; could not keep ${legacyWorkspace} (old session cwd is gone)`)

    for (const name of ['state.json', 'host.log']) {
      const from = join(legacyDir, name)
      const to = join(stateDir, name)
      if (!(await exists(from)) || (await exists(to))) continue
      try {
        await mkdir(dirname(to), { recursive: true })
        await move(from, to)
      } catch (error) {
        log(`could not move ${name}: ${(error as Error)?.message}`)
      }
    }
    log('state directory migrated: $DSH_HOME/companion -> $DSH_HOME/dsh-pet-go')
  } catch (error) {
    log(`migration failed: ${(error as Error)?.message}`)
    result.migrated = false
    result.legacyWorkspace = null
  }
  return result
}

/** The companion's own files are under the state dir; this is only for logs. */
export function legacyStateExists (legacyDir: string): boolean {
  return existsSync(legacyDir)
}
