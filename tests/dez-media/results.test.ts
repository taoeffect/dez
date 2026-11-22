import { describe, expect, it } from 'vitest'
import { resultJson, roundTo, workFile } from '../../src-tauri/libs/dez-media/results.js'
import { appsPath } from '../../src/model/tools/appsTool'
import { CONVERSATION_ID, JOINED_WORK_FOLDER } from '../../src/model/tools/testing'

// Whether `run` gives a value; false when it throws.
function takes(run: () => unknown): boolean {
  try {
    run()
    return true
  } catch {
    return false
  }
}

describe('dez-media workFile', () => {
  it('gives the file below the work folder of the run, and the path as the model gave it', () => {
    expect(workFile(JOINED_WORK_FOLDER, '/work/beats.json')).toStrictEqual({ path: `${JOINED_WORK_FOLDER}/beats.json`, shown: '/work/beats.json' })
    expect(workFile(JOINED_WORK_FOLDER, '/work/song/v2.beats.json')).toStrictEqual({ path: `${JOINED_WORK_FOLDER}/song/v2.beats.json`, shown: '/work/song/v2.beats.json' })
  })

  // A model reads the file with the apps tool, which must take its path.
  it('takes a path in /work/ when the apps tool takes it', () => {
    const paths = [
      '/work/a.json', '/work/x/y/z_1-2.json', '/work/../a.json', '/work/a/./b.json', '/work/a b.json', '/work/é.json', '/work//a.json',
      `/work/${'n'.repeat(100)}`, `/work/${'n'.repeat(101)}`, `/work/${Array(12).fill('d').join('/')}`, `/work/${Array(13).fill('d').join('/')}`,
    ]
    for (const path of paths) {
      expect(takes(() => workFile(JOINED_WORK_FOLDER, path)), path).toBe(takes(() => appsPath(path, 'save_to', CONVERSATION_ID)))
    }
  })

  it('refuses a path of another place, the work folder itself, and a folder', () => {
    for (const path of ['/apps/x/a.json', '/libs/a.json', '/workx/a.json', 'work/a.json', 'a.json', '/work', '/work/', '/work/data/']) {
      expect(() => workFile(JOINED_WORK_FOLDER, path), path).toThrow(RangeError)
    }
  })

  // `withoutLocalPaths` would hide `/work/home/x.json` from the model.
  it('refuses a name that Dez hides as the start of a path of the computer', () => {
    expect(() => workFile(JOINED_WORK_FOLDER, '/work/home/x.json')).toThrow(/"home"/)
    expect(() => workFile(JOINED_WORK_FOLDER, '/work/a/Users/x.json')).toThrow(/"Users"/)
  })
})

describe('dez-media resultJson', () => {
  it('puts each field on a line, each object of a list on a line, and a list of numbers on one line', () => {
    const value = { id: 'a', bpm: 129.04, beats: [0.012, 0.488], cuts: [{ time: 1, score: 0.9 }, { time: 2, score: 0.8 }], range: { from: 0, to: 1 }, none: [] }
    expect(resultJson(value)).toBe([
      '{',
      '  "id": "a",',
      '  "bpm": 129.04,',
      '  "beats": [0.012,0.488],',
      '  "cuts": [',
      '    {"time":1,"score":0.9},',
      '    {"time":2,"score":0.8}',
      '  ],',
      '  "range": {"from":0,"to":1},',
      '  "none": []',
      '}',
      '',
    ].join('\n'))
    expect(JSON.parse(resultJson(value))).toStrictEqual(value)
  })

  it('leaves out a field with no value, as JSON does, and writes any other value on one line', () => {
    expect(resultJson({ first: null, peak: undefined })).toBe('{\n  "first": null\n}\n')
    expect(resultJson({})).toBe('{}\n')
    expect(resultJson([1, 2])).toBe('[1,2]\n')
    expect(resultJson('text')).toBe('"text"\n')
  })
})

describe('dez-media roundTo', () => {
  it('rounds to the digits after the point, a half up', () => {
    expect(roundTo(1.23456, 3)).toBe(1.235)
    expect(roundTo(129.0449, 2)).toBe(129.04)
    expect(roundTo(2.5, 0)).toBe(3)
    expect(roundTo(-17.44, 1)).toBe(-17.4)
  })
})
