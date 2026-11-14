const api = window.companion

const bubble = document.getElementById('bubble')
const bubbleText = document.getElementById('bubble-text')
const bubbleMeta = document.getElementById('bubble-meta')
const panel = document.getElementById('panel')
const input = document.getElementById('input')
const captureToggle = document.getElementById('capture-toggle')
const sendBtn = document.getElementById('send')
const newBtn = document.getElementById('new-session')
const toast = document.getElementById('toast')
const modelChip = document.getElementById('model-chip')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let sending = false
let answerText = ''
let composerOpen = false
let lastReported = 0

// Bubble lifetime: 20s idle -> faded, +10s -> gone. Hovering resets it.
const FADE_AFTER_MS = 20_000
const HIDE_AFTER_MS = 10_000
let fadeTimer = null
let hideTimer = null

function clearIdleTimers () {
  if (fadeTimer) clearTimeout(fadeTimer)
  if (hideTimer) clearTimeout(hideTimer)
  fadeTimer = null
  hideTimer = null
}

function armIdleTimers () {
  clearIdleTimers()
  if (composerOpen) return
  bubble.classList.remove('faded')
  fadeTimer = setTimeout(() => {
    if (!composerOpen) bubble.classList.add('faded')
  }, FADE_AFTER_MS)
  hideTimer = setTimeout(() => {
    if (composerOpen) return
    bubble.classList.add('hidden')
    bubble.classList.remove('faded')
    answerText = ''
    api.hideBubble()
  }, FADE_AFTER_MS + HIDE_AFTER_MS)
}

function touchBubble () {
  if (composerOpen) return
  if (bubble.classList.contains('hidden')) return
  armIdleTimers()
}

// ------------------------------------------------------------------ geometry

function reportBubbleHeight () {
  if (composerOpen || bubble.classList.contains('hidden')) return
  const height = Math.ceil(bubble.getBoundingClientRect().height) + 12
  if (Math.abs(height - lastReported) < 4) return
  lastReported = height
  api.bubbleSize(height)
}

const observer = new ResizeObserver(() => reportBubbleHeight())
observer.observe(bubble)

const panelObserver = new ResizeObserver(() => reportPanelHeight())
panelObserver.observe(panel)

// --------------------------------------------------------------------- toast

function showToast (message) {
  toast.textContent = message
  toast.classList.remove('hidden')
}

function hideToast () {
  toast.classList.add('hidden')
}

// ------------------------------------------------------------------ composer

function reportPanelHeight () {
  if (!composerOpen) return
  const height = Math.ceil(panel.getBoundingClientRect().height) + 12
  api.panelSize(height)
}

function showComposer () {
  composerOpen = true
  clearIdleTimers()
  bubble.classList.remove('faded')
  panel.classList.remove('hidden')
  bubble.classList.add('hidden')
  hideToast()
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
  requestAnimationFrame(reportPanelHeight)
}

function hideComposer () {
  composerOpen = false
  hideToast()
  panel.classList.add('hidden')
}

async function send () {
  if (sending) return
  const text = input.value.trim()
  if (!text) {
    showToast('先说点什么吧')
    input.focus()
    return
  }
  const wantCapture = captureToggle.checked
  sending = true
  sendBtn.disabled = true
  hideToast()

  // Hide the composer before the screenshot: the ball stays visible (the user
  // sees it, so it belongs in the shot), the draft text does not.
  hideComposer()
  api.closePanel()
  await sleep(140)

  let response
  try {
    response = await api.submit({ text, capture: wantCapture })
  } catch (error) {
    response = { ok: false, detail: String(error?.message ?? error) }
  }

  sending = false
  sendBtn.disabled = false

  if (!response || response.ok === false) {
    input.value = text
    showBubbleAnswer(answerText, true, response?.detail || '发送失败了')
    showComposer()
    showToast(response?.detail || '发送失败了')
    return
  }

  input.value = ''
  answerText = ''
  bubble.classList.remove('error')
  bubble.classList.add('thinking')
  bubbleText.textContent = '思考中…'
  bubbleMeta.classList.add('hidden')
  bubble.classList.remove('hidden')
}

function sendWithKeyboard (event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void send()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    api.closePanel()
  }
}

input.addEventListener('keydown', sendWithKeyboard)
input.addEventListener('input', () => {
  input.style.height = 'auto'
  input.style.height = Math.min(input.scrollHeight, 132) + 'px'
  reportPanelHeight()
})

sendBtn.addEventListener('click', () => void send())

newBtn.addEventListener('click', async () => {
  newBtn.disabled = true
  const result = await api.newSession()
  newBtn.disabled = false
  if (result && result.ok === false) showToast(result.detail || '新建会话失败')
  else {
    answerText = ''
    bubble.classList.add('hidden')
    showToast('已经换到一个新会话')
    setTimeout(hideToast, 1800)
  }
})

// -------------------------------------------------------------------- bubble

function showBubbleAnswer (text, isError, detail) {
  bubble.classList.remove('hidden', 'thinking', 'faded')
  bubble.classList.toggle('error', Boolean(isError))
  bubbleText.textContent = text
  if (detail) {
    bubbleMeta.textContent = detail
    bubbleMeta.classList.remove('hidden')
  } else {
    bubbleMeta.classList.add('hidden')
  }
  reportBubbleHeight()
  armIdleTimers()
}

// ---------------------------------------------------------------- host frames

api.onHost((frame) => {
  if (!frame || typeof frame !== 'object') return
  switch (frame.type) {
    case 'welcome':
      if (frame.model?.model) modelChip.textContent = frame.model.model
      break
    case 'session':
      modelChip.title = frame.sessionId ?? ''
      break
    case 'answer': {
      if (frame.phase === 'start') {
        answerText = ''
        lastReported = 0
        bubble.classList.remove('error')
        bubble.classList.add('thinking')
        bubble.classList.remove('hidden')
        bubbleText.textContent = '思考中…'
        bubbleMeta.classList.add('hidden')
        reportBubbleHeight()
      } else if (frame.phase === 'delta') {
        bubble.classList.remove('thinking')
        answerText += frame.text ?? ''
        bubbleText.textContent = answerText
        bubbleText.scrollTop = bubbleText.scrollHeight
        reportBubbleHeight()
      } else if (frame.phase === 'end') {
        bubble.classList.remove('thinking')
        if (frame.ok === false) {
          showBubbleAnswer(answerText || '回答失败', true, frame.detail)
        } else {
          reportBubbleHeight()
          armIdleTimers()
        }
      }
      break
    }
    case 'transport':
      if (frame.state === 'lost') showBubbleAnswer('和 DSH 的连接断了，正在重连…', true)
      break
    default:
      break
  }
})

api.onOpen(() => showComposer())

api.onHover((inside) => {
  if (composerOpen || bubble.classList.contains('hidden')) return
  if (inside) {
    // While the pointer is on the bubble it must never fade; the countdown
    // starts again the moment it leaves.
    clearIdleTimers()
    bubble.classList.remove('faded')
  } else {
    armIdleTimers()
  }
})

api.onClose(() => {
  hideComposer()
  if (answerText) {
    bubble.classList.remove('hidden')
    reportBubbleHeight()
    armIdleTimers()
  } else {
    bubble.classList.add('hidden')
  }
})

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !composerOpen) api.hideBubble()
})
