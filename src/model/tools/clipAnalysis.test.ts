import { describe, expect, it } from 'vitest'
import { blackIntervals, clipChecksArgs, cutTimes, frameCompareArgs, frozenIntervals, loudnessCurve, silenceIntervals } from './clipAnalysis'

describe('cutTimes', () => {
  // Lines of a real `SCENE_CUT_FILTER` run (ffmpeg 8) on a clip of 24 fps
  // with cuts at 3, 5, and 7 s, between lines of other parts of the run.
  it('reads the time of each cut, in order, and nothing from the other lines', () => {
    const log = [
      '[Parsed_scdet_0 @ 0xffff8c0b2a60] lavfi.scd.score: 21.747, lavfi.scd.time: 3',
      '[out#0/null @ 0xffff8c0a1b00] video:2KiB audio:0KiB',
      '[Parsed_scdet_0 @ 0xffff8c0b2a60] lavfi.scd.score: 27.512, lavfi.scd.time: 5.041667',
      '[Parsed_showinfo_1 @ 0xffff8c0b2b20] n:   0 pts:  2560 pts_time:6',
      '[Parsed_scdet_0 @ 0xffff8c0b2a60] lavfi.scd.score: 25.391, lavfi.scd.time: 7',
    ].join('\n')
    expect(cutTimes(log)).toStrictEqual([3, 5.041667, 7])
  })

  it('reads no cut from the log of a clip of one shot', () => {
    expect(cutTimes('[out#0/null @ 0xffff8c0a1b00] video:2KiB audio:0KiB')).toStrictEqual([])
  })
})

describe('clipChecksArgs', () => {
  const HD = { width: 1920, height: 1080 }
  const ffmpegArgs = (graph: string, maps: string[], beforeInput: string[] = []) => [
    '-nostdin', '-hide_banner', '-v', 'warning', '-stats', '-v', 'info', ...beforeInput, '-i', 'clip.mp4',
    '-filter_complex', graph, ...maps.flatMap((map) => ['-map', map]), '-f', 'null', '-',
  ]

  it('puts the checks of the picture and of the sound into one chain each, in the order of the checks', () => {
    expect(clipChecksArgs('clip.mp4', ['loudness_curve', 'black', 'silence', 'frozen'], HD)).toStrictEqual(ffmpegArgs(
      '[0:v:0]blackdetect=d=0,freezedetect=d=1[v];[0:a:0]silencedetect=n=-60dB:d=1,ebur128=framelog=info[a]',
      ['[v]', '[a]'],
    ))
  })

  it('reads only the stream that the checks need', () => {
    expect(clipChecksArgs('clip.mp4', ['silence'], null)).toStrictEqual(ffmpegArgs('[0:a:0]silencedetect=n=-60dB:d=1[a]', ['[a]']))
    expect(clipChecksArgs('clip.mp4', ['black'], HD)).toStrictEqual(ffmpegArgs('[0:v:0]blackdetect=d=0[v]', ['[v]']))
  })

  // ffmpeg's x86 SIMD code gives frozen parts at random for these pictures
  // (`frameCompareArgs`).
  it('turns the SIMD code of ffmpeg off for a check that compares the frames of a small picture', () => {
    const small = { width: 48, height: 36 }
    const noSimd = ['-cpuflags', '0']
    expect(clipChecksArgs('clip.mp4', ['frozen'], small)).toStrictEqual(ffmpegArgs('[0:v:0]freezedetect=d=1[v]', ['[v]'], noSimd))
    expect(clipChecksArgs('clip.mp4', ['frozen', 'silence'], small)).toStrictEqual(ffmpegArgs(
      '[0:v:0]freezedetect=d=1[v];[0:a:0]silencedetect=n=-60dB:d=1[a]',
      ['[v]', '[a]'],
      noSimd,
    ))
    // `blackdetect` and the sound filters compare no frames.
    expect(clipChecksArgs('clip.mp4', ['black', 'silence'], small)).not.toContain('-cpuflags')
  })
})

describe('frameCompareArgs', () => {
  it('turns the SIMD code of ffmpeg off only for a picture with a side under 256 px', () => {
    expect(frameCompareArgs({ width: 255, height: 1080 })).toStrictEqual(['-cpuflags', '0'])
    expect(frameCompareArgs({ width: 1920, height: 255 })).toStrictEqual(['-cpuflags', '0'])
    expect(frameCompareArgs({ width: 256, height: 256 })).toStrictEqual([])
  })
})

// The lines below are lines of real runs of `clipChecksArgs` (ffmpeg 8) on
// a clip of 10.04 s at 24 fps, black from 2 to 3 s and for one frame at
// 8 s, with the same picture from 2 to 5 s, and silent from 2 to 4 s. Two
// lines are added by hand: the black part that starts before 0 s, and the
// frozen part at 9 s, which has no end line, as a part that lasts to the
// end of the clip has none.
describe('blackIntervals', () => {
  it('reads each black part, a part of one frame too', () => {
    const log = [
      '[Parsed_blackdetect_0 @ 0xffffa1667d90] black_start:2 black_end:3 black_duration:1',
      '[Parsed_freezedetect_1 @ 0xffffa1667e50] lavfi.freezedetect.freeze_start: 2',
      '[Parsed_blackdetect_0 @ 0xffffa1667d90] black_start:8 black_end:8.083333 black_duration:0.083333',
    ].join('\n')
    expect(blackIntervals(log)).toStrictEqual([{ start: 2, end: 3 }, { start: 8, end: 8.083333 }])
  })

  it('puts a start before the clip at 0 s', () => {
    expect(blackIntervals('[Parsed_blackdetect_0 @ 0x1] black_start:-0.02 black_end:1.5 black_duration:1.52'))
      .toStrictEqual([{ start: 0, end: 1.5 }])
  })
})

