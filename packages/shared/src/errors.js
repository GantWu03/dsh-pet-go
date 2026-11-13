/**
 * Stable error codes shared by both processes.
 * Every failure the user can see carries one of these plus a human sentence.
 */

export const ErrorCode = /** @type {const} */ ({
  DSH_NOT_READY: 'DSH_NOT_READY',
  AGENT_UNAVAILABLE: 'AGENT_UNAVAILABLE',
  CAPTURE_DENIED: 'CAPTURE_DENIED',
  CAPTURE_EMPTY: 'CAPTURE_EMPTY',
  IMAGE_TOO_LARGE: 'IMAGE_TOO_LARGE',
  UNSUPPORTED_IMAGE_TYPE: 'UNSUPPORTED_IMAGE_TYPE',
  TRANSPORT_LOST: 'TRANSPORT_LOST',
  PROTOCOL_MISMATCH: 'PROTOCOL_MISMATCH',
  BAD_REQUEST: 'BAD_REQUEST',
  INTERNAL: 'INTERNAL',
})

const MESSAGES = {
  DSH_NOT_READY: 'DSH 还没准备好，稍等一下再试',
  AGENT_UNAVAILABLE: '专属会话丢失了，正在重建…',
  CAPTURE_DENIED: '截图被系统拒绝了，请检查屏幕录制权限',
  CAPTURE_EMPTY: '截到的是空画面，再试一次',
  IMAGE_TOO_LARGE: '这张图太大了，试试关掉「截图」只发文字',
  UNSUPPORTED_IMAGE_TYPE: '这个图片格式 DSH 不接受',
  TRANSPORT_LOST: '和 DSH 的连接断了，正在重连…',
  PROTOCOL_MISMATCH: '版本对不上，需要同时升级插件和浮窗',
  BAD_REQUEST: '请求不完整',
  INTERNAL: '内部错误',
}

const RETRYABLE = new Set(['DSH_NOT_READY', 'AGENT_UNAVAILABLE', 'CAPTURE_EMPTY', 'TRANSPORT_LOST'])

/**
 * @param {string} code
 * @param {string} [detail]
 * @returns {{ code: string, detail: string, retryable: boolean }}
 */
export function describeError (code, detail) {
  const message = MESSAGES[code] ?? MESSAGES.INTERNAL
  return {
    code,
    detail: detail ? `${message}（${detail}）` : message,
    retryable: RETRYABLE.has(code),
  }
}
