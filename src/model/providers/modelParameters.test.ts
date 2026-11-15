import { describe, expect, it } from 'vitest'
import { checkedParameterValues, cloneModelParameter, effectiveParameterValues, MAX_CUSTOM_VALUE_LENGTH, nearestRangeValue, type ModelParameter, type OptionsParameter, type RangeParameter } from './modelParameters'

const DURATION: ModelParameter = { name: 'duration', label: 'Length', options: [1, 5, 10], default: 1 }
const ASPECT_RATIO: ModelParameter = { name: 'aspect_ratio', label: 'Aspect ratio', options: ['16:9', '1:1'] }
const SECONDS: ModelParameter = { name: 'duration_seconds', label: 'Length (seconds)', min: 3, max: 30, default: 5 }
const SPEED: RangeParameter = { name: 'speed', label: 'Speed', min: 0.7, max: 1.2, step: 0.05, default: 1 }
const LOOP: ModelParameter = { name: 'loop', label: 'Loop' }
const ENHANCE: ModelParameter = { name: 'enhance', label: 'Enhance', default: true }
const PARAMETERS = [DURATION, ASPECT_RATIO, SECONDS]
// A voice list that is not complete: the model also takes another voice id
// of its provider.
const VOICE: ModelParameter = { name: 'voice', label: 'Voice', options: ['Aria', 'Roger'], default: 'Aria', custom: true }
// A model that lists no voice and takes a voice id.
const ANY_VOICE: ModelParameter = { name: 'voice', label: 'Voice', options: [], custom: true }
const LISTED_VOICE: ModelParameter = { name: 'voice', label: 'Voice', options: ['Aria', 'Roger'], default: 'Aria' }
const VOICE_ID = 'laTmoAT4stwoPzthxjZT'
// A speed that the model takes any number of; the step is for the arrows
// of the settings field.
const ANY_SPEED: RangeParameter = { name: 'speed', label: 'Speed', min: 0.25, max: 4, step: 0.05, anyNumber: true, default: 1 }

