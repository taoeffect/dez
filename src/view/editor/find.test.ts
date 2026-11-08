import { history, undo, undoDepth } from '@codemirror/commands'
import type { SearchQuery } from '@codemirror/search'
import { EditorSelection, EditorState, type Extension } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { PILL_NL, PILL_OPEN, SECTION_SEP, encodePrompt, pillsField, scanPills, type PillMetadata } from '../thread/cmEditor'
import {
  FIND_COUNT_LIMIT,
  createFindQuery,
  findMatchStatus,
  findMatches,
  findNextMatch,
  findPrefillText,
  findPreviousMatch,
  findQueryField,
  replaceAllMatchesTransaction,
  replaceMatchTransaction,
  type FindTransaction,
} from './find'
import { markdownImages } from './images'

function createState(doc: string, selection?: [number, number], extensions: Extension[] = []): EditorState {
  return EditorState.create({
    doc,
    selection: selection ? EditorSelection.single(...selection) : undefined,
    extensions,
  })
}

function plain(search: string, replace = ''): SearchQuery {
  return createFindQuery({ search, regexp: false, caseSensitive: false }, replace)
}

function regex(search: string, replace = ''): SearchQuery {
  return createFindQuery({ search, regexp: true, caseSensitive: false }, replace)
}

function matchTexts(state: EditorState, query: SearchQuery): string[] {
  return [...findMatches(state, query)].map((match) => state.sliceDoc(match.from, match.to))
}

function matchRanges(state: EditorState, query: SearchQuery): [number, number][] {
  return [...findMatches(state, query)].map((match) => [match.from, match.to])
}

function apply(state: EditorState, spec: FindTransaction | null): EditorState {
  expect(spec).not.toBeNull()
  return state.update(spec!).state
}

function undoOnce(state: EditorState): EditorState {
  let next = state
  expect(undo({ state, dispatch: (tr) => { next = tr.state } })).toBe(true)
  return next
}

// CM joins typing next to a recent change into that change's undo step,
// unless the change was isolated with `isolateHistory`.
function typeAtCursor(state: EditorState, text: string): EditorState {
  return state.update({ changes: { from: state.selection.main.head, insert: text }, userEvent: 'input.type' }).state
}

function sectioned(...sections: string[]): string {
  return sections.join(`\n${SECTION_SEP}\n`)
}

describe('find match filter', () => {
  it('skips separator lines and their framing line breaks without ending a multi-line regex search', () => {
    // `\W` and `\n` use CM's multi-line regex cursor, which stops for good
    // when a match is rejected inside the cursor.
    expect(matchRanges(createState(sectioned('a b', 'c d')), regex('\\W'))).toEqual([[1, 2], [7, 8]])
    expect(matchRanges(createState(sectioned('a\nb', 'c\nd')), regex('\\n'))).toEqual([[1, 2], [7, 8]])
    expect(matchTexts(createState(sectioned('a b', 'b c')), plain('b\n'))).toEqual([])
  })

  it('matches expanded prompt bodies but never pill ids or collapsed bodies', () => {
    const doc = `x ${encodePrompt('p-hidden', 'secret\nline')} y ${encodePrompt('p-open', 'shown secret', false)} z`
    const pills = new Map<string, PillMetadata>([
      ['p-hidden', { promptId: null, name: 'Hidden', expanded: false }],
      ['p-open', { promptId: null, name: 'Open', expanded: true }],
    ])
    const state = createState(doc, undefined, [pillsField.init(() => pills)])

    expect(matchTexts(state, regex('\\w+'))).toEqual(['x', 'y', 'shown', 'secret', 'z'])
    expect(matchTexts(state, plain('line'))).toEqual([])
    expect(matchTexts(state, plain('p-'))).toEqual([])
  })

  it('treats pills without metadata as collapsed', () => {
    const state = createState(`a ${encodePrompt('p1', 'secret', false)} b`)
    expect(matchTexts(state, plain('secret'))).toEqual([])
  })

  it('skips the hidden source of shown images but matches a broken image reference', () => {
    const path = '/home/u/.config/dez/assets/images/a.png'
    const doc = `png ![${path}]() ![${path}](`
    const state = createState(doc, undefined, [markdownImages()])
    const broken = doc.lastIndexOf(path)
    expect(matchRanges(state, plain('png'))).toEqual([[0, 3], [broken + path.length - 3, broken + path.length]])
    expect(matchTexts(state, plain('png ![/home'))).toEqual([])
  })

  it('never yields empty regex matches', () => {
    const state = createState('abc')
    expect(matchTexts(state, regex('x*'))).toEqual([])
    expect(findMatchStatus(state, regex('x*'))).toEqual({ total: 0, current: null, capped: false })
  })

  it('ignores sentinels pasted into the search text', () => {
    const state = createState('ab')
    expect(matchTexts(state, plain(`a${SECTION_SEP}${PILL_OPEN}b`))).toEqual(['ab'])
  })
})