describe('frozenIntervals', () => {
  it('reads each frozen part, and a part with no end line lasts to the end of the clip', () => {
    const log = [
      '[Parsed_freezedetect_1 @ 0xffffa1667e50] lavfi.freezedetect.freeze_start: 2',
      '[Parsed_freezedetect_1 @ 0xffffa1667e50] lavfi.freezedetect.freeze_duration: 1',
      '[Parsed_freezedetect_1 @ 0xffffa1667e50] lavfi.freezedetect.freeze_end: 3',
      '[Parsed_freezedetect_1 @ 0xffffa1667e50] lavfi.freezedetect.freeze_start: 3.041667',
      '[Parsed_freezedetect_1 @ 0xffffa1667e50] lavfi.freezedetect.freeze_duration: 1.958333',
      '[Parsed_freezedetect_1 @ 0xffffa1667e50] lavfi.freezedetect.freeze_end: 5',
      '[Parsed_freezedetect_1 @ 0xffffa1667e50] lavfi.freezedetect.freeze_start: 9',
    ].join('\n')
    expect(frozenIntervals(log)).toStrictEqual([{ start: 2, end: 3 }, { start: 3.041667, end: 5 }, { start: 9, end: null }])
  })
})

describe('silenceIntervals', () => {
  it('reads each silent part, and not the lines of the other filters', () => {
    const log = [
      '[Parsed_silencedetect_3 @ 0xffffa1668090] silence_start: 2.014813',
      '[Parsed_ebur128_4 @ 0xffffad6000f0] t: 2.099979   TARGET:-23 LUFS    M:   nan S:-120.7     I: -21.0 LUFS       LRA:   0.0 LU',
      '[Parsed_silencedetect_3 @ 0xffffa1668090] silence_end: 3.998875 | silence_duration: 1.984062',
    ].join('\n')
    expect(silenceIntervals(log)).toStrictEqual([{ start: 2.014813, end: 3.998875 }])
  })
})

describe('loudnessCurve', () => {
  // A line of `ebur128=framelog=info` at the time `t` with the momentary
  // loudness `m`, as ffmpeg writes it.
  const line = (t: number, m: string) => `[Parsed_ebur128_4 @ 0xffffad6000f0] t: ${t - 0.000021}   TARGET:-23 LUFS    M:${m} S:-120.7     I: -21.0 LUFS       LRA:   0.0 LU`

  it('gives the mean energy of each second, without the steps before the window is full', () => {
    const log = [
      line(0.1, '-120.7'), line(0.2, '-120.7'), line(0.3, '-120.7'),
      ...[0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].map((t) => line(t, ' -20.0')),
      ...[1.1, 1.2, 1.3, 1.4, 1.5].map((t) => line(t, ' -20.0')),
      ...[1.6, 1.7, 1.8, 1.9, 2].map((t) => line(t, ' -30.0')),
      ...[2.1, 2.2, 2.3].map((t) => line(t, '   nan')),
    ].join('\n')
    const curve = loudnessCurve(log)
    expect(curve?.step).toBe(1)
    expect(curve?.values.map((value) => value?.toFixed(2))).toStrictEqual(['-20.00', '-22.60', '-Infinity'])
  })

  it('leaves out the steps before the window is full for a sound that starts after 0 s', () => {
    const log = [
      line(0.3, '-120.7'), line(0.4, '-120.7'), line(0.5, '-120.7'),
      ...[0.6, 0.7, 0.8, 0.9, 1].map((t) => line(t, ' -20.0')),
    ].join('\n')
    expect(loudnessCurve(log)?.values.map((value) => value?.toFixed(2))).toStrictEqual(['-20.00'])
  })

  // At 11025 Hz, ebur128 steps 1102 samples and fills its window of 4410
  // samples only at the fifth step.
  it('leaves out each step before the window is full, 4 of them at 11025 Hz', () => {
    const log = [
      ...[0.1, 0.2, 0.3, 0.4].map((t) => line(t, '-120.7')),
      ...[0.5, 0.6, 0.7, 0.8, 0.9, 1].map((t) => line(t, ' -20.0')),
    ].join('\n')
    expect(loudnessCurve(log)?.values.map((value) => value?.toFixed(2))).toStrictEqual(['-20.00'])
  })

  it('gives at most 120 values, one for each 3 s of a sound of 5 minutes', () => {
    const log = Array.from({ length: 3000 }, (_, index) => line((index + 1) / 10, ' -18.0')).join('\n')
    const curve = loudnessCurve(log)
    expect(curve?.step).toBe(3)
    expect(curve?.values).toHaveLength(100)
    expect(curve?.values.every((value) => value !== null && Math.abs(value + 18) < 1e-9)).toBe(true)
  })

  it('has one value for each second of a sound of 120 s', () => {
    const log = Array.from({ length: 1200 }, (_, index) => line((index + 1) / 10, ' -18.0')).join('\n')
    expect(loudnessCurve(log)?.values).toHaveLength(120)
  })

  it('has no curve for a sound shorter than the window', () => {
    expect(loudnessCurve([line(0.1, '-120.7'), line(0.2, '-120.7'), line(0.3, '-120.7')].join('\n'))).toBeNull()
  })
})
