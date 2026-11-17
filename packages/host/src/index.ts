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
import { COMPANION_PERSONA } from './persona.ts'
import type { CompanionPaths, Log } from './types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * This module is the bundled plugin entry, so it lives at
 * `packages/host/lib/index.js` in the checkout, or at `<package>/lib/index.js`
 * when installed. The helper is looked up relative to the package root, which
 * covers both layouts.
 */
const PACKAGE_ROOT = join(HERE, '..')
const REPO_ROOT = join(PACKAGE_ROOT, '..', '..')

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_DIR = join(DSH_HOME, 'dsh-pet-go')

const PATHS: CompanionPaths = {
  dshHome: DSH_HOME,
  stateDir: STATE_DIR,
  workspaceDir: join(STATE_DIR, 'workspace'),
  envDir: STATE_DIR,
  stateFile: join(STATE_DIR, 'state.json'),
  logFile: join(STATE_DIR, 'host.log'),
}

/** Older builds wrote everything to `$DSH_HOME/companion`. */
const LEGACY_DIR = join(DSH_HOME, 'companion')

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
    legacyDir: LEGACY_DIR,
    repoRoot: REPO_ROOT,
    packageRoot: PACKAGE_ROOT,
    // The DSH boundary is assembled here and nowhere else.
    adapter: createDshAdapter(ctx, { log, persona: COMPANION_PERSONA }),
    workspace: createWorkspacePort(ctx, log),
    log,
  })
  ctx.effect(() => {
    void service.start()
    return () => service.dispose()
  })
}
