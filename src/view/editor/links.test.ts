import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { SECTION_SEP, dezLanguageSupport, encodePrompt } from '../thread/cmEditor'
import { markdownImages } from './images'
import { renderedLinkAt, renderedLinks } from './links'

const RED = '/home/u/.config/dez/assets/images/red.png'

function lines(...rows: string[]): string {
  return rows.join('\n')
}

/** A state with the editor's markdown language and images. Each selection
 *  item is a caret or an `[anchor, head]` range; the default is a caret at
 *  the doc start. */
function createState(doc: string, ...selection: (number | [number, number])[]): EditorState {
  return EditorState.create({
    doc,
    selection: selection.length
      ? EditorSelection.create(selection.map((item) => typeof item === 'number' ? EditorSelection.cursor(item) : EditorSelection.range(...item)))
      : undefined,
    extensions: [dezLanguageSupport(), markdownImages(), EditorState.allowMultipleSelections.of(true)],
  })
}

/** Each rendered link: its whole source, the text that it shows, and its
 *  URL. */
function shown(state: EditorState, from?: number, to?: number): { source: string, text: string, url: string }[] {
  return renderedLinks(state, from, to).map((link) => ({
    source: state.sliceDoc(link.from, link.to),
    text: state.sliceDoc(link.textFrom, link.textTo),
    url: link.url,
  }))
}

/** The text that each rendered link shows. */
function shownTexts(state: EditorState): string[] {
  return shown(state).map((link) => link.text)
}

describe('renderedLinks', () => {
  it('renders inline links and autolinks that Dez can open, showing only their text', () => {
    const doc = 'See [the docs](https://example.com/a "Title"), <https://example.com/b>, <me@example.com>, ' +
      '[mail](mailto:me@example.com), [call](tel:+15551234), and [plain](http://example.com).'
    expect(shown(createState(doc))).toEqual([
      { source: '[the docs](https://example.com/a "Title")', text: 'the docs', url: 'https://example.com/a' },
      { source: '<https://example.com/b>', text: 'https://example.com/b', url: 'https://example.com/b' },
      { source: '<me@example.com>', text: 'me@example.com', url: 'mailto:me@example.com' },
      { source: '[mail](mailto:me@example.com)', text: 'mail', url: 'mailto:me@example.com' },
      { source: '[call](tel:+15551234)', text: 'call', url: 'tel:+15551234' },
      { source: '[plain](http://example.com)', text: 'plain', url: 'http://example.com' },
    ])
  })

  it('opens the destination as CommonMark reads it', () => {
    const state = createState(String.raw`See [a](<https://example.com/a b>) and [b](https://example.com/a\_b) and <https://example.com/a\_b>.`)
    expect(shown(state).map((link) => link.url)).toEqual([
      'https://example.com/a b',
      'https://example.com/a_b',
      // Backslash escapes do not work in autolinks.
      String.raw`https://example.com/a\_b`,
    ])
  })

  it('leaves links that Dez cannot open as source', () => {
    const doc = 'See [a](ftp://example.org), [b](javascript:alert(1)), [c](file:///etc/passwd), [d](docs/a.md), ' +
      '[e](#top), [f](http:example.com), <irc:dez>, [g](<>), [h][ref], [i], [j](), and [ok](HTTPS://EXAMPLE.COM).'
    expect(shownTexts(createState(doc))).toEqual(['ok'])
  })

  it('leaves a Dez image reference without its `!` as source, and never renders a link in an image description', () => {
    const doc = `See [${RED}](id=a) and ![a [b](https://example.com)](https://example.com/i.png).`
    expect(shown(createState(doc))).toEqual([])
  })

  it('leaves links in code as source', () => {
    const doc = lines('See `[a](https://a.example)`.', '```', '[b](https://b.example)', '```', '', '    [c](https://c.example)')
    expect(shown(createState(doc))).toEqual([])
  })

  it('shows the source of a link that a selection touches, also at its two ends', () => {
    const doc = 'See [docs](https://example.com) now'
    const from = doc.indexOf('[')
    const to = doc.indexOf(')') + 1
    const cases: { selection: (number | [number, number])[], rendered: boolean }[] = [
      { selection: [from - 1], rendered: true },
      { selection: [from], rendered: false },
      { selection: [from + 3], rendered: false },
      { selection: [to], rendered: false },
      { selection: [to + 1], rendered: true },
      { selection: [[0, from - 1]], rendered: true },
      { selection: [[0, from]], rendered: false },
      { selection: [[doc.length, to]], rendered: false },
      { selection: [[0, doc.length]], rendered: false },
      { selection: [0, from + 3], rendered: false },
    ]
    for (const { selection, rendered } of cases) {
      expect(shownTexts(createState(doc, ...selection)), JSON.stringify(selection)).toEqual(rendered ? ['docs'] : [])
    }
  })

  it('keeps the other links rendered while a selection touches one', () => {
    const doc = 'See [a](https://a.example) and [b](https://b.example).'
    expect(shownTexts(createState(doc, doc.indexOf('a]')))).toEqual(['b'])
  })

  it('leaves a link with no text to show, or with markup across a line break, as source', () => {
    const doc = lines(
      'See [](https://a.example) and [ ](https://b.example).',
      'See [c](',
      'https://c.example) and [d](https://d.example',
      '"Title").',
      'See [two',
      'lines](https://e.example).',
    )
    expect(shownTexts(createState(doc))).toEqual(['two\nlines'])
  })

  it('leaves links on table row lines as source', () => {
    const doc = lines(
      '| [a](https://a.example) | Note |',
      '| --- | --- |',
      '| [b](https://b.example) | c |',
      'A row with no pipe: [d](https://d.example)',
      '',
      'After the table: [e](https://e.example)',
    )
    expect(shownTexts(createState(doc))).toEqual(['e'])
  })

  it('leaves links on a line with a section separator or a prompt pill as source', () => {
    const doc = lines(
      'First [a](https://a.example)',
      SECTION_SEP,
      `[b](https://b.example) ${encodePrompt('p1', 'see [c](https://c.example)')}`,
      'Last [d](https://d.example)',
    )
    expect(shownTexts(createState(doc))).toEqual(['a', 'd'])
  })

  it('leaves a link that touches a rendered image as source', () => {
    const image = (id: string): string => `![${RED}](id=${id})`
    const doc = `See ${image('a')}[a](https://a.example), [${image('b')}](https://b.example), and [c](https://c.example) ${image('c')}.`
    expect(shownTexts(createState(doc))).toEqual(['c'])
  })

  it('finds only the links in the given range', () => {
    const state = createState(lines('First [a](https://a.example)', 'Second [b](https://b.example)', 'Third [c](https://c.example)'))
    const second = state.doc.line(2)
    expect(shownTexts(state)).toEqual(['a', 'b', 'c'])
    expect(shown(state, second.from, second.to).map((link) => link.text)).toEqual(['b'])
  })
})