describe('find matching', () => {
  it('matches plain text case-insensitively, across line breaks, with literal backslashes', () => {
    const state = createState('Hello\nWORLD hello a\\nb')
    expect(matchTexts(state, plain('hello'))).toEqual(['Hello', 'hello'])
    expect(matchTexts(state, plain('o\nw'))).toEqual(['o\nW'])
    expect(matchTexts(state, plain('a\\nb'))).toEqual(['a\\nb'])
  })

  it('matches regexes case-insensitively and finds nothing for an invalid pattern', () => {
    const state = createState('Hello\nWORLD hello')
    expect(matchTexts(state, regex('h.llo'))).toEqual(['Hello', 'hello'])

    const invalid = regex('(')
    expect(invalid.valid).toBe(false)
    expect(matchTexts(state, invalid)).toEqual([])
    expect(findMatchStatus(state, invalid)).toEqual({ total: 0, current: null, capped: false })
  })

  it('matches plain text case-sensitively when the flag is set', () => {
    const state = createState('Hello\nWORLD hello')
    const exact = (search: string): SearchQuery => createFindQuery({ search, regexp: false, caseSensitive: true })
    expect(matchTexts(state, exact('hello'))).toEqual(['hello'])
    expect(matchTexts(state, exact('Hello'))).toEqual(['Hello'])
    expect(matchTexts(state, exact('o\nW'))).toEqual(['o\nW'])
    expect(matchTexts(state, exact('o\nw'))).toEqual([])
  })

  it('matches regexes case-sensitively when the flag is set, on one line and across lines', () => {
    const state = createState('Hello\nWORLD hello')
    const exact = (search: string): SearchQuery => createFindQuery({ search, regexp: true, caseSensitive: true })
    expect(matchTexts(state, regex('[A-Z]+'))).toEqual(['Hello', 'WORLD', 'hello'])
    expect(matchTexts(state, exact('[A-Z]+'))).toEqual(['H', 'WORLD'])
    expect(matchTexts(state, exact('h.llo'))).toEqual(['hello'])
    // `\s` runs CM's multi-line regex cursor, which takes the flag separately.
    expect(matchTexts(state, exact('o\\sW'))).toEqual(['o\nW'])
    expect(matchTexts(state, exact('o\\sw'))).toEqual([])
  })
})

describe('find navigation', () => {
  const state = createState('foo bar foo baz foo')
  const query = plain('foo')

  it('finds the next match at or after a position and wraps to the first', () => {
    expect(findNextMatch(state, query, 8)?.from).toBe(8)
    expect(findNextMatch(state, query, 9)?.from).toBe(16)
    expect(findNextMatch(state, query, 17)?.from).toBe(0)
  })

  it('finds the previous match before a position and wraps to the last', () => {
    expect(findPreviousMatch(state, query, 9)?.from).toBe(8)
    expect(findPreviousMatch(state, query, 8)?.from).toBe(0)
    expect(findPreviousMatch(state, query, 0)?.from).toBe(16)
  })

  it('returns null when nothing matches', () => {
    expect(findNextMatch(state, plain('nope'), 0)).toBeNull()
    expect(findPreviousMatch(state, plain('nope'), 0)).toBeNull()
  })

  it('does not start a regex match mid-word when searching from inside a word', () => {
    const words = createState('alpha beta')
    expect(findNextMatch(words, regex('\\w+'), 2)).toMatchObject({ from: 6, to: 10 })
  })

  it('agrees with a full scan for multi-line queries started at a line start', () => {
    // A scan from line 2 would split these differently: `two`, and `a\na` at 2.
    expect(findNextMatch(createState('one\ntwo. three\nfour.'), regex('[^.]+'), 4)).toMatchObject({ from: 8, to: 19 })
    expect(findNextMatch(createState('a\na\na'), plain('a\na'), 2)).toMatchObject({ from: 0, to: 3 })
  })
})

