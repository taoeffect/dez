import { describe, expect, it } from 'vitest'
import { titleMotion } from '../../src-tauri/libs/dez-media/motion.js'

// The motion of a title: the times of the reference card (24 frames a
// second: a slam of 6 frames, a flash of 4, a glint of 18 that starts 4
// frames after the entrance, a glitch exit of 6).

const FRAME = 1 / 24
const close = (value: number) => expect.closeTo(value, 9)

describe('titleMotion', () => {
  it('slams the title in from 135%, blurred and faint, to its own size in 6 frames', () => {
    expect(titleMotion(0, { duration: 4 })).toStrictEqual({ scale: 1.35, blur: 6 / 720, alpha: 0.3, flash: 0, glint: null, glitch: 0 })
    const half = titleMotion(3 * FRAME, { duration: 4 })
    expect(half).toMatchObject({ scale: close(1.35 - 0.35 * (1 - 0.5 ** 3)), blur: close(3 / 720), alpha: close(0.8), flash: 0 })
  })

  it('flashes white for 4 frames after the slam, and settles with a bounce that dies away', () => {
    expect(titleMotion(0.25, { duration: 4 })).toMatchObject({ scale: close(1.02), blur: 0, alpha: 1, flash: close(0.8) })
    expect(titleMotion(0.25 + 2 * FRAME, { duration: 4 }).flash).toBeCloseTo(0.4, 9)
    expect(titleMotion(0.25 + 4 * FRAME, { duration: 4 }).flash).toBeCloseTo(0, 9)
    const scales = Array.from({ length: 24 }, (_, frame) => titleMotion(0.25 + frame * FRAME, { duration: 4 }).scale)
    expect(Math.min(...scales)).toBeLessThan(1)
    expect(Math.abs(titleMotion(1.5, { duration: 4 }).scale - 1)).toBeLessThan(1e-6)
  })

  it('sweeps the glint over 18 frames, from 4 frames after the entrance, only when asked', () => {
    const start = 0.25 + 4 * FRAME
    expect(titleMotion(start - 0.001, { duration: 4 }).glint).toBeNull()
    expect(titleMotion(start, { duration: 4 }).glint).toBeCloseTo(0, 9)
    expect(titleMotion(start + 9 * FRAME, { duration: 4 }).glint).toBeCloseTo(0.5, 9)
    expect(titleMotion(start + 18 * FRAME, { duration: 4 }).glint).toBeCloseTo(1, 9)
    expect(titleMotion(start + 18 * FRAME + 0.001, { duration: 4 }).glint).toBeNull()
    expect(titleMotion(start + 9 * FRAME, { duration: 4, glint: false }).glint).toBeNull()
    // After a fade in of 0.5 s, and with no entrance.
    expect(titleMotion(0.5 + 4 * FRAME, { duration: 4, entrance: 'fade' }).glint).toBeCloseTo(0, 9)
    expect(titleMotion(4 * FRAME, { duration: 4, entrance: 'none' }).glint).toBeCloseTo(0, 9)
  })

  it('glitches the title out in the last 0.25 s, as it fades', () => {
    expect(titleMotion(3.75, { duration: 4 })).toMatchObject({ alpha: 1, glitch: 0 })
    expect(titleMotion(3.875, { duration: 4 })).toMatchObject({ alpha: close(0.5), glitch: close(0.5) })
    expect(titleMotion(4, { duration: 4 })).toMatchObject({ alpha: 0, glitch: 1 })
  })

  it('fades in and out over 0.5 s, with no slam, flash, or glitch', () => {
    const fade = { duration: 4, entrance: 'fade', exit: 'fade' } as const
    expect(titleMotion(0, fade)).toStrictEqual({ scale: 1, blur: 0, alpha: 0, flash: 0, glint: null, glitch: 0 })
    expect(titleMotion(0.25, fade)).toMatchObject({ scale: 1, alpha: 0.5, flash: 0 })
    expect(titleMotion(0.5, fade)).toMatchObject({ scale: 1, alpha: 1, flash: 0 })
    expect(titleMotion(3.75, fade)).toMatchObject({ alpha: close(0.5), glitch: 0 })
  })

  it('shows the title as it is with no entrance and no exit', () => {
    for (const time of [0, 2, 4]) {
      expect(titleMotion(time, { duration: 4, entrance: 'none', exit: 'none', glint: false })).toStrictEqual({ scale: 1, blur: 0, alpha: 1, flash: 0, glint: null, glitch: 0 })
    }
  })

  it('refuses an entrance, an exit, or a duration that it does not know', () => {
    expect(() => titleMotion(0, { duration: 4, entrance: 'zoom' as 'slam' })).toThrow('The entrance of a title is "slam", "fade", or "none", not "zoom".')
    expect(() => titleMotion(0, { duration: 4, exit: 'spin' as 'fade' })).toThrow(RangeError)
    expect(() => titleMotion(0, { duration: 0 })).toThrow(RangeError)
    expect(() => titleMotion(Number.NaN, { duration: 4 })).toThrow(RangeError)
  })
})
