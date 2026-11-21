const api = window.companion

const bubble = document.getElementById('bubble')
const bubbleText = document.getElementById('bubble-text')
const bubbleMeta = document.getElementById('bubble-meta')
const bubbleClose = document.getElementById('bubble-close')
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

// ------------------------------------------------------------------ markdown
// Deliberately tiny and DOM-built: no innerHTML, no dependency. Covers what a
// chat answer actually uses — fenced code, inline code, bold, lists, links.
// Only http(s) links become anchors; everything else stays literal text.

const SAFE_URL = /^https?:\/\//i

function appendInline (parent, text) {
  // Split on the three inline forms, keeping delimiters.
  const parts = String(text).split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g)
  for (const part of parts) {
    if (!part) continue
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      const code = document.createElement('code')
      code.textContent = part.slice(1, -1)
      parent.appendChild(code)
      continue
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      const strong = document.createElement('strong')
      strong.textContent = part.slice(2, -2)
      parent.appendChild(strong)
      continue
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)
    if (link) {
      const url = link[2].trim()
      if (SAFE_URL.test(url)) {
        const anchor = document.createElement('a')
        anchor.textContent = link[1]
        anchor.href = url
        anchor.title = url
        // Never navigate this window: the bubble is a glance, not a browser.
        // The click handler below hands the URL to the main process instead.
        anchor.target = '_blank'
        anchor.rel = 'noopener noreferrer'
        parent.appendChild(anchor)
        return
      }
      parent.appendChild(document.createTextNode(link[1]))
      return
    }
    parent.appendChild(document.createTextNode(part))
  }
}

function buildNodes (source) {
  const nodes = []
  const lines = String(source).split('\n')
  let list = null
  let listTag = ''

  const closeList = () => {
    if (list) {
      nodes.push(list)
      list = null
      listTag = ''
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]

    if (/^```/.test(line)) {
      closeList()
      const language = line.slice(3).trim()
      const body = []
      index += 1
      while (index < lines.length && !/^```/.test(lines[index])) {
        body.push(lines[index])
        index += 1
      }
      const pre = document.createElement('pre')
      const code = document.createElement('code')
      if (language) code.dataset.language = language
      code.textContent = body.join('\n')
      pre.appendChild(code)
      nodes.push(pre)
      continue
    }

    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (ordered || bullet) {
      const tag = ordered ? 'ol' : 'ul'
      if (listTag !== tag) {
        closeList()
        list = document.createElement(tag)
        listTag = tag
      }
      const item = document.createElement('li')
      appendInline(item, ordered ? ordered[1] : bullet[1])
      list.appendChild(item)
      continue
    }

    closeList()
    if (line.trim() === '') {
      nodes.push(document.createElement('br'))
      continue
    }
    const paragraph = document.createElement('p')
    appendInline(paragraph, line)
    nodes.push(paragraph)
  }
  closeList()
  return nodes
}

function renderAnswer (text) {
  bubbleText.replaceChildren(...buildNodes(text))
}

// A link in an answer points somewhere else; it is not a place to go *from* the
// bubble. Clicking it hands the URL to the main process, which opens the user's
// browser and refuses anything that is not http(s). Without this the bubble's
// window itself followed the link — one click turned the whole pet into GitHub's
// 404 page with no way back. Capture phase so nothing renders between the click
// and the hand-off, and `auxclick` too, since a middle click would otherwise ask
// for a new window.
function followLink (event) {
  const node = event.target
  const anchor = node instanceof Element ? node.closest('a[href]') : null
  if (!anchor) return
  event.preventDefault()
  event.stopPropagation()
  api.openExternal?.(anchor.href)
}

bubbleText.addEventListener('click', followLink, true)
bubbleText.addEventListener('auxclick', followLink, true)

function reportBubbleHeight () {
  if (composerOpen || bubble.classList.contains('hidden')) return
  const height = Math.ceil(bubble.getBoundingClientRect().height) + 20
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
  const height = Math.ceil(panel.getBoundingClientRect().height) + 20
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

// Faint × in the bubble's top-right corner: dismiss without waiting for the
// idle timer.
bubbleClose.addEventListener('click', () => {
  answerText = ''
  clearIdleTimers()
  bubble.classList.add('hidden')
  bubble.classList.remove('thinking', 'error', 'faded')
  api.hideBubble()
})

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
      } else if (frame.phase === 'tool') {
        // The model is out investigating; keep the bubble alive and honest
        // instead of leaving it empty for a dozen tool calls.
        if (!answerText) {
          bubble.classList.remove('hidden')
          bubble.classList.add('thinking')
          bubbleText.textContent = '让我想想呢…'
          reportBubbleHeight()
        }
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
        } else if (answerText) {
          // Re-render once at the end: streaming stays a cheap textContent
          // append, and the final answer gets links/lists/code blocks.
          renderAnswer(answerText)
          reportBubbleHeight()
          armIdleTimers()
        }
        // A step that only called tools ends with no text: not a finished
        // answer, so keep the bubble waiting for the next step.
      }
      break
    }
    case 'state': {
      if (frame.state === 'idle' && !answerText && !bubble.classList.contains('hidden')) {
        bubbleText.textContent = '（这次没有拿到文字回答）'
        bubble.classList.remove('thinking')
        reportBubbleHeight()
        armIdleTimers()
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
  // CSS :hover does not fire when the window only just stopped ignoring the
  // mouse, so the close button's visibility is driven by this event instead.
  bubble.classList.toggle('hovered', inside)
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
