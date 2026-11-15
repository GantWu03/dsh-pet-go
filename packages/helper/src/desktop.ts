/**
 * Desktop entry points: the tray icon, the pet's right-click menu, the global
 * hotkey and the login item.
 *
 * These are the places the user reaches the companion from, so they only contain
 * menu structure and Electron calls; what each item *does* is injected. That
 * keeps every Electron API in one of the helper's platform modules and lets the
 * entry decide the wiring.
 */
import { Menu, Tray, app, globalShortcut, nativeImage } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'

import type { Log, PetSettings } from './settings.ts'
import { HOTKEY_PRESETS } from './settings.ts'

export interface DesktopActions {
  openPanel (): void
  togglePanel (): void
  setPet (pet: string): void
  resetPosition (): void
  newSession (): void
  hidePet (): void
  quit (): void
}

export interface DesktopDeps {
  log: Log
  getSettings: () => PetSettings
  updateSettings: (patch: Partial<PetSettings>) => void
  trayIconPath: string
  /** Directory Electron was launched with; what the login item re-launches. */
  appPath: string
  actions: DesktopActions
}

export interface Desktop {
  createTray (): void
  showPetMenu (): void
  applyHotkey (): void
  applyLoginItem (): void
  destroy (): void
}

export function createDesktop (deps: DesktopDeps): Desktop {
  const { log, getSettings, updateSettings, actions } = deps
  let tray: Tray | null = null

  const hotkeyItems = (): MenuItemConstructorOptions[] =>
    HOTKEY_PRESETS.map(([value, label]) => ({
      label,
      type: 'radio',
      checked: getSettings().hotkey === value,
      click: () => {
        updateSettings({ hotkey: value })
        api.applyHotkey()
      },
    }))

  const loginItem = (): MenuItemConstructorOptions => ({
    label: '开机自启',
    type: 'checkbox',
    checked: Boolean(getSettings().openAtLogin),
    click: (item: { checked: boolean }) => {
      updateSettings({ openAtLogin: item.checked })
      api.applyLoginItem()
    },
  })

  const trayMenu = (): Menu => Menu.buildFromTemplate([
    { label: '打开输入条', click: () => actions.openPanel() },
    { label: '新会话', click: () => actions.newSession() },
    { type: 'separator' },
    { label: '快捷键', submenu: hotkeyItems() },
    loginItem(),
    { label: '复位浮窗位置', click: () => actions.resetPosition() },
    { type: 'separator' },
    { label: '退出', click: () => actions.quit() },
  ])

  /** Right-click menu on the pet — the primary entry point (ADR-016). */
  const petMenu = (): Menu => Menu.buildFromTemplate([
    {
      label: '形象',
      submenu: [
        { label: '默认', type: 'radio', checked: getSettings().pet === 'circle', click: () => actions.setPet('circle') },
        { label: '大肥鱼', type: 'radio', checked: getSettings().pet === 'baifan', click: () => actions.setPet('baifan') },
      ],
    },
    { type: 'separator' },
    { label: '快捷键', submenu: hotkeyItems() },
    loginItem(),
    {
      label: '打开时自动聚焦',
      type: 'checkbox',
      checked: Boolean(getSettings().focusOnOpen),
      click: (item) => updateSettings({ focusOnOpen: item.checked }),
    },
    { label: '复位位置', click: () => actions.resetPosition() },
    { type: 'separator' },
    { label: '打开输入条', click: () => actions.openPanel() },
    { label: '隐藏浮窗', click: () => actions.hidePet() },
    { label: '退出', click: () => actions.quit() },
  ])

  const refreshTray = (): void => {
    try {
      tray?.setContextMenu(trayMenu())
    } catch {}
  }

  const api: Desktop = {
    createTray (): void {
      try {
        const icon = nativeImage.createFromPath(deps.trayIconPath)
        tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
        tray.setToolTip('桌面小助手 · 点球或快捷键')
        refreshTray()
        tray.on('click', () => {
          actions.openPanel()
        })
        log('tray created')
      } catch (error) {
        log(`tray failed: ${(error as Error)?.message}`)
      }
    },

    showPetMenu (): void {
      petMenu().popup()
    },

    applyHotkey (): void {
      try {
        globalShortcut.unregisterAll()
      } catch {}
      const { hotkey } = getSettings()
      if (!hotkey) {
        log('hotkey disabled')
        refreshTray()
        return
      }
      try {
        const registered = globalShortcut.register(hotkey, () => {
          log('hotkey pressed')
          actions.togglePanel()
        })
        log(`hotkey registered=${registered} key=${hotkey}`)
      } catch (error) {
        log(`hotkey failed: ${(error as Error)?.message}`)
      }
      refreshTray()
    },

    applyLoginItem (): void {
      const openAtLogin = Boolean(getSettings().openAtLogin)
      try {
        app.setLoginItemSettings({ openAtLogin, path: process.execPath, args: [deps.appPath] })
        log(`openAtLogin=${openAtLogin}`)
      } catch (error) {
        log(`login item failed: ${(error as Error)?.message}`)
      }
      refreshTray()
    },

    destroy (): void {
      try {
        globalShortcut.unregisterAll()
      } catch {}
      try {
        tray?.destroy()
      } catch {}
      tray = null
    },
  }

  return api
}
