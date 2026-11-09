import { describe, expect, it } from 'vitest'
import { readableThinking, readableThinkingRounds, sameThinking, thinkingField } from './thinking'
import type { SectionThinking } from './types'

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

describe('thinking copies', () => {
  const ROUNDS: SectionThinking = {
    text: 'Plan.Check the list.',
    replay: { kind: 'field', field: 'reasoning_content' },
    rounds: [
      { afterToolCall: 'call_1', from: 5, replay: { kind: 'anthropicBlocks', blocks: [{ type: 'redacted_thinking', data: 'enc' }], prefixHash: 'h' } },
      { afterToolCall: 'call_2', from: 20 },
    ],
  }

  // The store and the editor each keep a copy; a shared round would let one
  // change the other's replay.
  it('copies the rounds deeply, with no key for an absent replay', () => {
    const copy = thinkingField(ROUNDS).thinking

    expect(copy).toStrictEqual(ROUNDS)
    expect(copy?.rounds?.[0]).not.toBe(ROUNDS.rounds?.[0])
    expect(copy?.rounds?.[0].replay).not.toBe(ROUNDS.rounds?.[0].replay)
    expect(thinkingField({ text: 'x' }).thinking).toStrictEqual({ text: 'x' })
  })

  it('finds thinking with other rounds different', () => {
    const { rounds = [] } = ROUNDS
    expect(sameThinking(ROUNDS, thinkingField(ROUNDS).thinking)).toBe(true)
    expect(sameThinking(ROUNDS, { ...ROUNDS, rounds: rounds.slice(0, 1) })).toBe(false)
    expect(sameThinking(ROUNDS, { ...ROUNDS, rounds: [rounds[0], { ...rounds[1], from: 19 }] })).toBe(false)
    expect(sameThinking(ROUNDS, { ...ROUNDS, rounds: [rounds[0], { ...rounds[1], replay: { kind: 'field', field: 'reasoning' } }] })).toBe(false)
    expect(sameThinking({ text: 'a' }, { text: 'a', rounds: [{ afterToolCall: 'c', from: 1 }] })).toBe(false)
  })
})

describe('readableThinkingRounds', () => {
  const RULE = '─'.repeat(16)

  it('gives the text as it is with no later round', () => {
    expect(readableThinkingRounds('Plan.\n', [], false)).toStrictEqual(readableThinking('Plan.\n', false))
  })

  it('puts a rule line between rounds that show text, with no blank lines next to it', () => {
    expect(readableThinkingRounds('Plan.\n\nLook.\n\nDone.', [7, 13], false).text).toBe(`Plan.\n${RULE}\nLook.\n${RULE}\nDone.`)
    expect(readableThinkingRounds('Plan.Look.', [5], false).text).toBe(`Plan.\n${RULE}\nLook.`)
  })

  // A round with only a replay, or only encrypted lines, shows no text.
  it('draws no rule next to a round that shows no text', () => {
    expect(readableThinkingRounds('Look.', [0], false).text).toBe('Look.')
    expect(readableThinkingRounds('Plan.', [5, 5], false).text).toBe('Plan.')
    expect(readableThinkingRounds(`Plan.${ENCRYPTED}Done.`, [5, 5 + ENCRYPTED.length], false))
      .toStrictEqual({ text: `Plan.\n${RULE}\nDone.`, encryptedLines: 1, encryptedChars: ENCRYPTED.length })
  })

  // Only the last round streams, so a held-back tail of an earlier round
  // shows once a later round starts.
  it('gives each streamed text a prefix of the next one across a round start', () => {
    const full = 'Plan:\n- read\n\nNext:\n\n- write\n'
    const roundStart = 'Plan:\n- read\n\n'.length
    const finished = readableThinkingRounds(full, [roundStart], false).text
    expect(finished).toBe(`Plan:\n- read\n${RULE}\nNext:\n\n- write\n`)

    let shown = ''
    for (let end = 0; end <= full.length; end++) {
      const next = readableThinkingRounds(full.slice(0, end), end > roundStart ? [roundStart] : [], true).text
      expect(next.startsWith(shown), `streamed text after ${end} chars`).toBe(true)
      expect(finished.startsWith(next), `finished text after ${end} chars`).toBe(true)
      shown = next
    }
  })
})
