import { describe, expect, it } from 'vitest'
import { jobStartedText, startedJob } from '../tools/jobs'
import {
  BRIDGED_LIST_CHARS,
  BRIDGED_RESULT_CHARS,
  bridgedCallsText,
  cappedBridgedCalls,
  hasBridgedCalls,
  readBridgedCalls,
  type BridgedCall,
} from './bridgedCalls'

function call(result: string, fields: Partial<BridgedCall> = {}): BridgedCall {
  return { name: 'jobs_list', arguments: {}, status: 'success', result, ...fields }
}

describe('bridgedCallsText and readBridgedCalls', () => {
  it('reads back what the writer wrote', () => {
    const bridged = {
      calls: [
        call('Made the image @b.', { name: 'image', arguments: { command: 'flip', parameters: '{"image":"a"}' } }),
        call('No model has the id "x".', { name: 'model_invoke', arguments: { model: 'x', prompt: 'A "fox" & more\nlines', is_intermediate: true, timeout_seconds: 60 }, status: 'error' }),
        call('', { status: 'cut' }),
      ],
      more: 3,
    }

    expect(readBridgedCalls(bridgedCallsText(bridged))).toStrictEqual(bridged)
  })

  it('reads a value that is not the form of the writer as no list', () => {
    const one = (fields: object) => JSON.stringify({ calls: [{ name: 'image', arguments: {}, status: 'success', result: '', ...fields }], more: 0 })

    expect(readBridgedCalls(one({}))).not.toBeNull()
    for (const text of [
      '',
      'x',
      '[]',
      '{}',
      '{"calls":[]}',
      '{"calls":[],"more":-1}',
      '{"calls":[],"more":1.5}',
      '{"calls":{},"more":0}',
      one({ status: 'running' }),
      one({ name: 5 }),
      one({ result: null }),
      one({ arguments: { nested: { a: 1 } } }),
      one({ arguments: ['a'] }),
    ]) {
      expect(readBridgedCalls(text), text).toBeNull()
    }
  })
})

describe('hasBridgedCalls', () => {
  it('is false only for a list with no call and no count of more calls', () => {
    expect(hasBridgedCalls({ calls: [], more: 0 })).toBe(false)
    expect(hasBridgedCalls({ calls: [call('done')], more: 0 })).toBe(true)
    expect(hasBridgedCalls({ calls: [], more: 2 })).toBe(true)
  })
})

describe('cappedBridgedCalls', () => {
  it('keeps short calls as they are, with the count of the calls that have no entry', () => {
    const calls = [call('one'), call('two', { status: 'error' })]

    expect(cappedBridgedCalls(calls, 0)).toStrictEqual({ calls, more: 0 })
    expect(cappedBridgedCalls(calls, 4)).toStrictEqual({ calls, more: 4 })
  })

  it('keeps the start of a long result, with a note of the cut', () => {
    const whole = 'x'.repeat(BRIDGED_RESULT_CHARS)
    const [kept, cut] = cappedBridgedCalls([call(whole), call(`${whole}yz`)], 0).calls

    expect(kept.result).toBe(whole)
    expect(cut.result).toBe(`${whole}…\n\n(The result has 1,002 characters. Dez keeps only its start in this list.)`)
  })

  // The rule of the jobs reads the job of a call from the start of its
  // result.
  it('keeps the start text of a job in a long result', () => {
    const result = `${jobStartedText('j-k3x9', 2)}\n${'A long line of a tool. '.repeat(200)}`
    const [kept] = cappedBridgedCalls([call(result)], 0).calls

    expect(kept.result.length).toBeLessThan(result.length)
    expect(startedJob(kept.result)).toStrictEqual({ id: 'j-k3x9', number: 2 })
  })

  it('cuts a long result at no half of a character', () => {
    const [kept] = cappedBridgedCalls([call(`${'x'.repeat(BRIDGED_RESULT_CHARS - 1)}🦊 and more`)], 0).calls

    expect(kept.result.startsWith(`${'x'.repeat(BRIDGED_RESULT_CHARS - 1)}…`)).toBe(true)
  })

  it('leaves out a call that does not fit the list, counts it, and keeps a later call that fits', () => {
    const large = call('', { name: 'model_invoke', arguments: { model: 'p/m', prompt: 'x'.repeat(BRIDGED_LIST_CHARS) } })
    const bridged = cappedBridgedCalls([call('first'), large, call('last')], 1)

    expect(bridged).toStrictEqual({ calls: [call('first'), call('last')], more: 2 })
  })

  it('holds the calls of a whole run with long results, and stays under the limit of the list', () => {
    const calls = Array.from({ length: 40 }, () => call('x'.repeat(5000)))
    const bridged = cappedBridgedCalls(calls, 0)

    expect(bridged.calls).toHaveLength(40)
    expect(bridged.more).toBe(0)
    // Many calls with large arguments: the list keeps the ones that fit.
    const wide = cappedBridgedCalls(Array.from({ length: 40 }, () => call('done', { arguments: { text: 'x'.repeat(4000) } })), 0)
    expect(JSON.stringify(wide.calls).length).toBeLessThanOrEqual(BRIDGED_LIST_CHARS + wide.calls.length + 1)
    expect(wide.calls.length).toBeGreaterThan(0)
    expect(wide.calls.length + wide.more).toBe(40)
    expect(wide.more).toBeGreaterThan(0)
  })
})
