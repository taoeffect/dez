import { history, undo } from '@codemirror/commands'
import { EditorSelection, EditorState, type Transaction, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { SECTION_SEP, encodePrompt } from '../thread/cmEditor'
import { deleteImageBang, deleteImageParen, markdownImages, renderedImages } from './images'

const RED = '/home/u/.config/dez/assets/images/red.png'
const BLUE = '/home/u/.config/dez/assets/images/blue.jpg'
const red = `![${RED}]()`
const blue = `![${BLUE}]()`

function createState(doc: string, ...carets: number[]): EditorState {
  return EditorState.create({
    doc,
    selection: carets.length ? EditorSelection.create(carets.map((pos) => EditorSelection.cursor(pos))) : undefined,
    extensions: [markdownImages(), history(), EditorState.allowMultipleSelections.of(true)],
  })
}

/** The source of each image that the editor shows. */
function shown(state: EditorState): string[] {
  return renderedImages(state).map((image) => state.sliceDoc(image.from, image.to))
}

/** Runs a key command on a fake view; the next state is unchanged when the
 *  command does not handle the key. */
function runCommand(state: EditorState, command: (view: EditorView) => boolean): { handled: boolean, state: EditorState } {
  let next = state
  const view = {
    get state() {
      return next
    },
    dispatch(...specs: [Transaction] | TransactionSpec[]) {
      next = 'startState' in specs[0] ? specs[0].state : next.update(...specs as TransactionSpec[]).state
    },
  } as EditorView
  const handled = command(view)
  return { handled, state: next }
}

function type(state: EditorState, text: string): EditorState {
  const caret = state.selection.main.head
  return state.update({ changes: { from: caret, insert: text }, selection: { anchor: caret + text.length }, userEvent: 'input.type' }).state
}

function undoOnce(state: EditorState): EditorState {
  let next = state
  expect(undo({ state, dispatch: (tr) => { next = tr.state } })).toBe(true)
  return next
}

describe('renderedImages', () => {
  it('finds every image reference in the doc, at doc offsets', () => {
    const doc = ['intro', `look ${red} and ${blue}`, SECTION_SEP, red].join('\n')
    const state = createState(doc)
    expect(shown(state)).toEqual([red, blue, red])
    expect(renderedImages(state).map((image) => image.path)).toEqual([RED, BLUE, RED])
    expect(renderedImages(state)[0].from).toBe(doc.indexOf(red))
  })

  it('leaves broken references and other markdown images as text', () => {
    const state = createState([`![${RED}](`, `[${RED}]()`, `![${RED}](x)`, '![](https://example.com/a.png)'].join('\n'))
    expect(shown(state)).toEqual([])
  })

  it('leaves references on table row lines as text, but not on the lines around a table', () => {
    const doc = [red, `| ${red} | b |`, '|---|---|', `| ${blue} | d |`, '', blue].join('\n')
    const state = createState(doc)
    expect(renderedImages(state).map((image) => image.from)).toEqual([0, doc.lastIndexOf(blue)])
  })

  it('leaves references on a line with a pill marker as text', () => {
    const state = createState([`${encodePrompt('p1', 'body', false)} ${red}`, blue].join('\n'))
    expect(shown(state)).toEqual([blue])
  })

  it('follows edits to the doc', () => {
    const state = createState('a')
    expect(shown(state)).toEqual([])
    expect(shown(type(state, red))).toEqual([red])
  })
})

describe('Backspace after an image', () => {
  it('deletes only the `)`, so the source shows with the caret after the `(`', () => {
    const doc = `x ${red} y`
    const after = doc.indexOf(red) + red.length
    const { handled, state } = runCommand(createState(doc, after), deleteImageParen)
    expect(handled).toBe(true)
    expect(state.doc.toString()).toBe(`x ![${RED}]( y`)
    expect(state.selection.main.head).toBe(after - 1)
    expect(shown(state)).toEqual([])
  })

  it('shows the image again when `)` is typed or the delete is undone', () => {
    const after = red.length
    const broken = runCommand(createState(red, after), deleteImageParen).state
    expect(shown(type(broken, ')'))).toEqual([red])
    const undone = undoOnce(broken)
    expect(undone.doc.toString()).toBe(red)
    expect(undone.selection.main.head).toBe(after)
    expect(shown(undone)).toEqual([red])
  })

  it('takes the image before the caret when two images touch', () => {
    const { state } = runCommand(createState(red + blue, red.length), deleteImageParen)
    expect(state.doc.toString()).toBe(red.slice(0, -1) + blue)
    expect(shown(state)).toEqual([blue])
  })

  it('leaves other Backspaces to the next commands', () => {
    // Not right after an image, a selection, many carets, an image on a
    // table row (shown as text, so the default Backspace deletes the `)`).
    const tableRow = `| ${red} |\n|---|`
    const cases = [
      createState(`${red} y`, red.length + 1),
      createState(red, 0),
      EditorState.create({ doc: red, selection: EditorSelection.single(0, red.length), extensions: markdownImages() }),
      createState(`${red}\n${red}`, red.length, red.length * 2 + 1),
      createState(tableRow, 2 + red.length),
    ]
    for (const state of cases) {
      expect(runCommand(state, deleteImageParen)).toEqual({ handled: false, state })
    }
  })
})

describe('Delete before an image', () => {
  it('deletes only the `!`, and typing `!` shows the image again', () => {
    const doc = `x ${red}`
    const before = doc.indexOf(red)
    const { handled, state } = runCommand(createState(doc, before), deleteImageBang)
    expect(handled).toBe(true)
    expect(state.doc.toString()).toBe(`x [${RED}]()`)
    expect(state.selection.main.head).toBe(before)
    expect(shown(state)).toEqual([])
    expect(shown(type(state, '!'))).toEqual([red])
  })

  it('takes the image after the caret when two images touch', () => {
    const { state } = runCommand(createState(red + blue, red.length), deleteImageBang)
    expect(state.doc.toString()).toBe(red + blue.slice(1))
    expect(shown(state)).toEqual([red])
  })

  it('leaves other Deletes to the next commands', () => {
    const cases = [
      createState(`x ${red}`, 0),
      createState(red, red.length),
      createState(`${red}\n${red}`, 0, red.length + 1),
    ]
    for (const state of cases) {
      expect(runCommand(state, deleteImageBang)).toEqual({ handled: false, state })
    }
  })
})
