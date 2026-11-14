/**
 * dsh-companion helper — two windows, on purpose.
 *
 *   ballWin   72x72, always interactive: the ball itself. Because the window is
 *             exactly the ball, clicks outside it pass through to the desktop
 *             with no `setIgnoreMouseEvents` hit-testing at all.
 *   panelWin  380 wide, hosts both the composer and the answer bubble. It is
 *             mouse-transparent while it only shows a bubble (so it never
 *             blocks the app underneath) and interactive while the composer is
 *             open.
 *
 * An earlier single-window build relied on `setIgnoreMouseEvents(true,
 * {forward:true})` plus a renderer hit-test; on this machine the forwarded
 * mousemove never reached the page, so the ball received no clicks.
 */
import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
} from 'electron'
import net from 'node:net'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import { PROTOCOL_VERSION, CAPTURE_MODE, encodeFrame, createFrameDecoder } from '../shared/src/protocol.js'

const HERE = dirname(fileURLToPath(import.meta.url))

const BALL = 80
const PANEL_W = 388
const GAP = 8
const EDGE = 8

const PORT = Number(process.env.COMPANION_PORT)
const TOKEN = process.env.COMPANION_TOKEN
const LOG_FILE = process.env.COMPANION_LOG

function log (line) {
  if (!LOG_FILE) return
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [helper] ${line}\n`, 'utf8')
  } catch {}
}

/** @type {BrowserWindow | null} */
let ballWin = null
/** @type {BrowserWindow | null} */
let panelWin = null
/** @type {import('node:net').Socket | null} */
let socket = null
let connected = false
let reqSeq = 0
/** @type {Map<string, (frame: any) => void>} */
const pending = new Map()
let dragging = null
let tray = null
let panelOpen = false
let bubbleHeight = 0
let panelHeight = 140
let welcomeFrame = null

const stateFile = () => join(app.getPath('userData'), 'window-state.json')
const configFile = () => join(app.getPath('userData'), 'config.json')

/** Hotkey presets offered from the tray; an empty string disables the hotkey. */
const HOTKEY_PRESETS = [
  ['Control+Shift+Space', 'Ctrl+Shift+Space'],
  ['Control+Alt+Space', 'Ctrl+Alt+Space'],
  ['Control+Shift+B', 'Ctrl+Shift+B'],
  ['', '关闭热键'],
]

const defaultConfig = () => ({ hotkey: 'Control+Shift+Space', openAtLogin: false, pet: 'circle' })
let config = defaultConfig()

function loadConfig () {
  try {
    const saved = JSON.parse(readFileSync(configFile(), 'utf8'))
    config = { ...defaultConfig(), ...saved }
  } catch (error) {
    // A corrupt config must not brick the pet, but it must be visible.
    config = defaultConfig()
    log(`config unreadable, using defaults: ${error?.message}`)
  }
  return config
}

function saveConfig (patch) {
  config = { ...config, ...patch }
  try {
    mkdirSync(dirname(configFile()), { recursive: true })
    writeFileSync(configFile(), JSON.stringify(config, null, 2), 'utf8')
  } catch (error) {
    log(`config write failed: ${error?.message}`)
  }
}

function applyHotkey () {
  try {
    globalShortcut.unregisterAll()
  } catch {}
  if (!config.hotkey) {
    log('hotkey disabled')
    refreshTray()
    return
  }
  try {
    const ok = globalShortcut.register(config.hotkey, () => {
      log('hotkey pressed')
      if (panelOpen) closePanel()
      else openPanel()
    })
    log(`hotkey registered=${ok} key=${config.hotkey}`)
  } catch (error) {
    log(`hotkey failed: ${error?.message}`)
  }
  refreshTray()
}

function applyLoginItem () {
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(config.openAtLogin),
      path: process.execPath,
      args: [HERE],
    })
    log(`openAtLogin=${config.openAtLogin}`)
  } catch (error) {
    log(`login item failed: ${error?.message}`)
  }
  refreshTray()
}

// ------------------------------------------------------------------ geometry

function clampToWorkArea (x, y, width = BALL, height = BALL) {
  const display = screen.getDisplayNearestPoint({ x, y })
  const area = display.workArea
  const maxX = area.x + area.width - width
  const maxY = area.y + area.height - height
  return {
    x: Math.min(Math.max(x, area.x), maxX),
    y: Math.min(Math.max(y, area.y), maxY),
  }
}

function loadBallPosition () {
  try {
    const saved = JSON.parse(readFileSync(stateFile(), 'utf8'))
    if (typeof saved.x === 'number' && typeof saved.y === 'number') {
      return clampToWorkArea(saved.x, saved.y)
    }
  } catch {}
  const area = screen.getPrimaryDisplay().workArea
  return { x: area.x + area.width - BALL - EDGE, y: area.y + area.height - BALL - EDGE }
}

function saveBallPosition () {
  if (!ballWin) return
  try {
    const [x, y] = ballWin.getPosition()
    mkdirSync(dirname(stateFile()), { recursive: true })
    writeFileSync(stateFile(), JSON.stringify({ x, y }), 'utf8')
  } catch {}
}

/** Anchor the panel window above the ball, right edges aligned. */
function positionPanel (height) {
  if (!ballWin || !panelWin) return
  const [bx, by] = ballWin.getPosition()
  const ballWidth = ballWin.getBounds().width
  const x = Math.round(bx + ballWidth - PANEL_W)
  const y = Math.round(by - GAP - height)
  const display = screen.getDisplayNearestPoint({ x: bx, y: by })
  const area = display.workArea
  panelWin.setBounds({
    x: Math.max(area.x, Math.min(x, area.x + area.width - PANEL_W)),
    y: Math.max(area.y, Math.min(y, area.y + area.height - height)),
    width: PANEL_W,
    height,
  })
}

// -------------------------------------------------------------------- windows

function createBallWindow () {
  const position = loadBallPosition()
  ballWin = new BrowserWindow({
    width: BALL,
    height: BALL,
    x: position.x,
    y: position.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: { preload: join(HERE, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  })
  ballWin.setAlwaysOnTop(true, 'screen-saver')
  ballWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  ballWin.loadFile(join(HERE, 'renderer', 'ball.html'))
  ballWin.webContents.on('did-finish-load', () => {
    ballWin?.webContents.send('companion:init', { pet: config.pet })
  })
  ballWin.once('ready-to-show', () => {
    ballWin?.showInactive()
    log(`ball shown at ${JSON.stringify(ballWin?.getPosition())}`)
  })
  ballWin.on('closed', () => { ballWin = null })
}

function createPanelWindow () {
  panelWin = new BrowserWindow({
    width: PANEL_W,
    height: panelHeight,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    focusable: true,
    webPreferences: { preload: join(HERE, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  })
  panelWin.setAlwaysOnTop(true, 'screen-saver')
  panelWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  panelWin.setIgnoreMouseEvents(true, { forward: true })
  panelWin.loadFile(join(HERE, 'renderer', 'panel.html'))
  // Frames that arrive before the page is ready (welcome/model) would be lost,
  // so replay the last welcome once the renderer is up.
  panelWin.webContents.on('did-finish-load', () => {
    if (welcomeFrame) panelWin?.webContents.send('companion:host', welcomeFrame)
  })
  panelWin.on('closed', () => { panelWin = null })
}

function openPanel () {
  if (!panelWin || !ballWin) return
  panelOpen = true
  stopHoverWatch()
  positionPanel(panelHeight)
  panelWin.setIgnoreMouseEvents(false)
  panelWin.show()
  panelWin.focus()
  panelWin.webContents.send('companion:open')
  ballWin?.webContents.send('companion:open')
  log('panel opened')
}

function closePanel () {
  if (!panelOpen) return
  panelOpen = false
  panelWin?.webContents.send('companion:close')
  ballWin?.webContents.send('companion:close')
  if (bubbleHeight > 0) {
    showBubbleWindow()
  } else {
    panelWin?.hide()
    panelWin?.setIgnoreMouseEvents(true, { forward: true })
  }
  log('panel closed')
}

/** Bubble-only mode: visible, sized to content, and mouse-transparent. */
function showBubbleWindow (height) {
  if (!panelWin) return
  if (typeof height === 'number') bubbleHeight = height
  const target = Math.round(bubbleHeight > 0 ? bubbleHeight : 120)
  positionPanel(target)
  panelWin.setIgnoreMouseEvents(true, { forward: true })
  if (!panelWin.isVisible()) panelWin.showInactive()
  startHoverWatch()
}

function hideBubble () {
  bubbleHeight = 0
  stopHoverWatch()
  if (panelOpen) return
  panelWin?.hide()
}

// The bubble window is mouse-transparent, so it cannot receive hover events
// itself. Poll the cursor against its bounds instead; the renderer uses a
// transition into the bubble to reset its fade-out countdown.
let hoverTimer = null
let lastHover = false

function startHoverWatch () {
  if (hoverTimer) return
  lastHover = false
  hoverTimer = setInterval(() => {
    if (!panelWin || !panelWin.isVisible() || panelOpen) return
    const point = screen.getCursorScreenPoint()
    const bounds = panelWin.getBounds()
    const inside = point.x >= bounds.x && point.x < bounds.x + bounds.width &&
      point.y >= bounds.y && point.y < bounds.y + bounds.height
    if (inside !== lastHover) {
      lastHover = inside
      panelWin.webContents.send('companion:hover', inside)
    }
  }, 250)
}

function stopHoverWatch () {
  if (hoverTimer) clearInterval(hoverTimer)
  hoverTimer = null
  lastHover = false
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
  return { base64: image.toPNG().toString('base64'), mediaType: 'image/png', width: size.width, height: size.height }
}

// ------------------------------------------------------------- host channel

function connectHost () {
  if (!PORT || !TOKEN) {
    log('missing COMPANION_PORT / COMPANION_TOKEN')
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
    if (frame?.type === 'welcome') welcomeFrame = frame
    if (frame?.type === 'answer') {
      if (frame.phase === 'start') {
        panelWin?.webContents.send('companion:host', frame)
        ballWin?.webContents.send('companion:host', frame)
        showBubbleWindow(Math.max(bubbleHeight, 96))
        return
      }
      if (frame.phase === 'delta') {
        panelWin?.webContents.send('companion:host', frame)
        ballWin?.webContents.send('companion:host', frame)
        return
      }
    }
    panelWin?.webContents.send('companion:host', frame)
    ballWin?.webContents.send('companion:host', frame)
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
    panelWin?.webContents.send('companion:host', { type: 'transport', state: 'connected' })
    log('host connected')
  })
  socketInstance.on('data', (chunk) => decode(chunk))
  socketInstance.on('error', () => {})
  socketInstance.on('close', () => {
    connected = false
    panelWin?.webContents.send('companion:host', { type: 'transport', state: 'lost' })
    log('host disconnected')
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

// ---------------------------------------------------------------------- tray

function buildTrayMenu () {
  const hotkeyItems = HOTKEY_PRESETS.map(([value, label]) => ({
    label,
    type: 'radio',
    checked: config.hotkey === value,
    click: () => {
      saveConfig({ hotkey: value })
      applyHotkey()
    },
  }))
  return Menu.buildFromTemplate([
    { label: '打开输入条', click: () => openPanel() },
    { label: '新会话', click: () => { void request({ type: 'new-session' }, 20_000) } },
    { type: 'separator' },
    { label: '快捷键', submenu: hotkeyItems },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: Boolean(config.openAtLogin),
      click: (item) => {
        saveConfig({ openAtLogin: item.checked })
        applyLoginItem()
      },
    },
    { label: '复位浮窗位置', click: resetBallPosition },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ])
}

function refreshTray () {
  try {
    tray?.setContextMenu(buildTrayMenu())
  } catch {}
}

function createTray () {
  try {
    const icon = nativeImage.createFromPath(join(HERE, 'assets', 'tray.png'))
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
    tray.setToolTip('桌面小助手 · 点球或快捷键')
    refreshTray()
    tray.on('click', () => {
      showBall()
      openPanel()
    })
    log('tray created')
  } catch (error) {
    log(`tray failed: ${error?.message}`)
  }
}

function resetBallPosition () {
  const area = screen.getPrimaryDisplay().workArea
  const bounds = ballWin?.getBounds() ?? { width: BALL, height: BALL }
  ballWin?.setPosition(area.x + area.width - bounds.width - EDGE, area.y + area.height - bounds.height - EDGE)
  saveBallPosition()
  if (panelOpen) positionPanel(panelHeight)
  else if (bubbleHeight > 0) showBubbleWindow()
}

// ----------------------------------------------------------------------- IPC

ipcMain.on('companion:ball-click', () => {
  log('ball clicked')
  if (panelOpen) closePanel()
  else openPanel()
})

ipcMain.on('companion:context-menu', () => {
  buildPetMenu().popup({ window: ballWin ?? undefined })
})

/** Right-click menu on the pet — the primary entry point (ADR-016). */
function buildPetMenu () {
  const hotkeys = HOTKEY_PRESETS.map(([value, label]) => ({
    label,
    type: 'radio',
    checked: config.hotkey === value,
    click: () => {
      saveConfig({ hotkey: value })
      applyHotkey()
    },
  }))
  return Menu.buildFromTemplate([
    {
      label: '形象',
      submenu: [
        { label: '圆球', type: 'radio', checked: config.pet === 'circle', click: () => setPet('circle') },
        { label: '大肥鱼', type: 'radio', checked: config.pet === 'baifan', click: () => setPet('baifan') },
      ],
    },
    { type: 'separator' },
    { label: '快捷键', submenu: hotkeys },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: Boolean(config.openAtLogin),
      click: (item) => {
        saveConfig({ openAtLogin: item.checked })
        applyLoginItem()
      },
    },
    { label: '复位位置', click: resetBallPosition },
    { type: 'separator' },
    { label: '打开输入条', click: () => openPanel() },
    {
      label: '隐藏浮窗',
      click: () => {
        panelWin?.hide()
        ballWin?.hide()
      },
    },
    { label: '退出', click: () => app.quit() },
  ])
}

function showBall () {
  if (!ballWin) return
  ballWin.showInactive()
  if (panelOpen) positionPanel(panelHeight)
  else if (bubbleHeight > 0) showBubbleWindow()
}

/** Switch the pet: persist, then let the page rebuild its renderer. */
function setPet (pet) {
  if (config.pet === pet) return
  saveConfig({ pet })
  log(`pet switched to ${pet}`)
  ballWin?.webContents.send('companion:init', { pet })
}

ipcMain.on('companion:log', (_event, message) => {
  log(`[renderer] ${message}`)
})

ipcMain.on('companion:drag', (_event, phase) => {
  if (!ballWin) return
  if (phase === 'start') {
    dragging = { cursor: screen.getCursorScreenPoint(), origin: ballWin.getPosition() }
  } else if (phase === 'move') {
    if (!dragging) return
    const point = screen.getCursorScreenPoint()
    const x = dragging.origin[0] + (point.x - dragging.cursor.x)
    const y = dragging.origin[1] + (point.y - dragging.cursor.y)
    ballWin.setPosition(x, y)
    if (panelOpen) positionPanel(panelHeight)
    else if (bubbleHeight > 0) showBubbleWindow()
  } else {
    if (!dragging) return
    dragging = null
    const bounds = ballWin.getBounds()
    const clamped = clampToWorkArea(bounds.x, bounds.y, bounds.width, bounds.height)
    ballWin.setPosition(clamped.x, clamped.y)
    saveBallPosition()
    if (panelOpen) positionPanel(panelHeight)
    else if (bubbleHeight > 0) showBubbleWindow()
  }
})

ipcMain.on('companion:pet-size', (_event, size) => {
  if (!ballWin || !size) return
  const width = Math.max(48, Math.min(Math.round(size.width), 420))
  const height = Math.max(48, Math.min(Math.round(size.height), 420))
  const bounds = ballWin.getBounds()
  if (bounds.width === width && bounds.height === height) return
  ballWin.setBounds({
    x: bounds.x + (bounds.width - width),
    y: bounds.y + (bounds.height - height),
    width,
    height,
  })
  log(`pet window ${width}x${height}`)
  saveBallPosition()
  if (panelOpen) positionPanel(panelHeight)
  else if (bubbleHeight > 0) showBubbleWindow()
})

ipcMain.on('companion:close-panel', () => closePanel())

ipcMain.on('companion:bubble-size', (_event, height) => {
  if (typeof height !== 'number' || !Number.isFinite(height)) return
  bubbleHeight = Math.max(80, Math.min(Math.round(height), 340))
  if (!panelOpen) showBubbleWindow(bubbleHeight)
})

ipcMain.on('companion:panel-size', (_event, height) => {
  if (typeof height !== 'number' || !Number.isFinite(height)) return
  panelHeight = Math.max(96, Math.min(Math.round(height), 420))
  if (panelOpen) positionPanel(panelHeight)
})

ipcMain.on('companion:hide-bubble', () => hideBubble())

ipcMain.on('companion:quit', () => app.quit())

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
  return await request({
    type: 'submit',
    text: payload?.text ?? '',
    capture: { mode: wantsImage ? CAPTURE_MODE.screen : CAPTURE_MODE.none },
    image,
  })
})

ipcMain.handle('companion:new-session', async () => await request({ type: 'new-session' }, 20_000))

// ---------------------------------------------------------------------- boot

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  // A second helper would draw a second ball; the supervisor only tracks the
  // one it spawned, so refuse to start at all.
  log('another instance owns the single-instance lock, exiting')
  app.quit()
} else {
  app.on('second-instance', () => {
    log('second instance launched -> opening panel')
    openPanel()
  })

  app.whenReady().then(() => {
    loadConfig()
    log(`ready electron=${process.versions.electron} port=${PORT} hotkey=${config.hotkey || 'off'}`)
    try {
      const display = screen.getPrimaryDisplay()
      log(`display size=${JSON.stringify(display.size)} work=${JSON.stringify(display.workArea)} scale=${display.scaleFactor}`)
    } catch {}
    createBallWindow()
    createPanelWindow()
    createTray()
    applyHotkey()
    applyLoginItem()
    connectHost()
  })
}

process.on('uncaughtException', (error) => log(`uncaught: ${error?.stack ?? error}`))
process.on('unhandledRejection', (error) => log(`unhandled: ${error?.stack ?? error}`))

app.on('window-all-closed', () => {})

app.on('before-quit', () => {
  dragging = null
  globalShortcut.unregisterAll()
  try {
    tray?.destroy()
  } catch {}
  tray = null
})
