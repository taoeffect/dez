import sbp from '@sbp/sbp'
import { history, undo } from '@codemirror/commands'
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HIDDEN_IMAGE_PATH, hiddenImage, invokeBlock } from '../../model/chat/testing'
import { SECTION_SEP, encodePrompt, sectionsField } from '../thread/cmEditor'
import { deleteImage, deleteImageBang, deleteImageParen, imageRemovalRange, imageTooltip, imageTooltipDelay, markdownImages, renderedImages, setImageTooltip } from './images'
import { createState as createThreadState, joinSections, runCommand } from './testing'

interface ConfirmCall {
  message: string
  answer: (confirmed: boolean) => void
}

interface DeleteCall {
  path: string
  finish: () => void
  fail: () => void
}

interface Toast {
  title?: string
  message: string
  variant?: string
}

const RED = '/home/u/.config/dez/assets/images/red.png'
const BLUE = '/home/u/.config/dez/assets/images/blue.jpg'
const red = `![${RED}]()`
const blue = `![${BLUE}]()`

let confirmCalls: ConfirmCall[] = []
let deleteCalls: DeleteCall[] = []
let toasts: Toast[] = []
let activeTabId = 'tab-1'

// Each prompt and each file delete waits until the test answers or ends it.
sbp('sbp/selectors/register', {
  'dez.ui/confirm' ({ message }: { message: string }): Promise<boolean> {
    return new Promise((resolve) => {
      confirmCalls.push({ message, answer: resolve })
    })
  },
  'dez.controller/images/delete' (path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      deleteCalls.push({ path, finish: resolve, fail: () => reject(new Error('Permission denied')) })
    })
  },
  'dez.ui/toast' (_area: string, toast: Toast): void {
    toasts.push(toast)
  },
  'dez.model/tabs/activeId' (): string {
    return activeTabId
  },
})

beforeEach(() => {
  confirmCalls = []
  deleteCalls = []
  toasts = []
  activeTabId = 'tab-1'
})

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
    // Not right before an image, a selection whose head is there, many carets.
    const cases = [
      createState(`x ${red}`, 0),
      createState(red, red.length),
      EditorState.create({ doc: red, selection: EditorSelection.single(red.length, 0), extensions: markdownImages() }),
      createState(`${red}\n${red}`, 0, red.length + 1),
    ]
    for (const state of cases) {
      expect(runCommand(state, deleteImageBang)).toEqual({ handled: false, state })
    }
  })
})

describe('imageRemovalRange', () => {
  /** The doc after the first shown image is taken out. */
  function removeImage(doc: string): string {
    const state = createState(doc)
    return state.update({ changes: imageRemovalRange(state.doc, renderedImages(state)[0]) }).state.doc.toString()
  }

  it('takes only the reference when its line has other text', () => {
    expect(removeImage(`look ${red} here`)).toBe('look  here')
    expect(removeImage(`${red}${blue}`)).toBe(blue)
  })

  it('takes the whole line of a reference that is alone on it (white space aside), with one line break', () => {
    expect(removeImage(['before', red, 'after'].join('\n'))).toBe('before\nafter')
    expect(removeImage(['before', `  ${red} `, 'after'].join('\n'))).toBe('before\nafter')
    expect(removeImage(['before', red].join('\n'))).toBe('before')
    expect(removeImage([red, 'after'].join('\n'))).toBe('after')
  })

  it('keeps the line breaks that frame a section separator', () => {
    expect(removeImage(['x', SECTION_SEP, red, 'more', SECTION_SEP, 'y'].join('\n'))).toBe(['x', SECTION_SEP, 'more', SECTION_SEP, 'y'].join('\n'))
    expect(removeImage(['x', SECTION_SEP, 'more', red, SECTION_SEP, 'y'].join('\n'))).toBe(['x', SECTION_SEP, 'more', SECTION_SEP, 'y'].join('\n'))
    // The only line of its section stays, as an empty line.
    expect(removeImage(['x', SECTION_SEP, red, SECTION_SEP, 'y'].join('\n'))).toBe(['x', SECTION_SEP, '', SECTION_SEP, 'y'].join('\n'))
    expect(removeImage([` ${red}`, SECTION_SEP, 'y'].join('\n'))).toBe(['', SECTION_SEP, 'y'].join('\n'))
    expect(removeImage(['x', SECTION_SEP, red].join('\n'))).toBe(['x', SECTION_SEP, ''].join('\n'))
    expect(removeImage(red)).toBe('')
  })
})

