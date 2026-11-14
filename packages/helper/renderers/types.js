/**
 * Pet renderer contract.
 *
 * A renderer owns exactly one thing: what the pet looks like and how big it is.
 * It must NOT know about the window, the composer, the bubble, the capture or
 * the host protocol — the controller (ball.js) wires those.
 *
 * Implementations live as siblings in this directory and must not import each
 * other; add one to registry.js to make it selectable.
 */

/** States the controller can ask for. */
export const PET_STATES = Object.freeze([
  'idle',       // nothing happening
  'listening',  // composer just opened (short reaction)
  'thinking',   // request sent, waiting for the model
  'answering',  // tokens are streaming
  'done',       // answer finished (short reaction, then back to idle)
  'drag',       // user is dragging the pet
  'error',      // something failed
])

/**
 * @typedef {object} PetRenderer
 * @property {string} id
 * @property {(host: HTMLElement) => void | Promise<void>} mount
 * @property {() => {width: number, height: number}} measure  Window size this
 *   renderer needs, including its own padding for shadows/glow.
 * @property {(state: string) => void} setState
 * @property {() => void} dispose
 */
