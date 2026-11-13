/**
 * dsh-companion helper — the floating ball.
 *
 * Runs as its own Electron process so it survives DSH being minimized or
 * covered. Responsibilities:
 *   - one transparent always-on-top window (ball + composer + bubble),
 *   - global hotkey,
 *   - the actual screen capture (the host process has no Electron APIs),
 *   - the loopback TCP channel to the host plugin.
 */
import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  screen,
} from 'electron'
import net from 'node:net'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import { PROTOCOL_VERSION, CAPTURE_MODE, encodeFrame, createFrameDecoder } from '../shared/src/protocol.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const WIN_W = 380
const WIN_H = 470
const EDGE = 8

const PORT = Number(process.env.COMPANION_PORT)
const TOKEN = process.env.COMPANION_TOKEN
const LOG_FILE = process.env.COMPANION_LOG

function log (line) {
  const text = `[${new Date().toISOString()}] [helper] ${line}\n`
  if (!LOG_FILE) return
  try {
    appendFileSync(LOG_FILE, text, 'utf8')
  } catch {}
}

/** @type {BrowserWindow | null} */
let win = null
/** @type {import('node:net').Socket | null} */
let socket = null
let connected = false
let reqSeq = 0
/** @type {Map<string, (frame: any) => void>} */
const pending = new Map()
let dragging = null

const stateFile = () => join(app.getPath('userData'), 'window-state.json')

function loadBounds () {
  try {
    const saved = JSON.parse(readFileSync(stateFile(), 'utf8'))
    const display = screen.getDisplayNearestPoint({ x: saved.x ?? 0, y: saved.y ?? 0 })
    const area = display.workArea
    if (
      typeof saved.x === 'number' && typeof saved.y === 'number' &&
      saved.x >= area.x - 200 && saved.x <= area.x + area.width &&
      saved.y >= area.y - 200 && saved.y <= area.y + area.height
    ) {
      return { x: saved.x, y: saved.y }
    }
  } catch {}
  const area = screen.getPrimaryDisplay().workArea
  return { x: area.x + area.width - WIN_W - EDGE, y: area.y + area.height - WIN_H - EDGE }
}

function saveBounds () {
  if (!win) return
  try {
    const [x, y] = win.getPosition()
    mkdirSync(dirname(stateFile()), { recursive: true })
    writeFileSync(stateFile(), JSON.stringify({ x, y }), 'utf8')
  } catch {}
}

function createWindow () {
  const bounds = loadBounds()
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: bounds.x,
    y: bounds.y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    focusable: true,
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setIgnoreMouseEvents(true, { forward: true })
  win.loadFile(join(HERE, 'renderer', 'index.html'))
  win.once('ready-to-show', () => {
    log(`ready-to-show pos=${JSON.stringify(win.getPosition())}`)
    win.showInactive()
    log(`shown visible=${win.isVisible()} bounds=${JSON.stringify(win.getBounds())}`)
  })
  win.webContents.on('did-finish-load', () => {
    log('did-finish-load')
    if (win && !win.isVisible()) win.showInactive()
  })
  win.webContents.on('did-fail-load', (_event, code, description) => {
    log(`did-fail-load ${code} ${description}`)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    log(`render-process-gone ${JSON.stringify(details)}`)
  })
  win.on('closed', () => { win = null })
}

function openPanel () {
  if (!win) return
  win.show()
  win.focus()
  win.setIgnoreMouseEvents(false)
  win.webContents.send('companion:open')
}

// ---------------------------------------------------------------- screen cap

async function captureActiveDisplay () {
  const point = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(point)
  const scale = display.scaleFactor || 1
  const thumbnailSize = {
    width: Math.round(display.size.width * scale),
    height: Math.round(display.size.height * scale),
  }
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize })
  const source = sources.find((candidate) => String(candidate.display_id) === String(display.id)) ?? sources[0]
  if (!source) {
    const error = new Error('系统没有返回可用的屏幕源')
    error.code = 'CAPTURE_DENIED'
    throw error
  }
  const image = source.thumbnail
  if (!image || image.isEmpty()) {
    const error = new Error('截到的是空画面')
    error.code = 'CAPTURE_EMPTY'
    throw error
  }
  const size = image.getSize()
  return {
    base64: image.toPNG().toString('base64'),
    mediaType: 'image/png',
    width: size.width,
    height: size.height,
  }
}

// ------------------------------------------------------------- host channel

