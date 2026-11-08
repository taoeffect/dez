import { describe, expect, it } from 'vitest'
import { readableThinking } from './thinking'

const ENCRYPTED = '__ENCRYPTED_REASONING__v1:{"format":"xai-responses-v1","items":[{"id":"rs_1","content":"QUJDRA=="}]}'
const ENCRYPTED_2 = '__ENCRYPTED_REASONING__v12:{"items":[]}'

describe('readableThinking', () => {
  it('gives a finished text with no encrypted line as it is', () => {
    for (const text of ['', 'Plan:\n\n- read\n- write', 'Ends with a newline\n', '\n\nStarts with blank lines', 'Last line __ENC']) {
      expect(readableThinking(text, false)).toStrictEqual({ text, encryptedLines: 0, encryptedChars: 0 })
    }
  })

  it('leaves out an encrypted line with the blank lines that set it apart', () => {
    expect(readableThinking(`Plan.\n\nMore.\n\n${ENCRYPTED}`, false))
      .toStrictEqual({ text: 'Plan.\n\nMore.', encryptedLines: 1, encryptedChars: ENCRYPTED.length })
    expect(readableThinking(`Plan.\n\n${ENCRYPTED}\n\nMore.`, false).text).toBe('Plan.\n\nMore.')
    expect(readableThinking(`${ENCRYPTED}\n\nMore.`, false).text).toBe('More.')
    expect(readableThinking(`Plan.\n\n${ENCRYPTED}\n\n`, false).text).toBe('Plan.')
  })

  it('gives empty text for a text that is only an encrypted line', () => {
    expect(readableThinking(ENCRYPTED, false)).toStrictEqual({ text: '', encryptedLines: 1, encryptedChars: ENCRYPTED.length })
    expect(readableThinking(`\n${ENCRYPTED}\n`, true)).toStrictEqual({ text: '', encryptedLines: 1, encryptedChars: ENCRYPTED.length })
  })

  it('counts each encrypted line and adds up their lengths', () => {
    expect(readableThinking(`A.\n\n${ENCRYPTED}\n\nB.\n${ENCRYPTED_2}\n${ENCRYPTED}`, false)).toStrictEqual({
      text: 'A.\n\nB.',
      encryptedLines: 3,
      encryptedChars: 2 * ENCRYPTED.length + ENCRYPTED_2.length,
    })
  })

  // Only the full marker (prefix, version digits, colon) at the start of a
  // line makes an encrypted line.
  it('keeps a marker inside a line and lines that are not the full marker', () => {
    for (const text of [
      `Quoted: ${ENCRYPTED}`,
      ` ${ENCRYPTED}`,
      '__ENCRYPTED_REASONING__v:{}',
      '__ENCRYPTED_REASONING__v1\nnext',
      '__ENCRYPTED_REA\nnext',
    ]) {
      expect(readableThinking(text, false)).toStrictEqual({ text, encryptedLines: 0, encryptedChars: 0 })
      expect(readableThinking(text, true).text).toBe(text)
    }
  })

  it('holds back a streaming last line that can still become the marker', () => {
    for (const tail of ['', '_', '__ENCRYPTED_REA', '__ENCRYPTED_REASONING__v', '__ENCRYPTED_REASONING__v12']) {
      expect(readableThinking(`Plan.\n\n${tail}`, true)).toStrictEqual({ text: 'Plan.', encryptedLines: 0, encryptedChars: 0 })
    }
    const growing = '__ENCRYPTED_REASONING__v1:{"ite'
    expect(readableThinking(`Plan.\n\n${growing}`, true))
      .toStrictEqual({ text: 'Plan.', encryptedLines: 1, encryptedChars: growing.length })
    expect(readableThinking('Plan.\n\n__ENCRYPTED_REAL', true).text).toBe('Plan.\n\n__ENCRYPTED_REAL')
    expect(readableThinking('Plan.\n\n__ENCRYPTED_REA', false).text).toBe('Plan.\n\n__ENCRYPTED_REA')
  })

  // The panel appends a text that starts with the shown one, which keeps the
  // user's selection; any other change replaces the whole text.
  it('gives each streamed text a prefix of the next one and of the finished one', () => {
    const full = `\n${ENCRYPTED_2}\n\nPlan:\n\n- read\n${ENCRYPTED}\n\n- write\n\n__ENCRYPTED_REA\n\n${ENCRYPTED}\n`
    const finished = readableThinking(full, false).text
    expect(finished).toBe('Plan:\n\n- read\n\n- write\n\n__ENCRYPTED_REA')

    let shown = ''
    for (let end = 0; end <= full.length; end++) {
      const next = readableThinking(full.slice(0, end), true).text
      expect(next.startsWith(shown), `streamed text after ${end} chars`).toBe(true)
      expect(finished.startsWith(next), `finished text after ${end} chars`).toBe(true)
      shown = next
    }
  })
})
