/**
 * dsh-pet-go — the Cordis plugin entry.
 *
 * The only job of this process: turn (text + screenshot) into one ordinary user
 * message inside a dedicated DSH session, then relay that session's assistant
 * stream back to the floating window.
 *
 * This file resolves where things live and wires the service; the work itself is
 * in companion.ts and its modules. It deliberately owns nothing else: no OCR, no
 * coordinates, no context management, no model capability probing.
 */
import { homedir } from 'node:os'
import { appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CompanionService } from './companion.ts'
import { createDshAdapter, createWorkspacePort } from './adapters/dsh.ts'
import type { DshContext } from './adapters/dsh.ts'
import type { CompanionPaths, Log } from './types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * This module is the bundled plugin entry, so it lives at
 * `packages/host/lib/index.js` and the helper is its sibling workspace package.
 * The pair is always built together (scripts/build.mjs) and installed from the
 * same checkout.
 */
const REPO_ROOT = join(HERE, '..', '..', '..')

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const COMPANION_DIR = join(DSH_HOME, 'companion')

const PATHS: CompanionPaths = {
  dshHome: DSH_HOME,
  companionDir: COMPANION_DIR,
  workspaceDir: join(COMPANION_DIR, 'workspace'),
  envDir: join(DSH_HOME, 'dsh-pet-go'),
  stateFile: join(COMPANION_DIR, 'state.json'),
  logFile: join(COMPANION_DIR, 'host.log'),
}

export const name = 'companion'
export const inject = ['attachments', 'agents']

interface CordisContext extends DshContext {
  effect (setup: () => (() => void) | void): void
}

/** One log file for both processes, appended without blocking the turn. */
function fileLogger (logFile: string): Log {
  return (line: string): void => {
    void appendFile(logFile, `[${new Date().toISOString()}] ${line}\n`, 'utf8').catch(() => {})
  }
}

export function apply (ctx: CordisContext, config: Record<string, unknown> = {}): void {
  const log = fileLogger(PATHS.logFile)
  const service = new CompanionService({
    config,
    paths: PATHS,
    repoRoot: REPO_ROOT,
    // The DSH boundary is assembled here and nowhere else.
    adapter: createDshAdapter(ctx, { log }),
    workspace: createWorkspacePort(ctx, log),
    log,
  })
  ctx.effect(() => {
    void service.start()
    return () => service.dispose()
  })
}
