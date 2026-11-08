import sbp from '@sbp/sbp'
import { history, undo } from '@codemirror/commands'
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { imageMarkdown } from '../../model/chat/images'
import { SECTION_SEP, clipboardPasteTransaction, encodePrompt, pillsField, sectionsField } from '../thread/cmEditor'
import { dropFilePaths, dropImages, imagePasteAndDrop, pasteImages } from './imageInsert'
import { markdownImages, renderedImages } from './images'

interface SaveCall {
  bytes: Uint8Array
  mediaType: string
  finish: () => void
  fail: () => void
}

interface Toast {
  title?: string
  message: string
  variant?: string
}

const IMAGE_FOLDER = '/home/u/.config/dez/assets/images'
const PNG_BYTES = new Uint8Array([137, 80, 78, 71])

let saveCalls: SaveCall[] = []
let holdSaves = false
let toasts: Toast[] = []
let activeTabId = 'tab-1'
/** The files that `dez.controller/images/readFile` reads, by path; any
 *  other path fails to read. */
let localFiles = new Map<string, File>()
let readPaths: string[] = []
let consoleError: MockInstance<typeof console.error>

sbp('sbp/selectors/register', {
  // Names each file after the first byte of its content, so that a test
  // knows the path of each image whatever the order of the saves. With
  // `holdSaves` the test ends each save itself.
  'dez.controller/images/save' (bytes: Uint8Array, mediaType: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const path = savedPath(bytes[0], mediaType === 'image/png' ? 'png' : 'jpg')
      const call = { bytes, mediaType, finish: () => resolve(path), fail: () => reject(new Error('disk full')) }
      saveCalls.push(call)
      if (!holdSaves) call.finish()
    })
  },
  'dez.ui/toast' (_area: string, toast: Toast): void {
    toasts.push(toast)
  },
  'dez.model/tabs/activeId' (): string {
    return activeTabId
  },
  'dez.controller/images/readFile' (path: string): Promise<File> {
    readPaths.push(path)
    const file = localFiles.get(path)
    return file ? Promise.resolve(file) : Promise.reject(new Error(`Failed to read ${path}: HTTP 404`))
  },
})

function savedPath(firstByte: number, extension = 'png'): string {
  return `${IMAGE_FOLDER}/img${firstByte}.${extension}`
}

/** The reference that an insert of the image saved as `img<firstByte>`
 *  puts in the doc, with its id. */
function reference(firstByte = PNG_BYTES[0], id = 'a', extension = 'png'): string {
  return imageMarkdown(savedPath(firstByte, extension), [{ key: 'id', value: id }])
}

function saveCallOf(firstByte: number): SaveCall {
  const call = saveCalls.find((candidate) => candidate.bytes[0] === firstByte)
  if (!call) throw new Error(`No save of image ${firstByte}`)
  return call
}

function png(name = 'shot.png', firstByte = PNG_BYTES[0]): File {
  return new File([new Uint8Array([firstByte, ...PNG_BYTES.subarray(1)])], name, { type: 'image/png' })
}

function jpeg(name = 'photo.jpg'): File {
  return new File([new Uint8Array([255, 216, 255])], name, { type: 'image/jpeg' })
}

function createState(doc: string, anchor: number, head = anchor): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: [imagePasteAndDrop(), markdownImages()],
  })
}

/** A view stand-in: the handlers read the state, dispatch, focus, and map
 *  drop coordinates (here `clientX` is the doc position). */
function createEditor(doc: string, anchor: number, head = anchor) {
  let state = createState(doc, anchor, head)
  const view = {
    get state() {
      return state
    },
    dispatch(spec: TransactionSpec) {
      state = state.update(spec).state
    },
    posAtCoords(coords: { x: number }) {
      return coords.x
    },
    contentDOM: { parentElement: null },
    focus() {},
  } as unknown as EditorView
  return {
    view,
    doc: () => state.doc.toString(),
    /** Stands for `view.setState` on a tab switch or a stream-end rebuild. */
    replaceState(next: EditorState) {
      state = next
    },
  }
}

function dataTransfer({ text = '', files = [], items = [] }: { text?: string, files?: File[], items?: File[] }): DataTransfer {
  return {
    types: [...(text ? ['text/plain'] : []), ...(files.length + items.length > 0 ? ['Files'] : [])],
    files,
    items: items.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    getData: (type: string) => (type === 'text/plain' ? text : ''),
  } as unknown as DataTransfer
}

function paste(view: EditorView, data: Parameters<typeof dataTransfer>[0]): boolean {
  return pasteImages({ clipboardData: dataTransfer(data) } as unknown as ClipboardEvent, view)
}

function drop(view: EditorView, pos: number, data: Parameters<typeof dataTransfer>[0]): boolean {
  return dropImages({ dataTransfer: dataTransfer(data), clientX: pos, clientY: 0 } as unknown as DragEvent, view)
}