describe('deleteImage (the image trash)', () => {
  interface FakeEditor {
    view: EditorView
    doc: () => string
    edit: (spec: TransactionSpec) => void
    /** Stands for `view.setState` on a tab switch or a stream-end rebuild. */
    replaceState: (next: EditorState) => void
  }

  /** A view stand-in that `deleteImage` reads and dispatches to; its state
   *  is `createState(doc)`, or `doc` when that is a state. */
  function createEditor(doc: string | EditorState): FakeEditor {
    let state = typeof doc === 'string' ? createState(doc) : doc
    const view = {
      get state() {
        return state
      },
      dispatch(spec: TransactionSpec) {
        state = state.update(spec).state
      },
    } as unknown as EditorView
    return {
      view,
      doc: () => state.doc.toString(),
      edit: (spec: TransactionSpec) => view.dispatch(spec),
      replaceState(next: EditorState) {
        state = next
      },
    }
  }

  async function nextDeleteCall(): Promise<DeleteCall> {
    await vi.waitFor(() => expect(deleteCalls).toHaveLength(1))
    return deleteCalls[0]
  }

  it('asks first; on "Yes" deletes the file, and then the reference with its line, in a step that undo skips', async () => {
    const editor = createEditor(['before', red, 'after'].join('\n'))
    editor.edit({ changes: { from: editor.doc().length, insert: '!' }, userEvent: 'input.type' })
    const done = deleteImage(editor.view, 'before\n'.length, RED)
    expect(confirmCalls.map((call) => call.message)).toEqual(['Are you sure you want to delete this image?'])
    confirmCalls[0].answer(true)
    const fileDelete = await nextDeleteCall()
    expect(fileDelete.path).toBe(RED)
    expect(editor.doc()).toBe(['before', red, 'after!'].join('\n'))
    fileDelete.finish()
    await done
    expect(editor.doc()).toBe('before\nafter!')

    // The undo takes back the typed `!`, not the delete.
    let undone = editor.view.state
    expect(undo({ state: undone, dispatch: (tr) => { undone = tr.state } })).toBe(true)
    expect(undone.doc.toString()).toBe('before\nafter')
  })

  it('removes a linked image, whose file stays, in its own step that undo takes back', async () => {
    const path = '/home/u/Pictures/cat.png'
    const linked = `![${path}](id=a)`
    // A linked reference shows only in a user section.
    const editor = createEditor(EditorState.create({
      doc: ['before', linked, 'after'].join('\n'),
      extensions: [markdownImages(), history(), sectionsField.init(() => [{ id: 's0', role: 'user' }])],
    }))
    editor.edit({ changes: { from: editor.doc().length, insert: '!' }, userEvent: 'input.type' })
    const done = deleteImage(editor.view, 'before\n'.length, path)
    expect(confirmCalls.map((call) => call.message)).toEqual(['Are you sure you want to remove this image from the conversation? Its file stays where it is.'])
    confirmCalls[0].answer(true)
    await done
    expect(deleteCalls).toEqual([])
    expect(editor.doc()).toBe('before\nafter!')

    const undone = undoOnce(editor.view.state)
    expect(undone.doc.toString()).toBe(['before', linked, 'after!'].join('\n'))
    expect(shown(undone)).toEqual([linked])
    expect(undoOnce(undone).doc.toString()).toBe(['before', linked, 'after'].join('\n'))
  })

  it('takes a hidden image out with the blank line that went out of view with it, so that the text keeps its look', async () => {
    const invoke = invokeBlock('j-aaaa')
    const hidden = hiddenImage('j-aaaa')
    const editor = createEditor(createThreadState(['ask', [invoke, '', hidden, '', 'Done.'].join('\n')], ['user', 'agent']))
    const done = deleteImage(editor.view, editor.doc().indexOf(hidden), HIDDEN_IMAGE_PATH)
    confirmCalls[0].answer(true)
    ;(await nextDeleteCall()).finish()
    await done
    expect(editor.doc()).toBe(joinSections(['ask', [invoke, '', 'Done.'].join('\n')]))
  })

  it('changes nothing on "No", or when the file delete fails', async () => {
    const doc = `a ${red} b`
    const editor = createEditor(doc)
    const refused = deleteImage(editor.view, 2, RED)
    confirmCalls[0].answer(false)
    await refused
    expect(deleteCalls).toEqual([])
    expect(editor.doc()).toBe(doc)

    const failed = deleteImage(editor.view, 2, RED)
    confirmCalls[1].answer(true)
    ;(await nextDeleteCall()).fail()
    await failed
    expect(editor.doc()).toBe(doc)
    expect(toasts).toEqual([])
  })

  it('takes only the reference whose trash was pressed, when two show the same file', async () => {
    const editor = createEditor(`${red}\n${red} b`)
    const done = deleteImage(editor.view, red.length + 1, RED)
    confirmCalls[0].answer(true)
    ;(await nextDeleteCall()).finish()
    await done
    expect(editor.doc()).toBe(`${red}\n b`)
  })

  it('follows the reference through the edits made while the prompt is open', async () => {
    const editor = createEditor(['before', red, 'after'].join('\n'))
    const done = deleteImage(editor.view, 'before\n'.length, RED)
    editor.edit({ changes: [{ from: 0, insert: 'new\n' }, { from: editor.doc().length, insert: ' streamed' }] })
    confirmCalls[0].answer(true)
    ;(await nextDeleteCall()).finish()
    await done
    expect(editor.doc()).toBe('new\nbefore\nafter streamed')
  })

  it('finds the reference again by its path and id in a new state of the same tab (the stream-end rebuild)', async () => {
    const redA = `![${RED}](id=a)`
    const redB = `![${RED}](id=b)`
    const doc = [redA, redB, 'after'].join('\n')
    // The store got the end of the reply and a new user section.
    const rebuilt = `${doc} streamed\n${SECTION_SEP}\n`
    for (const rebuildDuringFileDelete of [false, true]) {
      confirmCalls = []
      deleteCalls = []
      const editor = createEditor(doc)
      const done = deleteImage(editor.view, redA.length + 1, RED)
      if (!rebuildDuringFileDelete) editor.replaceState(createState(rebuilt))
      confirmCalls[0].answer(true)
      const fileDelete = await nextDeleteCall()
      expect(fileDelete.path).toBe(RED)
      if (rebuildDuringFileDelete) editor.replaceState(createState(rebuilt))
      fileDelete.finish()
      await done
      expect(editor.doc()).toBe(`${redA}\nafter streamed\n${SECTION_SEP}\n`)
      expect(toasts).toEqual([])
    }
  })

  it('deletes no file, and says so, when the reference is gone before the answer', async () => {
    const doc = `a ${red}`
    const changes: Array<(editor: FakeEditor) => void> = [
      // Its source shows: the `)` was deleted.
      (editor) => editor.edit({ changes: { from: doc.length - 1, to: doc.length } }),
      // The tab changed while the view still holds its state.
      () => { activeTabId = 'tab-2' },
      // A new state with no shown reference to the file with the same id.
      (editor) => editor.replaceState(createState('a ')),
      // A new state in which two shown references have them (no id here).
      (editor) => editor.replaceState(createState(`${doc}\n${red}`)),
    ]
    for (const change of changes) {
      toasts = []
      const editor = createEditor(doc)
      const done = deleteImage(editor.view, 2, RED)
      change(editor)
      const docBeforeAnswer = editor.doc()
      confirmCalls.at(-1)?.answer(true)
      await done
      expect(deleteCalls).toEqual([])
      expect(editor.doc()).toBe(docBeforeAnswer)
      expect(toasts).toEqual([expect.objectContaining({ title: 'Image not deleted', variant: 'warning' })])
      activeTabId = 'tab-1'
    }
  })

  it('keeps the text of a reference that goes while its file is being deleted', async () => {
    const doc = `a ${red}`
    const editor = createEditor(doc)
    const done = deleteImage(editor.view, 2, RED)
    confirmCalls[0].answer(true)
    const fileDelete = await nextDeleteCall()
    editor.edit({ changes: { from: doc.length - 1, to: doc.length } })
    fileDelete.finish()
    await done
    expect(editor.doc()).toBe(doc.slice(0, -1))
  })
})

