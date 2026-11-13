import { describe, expect, it } from 'vitest'
import { MAX_SAVED_CLIP_BYTES } from '../chat/mediaFiles'
import { mediaTagText, type MediaTagData } from '../chat/mediaTags'
import type { Section } from '../chat/types'
import { checkArgumentValues } from './arguments'
import {
  AUDIO_CUT_FILE,
  AUDIO_TOOL,
  audioClipId,
  audioClipOf,
  audioCutArgs,
  audioCutPart,
  audioCutRequest,
  audioCutResultText,
  audioEmptyCutText,
  audioLengthText,
  audioRunDetails,
  writtenAudioSeconds,
} from './audioTool'
import { ToolError } from './types'

const SONG: MediaTagData = { kind: 'audio', id: 'b', type: 'audio/mpeg', src: 'https://cdn.example/b.mp3', url: 'https://cdn.example/b.mp3', expires: null, other: [] }
const VIDEO: MediaTagData = { kind: 'video', id: 'c', type: 'video/mp4', src: null, url: null, expires: null, other: [] }
const IMAGE = '![/home/u/.config/dez/assets/images/red.png](id=a)'

function section(role: Section['role'], text: string): Section {
  return { id: crypto.randomUUID(), role, content: [{ kind: 'text', text }] }
}

function errorOf(call: () => unknown): string {
  try {
    call()
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError)
    return (error as ToolError).message
  }
  throw new Error('The call did not throw.')
}

describe('AUDIO_TOOL', () => {
  it('gives each subcommand an example that its parameters take', () => {
    for (const subcommand of AUDIO_TOOL.subcommands) {
      expect(checkArgumentValues(subcommand, subcommand.example).ok).toBe(true)
    }
  })
})

describe('audioClipId', () => {
  it('reads an id with or without @', () => {
    expect([audioClipId({ clip: 'b' }), audioClipId({ clip: ' @ab ' })]).toStrictEqual(['b', 'ab'])
  })

  it('refuses a text that is not an id', () => {
    for (const clip of ['B', '@', '', 'b1', 'clip b']) {
      expect(errorOf(() => audioClipId({ clip }))).toBe(`${JSON.stringify(clip)} is not a clip id. A clip id is lower-case letters, as in "b" or "@b".`)
    }
  })
})

describe('audioClipOf', () => {
  it('finds the newest audio tag with the id in the agent and the user sections', () => {
    const newer = { ...SONG, src: '/home/u/.config/dez/assets/generated/audio/b.mp3' }
    const pasted = { ...SONG, src: '/home/u/.config/dez/assets/audio/b.mp3', url: null }
    const sections = [
      section('user', 'Make a song.'),
      section('agent', `Here:\n${mediaTagText(SONG)}`),
      section('user', 'Again.'),
      section('agent', mediaTagText(newer)),
    ]
    expect(audioClipOf(sections, 'b')).toMatchObject(newer)
    expect(audioClipOf([...sections, section('user', `Cut this:\n${mediaTagText(pasted)}`)], 'b')).toMatchObject(pasted)
  })

  it('tells the model that an id names a video clip or an image', () => {
    const sections = [section('user', `Look: ${IMAGE}`), section('agent', mediaTagText(VIDEO))]
    expect(errorOf(() => audioClipOf(sections, 'c'))).toBe('@c is a video clip. The audio tool works on audio clips only.')
    expect(errorOf(() => audioClipOf(sections, 'a'))).toBe('@a is an image. The audio tool works on audio clips only.')
  })

  it('lists the audio clips, each once, for an id that names nothing', () => {
    const sections = [section('agent', `${mediaTagText(SONG)}\n${mediaTagText({ ...SONG, id: 'd' })}`), section('agent', mediaTagText(SONG))]
    expect(errorOf(() => audioClipOf(sections, 'e'))).toBe('No audio clip of this conversation has the id @e. Its audio clips are @b, @d: call again with one of these ids.')
  })
})

describe('audioCutRequest', () => {
  it('gives no part for a call with no start and no end', () => {
    expect(audioCutRequest({ clip: 'b' })).toBeNull()
  })

  it('starts at 0 with no start, and has no end with none', () => {
    expect(audioCutRequest({ clip: 'b', end: 15 })).toStrictEqual({ start: 0, end: 15 })
    expect(audioCutRequest({ clip: 'b', start: 12.5 })).toStrictEqual({ start: 12.5, end: null })
    expect(audioCutRequest({ clip: 'b', start: 10, end: 45 })).toStrictEqual({ start: 10, end: 45 })
  })

  it('refuses a start before 0, and an end that is not after the start', () => {
    expect(errorOf(() => audioCutRequest({ clip: 'b', start: -1 })))
      .toBe('"start" must be 0 or more. Give 0, or leave it out, to start at the start of the clip.')
    expect(errorOf(() => audioCutRequest({ clip: 'b', start: 5, end: 5 }))).toBe('"end" (5) must be after "start" (5).')
    expect(errorOf(() => audioCutRequest({ clip: 'b', end: 0 }))).toBe('"end" (0) must be after "start" (0).')
  })
})