beforeEach(() => {
  saveCalls = []
  holdSaves = false
  toasts = []
  activeTabId = 'tab-1'
  localFiles = new Map()
  readPaths = []
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleError.mockRestore()
  vi.unstubAllGlobals()
})

describe('pasteImages', () => {
  it('saves a pasted image and puts it in place of the selection, with the caret after it', async () => {
    const editor = createEditor('Look at this: here', 14, 18)

    expect(paste(editor.view, { files: [png()] })).toBe(true)

    await vi.waitFor(() => expect(editor.doc()).toBe(`Look at this: ${reference()}`))
    expect(saveCalls.map((call) => [call.bytes, call.mediaType])).toEqual([[PNG_BYTES, 'image/png']])
    expect(editor.view.state.selection.main.head).toBe(editor.doc().length)
    expect(renderedImages(editor.view.state)).toHaveLength(1)
  })

  it('leaves a paste with plain text to the text paste, even with an image', () => {
    const editor = createEditor('', 0)

    expect(paste(editor.view, { text: 'a caption', files: [png()] })).toBe(false)
    expect(saveCalls).toEqual([])
  })

  it('leaves a paste without an image file to CodeMirror', () => {
    const editor = createEditor('', 0)
    const notes = new File(['hi'], 'notes.txt', { type: 'text/plain' })

    expect(paste(editor.view, { files: [notes] })).toBe(false)
    expect(paste(editor.view, {})).toBe(false)
    expect(saveCalls).toEqual([])
  })

  it('takes an image that the clipboard lists only in its items', async () => {
    const editor = createEditor('', 0)

    expect(paste(editor.view, { items: [png()] })).toBe(true)

    await vi.waitFor(() => expect(editor.doc()).toBe(reference()))
  })
})

describe('inserting the saved images', () => {
  it('puts several images one per line, in file order, without the ones that were not saved', async () => {
    holdSaves = true
    const editor = createEditor('', 0)

    paste(editor.view, { files: [png('a.png', 1), jpeg(), png('c.png', 3)] })
    await vi.waitFor(() => expect(saveCalls).toHaveLength(3))
    saveCallOf(3).finish()
    saveCallOf(255).fail()
    saveCallOf(1).finish()

    await vi.waitFor(() => expect(editor.doc()).toBe(`${reference(1)}\n${reference(3, 'b')}`))
  })

  it('puts the images where the paste point moved during the save, after text typed there', async () => {
    holdSaves = true
    const editor = createEditor('Hello world', 5)

    paste(editor.view, { files: [png()] })
    await vi.waitFor(() => expect(saveCalls).toHaveLength(1))
    editor.view.dispatch({ changes: { from: 0, insert: '> ' } })
    editor.view.dispatch({ changes: { from: 7, insert: '!' }, selection: { anchor: 8 } })
    saveCalls[0].finish()

    await vi.waitFor(() => expect(editor.doc()).toBe(`> Hello!${reference()} world`))
    expect(editor.view.state.selection.main.head).toBe(8 + reference().length)
  })

  it('keeps both images of two pastes over one selection, in the order their saves end', async () => {
    holdSaves = true
    const editor = createEditor('Look at this: here', 14, 18)

    paste(editor.view, { files: [png('a.png', 1)] })
    paste(editor.view, { files: [png('b.png', 2)] })
    await vi.waitFor(() => expect(saveCalls).toHaveLength(2))
    editor.view.dispatch({ changes: { from: 0, insert: '> ' } })
    saveCallOf(2).finish()
    await vi.waitFor(() => expect(editor.doc()).toBe(`> Look at this: ${reference(2)}`))
    saveCallOf(1).finish()

    await vi.waitFor(() => expect(editor.doc()).toBe(`> Look at this: ${reference(2)}${reference(1, 'b')}`))
    expect(editor.view.state.selection.main.head).toBe(editor.doc().length)
  })

  it('keeps text typed over the selection during the save, and puts the image after it', async () => {
    holdSaves = true
    const editor = createEditor('Look at this: here', 14, 18)

    paste(editor.view, { files: [png()] })
    await vi.waitFor(() => expect(saveCalls).toHaveLength(1))
    editor.view.dispatch({ changes: { from: 14, to: 18, insert: 'there' }, selection: { anchor: 19 } })
    saveCalls[0].finish()

    await vi.waitFor(() => expect(editor.doc()).toBe(`Look at this: there${reference()}`))
    expect(editor.view.state.selection.main.head).toBe(editor.doc().length)
  })

  it('inserts nothing in a state rebuilt during the save, and says so', async () => {
    holdSaves = true
    const editor = createEditor('first tab', 9)

    paste(editor.view, { files: [png()] })
    await vi.waitFor(() => expect(saveCalls).toHaveLength(1))
    editor.replaceState(createState('first tab', 9))
    saveCalls[0].finish()

    await vi.waitFor(() => expect(toasts).toEqual([expect.objectContaining({ title: 'Image not inserted', variant: 'warning' })]))
    expect(editor.doc()).toBe('first tab')
  })

  it('inserts nothing after a tab switch that the view has not caught up with', async () => {
    holdSaves = true
    const editor = createEditor('first tab', 9)

    paste(editor.view, { files: [png()] })
    await vi.waitFor(() => expect(saveCalls).toHaveLength(1))
    activeTabId = 'tab-2'
    saveCalls[0].finish()

    await vi.waitFor(() => expect(toasts).toEqual([expect.objectContaining({ title: 'Image not inserted', variant: 'warning' })]))
    expect(editor.doc()).toBe('first tab')
  })

  it('stores an image of another type as a PNG, and leaves it out with a warning when it cannot be decoded', async () => {
    vi.stubGlobal('Image', class {
      src = ''
      decode(): Promise<void> {
        return Promise.reject(new Error('unknown image format'))
      }
    })
    const editor = createEditor('', 0)
    const bitmap = new File([new Uint8Array([66, 77])], 'scan.bmp', { type: 'image/bmp' })

    paste(editor.view, { files: [bitmap, png()] })

    await vi.waitFor(() => expect(editor.doc()).toBe(reference()))
    expect(saveCalls.map((call) => call.mediaType)).toEqual(['image/png'])
    expect(toasts).toEqual([expect.objectContaining({ title: 'Image not added', variant: 'warning' })])
    expect(toasts[0].message).toContain('scan.bmp')
  })

  it('gives the images a line of their own next to a prompt pill, so that they show', async () => {
    const pill = encodePrompt('p1', 'Describe this', true)
    const editor = createEditor(`Please: ${pill} thanks`, 8 + pill.length)

    paste(editor.view, { files: [png()] })

    await vi.waitFor(() => expect(editor.doc()).toBe(`Please: ${pill}\n${reference()}\n thanks`))
    expect(renderedImages(editor.view.state)).toHaveLength(1)
    expect(editor.view.state.selection.main.head).toBe(editor.doc().indexOf('\n thanks'))
  })
})

