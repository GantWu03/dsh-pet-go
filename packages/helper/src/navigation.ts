/**
 * What a pet window is allowed to load, and what a link click is allowed to do.
 *
 * The ball and the panel are the companion's own UI for their whole lifetime.
 * They are not a browser: a navigation replaces the UI with a foreign web page
 * and nothing in the app can bring it back. That is not hypothetical — a
 * Markdown link in an answer opened inside the panel window and left the pet
 * showing GitHub's 404 page, with no way home but killing the process.
 *
 * So every navigation goes through here: the pet's own pages are allowed, and
 * http(s) links are handed to the user's browser. Everything else (file:,
 * javascript:, data:, mailto:, ...) is refused outright.
 *
 * Deliberately free of Electron and filesystem access, so the policy can be
 * tested on its own: `windows.ts` is the only caller.
 */
import { fileURLToPath } from 'node:url'
import { resolve, sep } from 'node:path'

/** The only schemes that make sense to hand to a browser. */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:'])

/** Parse without throwing; null for anything that is not a URL. */
function parse (input: unknown): URL | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (!trimmed) return null
  try {
    return new URL(trimmed)
  } catch {
    return null
  }
}

/** Windows paths are case-insensitive; comparing them case-sensitively lies. */
function comparable (path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * The normalised URL to hand to the user's browser, or null when this is not
 * something a link may open.
 */
export function externalTarget (input: unknown): string | null {
  const url = parse(input)
  if (!url) return null
  if (!EXTERNAL_PROTOCOLS.has(url.protocol.toLowerCase())) return null
  // `https:///foo` parses but has no host: not something a browser can use.
  if (!url.hostname) return null
  return url.href
}

/** True for a URL that belongs to the pet's own pages. */
export function isRendererUrl (input: unknown, rendererDir: string): boolean {
  const url = parse(input)
  if (!url || url.protocol !== 'file:') return false
  let path: string
  try {
    path = fileURLToPath(url)
  } catch {
    return false
  }
  const root = comparable(rendererDir)
  const target = comparable(path)
  return target === root || target.startsWith(root + sep)
}
