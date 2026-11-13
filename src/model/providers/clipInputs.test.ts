import { describe, expect, it } from 'vitest'
import type { MediaTagKind } from '../chat/mediaTags'
import { clipFileProblem, clipTagProblem, cloneInputClipRules, maxInputClips, missingClipProblem, needsWavCopy, type ClipAttachment, type ClipKindRules, type InputClipRules, type ReadInputClip } from './clipInputs'

const MP3_OR_WAV: ClipKindRules = { use: 'reference', maxClips: 2, types: ['audio/mpeg', 'audio/wav'] }

// Up to 2 MP3 or WAV audio clips and 1 MP4 video clip, as references.
const REFERENCES: InputClipRules = {
  audio: MP3_OR_WAV,
  video: { use: 'reference', maxClips: 1, types: ['video/mp4'] },
}

const clip = (kind: MediaTagKind, id: string, type = kind === 'audio' ? 'audio/mpeg' : 'video/mp4'): ClipAttachment =>
  ({ kind, id, type, src: `assets/generated/${kind}/${id}`, url: null, expires: null })

describe('needsWavCopy', () => {
  it('copies an audio clip to WAV when the model does not take its type and takes WAV', () => {
    expect(needsWavCopy('audio', MP3_OR_WAV, 'audio/ogg')).toBe(true)
  })

  it.each<[string, MediaTagKind, ClipKindRules, string]>([
    ['an audio clip of a type that the model takes', 'audio', MP3_OR_WAV, 'audio/MP3'],
    ['an audio clip of another name of a type that the model takes', 'audio', { use: 'source', types: ['audio/wav', 'audio/flac', 'audio/mp4'] }, 'audio/x-flac'],
    ['an audio clip to a model that takes any type', 'audio', { use: 'reference' }, 'audio/ogg'],
    ['an audio clip to a model that takes no WAV', 'audio', { use: 'reference', types: ['audio/mpeg'] }, 'audio/ogg'],
    // Dez converts no video.
    ['a video clip', 'video', { use: 'reference', types: ['video/mp4', 'audio/wav'] }, 'video/webm'],
  ])('makes no copy of %s', (_name, kind, rules, type) => {
    expect(needsWavCopy(kind, rules, type)).toBe(false)
  })
})

describe('maxInputClips', () => {
  it.each<[string, InputClipRules | undefined, number]>([
    ['the limit of the kind', REFERENCES, 2],
    ['no limit when the rules of the kind tell none', { audio: { use: 'voice' } }, Infinity],
    ['no clip of a kind with no rules', { video: REFERENCES.video }, 0],
    ['no clip to a model with no clip rules', undefined, 0],
  ])('gives %s', (_name, rules, max) => {
    expect(maxInputClips(rules, 'audio')).toBe(max)
  })
})

describe('cloneInputClipRules', () => {
  it('copies the rules and shares no object with them', () => {
    const rules: InputClipRules = { audio: { use: 'reference', types: ['audio/mpeg'] }, video: { use: 'reference', types: ['video/mp4'] }, audioNeedsVisual: true }
    const copy = cloneInputClipRules(rules)

    expect(copy).toStrictEqual(rules)

    copy.audio?.types?.push('audio/wav')
    copy.video?.types?.push('video/webm')
    if (copy.audio) copy.audio.maxClips = 1

    expect(rules).toStrictEqual({ audio: { use: 'reference', types: ['audio/mpeg'] }, video: { use: 'reference', types: ['video/mp4'] }, audioNeedsVisual: true })
  })
})

describe('missingClipProblem', () => {
  it('lets a model that changes or writes down a clip go with a clip of its kind, and every other model go with none', () => {
    expect([
      missingClipProblem('Edit', 'videoToVideo', [clip('audio', 'a'), clip('video', 'b')]),
      missingClipProblem('Voice', 'voiceChange', [clip('audio', 'a')]),
      missingClipProblem('Whisper', 'transcription', [clip('audio', 'a')]),
      missingClipProblem('Film', 'imageToVideo', []),
    ]).toStrictEqual([null, null, null, null])
  })

  it('tells which clip the model needs when the message has none of its kind', () => {
    expect([
      missingClipProblem('Edit', 'videoToVideo', [clip('audio', 'a')]),
      missingClipProblem('Whisper', 'transcription', [clip('video', 'b')]),
    ]).toStrictEqual([
      'Edit makes a new video from a video clip, and this message has no video clip. Paste or drop a video clip into the message, or name one with @id.',
      'Whisper writes down the speech of an audio clip, and this message has no audio clip. Paste or drop an audio clip into the message, or name one with @id.',
    ])
  })
})

