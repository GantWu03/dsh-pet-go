/**
 * Minimal Electron surface used by the helper.
 *
 * The helper is launched as `electron <app dir>`, so Electron is provided at
 * runtime by the binary the host resolves — it is not a dependency of this repo
 * (installing it would download a second copy of the browser for nothing). Only
 * the APIs the platform modules actually call are declared, which keeps the
 * Electron boundary visible: if a type here is missing, that call belongs in
 * windows.ts / desktop.ts / capture.ts, not in an application module.
 */
declare module 'electron' {
  export interface Size {
    width: number
    height: number
  }

  export interface Rectangle extends Size {
    x: number
    y: number
  }

  export interface Display {
    id: number
    size: Size
    workArea: Rectangle
    scaleFactor: number
  }

  export interface WebPreferences {
    preload?: string
    contextIsolation?: boolean
    nodeIntegration?: boolean
    sandbox?: boolean
  }

  export interface BrowserWindowConstructorOptions {
    width?: number
    height?: number
    x?: number
    y?: number
    frame?: boolean
    transparent?: boolean
    backgroundColor?: string
    resizable?: boolean
    movable?: boolean
    minimizable?: boolean
    maximizable?: boolean
    fullscreenable?: boolean
    skipTaskbar?: boolean
    alwaysOnTop?: boolean
    hasShadow?: boolean
    show?: boolean
    focusable?: boolean
    webPreferences?: WebPreferences
  }

  export class WebContents {
    send(channel: string, ...args: unknown[]): void
    on(event: 'did-finish-load', listener: () => void): this
    on(event: string, listener: (...args: never[]) => void): this
  }

  export class BrowserWindow {
    constructor(options?: BrowserWindowConstructorOptions)
    readonly webContents: WebContents
    setAlwaysOnTop(flag: boolean, level?: string): void
    setVisibleOnAllWorkspaces(flag: boolean, options?: { visibleOnFullScreen?: boolean }): void
    setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void
    loadFile(filePath: string): Promise<void>
    once(event: 'ready-to-show' | 'closed', listener: () => void): this
    on(event: string, listener: (...args: never[]) => void): this
    show(): void
    showInactive(): void
    hide(): void
    focus(): void
    blur(): void
    isVisible(): boolean
    getPosition(): [number, number]
    getBounds(): Rectangle
    setBounds(bounds: Rectangle): void
    destroy(): void
  }

  export interface NativeImage {
    isEmpty(): boolean
    toPNG(): Buffer
    getSize(): Size
  }

  export const nativeImage: {
    createFromPath(filePath: string): NativeImage
    createEmpty(): NativeImage
  }

  export interface MenuItemConstructorOptions {
    label?: string
    type?: 'normal' | 'separator' | 'checkbox' | 'radio' | 'submenu'
    checked?: boolean
    submenu?: MenuItemConstructorOptions[]
    click?: (menuItem: { checked: boolean }) => void
  }

  export class Menu {
    static buildFromTemplate(template: MenuItemConstructorOptions[]): Menu
    popup(options?: { window?: BrowserWindow }): void
  }

  export class Tray {
    constructor(image: NativeImage | string)
    setToolTip(text: string): void
    setContextMenu(menu: Menu | null): void
    on(event: 'click', listener: () => void): this
    destroy(): void
  }

  export const screen: {
    getPrimaryDisplay(): Display
    getDisplayNearestPoint(point: { x: number; y: number }): Display
    getCursorScreenPoint(): { x: number; y: number }
  }

  export interface DesktopCapturerSource {
    display_id: string
    thumbnail: NativeImage
  }

  export const desktopCapturer: {
    getSources(options: { types: string[], thumbnailSize: Size }): Promise<DesktopCapturerSource[]>
  }

  export const globalShortcut: {
    register(accelerator: string, callback: () => void): boolean
    unregisterAll(): void
  }

  export const ipcMain: {
    on(channel: string, listener: (event: unknown, ...args: never[]) => void): void
    handle(channel: string, listener: (event: unknown, ...args: never[]) => Promise<unknown> | unknown): void
    removeHandler(channel: string): void
    removeAllListeners(channel?: string): void
  }

  export interface App {
    requestSingleInstanceLock(): boolean
    quit(): void
    whenReady(): Promise<void>
    getPath(name: 'userData' | 'appData'): string
    setLoginItemSettings(settings: { openAtLogin: boolean, path?: string, args?: string[] }): void
    on(event: 'second-instance' | 'before-quit' | 'window-all-closed' | 'will-quit', listener: (...args: never[]) => void): this
  }

  export const app: App
}
