/**
 * Pet window controller.
 *
 * Owns everything that is NOT the pet's appearance: mounting the renderer,
 * reporting the window size it needs, click / drag / right-click, and mapping
 * host + UI events onto renderer states.
 */
import { createRenderer } from '../renderers/registry.js'

const api = window.companion
const host = document.getElementById('pet-host')

/** @type {any} */
let renderer = null
let drag = null
let panelOpen = false
let currentState = 'idle'
let doneTimer = 0

function setState (state) {
  if (state === currentState) return
  currentState = state
  renderer?.setState(state)
  api.log(`pet state=${state}`)
}

function reaction (state, then, ms = 1400) {
  if (doneTimer) clearTimeout(doneTimer)
  setState(state)
  doneTimer = setTimeout(() => {
    doneTimer = 0
    setState(then)
  }, ms)
}

async function init (petId) {
  if (doneTimer) clearTimeout(doneTimer)
  doneTimer = 0
  try {
    renderer?.dispose()
  } catch {}
  host.replaceChildren()
  try {
    renderer = await createRenderer(petId)
  } catch (error) {
    api.log(`renderer ${petId} failed: ${error?.message}`)
    renderer = await createRenderer('circle')
  }
  await renderer.mount(host)
  const size = renderer.measure()
  api.log(`pet ${renderer.id} size=${size.width}x${size.height}`)
  api.petSize(size)
  currentState = 'idle'
  renderer.setState('idle')
}

// ------------------------------------------------------------------ pointer

function endDrag (moved) {
  if (!drag) return
  drag = null
  api.drag('end')
  if (!moved) api.ballClick()
  else setState(panelOpen ? 'listening' : 'idle')
}

host.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  drag = { pointerId: event.pointerId, x: event.screenX, y: event.screenY, moved: false }
  api.drag('start')
  try {
    host.setPointerCapture(event.pointerId)
  } catch {}
})

host.addEventListener('pointermove', (event) => {
  if (!drag) return
  if (event.pointerId !== drag.pointerId) return
  if (event.buttons === 0) {
    endDrag(false)
    return
  }
  if (Math.abs(event.screenX - drag.x) + Math.abs(event.screenY - drag.y) > 4) {
    if (!drag.moved) {
      drag.moved = true
      setState('drag')
    }
    api.drag('move')
  }
})

for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  host.addEventListener(type, (event) => {
    if (!drag) return
    if (typeof event.pointerId === 'number' && event.pointerId !== drag.pointerId) return
    endDrag(drag.moved)
  })
}

window.addEventListener('mouseup', () => { if (drag) endDrag(drag.moved) })
window.addEventListener('blur', () => { if (drag) endDrag(false) })

window.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  api.contextMenu()
})

// -------------------------------------------------------------------- wiring

api.onInit((config) => { void init(config?.pet ?? 'circle') })
api.onOpen(() => {
  panelOpen = true
  reaction('listening', 'idle', 1200)
})
api.onClose(() => {
  panelOpen = false
  if (currentState === 'listening') setState('idle')
  if (currentState === 'drag') setState('idle')
})

api.onHost((frame) => {
  if (frame?.type === 'answer') {
    if (frame.phase === 'start') setState('answering')
    else if (frame.phase === 'delta' && currentState !== 'answering') setState('answering')
    else if (frame.phase === 'end') {
      if (frame.ok === false) reaction('error', 'idle', 1800)
      else reaction('done', 'idle', 1600)
    }
    return
  }
  if (frame?.type === 'state') {
    if (frame.state === 'running') setState('thinking')
    else if (frame.state === 'idle' && (currentState === 'thinking' || currentState === 'answering')) setState('idle')
  }
})
