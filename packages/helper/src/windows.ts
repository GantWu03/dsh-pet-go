/**
 * The two windows, on purpose.
 *
 *   ballWin   80x80, always interactive: the ball itself. Because the window is
 *             exactly the ball, clicks outside it pass through to the desktop
 *             with no `setIgnoreMouseEvents` hit-testing at all.
 *   panelWin  388 wide, hosts both the composer and the answer bubble. It is
 *             mouse-transparent while it only shows a bubble (so it never blocks
 *             the app underneath) and interactive while the composer is open.
 *
 * An earlier single-window build relied on `setIgnoreMouseEvents(true,
 * {forward:true})` plus a renderer hit-test; on this machine the forwarded
 * mousemove never reached the page, so the ball received no clicks.
 *
 * Geometry note: at 200% DPI, `setPosition` makes Electron re-scale a transparent
 * frameless window (69x84 grew to 144x147 after one drag). Every move therefore
 * goes through setBounds with an explicitly tracked logical size.
 */
import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'

import type { PetSettings, Log, Point } from './settings.ts'
import { loadWindowPosition, saveWindowPosition } from './settings.ts'

const BALL = 80
const PANEL_W = 388
const GAP = 8
const EDGE = 8
const HOVER_POLL_MS = 250

export type DragPhase = 'start' | 'move' | 'end'

export interface WindowSize {
  width: number
  height: number
}

export interface WindowsDeps {
  log: Log
  getSettings: () => PetSettings
  paths: { preload: string, renderer: string, userDataDir: string }
}

export interface CompanionWindows {
  /** Ball window sits exactly where the user left it. */
  create (): void
  destroy (): void
  readonly panelOpen: boolean
  readonly bubbleHeight: number
  openPanel (): void
  closePanel (): void
  togglePanel (): void
  showBall (): void
  setPet (pet: string): void
  resetPosition (): void
  drag (phase: DragPhase): void
  setPetSize (size: WindowSize): void
  setBubbleHeight (height: number): void
  setPanelHeight (height: number): void
  showBubble (height?: number): void
  hideBubble (): void
  /** Hide both windows (the pet's "隐藏浮窗" item). */
  hideAll (): void
  /** Physical pixels of the primary display, for the machine facts. */
  primaryDisplay (): { width: number, height: number, scale: number }
  sendToBall (channel: string, payload: unknown): void
  sendToPanel (channel: string, payload: unknown): void
  /** Called whenever the panel page (re)loads, e.g. to replay the welcome frame. */
  onPanelReady (listener: () => void): void
}