describe('audioCutArgs', () => {
  // The value of the option `name` of a run; undefined with no such option.
  function option(args: string[], name: string): string | undefined {
    const at = args.indexOf(name)
    return at < 0 ? undefined : args[at + 1]
  }

  it('cuts the decoded audio of the clip file, from the start, for the length of the part', () => {
    const args = audioCutArgs('b.mp3', { start: 1.5, end: 4 })

    expect([option(args, '-i'), option(args, '-ss'), option(args, '-t')]).toStrictEqual(['b.mp3', '1.500000', '2.500000'])
    // An option before `-i` is one of the input: a seek there is not exact.
    expect(args.indexOf('-ss')).toBeGreaterThan(args.indexOf('-i'))
    expect(args.at(-1)).toBe(AUDIO_CUT_FILE.name)
  })

  it('gives no length for a part that ends at the end of the clip', () => {
    expect(audioCutArgs('b.mp3', { start: 12, end: null })).not.toContain('-t')
  })

  it('gives ffmpeg no time in the exponent form, and no length of less than a millisecond', () => {
    expect(option(audioCutArgs('b.mp3', { start: 1e21, end: null }), '-ss')).toBe('1000000000.000000')
    expect(option(audioCutArgs('b.mp3', { start: 1e-7, end: null }), '-ss')).toBe('0.000000')
    expect(option(audioCutArgs('b.mp3', { start: 1, end: 1.0000001 }), '-t')).toBe('0.001000')
  })

  it('lets the file grow only one byte past the most that Dez stores, so that a larger file tells a part that is too long', () => {
    expect(option(audioCutArgs('b.mp3', { start: 0, end: null }), '-fs')).toBe(String(MAX_SAVED_CLIP_BYTES + 1))
  })
})

describe('writtenAudioSeconds', () => {
  it('reads the last length of the progress output, also after a first line that was cut off', () => {
    const progress = 't_time_us=100000\nprogress=continue\nbitrate=1536.0kbits/s\nout_time_us=2500000\nout_time=00:00:02.500000\nprogress=end\n'

    expect(writtenAudioSeconds(progress)).toBe(2.5)
  })

  it('gives null for a run that wrote no audio', () => {
    expect(writtenAudioSeconds('bitrate=N/A\nout_time_us=N/A\nout_time=N/A\nprogress=end\n')).toBeNull()
    expect(writtenAudioSeconds('out_time_us=0\nprogress=end\n')).toBeNull()
    expect(writtenAudioSeconds('')).toBeNull()
  })
})

describe('audioCutPart', () => {
  it('ends the part where the cut ended, for a part with no end or with an end past the end of the clip', () => {
    expect(audioCutPart({ start: 1, end: 3.5 }, 2.5)).toStrictEqual({ start: 1, end: 3.5 })
    expect(audioCutPart({ start: 8, end: 60 }, 2)).toStrictEqual({ start: 8, end: 10 })
    expect(audioCutPart({ start: 8, end: null }, 2)).toStrictEqual({ start: 8, end: 10 })
  })
})

describe('error texts', () => {
  it('tell the length of a clip that has no audio from the start of the part on', () => {
    expect(audioEmptyCutText('b', 12.3456, 12.3456)).toBe('The audio clip @b is 12.35 seconds long, so "start" must be less than 12.35.')
    expect(audioEmptyCutText('b', 40, 10)).toBe('The audio clip @b is 10 seconds long, so "start" must be less than 10.')
    // A start in the last sample of the clip.
    expect(audioEmptyCutText('b', 9.99999, 10))
      .toBe('The audio clip @b is 10 seconds long, and it has no audio after second 9.99999. Call again with a smaller "start".')
  })

  it('tell how a failed run ended, with the end of its error output when there is one', () => {
    expect(audioRunDetails({ kind: 'exited', code: 183 }, '[in#0 @ 0x55] Error opening input: Invalid data found when processing input\n'))
      .toBe('ffmpeg ended with the error code 183. The end of its error output:\n[in#0 @ 0x55] Error opening input: Invalid data found when processing input')
    expect(audioRunDetails({ kind: 'exited', code: null }, ' \n')).toBe('The system ended ffmpeg.')
    expect(audioRunDetails({ kind: 'outputTooLarge' }, '')).toBe('Dez stopped ffmpeg: it wrote more than 8.0 MB of output.')
  })
})

describe('result texts', () => {
  it('give lengths and times in seconds to at most two decimals, and no path', () => {
    expect(audioLengthText('b', 30)).toBe('The audio clip @b is 30 seconds long. Give a start, an end, or both to make a new clip from a part of it.')
    expect(audioCutResultText('b', 'c', { start: 1.005, end: 16.25 }, 15.2449)).toBe(
      'Made the audio clip @c from @b, from second 1 to second 16.25. The audio clip @c is 15.24 seconds long.',
    )
  })
})
