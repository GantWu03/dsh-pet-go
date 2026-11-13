const api = window.companion
const ball = document.getElementById('ball')

let drag = null

function endDrag (moved) {
  if (!drag) return
  drag = null
  api.drag('end')
  if (!moved) api.ballClick()
}

ball.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  drag = { pointerId: event.pointerId, x: event.screenX, y: event.screenY, moved: false }
  api.drag('start')
  try {
    ball.setPointerCapture(event.pointerId)
  } catch {}
})

ball.addEventListener('pointermove', (event) => {
  if (!drag) return
  if (event.pointerId !== drag.pointerId) return
  // A release that happened off-window (or losing capture while the window
  // moves under the cursor) must end the drag; otherwise the ball stays glued
  // to the pointer after mouse-up.
  if (event.buttons === 0) {
    endDrag(false)
    return
  }
  if (Math.abs(event.screenX - drag.x) + Math.abs(event.screenY - drag.y) > 4) {
    drag.moved = true
    api.drag('move')
  }
})

for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  ball.addEventListener(type, (event) => {
    if (!drag) return
    if (typeof event.pointerId === 'number' && event.pointerId !== drag.pointerId) return
    endDrag(drag.moved)
  })
}

window.addEventListener('mouseup', () => { if (drag) endDrag(drag.moved) })
window.addEventListener('blur', () => { if (drag) endDrag(false) })

api.onHost((frame) => {
  if (frame?.type === 'state') ball.classList.toggle('running', frame.state === 'running')
  if (frame?.type === 'welcome') ball.classList.toggle('running', frame.state === 'running')
})
