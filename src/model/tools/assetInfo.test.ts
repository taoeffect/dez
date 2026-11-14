import { describe, expect, it } from 'vitest'
import { assetInfoChecks, assetInfoLine, assetInfoText, assetOriginText, checkLines, checksFailedLine, fittingChecks, MAX_CHECK_ITEMS } from './assetInfo'
import { ToolError } from './types'

describe('assetOriginText', () => {
  it('names the user or the model', () => {
    expect(assetOriginText({ kind: 'user' })).toBe('from the user')
    expect(assetOriginText({ kind: 'model', model: { providerId: 'venice', modelId: 'flux-2' } })).toBe('made by the model venice/flux-2')
    expect(assetOriginText({ kind: 'model', model: null })).toBe('made by a model')
  })

  it('names a job with its number and its call when they are known', () => {
    expect(assetOriginText({ kind: 'job', tool: 'model_invoke', number: 3, label: 'scene 3: the fox runs…' })).toBe('made by the model_invoke job 3 of its reply: "scene 3: the fox runs…"')
    expect(assetOriginText({ kind: 'job', tool: 'video', number: null, label: '' })).toBe('made by a job of the video tool')
  })

  it('names the tool of a call', () => {
    expect(assetOriginText({ kind: 'call', tool: 'image', label: 'crop {\'image\':\'a\'}' })).toBe('made by the image tool: "crop {\'image\':\'a\'}"')
    expect(assetOriginText({ kind: 'call', tool: 'audio', label: '' })).toBe('made by the audio tool')
  })
})

describe('assetInfoLine', () => {
  it('gives the id, the kind, the facts, the place, and the origin', () => {
    expect(assetInfoLine('f', 'video', 'MP4 | 5.04 s', { hidden: true, origin: { kind: 'job', tool: 'model_invoke', number: 2, label: 'scene 2' } }))
      .toBe('@f | video | MP4 | 5.04 s | hidden | made by the model_invoke job 2 of its reply: "scene 2"')
    expect(assetInfoLine('a', 'image', 'PNG', { hidden: false, origin: { kind: 'user' } })).toBe('@a | image | PNG | shown | from the user')
  })
})

describe('assetInfoChecks', () => {
  it('reads the checks in any order, case, and separator, in the order of a result', () => {
    expect(assetInfoChecks({ assets: '@a', checks: 'Cuts, silence  BLACK,loudness_curve frozen cuts' }))
      .toStrictEqual(['black', 'frozen', 'silence', 'loudness_curve', 'cuts'])
  })

  it('has no check for a blank or absent `checks`', () => {
    expect(assetInfoChecks({ assets: '@a', checks: ' , ' })).toStrictEqual([])
    expect(assetInfoChecks({ assets: '@a' })).toStrictEqual([])
  })

  it('refuses a word that is no check, and names the checks', () => {
    expect(() => assetInfoChecks({ assets: '@a', checks: 'black loudness freeze loudness' })).toThrow(new ToolError(
      'Unknown values "loudness", "freeze" in `checks`. Use any of: black, frozen, silence, loudness_curve, cuts. Dez read no facts.',
    ))
  })
})

describe('checkLines', () => {
  const both = { picture: true, sound: true }

  it('gives a line for each check with what the log of its run tells', () => {
    const log = [
      '[Parsed_blackdetect_0 @ 0x1] black_start:2 black_end:3 black_duration:1',
      '[Parsed_blackdetect_0 @ 0x1] black_start:8 black_end:8.0833333 black_duration:0.0833333',
      '[Parsed_freezedetect_1 @ 0x2] lavfi.freezedetect.freeze_start: 9',
      '[Parsed_scdet_2 @ 0x3] lavfi.scd.score: 41.855, lavfi.scd.time: 2',
      '[Parsed_scdet_2 @ 0x3] lavfi.scd.score: 38.1, lavfi.scd.time: 3',
      ...[0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8].map((t) => `[Parsed_ebur128_4 @ 0x4] t: ${t}   TARGET:-23 LUFS    M:${t < 0.9 ? ' -21.8' : '   nan'} S:-120.7`),
    ].join('\n')
    expect(checkLines(['black', 'frozen', 'silence', 'loudness_curve', 'cuts'], both, log)).toStrictEqual([
      '  black: 2 s to 3 s, 8 s to 8.083 s',
      '  frozen: 9 s to the end',
      '  silence: none',
      '  loudness_curve: -21.8, -inf LUFS, one value for each second from 0 s (-inf: no sound at all)',
      '  cuts: 2, 3 s',
    ])
  })

  it('names the step of a long curve, and tells why a sound has no curve', () => {
    const curve = Array.from({ length: 1300 }, (_, index) => `[Parsed_ebur128_0 @ 0x4] t: ${(index + 1) / 10}   TARGET:-23 LUFS    M: -18.0 S:-120.7`).join('\n')
    expect(checkLines(['loudness_curve'], both, curve)[0]).toMatch(/^ {2}loudness_curve: -18, -18, .*, -18 LUFS, one value for each 2 s from 0 s$/)
    expect(checkLines(['loudness_curve'], both, '')).toStrictEqual(['  loudness_curve: none: the sound is shorter than 0.4 s'])
  })

  it(`shows at most ${MAX_CHECK_ITEMS} items of a check, and counts the others`, () => {
    const log = Array.from({ length: MAX_CHECK_ITEMS + 2 }, (_, index) => `[Parsed_scdet_0 @ 0x3] lavfi.scd.score: 20, lavfi.scd.time: ${index + 1}`).join('\n')
    expect(checkLines(['cuts'], both, log)[0]).toMatch(/^ {2}cuts: 1, 2, .*, 49, 50 s, and 2 more$/)
  })

  it('tells which stream a clip lacks for the checks that do not fit it', () => {
    const streams = { picture: false, sound: true }
    expect(fittingChecks(['black', 'silence', 'cuts'], streams)).toStrictEqual(['silence'])
    expect(checkLines(['black', 'silence', 'cuts'], streams, '')).toStrictEqual([
      '  black: no check, the clip has no picture',
      '  silence: none',
      '  cuts: no check, the clip has no picture',
    ])
    expect(checkLines(['silence'], { picture: true, sound: false }, '')).toStrictEqual(['  silence: no check, the clip has no sound'])
  })
})

describe('checksFailedLine', () => {
  it('tells a model to check only the sound when a run with picture checks took too long', () => {
    expect(checksFailedLine({ kind: 'timedOut' }, ['frozen', 'silence'])).toContain('check only its sound (`silence`, `loudness_curve`)')
    expect(checksFailedLine({ kind: 'timedOut' }, ['silence'])).not.toContain('check only its sound')
  })
})

describe('assetInfoText', () => {
  it('tells where the check lines are only when the call has checks', () => {
    const line = '@a | audio | WAV | 2 s | shown | from the user'
    expect(assetInfoText([line], [])).toBe(`Each line: id | kind | format and facts | shown, or hidden in the panel of its call's chip | who made it.\n${line}`)
    expect(assetInfoText([line, '  silence: none'], ['silence']).split('\n')[0]).toMatch(/Under the line of a clip: a line for each check, with times in seconds of the clip\.$/)
  })
})