describe('clipTagProblem', () => {
  it('finds no problem in clips that the model takes', () => {
    expect([
      clipTagProblem('Film', REFERENCES, [clip('audio', 'a1'), clip('audio', 'a2', 'audio/wav'), clip('video', 'v1')], 0),
      clipTagProblem('Film', undefined, [], 0),
    ]).toStrictEqual([null, null])
  })

  it('names the limit and the count when the message names too many clips of a kind', () => {
    const problem = clipTagProblem('Film', REFERENCES, [clip('video', 'v1'), clip('video', 'v2')], 0)

    expect(problem).toContain('takes only 1 video clip')
    expect(problem).toContain('has 2')
  })

  it('refuses each clip of a kind that the model has no rules for', () => {
    const problem = clipTagProblem('Film', { video: REFERENCES.video }, [clip('audio', 'a1'), clip('audio', 'a2')], 0)

    expect(problem).toContain('takes no audio clip')
    expect(problem).toContain('2 audio clips')
  })

  it.each<[string, InputClipRules, ClipAttachment]>([
    ['a video clip of another type', REFERENCES, clip('video', 'v1', 'video/quicktime')],
    ['an audio clip of another type, to a model that takes no WAV', { audio: { use: 'reference', types: ['audio/mpeg'] } }, clip('audio', 'a1', 'audio/ogg')],
  ])('refuses %s, and names its type', (_name, rules, refused) => {
    expect(clipTagProblem('Film', rules, [refused], 0)).toContain(`@${refused.id} is ${refused.type}`)
  })

  it('lets an audio clip of another type go as a WAV copy, when the model takes WAV', () => {
    expect(clipTagProblem('Film', REFERENCES, [clip('audio', 'a1', 'audio/ogg')], 0)).toBeNull()
  })

  describe('a model that takes audio only together with an image or a video', () => {
    const rules: InputClipRules = { ...REFERENCES, audioNeedsVisual: true }

    it('refuses an audio clip with no image and no video clip', () => {
      expect(clipTagProblem('Film', rules, [clip('audio', 'a1')], 0)).toContain('together with a reference image or video')
    })

    it.each<[string, ClipAttachment[], number]>([
      ['an image', [clip('audio', 'a1')], 1],
      ['a video clip', [clip('audio', 'a1'), clip('video', 'v1')], 0],
      ['no audio clip', [clip('video', 'v1')], 0],
    ])('lets the clips go with %s', (_name, clips, imageCount) => {
      expect(clipTagProblem('Film', rules, clips, imageCount)).toBeNull()
    })
  })

  describe('a model that takes each audio clip as the voice of one reference', () => {
    const rules: InputClipRules = { audio: { use: 'voice' }, video: { use: 'reference' } }

    it('refuses more audio clips than images and video clips, and names both counts', () => {
      const problem = clipTagProblem('Wan', rules, [clip('audio', 'a1'), clip('audio', 'a2')], 1)

      expect(problem).toContain('2 audio clips')
      expect(problem).toContain('1 image or video clip')
    })

    it('lets one audio clip go for each image and video clip', () => {
      expect(clipTagProblem('Wan', rules, [clip('audio', 'a1'), clip('audio', 'a2'), clip('video', 'v1')], 1)).toBeNull()
    })
  })

  describe('a model that takes clips only by their web address', () => {
    const rules: InputClipRules = { audio: { use: 'reference', urlOnly: true }, video: { use: 'reference', urlOnly: true } }
    const EXPIRES = '2026-11-12T10:00:00.000Z'
    const madeClip = (kind: MediaTagKind, url: string, expires: string | null = EXPIRES): ClipAttachment => ({ ...clip(kind, 'm1'), url, expires })

    it('lets a clip go while its https address works, also with no expiry time', () => {
      expect(clipTagProblem('Wan', rules, [madeClip('video', 'https://cdn.example.com/v.mp4')], 0, Date.parse(EXPIRES) - 1)).toBeNull()
      expect(clipTagProblem('Wan', rules, [madeClip('audio', 'https://cdn.example.com/a.mp3', null)], 1)).toBeNull()
    })

    it.each<[string, ClipAttachment, string]>([
      ['a clip that is only a file', clip('video', 'm1'), '@m1 has none: Dez has it only as a file'],
      ['a clip whose address is not https', madeClip('video', 'http://cdn.example.com/v.mp4'), 'the web address of @m1 is not https'],
      ['a clip whose address expired', madeClip('audio', 'https://cdn.example.com/a.mp3'), 'the web address of @m1 has expired'],
    ])('refuses %s, and tells why', (_name, refused, reason) => {
      expect(clipTagProblem('Wan', rules, [refused], 1, Date.parse(EXPIRES))).toContain(reason)
    })
  })
})

