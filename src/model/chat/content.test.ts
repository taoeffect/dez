import { describe, expect, it } from 'vitest'
import { plainLiveText, stripLiveSentinels } from './content'

// The live-doc markers (cmEditor.ts): a pill is OPEN + id + BODY + body +
// CLOSE, with NL for a line break of a collapsed body.
const SEP = '\u001E'
const OPEN = '\u{E000}'
const BODY = '\u{E001}'
const CLOSE = '\u{E002}'
const NL = '\u{E003}'

describe('plainLiveText', () => {
  const LIVE_TEXTS = [
    'no marker @a',
    `before ${OPEN}p1${BODY}one${NL}two @a${CLOSE} after @b`,
    `${OPEN}p1${BODY}${CLOSE}${OPEN}p2${BODY}x${CLOSE}`,
    // Broken pills: a header with no close, markers alone, a header that a
    // line break or another marker ends.
    `a${OPEN}id${BODY}b`,
    `a${CLOSE}b${BODY}c${OPEN}d${NL}e`,
    `a${OPEN}id\n${BODY}b${OPEN}x${OPEN}y${BODY}z`,
    `one\n${SEP}\ntwo`,
  ]

  it('gives the text of `stripLiveSentinels`', () => {
    expect(LIVE_TEXTS.map((text) => plainLiveText(text).text)).toStrictEqual(LIVE_TEXTS.map(stripLiveSentinels))
  })

  it('gives each char of the plain text its offset in the live text', () => {
    for (const live of LIVE_TEXTS) {
      const { text, liveOffset } = plainLiveText(live)
      const chars = [...text].map((_char, offset) => live[liveOffset(offset)].replace(NL, '\n'))

      expect(chars.join('')).toBe(text)
    }
  })

  it('keeps the offsets of a text with no marker', () => {
    const { text, liveOffset } = plainLiveText('see @a')

    expect([text, liveOffset(0), liveOffset(4)]).toStrictEqual(['see @a', 0, 4])
  })

  it('puts a char after the markers that come right before it', () => {
    const live = `x${OPEN}p1${BODY}@a${CLOSE}y`
    const { text, liveOffset } = plainLiveText(live)

    expect(text).toBe('x@ay')
    expect([0, 1, 2, 3].map(liveOffset)).toStrictEqual([0, live.indexOf('@'), live.indexOf('@') + 1, live.indexOf('y')])
  })
})