describe('dropImages', () => {
  it('puts dropped images at the drop point', async () => {
    const editor = createEditor('one two', 0)

    expect(drop(editor.view, 4, { files: [png()] })).toBe(true)

    await vi.waitFor(() => expect(editor.doc()).toBe(`one ${reference()}two`))
    expect(editor.view.state.selection.main.head).toBe(4 + reference().length)
  })

  it('keeps a drop on a role pill out of the separator line', async () => {
    const doc = `question\n${SECTION_SEP}\nanswer`
    const editor = createEditor(doc, 0)

    drop(editor.view, doc.indexOf(SECTION_SEP), { files: [png('a.png', 1)] })
    await vi.waitFor(() => expect(editor.doc()).toBe(`question\n${reference(1)}\n${SECTION_SEP}\nanswer`))
    drop(editor.view, editor.doc().indexOf(SECTION_SEP) + 1, { files: [png('b.png', 2)] })

    await vi.waitFor(() => expect(editor.doc()).toBe(`question\n${reference(1)}\n${SECTION_SEP}\n${reference(2, 'b')}\nanswer`))
  })

  it('leaves out the files that are not images, with a toast', async () => {
    const editor = createEditor('', 0)
    const notes = new File(['hi'], 'notes.txt', { type: 'text/plain' })

    expect(drop(editor.view, 0, { files: [notes, png()] })).toBe(true)
    expect(drop(editor.view, 0, { files: [notes] })).toBe(true)

    await vi.waitFor(() => expect(editor.doc()).toBe(reference()))
    expect(saveCalls).toHaveLength(1)
    expect(toasts.map((toast) => toast.message)).toEqual([
      'Only image files can be dropped into a conversation.',
      'Only image files can be dropped into a conversation.',
    ])
  })

  it('leaves a drag without files to CodeMirror', () => {
    const editor = createEditor('', 0)

    expect(drop(editor.view, 0, { text: 'moved text' })).toBe(false)
  })
})