describe('clipFileProblem', () => {
  const MB = 1024 * 1024
  const LIMITS: InputClipRules = {
    audio: { use: 'reference', minSeconds: 2, maxSeconds: 30, maxBytes: MB },
    video: { use: 'reference', maxSeconds: 10, maxBytes: 10 * MB },
  }
  const TOTALS: InputClipRules = {
    audio: { use: 'reference', maxTotalSeconds: 30 },
    video: { use: 'reference', maxTotalSeconds: 15 },
  }
  const read = (kind: MediaTagKind, id: string, seconds: number | null, byteLength = 1000): ReadInputClip => ({ clip: clip(kind, id), seconds, byteLength })

  it('finds no problem in clips within every limit, at both ends of each', () => {
    expect([
      clipFileProblem('Film', LIMITS, [read('audio', 'a1', 2, MB), read('audio', 'a2', 30), read('video', 'v1', 10, 10 * MB)]),
      clipFileProblem('Film', TOTALS, [read('audio', 'a1', 20), read('audio', 'a2', 10), read('video', 'v1', 15)]),
    ]).toStrictEqual([null, null])
  })

  it('names the size and the limit of a clip that is too large', () => {
    const problem = clipFileProblem('Film', LIMITS, [read('audio', 'a1', 5, 1.5 * MB)])

    expect(problem).toContain('1.5 MB')
    expect(problem).toContain('1.0 MB')
  })

  // A WAV copy is large because its clip is long: the length is the cause
  // that the user can fix.
  it('names the length, not the size, of a clip that is both too long and too large', () => {
    const problem = clipFileProblem('Film', LIMITS, [read('audio', 'a1', 90, 1.5 * MB)])

    expect(problem).toContain('@a1 is 90 seconds long')
    expect(problem).not.toContain('1.5 MB')
  })

  it('names a WAV copy that is too large as Dez\'s copy, not as the clip', () => {
    const problem = clipFileProblem('Film', LIMITS, [{ clip: clip('audio', 'a1', 'audio/ogg'), seconds: 5, byteLength: 1.5 * MB, wavCopy: true }])

    expect(problem).toContain('WAV copy')
    expect(problem).toContain('The copy is 1.5 MB')
    expect(problem).not.toContain('@a1 is 1.5 MB')
  })

  // A length that breaks a limit is rounded away from it, so the two
  // numbers of the text never look the same.
  it.each<[string, ReadInputClip, string, string]>([
    ['too long', read('video', 'v1', 12.34), '12.4 seconds', 'at most 10 seconds'],
    ['too short', read('audio', 'a1', 1), '1 second', 'at least 2 seconds'],
    ['too long by less than 0.05 s', read('video', 'v1', 10.04), '10.1 seconds', 'at most 10 seconds'],
    ['too short by less than 0.05 s', read('audio', 'a1', 1.96), '1.9 seconds', 'at least 2 seconds'],
  ])('names the length and the limit of a clip that is %s', (_name, input, length, limit) => {
    const problem = clipFileProblem('Film', LIMITS, [input])

    expect(problem).toContain(`@${input.clip.id} is ${length} long`)
    expect(problem).toContain(limit)
  })

  // Cutting is the fix only for an audio clip that is too long: Dez cuts no
  // video.
  it('tells the user to cut an audio clip that is too long with the audio tool', () => {
    expect([
      clipFileProblem('Film', LIMITS, [read('audio', 'a1', 31)])?.includes('audio tool'),
      clipFileProblem('Film', LIMITS, [read('audio', 'a1', 1)])?.includes('audio tool'),
      clipFileProblem('Film', LIMITS, [read('video', 'v1', 11)])?.includes('audio tool'),
    ]).toStrictEqual([true, false, false])
  })

  // The model that called `model_invoke` has the audio tool itself, and
  // its inputs are the clips that its prompt names.
  it('tells a model to cut the clip itself, and names its prompt, not a message', () => {
    const problems = [
      clipFileProblem('Film', LIMITS, [read('audio', 'a1', 31)], 'model'),
      clipFileProblem('Film', TOTALS, [read('audio', 'a1', 20), read('audio', 'a2', 15)], 'model'),
    ]

    expect(problems[0]).toContain('Cut it with the audio tool')
    for (const problem of problems) {
      expect(problem).toMatch(/prompt/)
      expect(problem).not.toMatch(/\b(message|chat model)\b/)
    }
  })

  it.each([
    ['5 seconds', 15, '35 seconds'],
    ['less than 0.05 s', 10.02, '30.1 seconds'],
  ])('names the total length and the limit of the clips of a kind that are too long together by %s', (_name, second, total) => {
    const problem = clipFileProblem('Film', TOTALS, [read('audio', 'a1', 20), read('audio', 'a2', second)])

    expect(problem).toContain(`are ${total} long together`)
    expect(problem).toContain('at most 30 seconds')
  })

  it('counts each kind against its own total', () => {
    expect(clipFileProblem('Film', TOTALS, [read('audio', 'a1', 25), read('video', 'v1', 10)])).toBeNull()
  })

  // The provider's answer tells the user when such a clip breaks a limit.
  it('checks no length of a clip whose length Dez could not tell', () => {
    expect([
      clipFileProblem('Film', LIMITS, [read('audio', 'a1', null)]),
      clipFileProblem('Film', TOTALS, [read('audio', 'a1', 25), read('audio', 'a2', null)]),
    ]).toStrictEqual([null, null])
  })

  it('still checks the size of a clip whose length Dez could not tell', () => {
    expect(clipFileProblem('Film', LIMITS, [read('video', 'v1', null, 11 * MB)])).toContain('11.0 MB')
  })
})