describe('find status', () => {
  it('reports the 1-based index of the match equal to the main selection', () => {
    const query = plain('ab')
    expect(findMatchStatus(createState('ab ab ab', [3, 5]), query)).toEqual({ total: 3, current: 2, capped: false })
    expect(findMatchStatus(createState('ab ab ab', [3, 4]), query)).toEqual({ total: 3, current: null, capped: false })
  })

  it('stops counting at the limit', () => {
    const state = createState('a'.repeat(FIND_COUNT_LIMIT + 1), [0, 1])
    expect(findMatchStatus(state, plain('a'))).toEqual({ total: FIND_COUNT_LIMIT, current: 1, capped: true })
  })
})

describe('find prefill', () => {
  it('takes the selected text, or nothing for an empty, long, or sentinel selection', () => {
    expect(findPrefillText(createState('one two', [4, 7]), false)).toBe('two')
    expect(findPrefillText(createState('one two', [7, 4]), false)).toBe('two')
    expect(findPrefillText(createState('one two', [4, 4]), false)).toBeNull()
    expect(findPrefillText(createState('a\nb\nc\nd', [0, 5]), false)).toBe('a\nb\nc')
    expect(findPrefillText(createState('a\nb\nc\nd', [0, 7]), false)).toBeNull()
    expect(findPrefillText(createState(sectioned('a', 'b'), [0, 5]), false)).toBeNull()
  })

  it('escapes regex syntax so the pattern compiles with the u flag and matches the selection', () => {
    const text = 'a-b (c) [d] {e} $f ^g .h *i +j ?k |l \\m /n "o" #p'
    const state = createState(`x ${text} y`, [2, 2 + text.length])
    const search = findPrefillText(state, true)
    expect(search).not.toBeNull()
    expect(matchTexts(state, regex(search!))).toEqual([text])
  })

  it('keeps the open query when the selection already is one of its matches', () => {
    const query = regex('t\\w+')
    const extensions = [findQueryField.init(() => query)]
    expect(findPrefillText(createState('one two', [4, 7], extensions), true)).toBeNull()
    expect(findPrefillText(createState('one two', [0, 3], extensions), true)).toBe('one')
  })
})

