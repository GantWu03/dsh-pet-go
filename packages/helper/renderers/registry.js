/**
 * Renderer registry: the only place that knows which pet ids exist.
 * Adding a pet = add an implementation file + one entry here.
 */
import { createCircle } from './circle.js'
import { createClip } from './clip.js'

/** @type {Record<string, (options: object) => any>} */
const FACTORIES = {
  circle: () => createCircle(),
  baifan: (options) => createClip({ ...options, petDir: 'baifan' }),
}

export const PET_IDS = Object.keys(FACTORIES)

/**
 * @param {string} id
 * @param {object} options
 */
export async function createRenderer (id, options = {}) {
  const factory = FACTORIES[id] ?? FACTORIES.circle
  return await factory(options)
}

export function isKnownPet (id) {
  return Object.prototype.hasOwnProperty.call(FACTORIES, id)
}