describe('effectiveParameterValues', () => {
  it('gives each parameter its default, and no entry to a parameter with none', () => {
    expect(effectiveParameterValues(PARAMETERS)).toStrictEqual({ duration: 1, duration_seconds: 5 })
  })

  it('takes a chosen value over the default', () => {
    expect(effectiveParameterValues(PARAMETERS, { duration: 10, aspect_ratio: '1:1', duration_seconds: 30 }))
      .toStrictEqual({ duration: 10, aspect_ratio: '1:1', duration_seconds: 30 })
  })

  // A stored choice can be older than the model's list.
  it.each([
    ['an option that the list does not have', { duration: 7, aspect_ratio: '4:3' }],
    ['a text for a number option', { duration: '10' }],
    ['a number under the range', { duration_seconds: 2 }],
    ['a number over the range', { duration_seconds: 31 }],
    ['a part of a second', { duration_seconds: 5.5 }],
    ['a text for a range', { duration_seconds: '10' }],
    ['a value that is no text or number', { duration: null, aspect_ratio: ['1:1'] }],
  ])('counts %s as not chosen', (_name, chosen) => {
    expect(effectiveParameterValues(PARAMETERS, chosen)).toStrictEqual({ duration: 1, duration_seconds: 5 })
  })

  it('gives a switch its chosen state, also off over a default of on, and no entry to a switch with neither', () => {
    expect([
      effectiveParameterValues([LOOP, ENHANCE]),
      effectiveParameterValues([LOOP, ENHANCE], { loop: true, enhance: false }),
      effectiveParameterValues([LOOP, ENHANCE], { loop: 'true', enhance: 0 }),
    ]).toStrictEqual([{ enhance: true }, { loop: true, enhance: false }, { enhance: true }])
  })

  it('takes true or false only for a switch', () => {
    expect(effectiveParameterValues(PARAMETERS, { duration: true, aspect_ratio: false, duration_seconds: true })).toStrictEqual({ duration: 1, duration_seconds: 5 })
  })

  // 0.7 + 2 * 0.05 is 0.7999999999999999 in binary.
  it.each([0.7, 0.75, 0.8, 0.85, 1.15, 1.2])('takes %d, a step of a range with a step under 1', (speed) => {
    expect(effectiveParameterValues([SPEED], { speed })).toStrictEqual({ speed })
  })

  it.each([0.72, 0.701, 1.25, 0.65])('counts %d, which is not on a step of the range, as not chosen', (speed) => {
    expect(effectiveParameterValues([SPEED], { speed })).toStrictEqual({ speed: 1 })
  })

  it('takes a number off the steps of a range that takes any number, and no number outside the range', () => {
    expect([0.33, 1.12, 4, 0.2, 4.01].map((speed) => effectiveParameterValues([ANY_SPEED], { speed })))
      .toStrictEqual([{ speed: 0.33 }, { speed: 1.12 }, { speed: 4 }, { speed: 1 }, { speed: 1 }])
  })

  it('sends no value for a name that is no parameter of the model', () => {
    expect(effectiveParameterValues([ASPECT_RATIO], { fps: 60, duration: 5 })).toStrictEqual({})
  })

  it('reads no value from the prototype of the chosen values', () => {
    const inherited = Object.create({ duration: 10, aspect_ratio: '1:1' }) as Record<string, unknown>

    expect(effectiveParameterValues(PARAMETERS, inherited)).toStrictEqual({ duration: 1, duration_seconds: 5 })
  })

  it('takes a text that the list of a parameter with `custom` does not hold, and a listed value', () => {
    expect([
      effectiveParameterValues([VOICE], { voice: VOICE_ID }),
      effectiveParameterValues([VOICE], { voice: 'Roger' }),
      effectiveParameterValues([VOICE]),
      effectiveParameterValues([ANY_VOICE], { voice: VOICE_ID }),
      effectiveParameterValues([ANY_VOICE]),
    ]).toStrictEqual([{ voice: VOICE_ID }, { voice: 'Roger' }, { voice: 'Aria' }, { voice: VOICE_ID }, {}])
  })

  it('takes only a listed value for a parameter with no `custom`', () => {
    expect(effectiveParameterValues([LISTED_VOICE], { voice: VOICE_ID })).toStrictEqual({ voice: 'Aria' })
  })

  it.each([
    ['a number that is no option', 7],
    ['an empty text', ''],
    ['a text of spaces', '   '],
    ['a text of two lines', 'Aria\nRoger'],
    ['a text over the length limit', 'a'.repeat(MAX_CUSTOM_VALUE_LENGTH + 1)],
    ['true', true],
  ])('counts %s as not chosen for a parameter with `custom`', (_name, voice) => {
    expect(effectiveParameterValues([VOICE], { voice })).toStrictEqual({ voice: 'Aria' })
  })

  it('takes a text of the length limit for a parameter with `custom`', () => {
    const voice = 'a'.repeat(MAX_CUSTOM_VALUE_LENGTH)

    expect(effectiveParameterValues([VOICE], { voice })).toStrictEqual({ voice })
  })
})

describe('nearestRangeValue', () => {
  it.each([
    ['a number under the range', 0.1, 0.7],
    ['a number over the range', 9, 1.2],
    ['a number between two steps', 0.83, 0.85],
    ['a number on a step', 0.8, 0.8],
    ['a number with binary noise', 0.7 + 2 * 0.05, 0.8],
  ])('gives the step nearest to %s', (_name, value, nearest) => {
    expect(nearestRangeValue(SPEED, value)).toBe(nearest)
  })

  it('gives a whole number for a range with no step', () => {
    expect([2, 5.4, 5.5, 31].map((value) => nearestRangeValue(SECONDS as RangeParameter, value))).toStrictEqual([3, 5, 6, 30])
  })

  // The speech speed of Venice: 0.25 + 11 * 0.05 is 0.8000000000000002.
  it('gives numbers with no binary noise', () => {
    const speed: RangeParameter = { name: 'speed', label: 'Speed', min: 0.25, max: 4, step: 0.05 }

    expect([0.8, 1, 3.99].map((value) => nearestRangeValue(speed, value))).toStrictEqual([0.8, 1, 4])
  })

  // 1 to 12 in steps of 4 takes 1, 5, and 9: the step nearest to 12 is 13.
  it('never gives a number over the last step when `max` is not on a step', () => {
    const range: RangeParameter = { name: 'n', label: 'N', min: 1, max: 12, step: 4 }

    expect([10, 12, 99].map((value) => nearestRangeValue(range, value))).toStrictEqual([9, 9, 9])
  })

  it('keeps a number of a range that takes any number as it is, and gives the nearer end for a number outside', () => {
    expect([0.33, 1.12, 0.1, 9].map((value) => nearestRangeValue(ANY_SPEED, value))).toStrictEqual([0.33, 1.12, 0.25, 4])
  })
})

