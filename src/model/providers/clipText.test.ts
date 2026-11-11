import { describe, expect, it } from 'vitest'
import { clipText, clipTextProblem, cloneClipTextRules, type ClipTextRules } from './clipText'

const SONG: ClipTextRules = { minPromptLength: 10, maxPromptLength: 30, lyrics: { required: true, maxLength: 20 } }
const OPTIONAL_LYRICS: ClipTextRules = { lyrics: { required: false } }
const NO_LYRICS: ClipTextRules = { minPromptLength: 1, maxPromptLength: 30 }

describe('clipText', () => {
  it('splits the message at the first line that is only `Lyrics:`, and trims both parts', () => {
    expect(clipText(SONG, 'Slow piano ballad\n\nLyrics:\n[Verse]\nRain on the roof\n')).toStrictEqual({
      prompt: 'Slow piano ballad',
      lyrics: '[Verse]\nRain on the roof',
    })
  })

  it.each([
    ['in lower case', 'Jazz\nlyrics:\nLa la'],
    ['in upper case', 'Jazz\nLYRICS:\nLa la'],
    ['with spaces and tabs around it', 'Jazz\n \tLyrics: \t\nLa la'],
    ['with Windows line ends', 'Jazz\r\nLyrics:\r\nLa la'],
  ])('takes the line %s', (_name, text) => {
    expect(clipText(SONG, text)).toStrictEqual({ prompt: 'Jazz', lyrics: 'La la' })
  })

  // Lyrics can hold the word, and a second such line.
  it('keeps a later `Lyrics:` line in the lyrics', () => {
    expect(clipText(SONG, 'Jazz\nLyrics:\nLa la\nLyrics:\nLa')).toStrictEqual({ prompt: 'Jazz', lyrics: 'La la\nLyrics:\nLa' })
  })

  it.each([
    ['text after the colon on the line', 'Jazz\nLyrics: La la'],
    ['text before the word on the line', 'Jazz with Lyrics:\nLa la'],
    ['no colon', 'Jazz\nLyrics\nLa la'],
  ])('finds no lyrics in a message with %s', (_name, text) => {
    expect(clipText(SONG, text)).toStrictEqual({ prompt: text })
  })

  it('gives no lyrics, and the prompt with no `Lyrics:` line, when nothing comes after the line', () => {
    expect(clipText(SONG, 'Jazz\nLyrics:\n  \n')).toStrictEqual({ prompt: 'Jazz' })
  })

  it('gives an empty prompt to a message that starts with the line', () => {
    expect(clipText(SONG, 'Lyrics:\nLa la')).toStrictEqual({ prompt: '', lyrics: 'La la' })
  })

  // A speech text can hold the line: the model must speak it.
  it.each([
    ['takes no lyrics', NO_LYRICS],
    ['has no rules', undefined],
  ])('leaves the message whole for a model that %s', (_name, rules) => {
    expect(clipText(rules, 'Jazz\nLyrics:\nLa la')).toStrictEqual({ prompt: 'Jazz\nLyrics:\nLa la' })
  })
})

describe('clipTextProblem', () => {
  it('finds no problem in a text within every limit, at both ends of each', () => {
    expect([
      clipTextProblem('Song', SONG, { prompt: 'a'.repeat(10), lyrics: 'b'.repeat(20) }),
      clipTextProblem('Song', SONG, { prompt: 'a'.repeat(30), lyrics: 'b' }),
      clipTextProblem('Song', OPTIONAL_LYRICS, { prompt: '' }),
      clipTextProblem('Song', undefined, { prompt: '' }),
    ]).toStrictEqual([null, null, null, null])
  })

  it('tells how to write lyrics when the model needs them and the message has none', () => {
    expect(clipTextProblem('MiniMax Music', SONG, { prompt: 'Slow piano ballad' }))
      .toBe('MiniMax Music needs lyrics. Write the style, then a line "Lyrics:", then the lyrics.')
  })

  it.each([
    ['a prompt that is too short', NO_LYRICS, { prompt: '' }, 'Voice needs a prompt of at least 1 character. This one has 0.'],
    ['a prompt that is too long', NO_LYRICS, { prompt: 'a'.repeat(31) }, 'Voice takes a prompt of at most 30 characters. This one has 31.'],
    [
      'a style that is too short',
      SONG,
      { prompt: 'Jazz', lyrics: 'La la' },
      'Voice needs a prompt (the text before the "Lyrics:" line) of at least 10 characters. This one has 4.',
    ],
    [
      'a style that is too long',
      SONG,
      { prompt: 'a'.repeat(31), lyrics: 'La la' },
      'Voice takes a prompt (the text before the "Lyrics:" line) of at most 30 characters. This one has 31.',
    ],
    ['lyrics that are too long', SONG, { prompt: 'Slow piano ballad', lyrics: 'b'.repeat(21) }, 'Voice takes lyrics of at most 20 characters. These have 21.'],
  ])('names the limit and the length of %s', (_name, rules, text, message) => {
    expect(clipTextProblem('Voice', rules, text)).toBe(message)
  })

  // The user must write the lyrics before the length of the style counts.
  it('names the missing lyrics before a prompt length', () => {
    expect(clipTextProblem('Song', SONG, { prompt: 'Jazz' })).toContain('needs lyrics')
  })
})

describe('cloneClipTextRules', () => {
  it('shares no object with the rules', () => {
    const copy = cloneClipTextRules(SONG)
    if (copy.lyrics) copy.lyrics.required = false

    expect(SONG.lyrics).toStrictEqual({ required: true, maxLength: 20 })
  })
})
