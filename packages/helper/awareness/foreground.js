/**
 * What is the user looking at right now?
 *
 * Captured at submit time and shipped alongside the screenshot so the model can
 * decide to open the file itself (the dedicated session runs the `standard`
 * preset, so it has read/grep/glob/shell).
 *
 * Windows-only for now; every failure path returns null and the upload simply
 * carries no context hint.
 */
import { execFile } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'probe.ps1')

/**
 * Windows always ships Windows PowerShell 5.1 even when pwsh 7 is absent
 * (this machine has no `pwsh` on PATH), so prefer the guaranteed one.
 */
function powershellPath () {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows'
  const candidates = [
    process.env.DSH_PET_GO_PS,
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'pwsh',
    'powershell.exe',
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (candidate === 'pwsh' || candidate === 'powershell.exe') return candidate
    if (existsSync(candidate)) return candidate
  }
  return 'powershell.exe'
}

/**
 * @param {number} timeoutMs
 * @returns {Promise<{app?: string, title?: string, docPath?: string, page?: number} | null>}
 */
export function probeForeground (timeoutMs = 2500) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(null)
      return
    }
    const outFile = join(tmpdir(), `dsh-pet-go-probe-${process.pid}-${Date.now()}.json`)
    execFile(
      powershellPath(),
      [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', SCRIPT,
        '-OwnPid', String(process.pid),
        '-OutFile', outFile,
      ],
      { timeout: timeoutMs, windowsHide: true },
      () => {
        void (async () => {
          try {
            const raw = await readFile(outFile, 'utf8')
            const parsed = JSON.parse(raw.trim())
            resolve(parsed && parsed.app ? parsed : null)
          } catch {
            resolve(null)
          } finally {
            void unlink(outFile).catch(() => {})
          }
        })()
      },
    )
  })
}