describe('checkedParameterValues', () => {
  it('takes a value for a switch and for a range with a step', () => {
    expect(checkedParameterValues([SPEED, LOOP], { speed: 0.85, loop: false })).toStrictEqual({ speed: 0.85, loop: false })
  })

  it('takes a text that the list of a parameter with `custom` does not hold', () => {
    expect([checkedParameterValues([VOICE], { voice: VOICE_ID }), checkedParameterValues([ANY_VOICE], { voice: VOICE_ID })])
      .toStrictEqual([{ voice: VOICE_ID }, { voice: VOICE_ID }])
  })

  it('takes a number off the steps of a range that takes any number', () => {
    expect(checkedParameterValues([ANY_SPEED], { speed: 1.12 })).toStrictEqual({ speed: 1.12 })
  })

  // A calling model writes a number as a text at times.
  it('takes the text of a number as that number, when the parameter takes only the number', () => {
    expect(checkedParameterValues([DURATION, SECONDS, SPEED], { duration: '10', duration_seconds: '30', speed: '0.85' }))
      .toStrictEqual({ duration: 10, duration_seconds: 30, speed: 0.85 })
  })

  it('keeps the text of a number that the parameter takes as a text', () => {
    const size: ModelParameter = { name: 'size', label: 'Size', options: ['1', 1] }

    expect([checkedParameterValues([size], { size: '1' }), checkedParameterValues([VOICE], { voice: '42' })])
      .toStrictEqual([{ size: '1' }, { voice: '42' }])
  })

  it.each<[string, ModelParameter[], Record<string, unknown>, string]>([
    ['a text for a switch', [LOOP], { loop: 'yes' }, 'The parameter "loop" takes true or false.'],
    ['a number off the steps of a range', [SPEED], { speed: 0.72 }, 'The parameter "speed" takes a number from 0.7 to 1.2 in steps of 0.05.'],
    ['a number outside a range that takes any number', [ANY_SPEED], { speed: 5 }, 'The parameter "speed" takes a number from 0.25 to 4.'],
    ['the text of a number that is no option', [DURATION], { duration: '7' }, 'The parameter "duration" takes one of: 1, 5, 10.'],
    ['a text that is no number for a range', [SECONDS], { duration_seconds: '5s' }, 'The parameter "duration_seconds" takes a whole number from 3 to 30.'],
    ['a part number for a range of whole numbers', [SECONDS], { duration_seconds: 5.5 }, 'The parameter "duration_seconds" takes a whole number from 3 to 30.'],
    ['a text that is no option of a closed list', [LISTED_VOICE], { voice: VOICE_ID }, 'The parameter "voice" takes one of: "Aria", "Roger".'],
    ['a number for a list that also takes another text', [VOICE], { voice: 7 }, `The parameter "voice" takes one of: "Aria", "Roger", or the text of another value that the provider takes (one line, at most ${MAX_CUSTOM_VALUE_LENGTH} characters).`],
    ['an empty text for a parameter with no list', [ANY_VOICE], { voice: '' }, `The parameter "voice" takes a text of one line (at most ${MAX_CUSTOM_VALUE_LENGTH} characters).`],
  ])('refuses %s, and tells what the parameter takes', (_name, parameters, chosen, message) => {
    expect(() => checkedParameterValues(parameters, chosen)).toThrow(new Error(message))
  })

  it('refuses a name that Dez has no parameter for, and tells the parameters that it has', () => {
    expect(() => checkedParameterValues(PARAMETERS, { fps: 60 })).toThrow(new Error('Dez has no parameter "fps" for this model. Its parameters: duration, aspect_ratio, duration_seconds.'))
    expect(() => checkedParameterValues([], { fps: 60 })).toThrow(new Error('Dez has no parameters for this model: leave out `parameters`.'))
  })
})

describe('cloneModelParameter', () => {
  it('shares no list with the parameter', () => {
    const copy = cloneModelParameter(DURATION) as OptionsParameter
    copy.options.push(60)

    expect(DURATION).toStrictEqual({ name: 'duration', label: 'Length', options: [1, 5, 10], default: 1 })
  })

  it('keeps the mark of a parameter that also takes another text', () => {
    expect(cloneModelParameter(ANY_VOICE)).toStrictEqual({ name: 'voice', label: 'Voice', options: [], custom: true })
  })
})
