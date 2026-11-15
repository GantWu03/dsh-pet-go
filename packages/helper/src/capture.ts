/**
 * Screenshot of the display the pointer is on.
 *
 * This is the helper's one job that is a platform capability, so it is a single
 * exported function with a typed failure: the host only ever sees either an
 * image or a `CaptureError` code it can describe to the user.
 */
import { desktopCapturer, screen } from 'electron'

export interface Screenshot {
  base64: string
  mediaType: string
  width: number
  height: number
}

export class CaptureError extends Error {
  readonly code: 'CAPTURE_DENIED' | 'CAPTURE_EMPTY'

  constructor (code: 'CAPTURE_DENIED' | 'CAPTURE_EMPTY', message: string) {
    super(message)
    this.name = 'CaptureError'
    this.code = code
  }
}

export async function captureActiveDisplay (): Promise<Screenshot> {
  const point = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(point)
  const scale = display.scaleFactor || 1
  const thumbnailSize = {
    width: Math.round(display.size.width * scale),
    height: Math.round(display.size.height * scale),
  }
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize })
  const source = sources.find((candidate) => String(candidate.display_id) === String(display.id)) ?? sources[0]
  if (!source) throw new CaptureError('CAPTURE_DENIED', '系统没有返回可用的屏幕源')
  const image = source.thumbnail
  if (!image || image.isEmpty()) throw new CaptureError('CAPTURE_EMPTY', '截到的是空画面')
  const size = image.getSize()
  return {
    base64: image.toPNG().toString('base64'),
    mediaType: 'image/png',
    width: size.width,
    height: size.height,
  }
}
