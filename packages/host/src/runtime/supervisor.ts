/**
 * The helper process: where the Electron binary is, what it is launched with,
 * and how a crash is retried.
 *
 * Electron is provided at runtime (the DSH installation ships one under
 * `$DSH_HOME/electron`), so finding it is a plain function rather than a service;
 * only the child process and the backoff live in here.
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { Log } from '../types.ts'

const RESTART_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000]

export interface SupervisorOptions {
  log: Log
  /** Electron executable, or null when it could not be found. */
  electron: string | null
  /** The helper's built application directory, or null when it is missing. */
  helperDir: string | null
  port: number
  token: string
  dshHome: string
  logFile: string
  /** Called when a restart is scheduled, so the bubble can say so. */
  onRestartScheduled: (attempt: number) => void
}

export interface Supervisor {
  start (): void
  stop (): void
  /** A healthy answer clears the backoff, so the next crash retries quickly. */
  resetBackoff (): void
}

export function resolveElectron (dshHome: string): string | null {
  const homeElectron = process.platform === 'win32'
    ? join(dshHome, 'electron', 'electron.exe')
    : process.platform === 'darwin'
      ? join(dshHome, 'electron', 'Electron.app', 'Contents', 'MacOS', 'Electron')
      : join(dshHome, 'electron', 'electron')
  const candidates = [
    process.env.DSH_COMPANION_ELECTRON,
    homeElectron,
    join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe'),
  ].filter(Boolean) as string[]
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {}
  }
  return null
}

/**
 * Where the helper's built Electron app directory is.
 *
 * Two layouts ship:
 *   - checkout:     packages/host/lib/index.js  +  packages/helper/dist
 *   - installed:    <package>/lib/index.js      +  <package>/helper
 * `DSH_PET_GO_HELPER` overrides both for debugging.
 */
export function resolveHelperDir (input: { packageRoot: string, repoRoot: string }): string | null {
  const candidates = [
    process.env.DSH_PET_GO_HELPER,
    // Installed package: the build copies the helper app next to lib/.
    join(input.packageRoot, 'helper'),
    // Checkout: the helper is a sibling workspace package.
    join(input.repoRoot, 'packages', 'helper', 'dist'),
    join(input.repoRoot, 'packages', 'helper'),
  ].filter(Boolean) as string[]
  for (const candidate of candidates) {
    try {
      if (existsSync(join(candidate, 'main.js')) && existsSync(join(candidate, 'package.json'))) return candidate
    } catch {}
  }
  return null
}

export function createSupervisor (options: SupervisorOptions): Supervisor {
  const { log } = options
  let child: ChildProcess | null = null
  let attempt = 0
  let restartTimer: NodeJS.Timeout | null = null
  let stopped = false

  const spawnHelper = (): void => {
    if (stopped) return
    if (!options.electron) {
      log('helper electron binary not found; set DSH_COMPANION_ELECTRON')
      return
    }
    if (!options.helperDir) {
      log('helper app directory not found; run `pnpm build`')
      return
    }
    log(`using electron: ${options.electron}`)
    log(`using helper: ${options.helperDir}`)
    // Deliberately a whitelist, not a copy of process.env: DSH runs inside
    // Electron, and letting ELECTRON_RUN_AS_NODE (or any NODE_OPTIONS) reach the
    // helper turns it into a plain Node process with no BrowserWindow at all.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      USERPROFILE: process.env.USERPROFILE,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      COMPANION_PORT: String(options.port),
      COMPANION_TOKEN: options.token,
      COMPANION_DSH_HOME: options.dshHome,
      COMPANION_LOG: options.logFile,
    }
    delete env.ELECTRON_RUN_AS_NODE
    try {
      const spawned = spawn(options.electron, [options.helperDir], { stdio: 'ignore', env, windowsHide: true })
      child = spawned
      log(`helper spawned pid=${spawned.pid}`)
      spawned.on('exit', (code, signal) => {
        if (child === spawned) child = null
        log(`helper exited code=${code} signal=${signal}`)
        scheduleRestart()
      })
      spawned.on('error', (error) => log(`helper spawn error: ${error?.message}`))
    } catch (error) {
      log(`spawn threw: ${(error as Error)?.message}`)
      scheduleRestart()
    }
  }

  const scheduleRestart = (): void => {
    if (stopped) return
    const delay = RESTART_DELAYS[Math.min(attempt, RESTART_DELAYS.length - 1)]
    attempt += 1
    log(`restarting helper in ${delay}ms (attempt ${attempt})`)
    options.onRestartScheduled(attempt)
    restartTimer = setTimeout(() => {
      restartTimer = null
      spawnHelper()
    }, delay)
  }

  return {
    start (): void {
      stopped = false
      spawnHelper()
    },

    stop (): void {
      stopped = true
      if (restartTimer) clearTimeout(restartTimer)
      restartTimer = null
      if (child) {
        try {
          child.kill()
        } catch {}
        child = null
      }
    },

    resetBackoff (): void {
      attempt = 0
    },
  }
}
