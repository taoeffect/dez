import { cloneJsonObject } from '../../utils/json'
import type { SectionThinking, ThinkingReplay, ThinkingRound } from './types'

function cloneThinkingReplay(replay: ThinkingReplay): ThinkingReplay {
  switch (replay.kind) {
    case 'field':
      return { kind: 'field', field: replay.field }
    case 'anthropicBlocks':
      return { kind: 'anthropicBlocks', blocks: replay.blocks.map((block) => ({ ...block })), prefixHash: replay.prefixHash }
    case 'reasoningDetails':
      return { kind: 'reasoningDetails', details: replay.details.map(cloneJsonObject), prefixHash: replay.prefixHash }
    case 'copilot':
      return { kind: 'copilot', opaque: replay.opaque, prefixHash: replay.prefixHash }
  }
}

function cloneThinkingRound(round: ThinkingRound): ThinkingRound {
  const { afterToolCall, from, replay } = round
  return replay ? { afterToolCall, from, replay: cloneThinkingReplay(replay) } : { afterToolCall, from }
}

/** For object spreads: `{ thinking }` with a copy, or `{}` without one,
 *  because a copy of a section must never write `thinking: undefined`. */
export function thinkingField(thinking: SectionThinking | undefined): { thinking?: SectionThinking } {
  if (!thinking) return {}
  const copy: SectionThinking = { text: thinking.text }
  if (thinking.replay) copy.replay = cloneThinkingReplay(thinking.replay)
  if (thinking.rounds) copy.rounds = thinking.rounds.map(cloneThinkingRound)
  return { thinking: copy }
}

/** Two absent values are equal. The store and the editor each keep their own
 *  copy (`thinkingField`), so this compares by value. The replays and rounds
 *  are compared as JSON: every copy keeps the key order of its source, and a
 *  false mismatch only costs one extra editor update. */
export function sameThinking(a: SectionThinking | undefined, b: SectionThinking | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.text === b.text &&
    JSON.stringify(a.replay) === JSON.stringify(b.replay) &&
    JSON.stringify(a.rounds) === JSON.stringify(b.rounds)
}

// Some servers (seen with a Grok model through Venice) write the encrypted
// reasoning into the reasoning text too: one line that starts with this
// marker, a version, and a colon, then a long JSON run with no spaces. The
// reply's replay holds the same data. The line stays in the stored text (a
// `field` or `copilot` replay sends the text back, so a change would change
// the request bytes and break the prompt cache); only the thinking panel
// leaves it out, as WebKit takes about half a second to wrap 80 KB with no
// break points.
const ENCRYPTED_MARKER_PREFIX = '__ENCRYPTED_REASONING__v'
// The regexes take the prefix as it is: it has no regex metacharacters.
const ENCRYPTED_MARKER = new RegExp(`${ENCRYPTED_MARKER_PREFIX}\\d+:`, 'y')
// A last line that the stream can still turn into the marker, past its
// fixed part. A shorter one is a prefix of `ENCRYPTED_MARKER_PREFIX`.
const ENCRYPTED_MARKER_SO_FAR = new RegExp(`${ENCRYPTED_MARKER_PREFIX}\\d*$`, 'y')

export interface ReadableThinking {
  /** The thinking text without its encrypted lines. */
  text: string
  /** How many encrypted lines `text` leaves out. */
  encryptedLines: number
  /** The total length of those lines. */
  encryptedChars: number
}

function startsEncryptedLine(text: string, at: number): boolean {
  ENCRYPTED_MARKER.lastIndex = at
  return ENCRYPTED_MARKER.test(text)
}

// The rest of the text from `at` (the last line) can still grow into the
// marker: it is empty, a prefix of the marker, or the marker up to its
// version digits.
function mayStartEncryptedLine(text: string, at: number): boolean {
  if (text.length - at <= ENCRYPTED_MARKER_PREFIX.length) return ENCRYPTED_MARKER_PREFIX.startsWith(text.slice(at))
  ENCRYPTED_MARKER_SO_FAR.lastIndex = at
  return ENCRYPTED_MARKER_SO_FAR.test(text)
}

/** The thinking text that the thinking panel shows: the text without each
 *  line that starts with the encrypted-reasoning marker, and without the
 *  blank lines that set such a line apart (before it, or after it when no
 *  readable text comes before it). A marker inside a line stays.
 *
 *  While the section `streaming`, the last line is held back when more text
 *  can still make it a marker line (an empty last line too), with the blank
 *  lines before it. So each result is a prefix of the result for the
 *  longer text, also after the stream ends, and the panel can append
 *  (which keeps the user's selection) instead of replacing its text. With
 *  no marker line, the result of a finished text is the text itself. */
export function readableThinking(text: string, streaming: boolean): ReadableThinking {
  let shown = ''
  // The text from here on is not yet copied to `shown` or left out.
  let keepFrom = 0
  // Where the blank lines before the current line start: the end of the
  // last readable or encrypted line.
  let gapStart = 0
  let shownReadableLine = false
  let gapFollowsEncryptedLine = false
  let encryptedLines = 0
  let encryptedChars = 0
  let lineStart = 0
  for (;;) {
    const newline = text.indexOf('\n', lineStart)
    const isLast = newline === -1
    const lineEnd = isLast ? text.length : newline
    if (startsEncryptedLine(text, lineStart)) {
      encryptedLines++
      encryptedChars += lineEnd - lineStart
      shown += text.slice(keepFrom, gapStart)
      keepFrom = lineEnd
      gapStart = lineEnd
      gapFollowsEncryptedLine = true
    } else if (isLast && (streaming ? mayStartEncryptedLine(text, lineStart) : lineStart === lineEnd && gapFollowsEncryptedLine)) {
      shown += text.slice(keepFrom, gapStart)
      keepFrom = text.length
    } else if (lineStart < lineEnd) {
      if (gapFollowsEncryptedLine && !shownReadableLine) {
        shown += text.slice(keepFrom, gapStart)
        keepFrom = lineStart
      }
      shownReadableLine = true
      gapFollowsEncryptedLine = false
      gapStart = lineEnd
    }
    if (isLast) break
    lineStart = newline + 1
  }
  return { text: shown + text.slice(keepFrom), encryptedLines, encryptedChars }
}

// The line that the thinking panel shows between the thinking of two
// request rounds. Display text only: the stored text has no separator.
const ROUND_RULE = '─'.repeat(16)

/** `readableThinking` of a reply with request rounds, for the thinking
 *  panel: each round's text on its own (`roundStarts` are the
 *  `ThinkingRound.from` offsets), with a rule line between two rounds that
 *  show text, and no blank lines next to the rule. Only the last round can
 *  still stream, so each streamed result is still a prefix of the next
 *  one. */
export function readableThinkingRounds(text: string, roundStarts: readonly number[], streaming: boolean): ReadableThinking {
  const starts = [0, ...roundStarts]
  let shown = ''
  let encryptedLines = 0
  let encryptedChars = 0
  for (let index = 0; index < starts.length; index++) {
    const isLast = index === starts.length - 1
    const round = readableThinking(text.slice(starts[index], isLast ? text.length : starts[index + 1]), streaming && isLast)
    encryptedLines += round.encryptedLines
    encryptedChars += round.encryptedChars
    if (shown === '') {
      shown = round.text
      continue
    }
    const roundText = round.text.replace(/^\n+/, '')
    if (roundText !== '') shown = `${shown.replace(/\n+$/, '')}\n${ROUND_RULE}\n${roundText}`
  }
  return { text: shown, encryptedLines, encryptedChars }
}