export function createWindows (deps: WindowsDeps): CompanionWindows {
  const { log, getSettings, paths } = deps

  let ballWin: BrowserWindow | null = null
  let panelWin: BrowserWindow | null = null
  let panelOpen = false
  let bubbleHeight = 0
  let panelHeight = 140
  let petSize: WindowSize = { width: BALL, height: BALL }
  let dragging: { cursor: Point, origin: [number, number] } | null = null
  let hoverTimer: NodeJS.Timeout | null = null
  let lastHover = false
  const panelReadyListeners: Array<() => void> = []

  const clampToWorkArea = (x: number, y: number, width = BALL, height = BALL): Point => {
    const display = screen.getDisplayNearestPoint({ x, y })
    const area = display.workArea
    return {
      x: Math.min(Math.max(x, area.x), area.x + area.width - width),
      y: Math.min(Math.max(y, area.y), area.y + area.height - height),
    }
  }

  const defaultPosition = (): Point => {
    const area = screen.getPrimaryDisplay().workArea
    return { x: area.x + area.width - BALL - EDGE, y: area.y + area.height - BALL - EDGE }
  }

  const loadBallPosition = (): Point =>
    loadWindowPosition(paths.userDataDir, defaultPosition(), (point) => clampToWorkArea(point.x, point.y))

  const saveBallPosition = (): void => {
    if (!ballWin) return
    const [x, y] = ballWin.getPosition()
    saveWindowPosition(paths.userDataDir, { x, y })
  }

  /** Anchor the panel window above the ball, right edges aligned. */
  const positionPanel = (height: number): void => {
    if (!ballWin || !panelWin) return
    const [bx, by] = ballWin.getPosition()
    const x = Math.round(bx + petSize.width - PANEL_W)
    const y = Math.round(by - GAP - height)
    const area = screen.getDisplayNearestPoint({ x: bx, y: by }).workArea
    panelWin.setBounds({
      x: Math.max(area.x, Math.min(x, area.x + area.width - PANEL_W)),
      y: Math.max(area.y, Math.min(y, area.y + area.height - height)),
      width: PANEL_W,
      height,
    })
  }

  const createBallWindow = (): void => {
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
      webPreferences: { preload: paths.preload, contextIsolation: true, nodeIntegration: false, sandbox: false },
    })
    ballWin.setAlwaysOnTop(true, 'screen-saver')
    ballWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    void ballWin.loadFile(join(paths.renderer, 'ball.html'))
    ballWin.webContents.on('did-finish-load', () => {
      ballWin?.webContents.send('companion:init', { pet: getSettings().pet })
    })
    ballWin.once('ready-to-show', () => {
      ballWin?.showInactive()
      log(`ball shown at ${JSON.stringify(ballWin?.getPosition())}`)
    })
    ballWin.on('closed', () => { ballWin = null })
  }

  const createPanelWindow = (): void => {
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
      webPreferences: { preload: paths.preload, contextIsolation: true, nodeIntegration: false, sandbox: false },
    })
    panelWin.setAlwaysOnTop(true, 'screen-saver')
    panelWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    panelWin.setIgnoreMouseEvents(true, { forward: true })
    void panelWin.loadFile(join(paths.renderer, 'panel.html'))
    // Frames that arrive before the page is ready (welcome/model) would be lost,
    // so the owner replays them once the renderer is up.
    panelWin.webContents.on('did-finish-load', () => {
      for (const listener of panelReadyListeners) listener()
    })
    panelWin.on('closed', () => { panelWin = null })
  }

  const openPanel = (): void => {
    if (!panelWin || !ballWin) return
    panelOpen = true
    stopHoverWatch()
    positionPanel(panelHeight)
    panelWin.setIgnoreMouseEvents(false)
    // By default the composer does NOT take focus: the user keeps reading their
    // own window, and clicking the textarea is what starts typing.
    if (getSettings().focusOnOpen) {
      panelWin.show()
      panelWin.focus()
    } else {
      panelWin.showInactive()
    }
    panelWin.webContents.send('companion:open')
    ballWin.webContents.send('companion:open')
    log(`panel opened (focus=${Boolean(getSettings().focusOnOpen)})`)
  }

  const closePanel = (): void => {
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
    // Hand the caret back to whatever the user was doing.
    if (getSettings().focusOnOpen) panelWin?.blur()
    log('panel closed')
  }

  const togglePanel = (): void => {
    if (panelOpen) closePanel()
    else openPanel()
  }

  /** Bubble-only mode: visible, sized to content, and mouse-transparent. */
  const showBubbleWindow = (height?: number): void => {
    if (!panelWin) return
    if (typeof height === 'number') bubbleHeight = height
    const target = Math.round(bubbleHeight > 0 ? bubbleHeight : 120)
    positionPanel(target)
    panelWin.setIgnoreMouseEvents(true, { forward: true })
    if (!panelWin.isVisible()) panelWin.showInactive()
    startHoverWatch()
    log(`bubble ${target} ball=${JSON.stringify(ballWin?.getBounds())}`)
  }

  const hideBubble = (): void => {
    bubbleHeight = 0
    stopHoverWatch()
    if (panelOpen) return
    panelWin?.hide()
  }

  // The bubble window is mouse-transparent, so it cannot receive hover events
  // itself. Poll the cursor against its bounds instead; the renderer uses a
  // transition into the bubble to reset its fade-out countdown.
  const startHoverWatch = (): void => {
    if (hoverTimer) return
    lastHover = false
    hoverTimer = setInterval(() => {
      if (!panelWin || !panelWin.isVisible() || panelOpen) return
      const point = screen.getCursorScreenPoint()
      const bounds = panelWin.getBounds()
      const inside = point.x >= bounds.x && point.x < bounds.x + bounds.width &&
        point.y >= bounds.y && point.y < bounds.y + bounds.height
      if (inside === lastHover) return
      lastHover = inside
      panelWin.webContents.send('companion:hover', inside)
      // Let the user scroll a long answer: while the pointer is on the bubble the
      // window accepts mouse input, and it goes back to click-through as soon as
      // the pointer leaves.
      panelWin.setIgnoreMouseEvents(!inside, { forward: true })
    }, HOVER_POLL_MS)
  }

  const stopHoverWatch = (): void => {
    if (hoverTimer) clearInterval(hoverTimer)
    hoverTimer = null
    lastHover = false
  }

  /** Everything the panel and the ball need to be re-anchored after a change. */
  const relayout = (): void => {
    if (panelOpen) positionPanel(panelHeight)
    else if (bubbleHeight > 0) showBubbleWindow()
  }

  return {
    create (): void {
      createBallWindow()
      createPanelWindow()
    },

    destroy (): void {
      stopHoverWatch()
      dragging = null
      panelReadyListeners.length = 0
      for (const win of [panelWin, ballWin]) {
        try {
          win?.destroy()
        } catch {}
      }
      panelWin = null
      ballWin = null
      panelOpen = false
    },

    get panelOpen (): boolean {
      return panelOpen
    },

    get bubbleHeight (): number {
      return bubbleHeight
    },

    openPanel,
    closePanel,
    togglePanel,

    showBall (): void {
      if (!ballWin) return
      const wasHidden = !ballWin.isVisible()
      ballWin.showInactive()
      if (wasHidden) log('ball restored')
      relayout()
    },

    setPet (pet: string): void {
      ballWin?.webContents.send('companion:init', { pet })
    },

    resetPosition (): void {
      const area = screen.getPrimaryDisplay().workArea
      ballWin?.setBounds({
        x: area.x + area.width - petSize.width - EDGE,
        y: area.y + area.height - petSize.height - EDGE,
        width: petSize.width,
        height: petSize.height,
      })
      saveBallPosition()
      relayout()
    },

    drag (phase: DragPhase): void {
      if (!ballWin) return
      if (phase === 'start') {
        dragging = { cursor: screen.getCursorScreenPoint(), origin: ballWin.getPosition() }
        log(`drag start at ${JSON.stringify(dragging.origin)} size ${petSize.width}x${petSize.height}`)
        return
      }
      if (!dragging) return
      if (phase === 'move') {
        const point = screen.getCursorScreenPoint()
        ballWin.setBounds({
          x: dragging.origin[0] + (point.x - dragging.cursor.x),
          y: dragging.origin[1] + (point.y - dragging.cursor.y),
          width: petSize.width,
          height: petSize.height,
        })
        relayout()
        return
      }
      dragging = null
      const [x, y] = ballWin.getPosition()
      const clamped = clampToWorkArea(x, y, petSize.width, petSize.height)
      ballWin.setBounds({ x: clamped.x, y: clamped.y, width: petSize.width, height: petSize.height })
      log(`drag end bounds=${JSON.stringify(ballWin.getBounds())}`)
      saveBallPosition()
      relayout()
    },

    setPetSize (size: WindowSize): void {
      if (!ballWin || !size) return
      const width = Math.max(48, Math.min(Math.round(size.width), 420))
      const height = Math.max(48, Math.min(Math.round(size.height), 420))
      log(`pet-size request ${width}x${height} (current ${petSize.width}x${petSize.height})`)
      const previous = petSize
      petSize = { width, height }
      const bounds = ballWin.getBounds()
      ballWin.setBounds({
        x: bounds.x + (previous.width - width),
        y: bounds.y + (previous.height - height),
        width,
        height,
      })
      log(`pet window now ${JSON.stringify(ballWin.getBounds())}`)
      saveBallPosition()
      relayout()
    },

    setBubbleHeight (height: number): void {
      if (!Number.isFinite(height)) return
      bubbleHeight = Math.max(80, Math.min(Math.round(height), 340))
      if (!panelOpen) showBubbleWindow(bubbleHeight)
    },

    setPanelHeight (height: number): void {
      if (!Number.isFinite(height)) return
      panelHeight = Math.max(96, Math.min(Math.round(height), 420))
      if (panelOpen) positionPanel(panelHeight)
    },

    showBubble (height?: number): void {
      showBubbleWindow(height)
    },

    hideBubble,

    hideAll (): void {
      log('pet hidden (tray icon or hotkey brings it back)')
      for (const win of [panelWin, ballWin]) {
        try {
          win?.hide()
        } catch {}
      }
    },

    primaryDisplay (): { width: number, height: number, scale: number } {
      const display = screen.getPrimaryDisplay()
      const scale = display.scaleFactor || 1
      // Physical pixels: the DIP size confuses the model about screen size.
      return {
        width: Math.round(display.size.width * scale),
        height: Math.round(display.size.height * scale),
        scale,
      }
    },

    sendToBall (channel: string, payload: unknown): void {
      ballWin?.webContents.send(channel, payload)
    },

    sendToPanel (channel: string, payload: unknown): void {
      panelWin?.webContents.send(channel, payload)
    },

    onPanelReady (listener: () => void): void {
      panelReadyListeners.push(listener)
    },
  }
}