describe('image overlay tooltips', () => {
  const redA = `![${RED}](id=a)`
  const blueB = `![${BLUE}](id=b)`

  /** The state with the tooltip of an overlay item of the shown image
   *  `index`, as the hover shows it. */
  function hover(state: EditorState, index: number): EditorState {
    const { from, path, id } = renderedImages(state)[index]
    const tooltip = { pos: from, create: () => ({ dom: {} as HTMLElement }) }
    return state.update({ effects: setImageTooltip.of({ from, path, id, tooltip }) }).state
  }

  function edit(state: EditorState, spec: TransactionSpec): EditorState {
    return state.update(spec).state
  }

  it('follows its image through edits around it, and keeps its tooltip view', () => {
    const doc = `x ${redA}\n${blueB}`
    const state = hover(createState(doc), 1)
    const shownTooltip = imageTooltip(state)?.tooltip
    // Text before the image (also right at its start), and a stream after it.
    const next = edit(state, { changes: [{ from: 0, insert: 'new ' }, { from: doc.indexOf(blueB), insert: 'y' }, { from: doc.length, insert: ' streamed' }] })
    const from = next.doc.toString().indexOf(blueB)
    expect(imageTooltip(next)).toMatchObject({ from, path: BLUE, id: 'b', tooltip: { pos: from } })
    expect(imageTooltip(next)?.tooltip.create).toBe(shownTooltip?.create)
    expect(imageTooltip(edit(next, { selection: { anchor: 0 } }))).toBe(imageTooltip(next))
  })

  it('goes when its image changes or goes', () => {
    const doc = `x ${redA} y`
    const from = doc.indexOf(redA)
    const to = from + redA.length
    const state = hover(createState(doc, to), 0)
    const changed = [
      // Backspace after the image: its source shows.
      runCommand(state, deleteImageParen).state,
      // Another id, another file, and no reference.
      edit(state, { changes: { from: to - 2, to: to - 1, insert: 'c' } }),
      edit(state, { changes: { from, to, insert: `![${BLUE}](id=a)` } }),
      edit(state, { changes: { from, to } }),
    ]
    for (const next of changed) expect(imageTooltip(next)).toBeNull()
  })

  it('hides on the hide effect, and never shows away from its image', () => {
    const state = hover(createState(redA), 0)
    expect(imageTooltip(state)).not.toBeNull()
    expect(imageTooltip(edit(state, { effects: setImageTooltip.of(null) }))).toBeNull()
    const tooltip = { pos: 1, create: () => ({ dom: {} as HTMLElement }) }
    const wrongPlace = edit(createState(` ${redA}`), { effects: setImageTooltip.of({ from: 0, path: RED, id: 'a', tooltip }) })
    expect(imageTooltip(wrongPlace)).toBeNull()
  })

  it('waits the hover time, except right after the pointer left a shown tooltip', () => {
    expect(imageTooltipDelay(1000, -Infinity)).toBe(300)
    expect(imageTooltipDelay(1000, 800)).toBe(0)
    expect(imageTooltipDelay(1000, 700)).toBe(300)
  })
})