function connectHost () {
  if (!PORT || !TOKEN) {
    console.error('[companion] missing COMPANION_PORT / COMPANION_TOKEN')
    return
  }
  const socketInstance = net.connect(PORT, '127.0.0.1')
  socket = socketInstance
  socketInstance.setEncoding('utf8')
  socketInstance.setNoDelay(true)

  const decode = createFrameDecoder((frame) => {
    if (frame?.type === 'result' && frame.requestId && pending.has(frame.requestId)) {
      const resolve = pending.get(frame.requestId)
      pending.delete(frame.requestId)
      resolve(frame)
      return
    }
    win?.webContents.send('companion:host', frame)
  })

  socketInstance.on('connect', () => {
    connected = true
    socketInstance.write(encodeFrame({
      v: PROTOCOL_VERSION,
      type: 'hello',
      token: TOKEN,
      platform: `${process.platform}/${process.arch}`,
      capabilities: { capture: true, hotkey: true, bubble: true },
    }))
    win?.webContents.send('companion:host', { type: 'transport', state: 'connected' })
  })
  socketInstance.on('data', (chunk) => decode(chunk))
  socketInstance.on('error', () => {})
  socketInstance.on('close', () => {
    connected = false
    win?.webContents.send('companion:host', { type: 'transport', state: 'lost' })
    setTimeout(connectHost, 2000)
  })
}

function request (frame, timeoutMs = 45000) {
  return new Promise((resolve) => {
    if (!connected || !socket || socket.destroyed) {
      resolve({ ok: false, code: 'TRANSPORT_LOST', detail: '和 DSH 的连接断开了' })
      return
    }
    const requestId = `req-${Date.now().toString(36)}-${++reqSeq}`
    const timer = setTimeout(() => {
      pending.delete(requestId)
      resolve({ ok: false, code: 'TIMEOUT', detail: 'DSH 没有响应' })
    }, timeoutMs)
    pending.set(requestId, (response) => {
      clearTimeout(timer)
      resolve(response)
    })
    socket.write(encodeFrame({ v: PROTOCOL_VERSION, requestId, ...frame }))
  })
}

// ---------------------------------------------------------------------- IPC

ipcMain.on('companion:interactive', (_event, value) => {
  win?.setIgnoreMouseEvents(!value, { forward: true })
})

ipcMain.on('companion:close-panel', () => {
  win?.setIgnoreMouseEvents(true, { forward: true })
})

ipcMain.on('companion:quit', () => {
  app.quit()
})

ipcMain.on('companion:drag', (_event, phase) => {
  if (!win) return
  if (phase === 'start') {
    const point = screen.getCursorScreenPoint()
    const [x, y] = win.getPosition()
    dragging = { cursor: point, origin: { x, y } }
  } else if (phase === 'move') {
    if (!dragging) return
    const point = screen.getCursorScreenPoint()
    win.setPosition(
      dragging.origin.x + (point.x - dragging.cursor.x),
      dragging.origin.y + (point.y - dragging.cursor.y),
    )
  } else if (phase === 'end') {
    dragging = null
    saveBounds()
  }
})

ipcMain.handle('companion:submit', async (_event, payload) => {
  const wantsImage = payload?.capture === true
  let image = null
  if (wantsImage) {
    try {
      image = await captureActiveDisplay()
    } catch (error) {
      return { ok: false, code: error?.code ?? 'CAPTURE_DENIED', detail: error?.message ?? '截图失败', retryable: true }
    }
  }
  const response = await request({
    type: 'submit',
    text: payload?.text ?? '',
    capture: { mode: wantsImage ? CAPTURE_MODE.screen : CAPTURE_MODE.none },
    image,
  })
  return response
})

ipcMain.handle('companion:new-session', async () => await request({ type: 'new-session' }, 20000))

// --------------------------------------------------------------------- boot

app.whenReady().then(() => {
  log(`ready electron=${process.versions.electron} port=${PORT}`)
  try {
    const displays = screen.getAllDisplays()
    log(`displays=${JSON.stringify(displays.map((d) => ({
      id: d.id,
      bounds: d.bounds,
      workArea: d.workArea,
      size: d.size,
      scaleFactor: d.scaleFactor,
    })))}`)
    log(`primary=${JSON.stringify(screen.getPrimaryDisplay().workArea)} cursor=${JSON.stringify(screen.getCursorScreenPoint())}`)
  } catch (error) {
    log(`display probe failed: ${error?.message}`)
  }
  createWindow()
  connectHost()
  try {
    const ok = globalShortcut.register('Control+Shift+Space', () => {
      log('hotkey pressed')
      openPanel()
    })
    log(`hotkey registered=${ok}`)
  } catch (error) {
    log(`hotkey registration failed: ${error?.message}`)
  }
})

process.on('uncaughtException', (error) => log(`uncaught: ${error?.stack ?? error}`))
process.on('unhandledRejection', (error) => log(`unhandled: ${error?.stack ?? error}`))

app.on('window-all-closed', (event) => {
  event.preventDefault()
})

app.on('before-quit', () => {
  globalShortcut.unregisterAll()
})
