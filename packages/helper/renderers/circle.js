/** The default pet: a pure-CSS ball. No assets, no network, no video. */

const BALL_SIZE = 64
const PADDING = 8

export function createCircle () {
  /** @type {HTMLElement | null} */
  let element = null

  return {
    id: 'circle',

    mount (host) {
      const ball = document.createElement('div')
      ball.className = 'pet-circle'
      ball.style.width = `${BALL_SIZE}px`
      ball.style.height = `${BALL_SIZE}px`
      const left = document.createElement('span')
      left.className = 'eye left'
      const right = document.createElement('span')
      right.className = 'eye right'
      ball.append(left, right)
      host.appendChild(ball)
      element = ball
    },

    measure () {
      const side = BALL_SIZE + PADDING * 2
      return { width: side, height: side }
    },

    setState (state) {
      if (!element) return
      element.classList.toggle('running', state === 'thinking' || state === 'answering')
    },

    dispose () {
      element?.remove()
      element = null
    },
  }
}