describe('find replace', () => {
  it('replaces the selected match and selects the next one', () => {
    const state = createState('one two one two', [0, 3])
    const next = apply(state, replaceMatchTransaction(state, plain('one', 'uno')))
    expect(next.doc.toString()).toBe('uno two one two')
    expect(next.selection.main).toMatchObject({ from: 8, to: 11 })
  })

  it('selects the next match in post-replace positions', () => {
    const state = createState('ab ab', [0, 2])
    const next = apply(state, replaceMatchTransaction(state, plain('ab', 'xyz')))
    expect(next.doc.toString()).toBe('xyz ab')
    expect(next.selection.main).toMatchObject({ from: 4, to: 6 })
  })

  it('only selects the next match when the selection is not a match', () => {
    const state = createState('one two one two', [4, 4])
    const next = apply(state, replaceMatchTransaction(state, plain('one', 'uno')))
    expect(next.doc.toString()).toBe('one two one two')
    expect(next.selection.main).toMatchObject({ from: 8, to: 11 })
  })

  it('does not replace text that only a scan from its line start sees as a match', () => {
    const state = createState('one\ntwo. three\nfour.', [4, 7])
    const next = apply(state, replaceMatchTransaction(state, regex('[^.]+', 'X')))
    expect(next.doc.toString()).toBe('one\ntwo. three\nfour.')
    expect(next.selection.main).toMatchObject({ from: 8, to: 19 })
  })

  it('leaves the cursor after the replacement when it replaced the only match', () => {
    const state = createState('x one y', [2, 5])
    const next = apply(state, replaceMatchTransaction(state, plain('one', 'uno!')))
    expect(next.doc.toString()).toBe('x uno! y')
    expect(next.selection.main).toMatchObject({ from: 6, to: 6 })
  })

  it('keeps a replace and the typing right after it as separate undo steps', () => {
    const doc = 'x one y'
    let state = createState(doc, [2, 5], [history()])

    state = apply(state, replaceMatchTransaction(state, plain('one', 'uno')))
    const replacedDoc = state.doc.toString()
    state = typeAtCursor(state, '!')
    expect(state.doc.toString()).toBe('x uno! y')
    expect(undoDepth(state)).toBe(2)

    state = undoOnce(state)
    expect(state.doc.toString()).toBe(replacedDoc)
    state = undoOnce(state)
    expect(state.doc.toString()).toBe(doc)
  })

  it('returns null when there is nothing to replace', () => {
    const state = createState('abc', [0, 0])
    expect(replaceMatchTransaction(state, plain('z', 'y'))).toBeNull()
    expect(replaceAllMatchesTransaction(state, plain('z', 'y'))).toBeNull()
  })

  it('replaces all matches as one undo step apart from later typing, and leaves separators and pills intact', () => {
    const doc = sectioned(`o ${encodePrompt('p1', 'oo')} o`, 'foo')
    let state = createState(doc, undefined, [history(), pillsField.init(() => new Map())])

    state = apply(state, replaceAllMatchesTransaction(state, plain('o', `0${SECTION_SEP}${PILL_NL}`)))
    expect(state.doc.toString()).toBe(sectioned(`0 ${encodePrompt('p1', 'oo')} 0`, 'f00'))
    const replacedDoc = state.doc.toString()
    state = typeAtCursor(state, 'x')
    expect(undoDepth(state)).toBe(2)

    state = undoOnce(state)
    expect(state.doc.toString()).toBe(replacedDoc)
    state = undoOnce(state)
    expect(state.doc.toString()).toBe(doc)
  })

  it('never removes the line breaks that frame a separator', () => {
    const state = createState(sectioned('a\nb', 'c\nd'))
    const next = apply(state, replaceAllMatchesTransaction(state, regex('\\n', ' ')))
    expect(next.doc.toString()).toBe(sectioned('a b', 'c d'))
  })

  it('expands $ references and escapes in regex replacements', () => {
    const state = createState('ann@host')
    const query = regex('(\\w+)@(\\w+)(x)?', '$2 at $1 [$&] $$ <$3> $12 $0\\t\\n|')
    const next = apply(state, replaceAllMatchesTransaction(state, query))
    expect(next.doc.toString()).toBe('host at ann [ann@host] $ <> ann2 $0\t\n|')
  })

  it('strips sentinels from $n groups that a lookahead captured outside the match', () => {
    const doc = sectioned(`a ${encodePrompt('p1', 'b')} c`, 'd')
    const state = createState(doc, undefined, [pillsField.init(() => new Map())])
    // `[\s\S]` runs CM's multi-line regex cursor, `.` the single-line one.
    for (const search of ['a(?=([\\s\\S]*))', 'a(?=(.*))']) {
      const next = apply(state, replaceAllMatchesTransaction(state, regex(search, '$1')))
      const text = next.doc.toString()
      expect(text.split(SECTION_SEP)).toHaveLength(2)
      expect(scanPills(text)).toHaveLength(1)
    }
  })

  it('inserts plain-mode replacements literally', () => {
    const state = createState('ann@host')
    const next = apply(state, replaceAllMatchesTransaction(state, plain('ann', '$&\\n')))
    expect(next.doc.toString()).toBe('$&\\n@host')
  })
})
