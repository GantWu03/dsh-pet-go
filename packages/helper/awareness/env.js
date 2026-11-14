/**
 * Facts about this machine, collected once per launch.
 *
 * Deliberately a RESOURCE LIST, never application-specific knowledge: which app
 * the user is in, and how to read it, stays the model's own judgement from the
 * screenshot. No PowerShell spawn either — everything here is process/os/fs.
 */
import os from 'node:os'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

function findInRuntimes (dshHome, relative) {
  const root = join(dshHome, 'dsh-runtimes')
  try {
    for (const name of readdirSync(root)) {
      const candidate = join(root, name, 'dependencies', relative)
      if (existsSync(candidate)) return candidate
    }
  } catch {}
  return null
}

/**
 * @param {{ dshHome: string, display?: { width: number, height: number, scaleFactor: number } }} input
 */
export function collectEnvironment ({ dshHome, display }) {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const windowsPowerShell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const pwsh7 = process.env.ProgramFiles ? join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe') : null
  return {
    platform: `${process.platform}/${process.arch}`,
    os: `${os.type()} ${os.release()} (${os.version?.() ?? 'unknown'})`,
    shell: existsSync(windowsPowerShell) ? windowsPowerShell : 'powershell.exe',
    pwsh7: pwsh7 && existsSync(pwsh7) ? pwsh7 : null,
    python: findInRuntimes(dshHome, join('python', 'python.exe')),
    node: findInRuntimes(dshHome, join('node', 'bin', 'node.exe')),
    home: os.homedir(),
    dshHome,
    display: display ? { width: display.width, height: display.height, scale: display.scaleFactor } : null,
    scannedAt: new Date().toISOString(),
  }
}