describe('dropFilePaths', () => {
  it('reads the dropped image files by path and puts them at the drop point, without reading the other files', async () => {
    localFiles = new Map([['/home/u/Pictures/a.png', png('a.png', 1)], ['/home/u/Pictures/b.JPG', jpeg('b.JPG')]])
    const editor = createEditor('one two', 0)

    dropFilePaths(editor.view, ['/home/u/Pictures/a.png', '/home/u/notes.txt', '/home/u/Pictures/b.JPG'], { x: 4, y: 0 })

    const references = `${reference(1)}\n${reference(255, 'b', 'jpg')}`
    await vi.waitFor(() => expect(editor.doc()).toBe(`one ${references}two`))
    expect(editor.view.state.selection.main.head).toBe(4 + references.length)
    expect(readPaths).toEqual(['/home/u/Pictures/a.png', '/home/u/Pictures/b.JPG'])
    expect(toasts.map((toast) => toast.message)).toEqual(['Only image files can be dropped into a conversation.'])
  })

  it('leaves out an image that cannot be read, with a warning', async () => {
    localFiles = new Map([['/tmp/a.png', png('a.png', 1)]])
    const editor = createEditor('', 0)

    dropFilePaths(editor.view, ['/tmp/gone.png', '/tmp/a.png'], { x: 0, y: 0 })

    await vi.waitFor(() => expect(editor.doc()).toBe(reference(1)))
    expect(toasts).toEqual([expect.objectContaining({ title: 'Image not added', message: 'Dez cannot read gone.png.', variant: 'warning' })])
  })

  it('puts a drop of links, with no local file, in as text', () => {
    const editor = createEditor('see ', 0)

    dropFilePaths(editor.view, ['https://example.com/a'], { x: 4, y: 0 })

    expect(editor.doc()).toBe('see https://example.com/a')
    expect(editor.view.state.selection.main.head).toBe(editor.doc().length)
    expect(readPaths).toEqual([])
    expect(toasts).toEqual([])
  })
})

describe('image ids', () => {
  const stored = (name: string, id?: string) => imageMarkdown(`${IMAGE_FOLDER}/${name}.png`, id ? [{ key: 'id', value: id }] : [])

  /** A one-section state with undo history, with the caret at the end. */
  function historyState(doc: string): EditorState {
    return EditorState.create({
      doc,
      selection: EditorSelection.cursor(doc.length),
      extensions: [imagePasteAndDrop(), history(), sectionsField.init(() => [{ id: 's1', role: 'user' }]), pillsField.init(() => new Map())],
    })
  }

  function undoOnce(state: EditorState): EditorState {
    let next = state
    expect(undo({ state, dispatch: (tr) => { next = tr.state } })).toBe(true)
    return next
  }

  it('gives images from saves in flight the next ids, in the order they go in', async () => {
    holdSaves = true
    const doc = `${stored('kept', 'b')} `
    const editor = createEditor(doc, doc.length)

    paste(editor.view, { files: [png('one.png', 1)] })
    paste(editor.view, { files: [png('two.png', 2)] })
    await vi.waitFor(() => expect(saveCalls).toHaveLength(2))
    saveCallOf(2).finish()
    await vi.waitFor(() => expect(editor.doc()).toBe(doc + reference(2, 'c')))
    saveCallOf(1).finish()

    await vi.waitFor(() => expect(editor.doc()).toBe(doc + reference(2, 'c') + reference(1, 'd')))
  })

  it.each(['input.paste', 'input.drop'])('gives the images of an %s new ids where they have none or clash, in one undo step', (userEvent) => {
    const doc = `${stored('a', 'a')}\n`
    const state = historyState(doc)
    const text = `${stored('b', 'a')} ${stored('a', 'a')} ${stored('c')}`

    const pasted = state.update({ changes: { from: doc.length, insert: text }, selection: { anchor: doc.length + text.length }, userEvent }).state

    expect(pasted.doc.toString()).toBe(`${doc}${stored('b', 'b')} ${stored('a', 'a')} ${stored('c', 'c')}`)
    expect(pasted.selection.main.head).toBe(pasted.doc.length)
    expect(undoOnce(pasted).doc.toString()).toBe(doc)
  })

  it('gives new ids in a Dez clipboard paste with section markers', () => {
    const doc = `${stored('a', 'a')}\n`
    const state = historyState(doc)

    const pasted = state.update(clipboardPasteTransaction(state, `note\n<dez:pill type="agent"/>\n${stored('b', 'a')}`)).state

    expect(pasted.doc.toString()).toBe(`${doc}note\n${SECTION_SEP}\n${stored('b', 'b')}`)
    expect(pasted.field(sectionsField).map((section) => section.role)).toEqual(['user', 'agent'])
    expect(undoOnce(pasted).doc.toString()).toBe(doc)
  })

  it.each(['input.type', 'move.drop'])('leaves the images of an %s as they are', (userEvent) => {
    const doc = `${stored('b')} ${stored('a', 'a')} `
    const state = historyState(doc)

    const moved = state.update({ changes: [{ from: 0, to: stored('b').length }, { from: doc.length, insert: stored('b') }], userEvent }).state

    expect(moved.doc.toString()).toBe(` ${stored('a', 'a')} ${stored('b')}`)
  })
})
