// @ts-check
// The motion of an animated title: the scale, blur, alpha, flash, glint,
// and glitch of the title at each time of its clip. The built-in app
// dez-title (src-tauri/builtin-apps/) draws each frame from it with
// `drawTitleFrame` of dez-media/canvas. It is plain math with no drawing,
// so the page of a UI app can use it with its own canvas too.
//
// The times are those of a 1980s anime title card at 24 frames a second:
// the title slams in from 135% in 6 frames, settles with a small bounce,
// flashes white for 4 frames, gets a glint across its letters, and leaves
// with a glitch in its last 6 frames.

/** @typedef {'slam' | 'fade' | 'none'} TitleEntrance */
/** @typedef {'glitch' | 'fade' | 'none'} TitleExit */

/**
 * The state of a title at one time of its clip:
 * - `scale`: the size of the title, around the center of its block (1 is
 *   its own size);
 * - `blur`: the motion blur, as a part of the height of the frame (0 for
 *   none);
 * - `alpha`: 0 (not seen) to 1;
 * - `flash`: how far its colors go to white, 0 to 1;
 * - `glint`: where the glint is in its sweep from the left of the frame to
 *   the right, 0 to 1, or null when no glint shows;
 * - `glitch`: how far the glitch exit is, 0 (none) to 1: the title then
 *   moves in horizontal slices.
 * @typedef {{ scale: number, blur: number, alpha: number, flash: number, glint: number | null, glitch: number }} TitleMotion
 */

/** The entrances of a title. */
export const TITLE_ENTRANCES = /** @type {const} */ (['slam', 'fade', 'none'])
/** The exits of a title. */
export const TITLE_EXITS = /** @type {const} */ (['glitch', 'fade', 'none'])

// The frame rate of the reference card: the bounce and the flash count its
// frames.
const CARD_FPS = 24
// The slam: from SLAM_SCALE to 1, with a blur of SLAM_BLUR of the height
// and an alpha from SLAM_ALPHA, in SLAM_SECONDS (6 frames of the card).
const SLAM_SECONDS = 0.25
const SLAM_SCALE = 1.35
const SLAM_BLUR = 6 / 720
const SLAM_ALPHA = 0.3
// The flash after the slam: toward white by FLASH at its start, gone after
// FLASH_FRAMES frames of the card.
const FLASH = 0.8
const FLASH_FRAMES = 4
// A fade in or a fade out.
const FADE_SECONDS = 0.5
// The glint starts 4 frames of the card after the entrance, and sweeps for
// 18 frames.
const GLINT_DELAY = 4 / CARD_FPS
const GLINT_SECONDS = 18 / CARD_FPS
const GLITCH_SECONDS = 0.25

/** @type {Readonly<Record<TitleEntrance, number>>} */
const ENTRANCE_SECONDS = { slam: SLAM_SECONDS, fade: FADE_SECONDS, none: 0 }
/** @type {Readonly<Record<TitleExit, number>>} */
const EXIT_SECONDS = { glitch: GLITCH_SECONDS, fade: FADE_SECONDS, none: 0 }

/**
 * The state of a title at `time` seconds of its clip of `duration` seconds
 * (`TitleMotion`). The frame `i` of a clip at `fps` frames a second is at
 * the time `i / fps`.
 * @param {number} time
 * @param {{ duration: number, entrance?: TitleEntrance, exit?: TitleExit, glint?: boolean }} options
 *   `entrance`: "slam" (default), "fade", or "none"; `exit`: "glitch"
 *   (default), "fade", or "none"; `glint`: true (default) for a glint
 *   after the entrance.
 * @returns {TitleMotion}
 */
export function titleMotion(time, { duration, entrance = 'slam', exit = 'glitch', glint = true }) {
  if (!Number.isFinite(time)) throw new RangeError(`titleMotion takes a time in seconds, not ${time}.`)
  if (!(duration > 0) || !Number.isFinite(duration)) throw new RangeError(`titleMotion takes the duration of the clip in seconds, more than 0, not ${duration}.`)
  if (!TITLE_ENTRANCES.includes(entrance)) throw new RangeError(`The entrance of a title is "slam", "fade", or "none", not ${JSON.stringify(entrance)}.`)
  if (!TITLE_EXITS.includes(exit)) throw new RangeError(`The exit of a title is "glitch", "fade", or "none", not ${JSON.stringify(exit)}.`)

  const motion = { scale: 1, blur: 0, alpha: 1, flash: 0, glint: /** @type {number | null} */ (null), glitch: 0 }
  if (entrance === 'slam' && time < SLAM_SECONDS) {
    const k = Math.max(0, time) / SLAM_SECONDS
    // An ease-out cubic from SLAM_SCALE to 1.
    motion.scale = SLAM_SCALE - (SLAM_SCALE - 1) * (1 - (1 - k) ** 3)
    motion.blur = SLAM_BLUR * (1 - k)
    motion.alpha = Math.min(1, SLAM_ALPHA + k)
  } else if (entrance === 'slam') {
    // A bounce of 2% that dies away, and the flash.
    const frames = (time - SLAM_SECONDS) * CARD_FPS
    motion.scale = 1 + 0.02 * Math.exp(-frames / 2.5) * Math.cos(1.8 * frames)
    if (frames < FLASH_FRAMES) motion.flash = FLASH * (1 - frames / FLASH_FRAMES)
  } else if (entrance === 'fade' && time < FADE_SECONDS) {
    motion.alpha = Math.max(0, time) / FADE_SECONDS
  }

  const glintStart = ENTRANCE_SECONDS[entrance] + GLINT_DELAY
  if (glint && time >= glintStart && time <= glintStart + GLINT_SECONDS) motion.glint = (time - glintStart) / GLINT_SECONDS

  const exitStart = duration - EXIT_SECONDS[exit]
  if (exit !== 'none' && time > exitStart) {
    const e = Math.min(1, (time - exitStart) / EXIT_SECONDS[exit])
    motion.alpha *= 1 - e
    if (exit === 'glitch') motion.glitch = e
  }
  return motion
}
