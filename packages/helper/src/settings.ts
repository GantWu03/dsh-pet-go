/**
 * Settings and window position: two small JSON files in Electron's userData
 * directory. Everything here is plain file I/O; clamping a position to a display
 * belongs to the module that knows about displays.
 *
 * A corrupt file must not brick the pet — it falls back to defaults and says so
 * in the log, because a silent reset looked like "my settings keep vanishing".
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type Log = (line: string) => void

export interface PetSettings {
  hotkey: string
  openAtLogin: boolean
  pet: string
  focusOnOpen: boolean
}

export interface Point {
  x: number
  y: number
}

/** Hotkey presets offered from the tray and the pet's menu; '' disables it. */
export const HOTKEY_PRESETS: ReadonlyArray<readonly [string, string]> = [
  ['Control+Shift+Space', 'Ctrl+Shift+Space'],
  ['Control+Alt+Space', 'Ctrl+Alt+Space'],
  ['Control+Shift+B', 'Ctrl+Shift+B'],
  ['', '关闭热键'],
]

export const DEFAULT_SETTINGS: PetSettings = {
  hotkey: 'Control+Shift+Space',
  openAtLogin: false,
  pet: 'circle',
  focusOnOpen: true,
}

const settingsFile = (userDataDir: string): string => join(userDataDir, 'config.json')
const positionFile = (userDataDir: string): string => join(userDataDir, 'window-state.json')

export function loadSettings (userDataDir: string, log: Log): PetSettings {
  try {
    const saved: unknown = JSON.parse(readFileSync(settingsFile(userDataDir), 'utf8'))
    if (typeof saved !== 'object' || saved === null) throw new Error('not an object')
    return { ...DEFAULT_SETTINGS, ...(saved as Partial<PetSettings>) }
  } catch (error) {
    log(`config unreadable, using defaults: ${(error as Error)?.message}`)
    return { ...DEFAULT_SETTINGS }
  }
}

/**
 * Merge a patch into the current settings and persist the result.
 * @returns the new settings, whether or not the write succeeded.
 */
export function saveSettings (userDataDir: string, current: PetSettings, patch: Partial<PetSettings>, log: Log): PetSettings {
  const next = { ...current, ...patch }
  try {
    mkdirSync(dirname(settingsFile(userDataDir)), { recursive: true })
    writeFileSync(settingsFile(userDataDir), JSON.stringify(next, null, 2), 'utf8')
  } catch (error) {
    log(`config write failed: ${(error as Error)?.message}`)
  }
  return next
}

/** Load the saved ball position, or the fallback when there is none. */
export function loadWindowPosition (
  userDataDir: string,
  fallback: Point,
  clamp: (point: Point) => Point,
): Point {
  try {
    const saved: unknown = JSON.parse(readFileSync(positionFile(userDataDir), 'utf8'))
    if (typeof saved !== 'object' || saved === null) return fallback
    const { x, y } = saved as Partial<Point>
    if (typeof x !== 'number' || typeof y !== 'number') return fallback
    return clamp({ x, y })
  } catch {
    return fallback
  }
}

export function saveWindowPosition (userDataDir: string, position: Point): void {
  try {
    mkdirSync(dirname(positionFile(userDataDir)), { recursive: true })
    writeFileSync(positionFile(userDataDir), JSON.stringify(position), 'utf8')
  } catch {}
}
