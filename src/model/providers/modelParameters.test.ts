import { describe, expect, it } from 'vitest'
import { cloneModelParameter, effectiveParameterValues, type ModelParameter, type OptionsParameter } from './modelParameters'

const DURATION: ModelParameter = { name: 'duration', label: 'Length', options: [1, 5, 10], default: 1 }
const ASPECT_RATIO: ModelParameter = { name: 'aspect_ratio', label: 'Aspect ratio', options: ['16:9', '1:1'] }
const SECONDS: ModelParameter = { name: 'duration_seconds', label: 'Length (seconds)', min: 3, max: 30, default: 5 }
const PARAMETERS = [DURATION, ASPECT_RATIO, SECONDS]

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

  it('sends no value for a name that is no parameter of the model', () => {
    expect(effectiveParameterValues([ASPECT_RATIO], { fps: 60, duration: 5 })).toStrictEqual({})
  })

  it('reads no value from the prototype of the chosen values', () => {
    const parameter: ModelParameter = { name: 'toString', label: 'Text', options: ['a'] }

    expect(effectiveParameterValues([parameter], {})).toStrictEqual({})
  })
})

describe('cloneModelParameter', () => {
  it('shares no list with the parameter', () => {
    const copy = cloneModelParameter(DURATION) as OptionsParameter
    copy.options.push(60)

    expect(DURATION).toStrictEqual({ name: 'duration', label: 'Length', options: [1, 5, 10], default: 1 })
  })
})
