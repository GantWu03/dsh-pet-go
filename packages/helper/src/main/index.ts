/**
 * dsh-pet-go helper — Electron main process.
 *
 * This file is assembly only: it reads the launch environment, constructs the
 * platform modules and the host client, registers IPC and owns the shutdown
 * order. Every capability lives next door:
 *
 *   windows.ts     the ball and panel windows, geometry, hover
 *   desktop.ts     tray, right-click menu, hotkey, login item
 *   capture.ts     screenshot of the active display
 *   settings.ts    config.json and window-state.json
 *   host-client.ts TCP to the DSH plugin: requests, timeouts, reconnects
 *   awareness/     machine facts collected once per launch
 *
 * It is launched as `electron <app dir>`, so `import.meta.url` is the app
 * directory and the pages, artwork and preload are its siblings.
 */
import { app, ipcMain } from 'electron'
import { appendFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

import { CAPTURE_MODE } from '@dsh-pet-go/shared/protocol'
import type { EnvironmentFacts, HostFrame, WelcomeFrame } from '@dsh-pet-go/shared/protocol'

import { collectEnvironment } from '../awareness/env.ts'
import { CaptureError, captureActiveDisplay } from '../capture.ts'
import { createDesktop } from '../desktop.ts'
import { createHostClient } from '../host-client.ts'
import { loadSettings, saveSettings } from '../settings.ts'
import type { PetSettings } from '../settings.ts'
import { createWindows } from '../windows.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.COMPANION_PORT)
const TOKEN = process.env.COMPANION_TOKEN
const LOG_FILE = process.env.COMPANION_LOG
const DSH_HOME = process.env.COMPANION_DSH_HOME || join(os.homedir(), '.dsh')

/** Facts age out, and a binary we recorded can disappear between launches. */
const ENV_TTL_MS = 7 * 24 * 60 * 60 * 1000
const ENV_CHECK_MS = 60 * 60 * 1000

function log (line: string): void {
  if (!LOG_FILE) return
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [helper] ${line}\n`, 'utf8')
  } catch {}
}

let environmentTimer: NodeJS.Timeout | null = null

async function boot (): Promise<void> {
  const userDataDir = app.getPath('userData')
  let settings: PetSettings = loadSettings(userDataDir, log)
  const getSettings = (): PetSettings => settings
  const updateSettings = (patch: Partial<PetSettings>): void => {
    settings = saveSettings(userDataDir, settings, patch, log)
  }

  let environment: EnvironmentFacts | null = null
  let environmentAt = 0
  let lastWelcome: WelcomeFrame | null = null

  const windows = createWindows({
    log,
    getSettings,
    paths: {
      preload: join(HERE, 'preload.cjs'),
      renderer: join(HERE, 'renderer'),
      userDataDir,
    },
  })

  const environmentIsStale = (): boolean => {
    if (!environment) return true
    if (Date.now() - environmentAt > ENV_TTL_MS) return true
    if (environment.python && !existsSync(environment.python)) return true
    if (environment.node && !existsSync(environment.node)) return true
    return false
  }

  const client = createHostClient({
    port: PORT,
    token: TOKEN ?? '',
    platform: `${process.platform}/${process.arch}`,
    log,
    getEnvironment: () => environment,
    onFrame: (frame) => onHostFrame(frame),
    onTransport: (state) => {
      windows.sendToPanel('companion:host', { type: 'transport', state })
    },
  })

  function refreshEnvironment (notify: boolean): void {
    try {
      const facts = collectEnvironment({ dshHome: DSH_HOME, display: windows.primaryDisplay() })
      environment = facts
      environmentAt = Date.now()
      log(`env collected: python=${facts.python ?? '-'} node=${facts.node ?? '-'}`)
      if (notify) client.pushEnvironment(facts)
    } catch (error) {
      log(`env failed: ${(error as Error)?.message}`)
    }
  }

  function onHostFrame (frame: HostFrame): void {
    if (frame.type === 'welcome') lastWelcome = frame
    if (frame.type === 'answer' && frame.phase === 'start') {
      windows.showBubble(Math.max(windows.bubbleHeight, 96))
    }
    windows.sendToPanel('companion:host', frame)
    windows.sendToBall('companion:host', frame)
  }

  const newSession = (): void => {
    void client.request({ type: 'new-session' }, 20_000)
  }

  const desktop = createDesktop({
    log,
    getSettings,
    updateSettings,
    trayIconPath: join(HERE, 'assets', 'tray.png'),
    appPath: HERE,
    actions: {
      openPanel: () => {
        windows.showBall()
        windows.openPanel()
      },
      // Every way of summoning the companion also restores a hidden pet: the
      // hotkey and a second launch used to open the composer while the pet
      // stayed hidden, leaving the user with no visible way back.
      togglePanel: () => {
        windows.showBall()
        windows.togglePanel()
      },
      setPet: (pet) => {
        updateSettings({ pet })
        log(`pet switched to ${pet}`)
        windows.setPet(pet)
      },
      resetPosition: () => windows.resetPosition(),
      newSession,
      hidePet: () => windows.hideAll(),
      quit: () => app.quit(),
    },
  })

  // Welcome/model frames can arrive before the panel page is ready; replay the
  // most recent welcome whenever that page (re)loads.
  windows.onPanelReady(() => {
    if (lastWelcome) windows.sendToPanel('companion:host', lastWelcome)
  })

  ipcMain.on('companion:ball-click', () => {
    log('ball clicked')
    windows.togglePanel()
  })

  ipcMain.on('companion:context-menu', () => {
    desktop.showPetMenu()
  })

  ipcMain.on('companion:log', (_event, message) => {
    log(`[renderer] ${String(message)}`)
  })

  ipcMain.on('companion:drag', (_event, phase) => {
    if (phase === 'start' || phase === 'move' || phase === 'end') windows.drag(phase)
  })

  ipcMain.on('companion:pet-size', (_event, size) => {
    if (!size || typeof size !== 'object') return
    const { width, height } = size as { width?: unknown, height?: unknown }
    if (typeof width !== 'number' || typeof height !== 'number') return
    windows.setPetSize({ width, height })
  })

  ipcMain.on('companion:close-panel', () => windows.closePanel())
  ipcMain.on('companion:bubble-size', (_event, height) => {
    if (typeof height === 'number') windows.setBubbleHeight(height)
  })
  ipcMain.on('companion:panel-size', (_event, height) => {
    if (typeof height === 'number') windows.setPanelHeight(height)
  })
  ipcMain.on('companion:hide-bubble', () => windows.hideBubble())
  ipcMain.on('companion:quit', () => app.quit())

  ipcMain.handle('companion:submit', async (_event, payload) => {
    const wanted = payload as { capture?: unknown, text?: unknown } | undefined
    const wantsImage = wanted?.capture === true
    let image = null
    if (wantsImage) {
      try {
        image = await captureActiveDisplay()
      } catch (error) {
        const failure = error as CaptureError
        return {
          ok: false,
          code: failure?.code ?? 'CAPTURE_DENIED',
          detail: failure?.message ?? '截图失败',
          retryable: true,
        }
      }
    }
    return await client.request({
      type: 'submit',
      text: typeof wanted?.text === 'string' ? wanted.text : '',
      capture: { mode: wantsImage ? CAPTURE_MODE.screen : CAPTURE_MODE.none },
      image,
    })
  })

  ipcMain.handle('companion:new-session', async () => await client.request({ type: 'new-session' }, 20_000))

  windows.create()
  desktop.createTray()

  app.on('second-instance', () => {
    log('second instance launched -> opening panel')
    windows.showBall()
    windows.openPanel()
  })

  refreshEnvironment(false)
  log(`ready electron=${process.versions.electron} port=${PORT} hotkey=${settings.hotkey || 'off'}`)
  log(`display facts=${JSON.stringify(windows.primaryDisplay())}`)
  desktop.applyHotkey()
  desktop.applyLoginItem()
  client.start()

  // Long-running instance: refresh when the snapshot ages out or a recorded
  // binary disappears, without waiting for the next DSH restart.
  environmentTimer = setInterval(() => {
    if (environmentIsStale()) refreshEnvironment(true)
  }, ENV_CHECK_MS)

  // Teardown order: stop taking new work (IPC, timers), close the channel, then
  // the windows. Safe to run twice.
  let cleaned = false
  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    if (environmentTimer) clearInterval(environmentTimer)
    environmentTimer = null
    try {
      ipcMain.removeHandler('companion:submit')
      ipcMain.removeHandler('companion:new-session')
      ipcMain.removeAllListeners()
    } catch {}
    client.stop()
    desktop.destroy()
    windows.destroy()
  }
  app.on('before-quit', () => {
    log('quitting')
    cleanup()
  })
}

process.on('uncaughtException', (error) => log(`uncaught: ${error?.stack ?? error}`))
process.on('unhandledRejection', (reason) => log(`unhandled: ${String(reason)}`))

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  // A second helper would draw a second ball; the supervisor only tracks the one
  // it spawned, so refuse to start at all.
  log('another instance owns the single-instance lock, exiting')
  app.quit()
} else {
  app.on('window-all-closed', () => {})

  void app.whenReady().then(boot).catch((error) => {
    log(`boot failed: ${(error as Error)?.stack ?? error}`)
  })
}
