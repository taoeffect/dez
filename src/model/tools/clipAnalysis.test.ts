import { describe, expect, it } from 'vitest'
import { cutTimes } from './clipAnalysis'

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
