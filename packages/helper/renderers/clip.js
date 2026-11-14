/**
 * Clip renderer: one transparent <video> per state, driven by pet.json.
 *
 * Why video instead of a frame sequence: the upstream dsh-pet assets are
 * VP9-alpha webm clips, Chromium decodes them with transparency, and one video
 * element switching `src` is far lighter than decoding PNG sequences by hand.
 *
 * pet.json shape (see assets/pets/<name>/pet.json):
 *   stage     {width,height}  source canvas the clips were authored on
 *   viewport  {x,y,width,height}  crop of the stage that is actually the pet
 *   preferred {width,height}  how big that crop should appear on screen
 *   states    {state: {clip, loop, then?}}
 */

const PADDING = 6

/**
 * @param {{ petDir?: string, baseUrl?: string }} options
 */
export async function createClip (options = {}) {
  const petDir = options.petDir ?? 'baifan'
  const baseUrl = options.baseUrl ?? new URL(`../assets/pets/${petDir}/`, window.location.href).href
  const response = await fetch(`${baseUrl}pet.json`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`pet.json ${response.status}`)
  const pet = await response.json()

  const viewport = pet.viewport ?? { x: 0, y: 0, width: pet.stage.width, height: pet.stage.height }
  const preferred = pet.preferred ?? { width: 84, height: 84 }
  const scale = preferred.height / viewport.height
  const boxWidth = Math.round(viewport.width * scale)
  const boxHeight = Math.round(viewport.height * scale)

  /** @type {HTMLElement | null} */
  let wrapper = null
  /** @type {HTMLVideoElement | null} */
  let video = null
  let currentClip = ''
  let fallback = null

  function play (state) {
    const spec = pet.states?.[state] ?? pet.states?.idle
    if (!spec || !video) return
    fallback = spec.then ?? null
    if (spec.clip === currentClip) return
    currentClip = spec.clip
    video.loop = spec.loop !== false
    video.src = `${baseUrl}${spec.clip}`
    void video.play().catch(() => {})
  }

  return {
    id: `clip:${petDir}`,

    mount (host) {
      const frame = document.createElement('div')
      frame.className = 'pet-clip'
      frame.style.width = `${boxWidth}px`
      frame.style.height = `${boxHeight}px`

      const element = document.createElement('video')
      element.className = 'pet-clip-video'
      element.muted = true
      element.playsInline = true
      element.autoplay = true
      element.preload = 'auto'
      element.disablePictureInPicture = true
      element.style.width = `${Math.round(pet.stage.width * scale)}px`
      element.style.height = `${Math.round(pet.stage.height * scale)}px`
      element.style.left = `${-Math.round(viewport.x * scale)}px`
      element.style.top = `${-Math.round(viewport.y * scale)}px`

      element.addEventListener('ended', () => {
        if (fallback) {
          const next = fallback
          fallback = null
          play(next)
        }
      })

      frame.appendChild(element)
      host.appendChild(frame)
      wrapper = frame
      video = element
      play('idle')
    },

    measure () {
      return { width: boxWidth + PADDING * 2, height: boxHeight + PADDING * 2 }
    },

    setState (state) {
      play(state)
    },

    dispose () {
      if (video) {
        video.pause()
        video.removeAttribute('src')
        video.load()
      }
      wrapper?.remove()
      wrapper = null
      video = null
    },
  }
}