describe('renderedLinkAt', () => {
  /** The URL of the link under a pointer that CodeMirror reads as `side` of
   *  `pos`, or `null`. */
  function urlAt(state: EditorState, pos: number, side: -1 | 1): string | null {
    return renderedLinkAt(state, pos, side)?.url ?? null
  }

  it('finds the link under the pointer at the edges of its text, from any position of its hidden markup', () => {
    const doc = 'See [docs](https://a.example) now.'
    const state = createState(doc, doc.length)
    const from = doc.indexOf('[')
    const textFrom = from + 1
    const textTo = doc.indexOf(']')
    const to = doc.indexOf(')') + 1
    // Over the first char of `docs`, or over the space before the link.
    for (const pos of [from, textFrom]) {
      expect(urlAt(state, pos, 1)).toBe('https://a.example')
      expect(urlAt(state, pos, -1)).toBeNull()
    }
    // Over the last char of `docs`, or over the space after the link.
    for (const pos of [textTo, textTo + 2, to]) {
      expect(urlAt(state, pos, -1)).toBe('https://a.example')
      expect(urlAt(state, pos, 1)).toBeNull()
    }
    // Inside the text, either side is on the link.
    expect(urlAt(state, textFrom + 2, -1)).toBe('https://a.example')
    expect(urlAt(state, textFrom + 2, 1)).toBe('https://a.example')
    expect(urlAt(state, from - 1, 1)).toBeNull()
    expect(urlAt(state, to + 1, -1)).toBeNull()
  })

  it('tells two links that touch apart by the side', () => {
    const doc = 'See [a](https://a.example)<https://b.example>'
    const between = doc.indexOf('<')
    const state = createState(doc)
    expect(urlAt(state, between, -1)).toBe('https://a.example')
    expect(urlAt(state, between, 1)).toBe('https://b.example')
  })

  it('finds no link where the source shows', () => {
    const doc = 'See [docs](https://a.example) and [path](id=a).'
    const inDocs = doc.indexOf('docs') + 2
    expect(urlAt(createState(doc, inDocs), inDocs, 1)).toBeNull()
    const inPath = doc.indexOf('path') + 2
    expect(urlAt(createState(doc, doc.length), inPath, 1)).toBeNull()
  })
})
