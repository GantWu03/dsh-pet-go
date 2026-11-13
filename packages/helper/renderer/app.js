/* Renderer: ball <-> panel <-> bubble. No Node access; talks through preload. */
const api = window.companion

const ball = document.getElementById('ball')
const panel = document.getElementById('panel')
const bubble = document.getElementById('bubble')
const bubbleText = document.getElementById('bubble-text')
const bubbleMeta = document.getElementById('bubble-meta')
const input = document.getElementById('input')
const captureToggle = document.getElementById('capture-toggle')
const sendBtn = document.getElementById('send')
const newBtn = document.getElementById('new-session')
const toast = document.getElementById('toast')
const modelChip = document.getElementById('model-chip')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let panelOpen = false
let sending = false
let answerText = ''
let lastInteractive = null
let menu = null

// ------------------------------------------------------------- mouse pass-through

function setInteractive (value) {
  if (lastInteractive === value) return
  lastInteractive = value
  api.interactive(value)
}

function overBall (event) {
  const rect = ball.getBoundingClientRect()
  return event.clientX >= rect.left && event.clientX <= rect.right &&
         event.clientY >= rect.top && event.clientY <= rect.bottom
}

document.addEventListener('mousemove', (event) => {
  if (panelOpen || menu) {
    setInteractive(true)
    return
  }
  setInteractive(overBall(event))
})

document.addEventListener('mouseleave', () => {
  if (!panelOpen && !menu) setInteractive(false)
})

// ------------------------------------------------------------------------ panel

function openPanel () {
  hideMenu()
  panelOpen = true
  panel.classList.remove('hidden')
  setInteractive(true)
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
}

function closePanel () {
  if (!panelOpen) return
  panelOpen = false
  hideToast()
  panel.classList.add('hidden')
  hideMenu()
  api.closePanel()
  setInteractive(overBallPointer())
}

function overBallPointer () {
  const rect = ball.getBoundingClientRect()
  const x = lastPointer?.x ?? -1
  const y = lastPointer?.y ?? -1
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}

let lastPointer = null
document.addEventListener('mousemove', (event) => {
  lastPointer = { x: event.clientX, y: event.clientY }
})

// ------------------------------------------------------------------------ ball

let drag = null

ball.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  drag = { x: event.screenX, y: event.screenY, moved: false }
  api.drag('start')
  try {
    ball.setPointerCapture(event.pointerId)
  } catch {}
})

ball.addEventListener('pointermove', (event) => {
  if (!drag) return
  if (Math.abs(event.screenX - drag.x) + Math.abs(event.screenY - drag.y) > 4) {
    if (!drag.moved) drag.moved = true
    api.drag('move')
  }
})

ball.addEventListener('pointerup', () => {
  if (!drag) return
  const moved = drag.moved
  drag = null
  api.drag('end')
  if (!moved) openPanel()
})

// --------------------------------------------------------------------- sending

function showToast (message) {
  toast.textContent = message
  toast.classList.remove('hidden')
}

function hideToast () {
  toast.classList.add('hidden')
}

async function send () {
  if (sending) return
  const text = input.value.trim()
  const wantCapture = captureToggle.checked
  if (!text) {
    showToast('先说点什么吧')
    input.focus()
    return
  }

  sending = true
  sendBtn.disabled = true
  hideToast()

  // Hide the composer before the screenshot: the ball stays (the user sees it,
  // so it belongs in the shot), the draft text does not (it is noise).
  panelOpen = false
  panel.classList.add('hidden')
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
    openPanel()
    showToast(response?.detail || '发送失败了')
    return
  }

  input.value = ''
  showBubbleThinking()
}

function sendWithKeyboard (event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void send()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    closePanel()
  }
}

input.addEventListener('keydown', sendWithKeyboard)
input.addEventListener('input', () => {
  input.style.height = 'auto'
  input.style.height = Math.min(input.scrollHeight, 132) + 'px'
})

sendBtn.addEventListener('click', () => void send())
newBtn.addEventListener('click', async () => {
  newBtn.disabled = true
  const result = await api.newSession()
  newBtn.disabled = false
  if (result && result.ok === false) showToast(result.detail || '新建会话失败')
  else {
    bubble.classList.add('hidden')
    showToast('已经换到一个新会话')
    setTimeout(hideToast, 1800)
  }
})

// ---------------------------------------------------------------------- bubble

function showBubble () {
  bubble.classList.remove('hidden')
}

function showBubbleThinking () {
  answerText = ''
  bubble.classList.remove('error')
  bubble.classList.add('thinking')
  bubbleText.textContent = ''
  bubbleMeta.classList.add('hidden')
  showBubble()
}

function setRunning (running) {
  ball.classList.toggle('running', Boolean(running))
}

// ---------------------------------------------------------------- host frames

api.onHost((frame) => {
  if (!frame || typeof frame !== 'object') return
  switch (frame.type) {
    case 'welcome': {
      if (frame.model?.model) modelChip.textContent = frame.model.model
      if (frame.sessionId) modelChip.title = frame.sessionId
      setRunning(frame.state === 'running')
      break
    }
    case 'state': {
      setRunning(frame.state === 'running')
      if (frame.detail) showToast(frame.detail)
      break
    }
    case 'session': {
      modelChip.title = frame.sessionId ?? ''
      break
    }
    case 'answer': {
      if (frame.phase === 'start') {
        showBubbleThinking()
      } else if (frame.phase === 'delta') {
        bubble.classList.remove('thinking')
        answerText += frame.text ?? ''
        bubbleText.textContent = answerText
        bubbleText.scrollTop = bubbleText.scrollHeight
      } else if (frame.phase === 'end') {
        bubble.classList.remove('thinking')
        if (frame.ok === false) {
          bubble.classList.add('error')
          bubbleText.textContent = answerText || frame.detail || '回答失败'
          if (answerText && frame.detail) {
            bubbleMeta.textContent = frame.detail
            bubbleMeta.classList.remove('hidden')
          }
        }
      }
      break
    }
    case 'transport': {
      if (frame.state === 'lost') {
        setRunning(false)
        showToast('和 DSH 的连接断了，正在重连…')
      } else if (frame.state === 'connected') {
        hideToast()
      }
      break
    }
    default:
      break
  }
})

api.onOpen(() => openPanel())

// ------------------------------------------------------------------------ menu

function hideMenu () {
  if (!menu) return
  menu.remove()
  menu = null
  if (!panelOpen) setInteractive(overBallPointer())
}

function showMenu (x, y) {
  hideMenu()
  menu = document.createElement('div')
  menu.style.cssText = `position:fixed;left:${Math.max(4, x - 90)}px;top:${Math.max(4, y - 44)}px;
    background:rgba(28,30,40,.96);border:1px solid rgba(255,255,255,.12);border-radius:10px;
    padding:4px;z-index:99;box-shadow:0 12px 28px rgba(0,0,0,.45);font-size:12.5px;`
  const quit = document.createElement('button')
  quit.textContent = '退出浮窗'
  quit.style.cssText = 'display:block;width:100%;text-align:left;background:transparent;color:#ffb4b4;padding:6px 10px;border:0;border-radius:7px;cursor:pointer;font:inherit;'
  quit.addEventListener('click', () => api.quit())
  menu.appendChild(quit)
  document.body.appendChild(menu)
  setInteractive(true)
}

document.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  showMenu(event.clientX, event.clientY)
})

document.addEventListener('pointerdown', (event) => {
  if (menu && !menu.contains(event.target)) hideMenu()
}, true)

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !panelOpen) {
    bubble.classList.add('hidden')
  }
})
