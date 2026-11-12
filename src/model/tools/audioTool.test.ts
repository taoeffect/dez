import { describe, expect, it } from 'vitest'
import { mediaTagText, type MediaTagData } from '../chat/mediaTags'
import type { Section } from '../chat/types'
import { checkArgumentValues } from './arguments'
import { AUDIO_TOOL, audioClipId, audioClipOf, audioClipPart, audioCutResultText, audioLengthText } from './audioTool'
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

describe('audioClipPart', () => {
  it('gives no part for a call with no start and no end', () => {
    expect(audioClipPart('b', { clip: 'b' }, 30)).toBeNull()
  })

  it('starts at 0 with no start, and ends at the clip end with no end or an end past it', () => {
    expect(audioClipPart('b', { clip: 'b', end: 15 }, 30)).toStrictEqual({ start: 0, end: 15 })
    expect(audioClipPart('b', { clip: 'b', start: 12.5 }, 30)).toStrictEqual({ start: 12.5, end: 30 })
    expect(audioClipPart('b', { clip: 'b', start: 10, end: 45 }, 30)).toStrictEqual({ start: 10, end: 30 })
  })

  it('refuses a start before 0, an end that is not after the start, and a start at or past the clip end', () => {
    expect(errorOf(() => audioClipPart('b', { clip: 'b', start: -1 }, 30)))
      .toBe('"start" must be 0 or more. Give 0, or leave it out, to start at the start of the clip.')
    expect(errorOf(() => audioClipPart('b', { clip: 'b', start: 5, end: 5 }, 30))).toBe('"end" (5) must be after "start" (5).')
    expect(errorOf(() => audioClipPart('b', { clip: 'b', end: 0 }, 30))).toBe('"end" (0) must be after "start" (0).')
    expect(errorOf(() => audioClipPart('b', { clip: 'b', start: 12.3456 }, 12.3456)))
      .toBe('The audio clip @b is 12.35 seconds long, so "start" must be less than 12.35.')
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
