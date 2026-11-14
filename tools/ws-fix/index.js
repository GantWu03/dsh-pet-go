/**
 * One-shot maintenance tool (not shipped): the project directory moved, so the
 * DSH workspace that pointed at the old path is dead. Recreate it at the new
 * path and drop the stale one. Result is appended to the companion log.
 */
import { appendFileSync } from 'node:fs'

const LOG = 'C:\\Users\\17303\\.dsh\\companion\\host.log'
const TARGET = 'D:\\work\\dsh-pet-go'
const TITLE = 'dsh-pet-go'
const OLD = 'D:\\实习\\vibecoding\\ai桌宠'

export const inject = ['workspaceRegistry']

function log (line) {
  try {
    appendFileSync(LOG, `[${new Date().toISOString()}] [ws-fix] ${line}\n`, 'utf8')
  } catch {}
}

export function apply (ctx) {
  void run(ctx)
}

async function run (ctx) {
  const registry = ctx.workspaceRegistry
  try {
    log('before ' + JSON.stringify(registry.list().map((w) => ({ id: w.id, title: w.title, path: w.path }))))

    const workspaces = registry.list()
    const stale = workspaces.find((w) => w.path === OLD)
    if (stale) {
      try {
        await ctx.workspaceController.delete({ workspaceId: stale.id })
        log(`deleted stale workspace ${stale.title} (${stale.path})`)
      } catch (error) {
        log(`delete via controller failed: ${error?.message}`)
        try {
          await registry.delete(stale.id)
          log('deleted stale workspace via registry')
        } catch (inner) {
          log(`delete via registry failed: ${inner?.message}`)
        }
      }
    }

    if (!registry.list().some((w) => w.path === TARGET)) {
      const created = await registry.create(TARGET, TITLE)
      log(`created workspace ${created.id} at ${TARGET}`)
    } else {
      log('target workspace already exists')
    }

    log('after ' + JSON.stringify(registry.list().map((w) => ({ id: w.id, title: w.title, path: w.path }))))
  } catch (error) {
    log('failed: ' + (error?.stack ?? error))
  }
}
