import sbp from '@sbp/sbp'
import { history, undo } from '@codemirror/commands'
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { DrawnImage, DrawnMediaType, ImageDrawing, ImageSize } from '../../model/chat/imageDrawing'
import { imageMarkdown } from '../../model/chat/images'
import { FileTooLargeError, MAX_SAVED_CLIP_BYTES } from '../../model/chat/mediaFiles'
import { mediaTagText, type MediaTagData, type MediaTagKind } from '../../model/chat/mediaTags'
import { SECTION_SEP, clipboardPasteTransaction, encodePrompt, pillsField, sectionsField } from '../thread/cmEditor'
import { dropFilePaths, dropFiles, filePasteAndDrop, pasteFiles } from './imageInsert'
import { markdownImages, renderedImages } from './images'

interface SaveCall {
  bytes: Uint8Array
  mediaType: string
  finish: () => void
  fail: () => void
}

interface ClipSave {
  clip: Pick<MediaTagData, 'kind' | 'type' | 'src' | 'url'>
  options: { bytes: Uint8Array, folder: string }
}

interface Toast {
  title?: string
  message: string
  variant?: string
}

const IMAGE_FOLDER = '/home/u/.config/dez/assets/images'
const PNG_BYTES = new Uint8Array([137, 80, 78, 71])
const UNSUPPORTED_DROP_MESSAGE = 'Only images and audio and video clips can be dropped into a conversation. '
  + 'Clips must be mp4, webm, mov, mp3, wav, ogg, flac, m4a, aac, or opus files.'

let saveCalls: SaveCall[] = []
let holdSaves = false
let toasts: Toast[] = []
let activeTabId = 'tab-1'
/** The files that `dez.controller/images/readFile` reads, by path; any
 *  other path fails to read. */
let localFiles = new Map<string, File>()
/** The sizes of the files that are too large to read with a `maxBytes`,
 *  by path. */
let largeFiles = new Map<string, number>()
let reads: [string, { maxBytes?: number }][] = []
let clipSaves: ClipSave[] = []
/** The first bytes of the clip files whose save fails. */
let failingClipSaves = new Set<number>()
/** The dropped paths that `dez.controller/images/linkPath` links; it gives
 *  null (copy) for any other path. */
let linkedPaths = new Set<string>()
/** The sizes that `dez.controller/images/fileSize` gives, by path (null for
 *  any other path); it throws for `unsizedPaths`. */
let fileSizes = new Map<string, number>()
let unsizedPaths = new Set<string>()
/** The paths that `dez.controller/images/droppedFilePaths` gives for the
 *  files of an HTML5 drop, by file name (null for any other file). */
let draggedPaths = new Map<string, string>()
let draggedFileReads: string[][] = []
/** What `dez.controller/images/redraw` does with the plan of its caller. */
let redraw: (plan: (size: ImageSize) => ImageDrawing | null, mediaType: DrawnMediaType) => Promise<DrawnImage | null>
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
  'dez.controller/images/readFile' (path: string, options: { maxBytes?: number }): Promise<File> {
    reads.push([path, options])
    const size = largeFiles.get(path)
    if (size !== undefined && options.maxBytes !== undefined && size > options.maxBytes) return Promise.reject(new FileTooLargeError(size, options.maxBytes))
    const file = localFiles.get(path)
    return file ? Promise.resolve(file) : Promise.reject(new Error('The file cannot be read (HTTP 404).'))
  },
  // Names each clip file after the first byte of its content, as the image
  // saves do.
  'dez.controller/media/save' (clip: ClipSave['clip'], options: ClipSave['options']): Promise<string> {
    clipSaves.push({ clip, options })
    if (failingClipSaves.has(options.bytes[0])) return Promise.reject(new Error('disk full'))
    return Promise.resolve(clipPath(clip.kind, options.bytes[0]))
  },
  async 'dez.controller/images/linkPath' (path: string): Promise<string | null> {
    return linkedPaths.has(path) ? path : null
  },
  async 'dez.controller/images/fileSize' (path: string): Promise<number | null> {
    if (unsizedPaths.has(path)) throw new Error('The file cannot be read (HTTP 404).')
    return fileSizes.get(path) ?? null
  },
  async 'dez.controller/images/droppedFilePaths' (files: readonly File[]): Promise<(string | null)[]> {
    draggedFileReads.push(files.map((file) => file.name))
    return files.map((file) => draggedPaths.get(file.name) ?? null)
  },
  'dez.controller/images/redraw' (_file: Blob, plan: (size: ImageSize) => ImageDrawing | null, mediaType: DrawnMediaType): Promise<DrawnImage | null> {
    return redraw(plan, mediaType)
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

function clipPath(kind: MediaTagKind, firstByte: number): string {
  return `/home/u/.config/dez/assets/${kind}/clip${firstByte}.bin`
}

/** The tag that an insert of the clip saved as `clip<firstByte>` puts in
 *  the doc, with its id. */
function clipTag(kind: MediaTagKind, type: string, firstByte: number, id: string): string {
  return mediaTagText({ kind, id, type, src: clipPath(kind, firstByte), url: null, expires: null, other: [] })
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

function clipFile(name: string, type: string, firstByte: number): File {
  return new File([new Uint8Array([firstByte, 0, 0])], name, { type })
}

/** A clip file whose size is `size`, larger than the test can make; its
 *  bytes are `read`, which the test checks. */
function largeClipFile(name: string, size: number, read: () => Promise<ArrayBuffer>): File {
  const file = clipFile(name, 'video/quicktime', 41)
  Object.defineProperties(file, { size: { value: size }, arrayBuffer: { value: read } })
  return file
}

function createState(doc: string, anchor: number, head = anchor): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: [filePasteAndDrop(), markdownImages(), history()],
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
  return pasteFiles({ clipboardData: dataTransfer(data) } as unknown as ClipboardEvent, view)
}

function drop(view: EditorView, pos: number, data: Parameters<typeof dataTransfer>[0]): boolean {
  return dropFiles({ dataTransfer: dataTransfer(data), clientX: pos, clientY: 0 } as unknown as DragEvent, view)
}

beforeEach(() => {
  saveCalls = []
  holdSaves = false
  toasts = []
  activeTabId = 'tab-1'
  localFiles = new Map()
  largeFiles = new Map()
  reads = []
  clipSaves = []
  failingClipSaves = new Set()
  linkedPaths = new Set()
  fileSizes = new Map()
  unsizedPaths = new Set()
  draggedPaths = new Map()
  draggedFileReads = []
  redraw = () => Promise.reject(new Error('No image of another type in this test.'))
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleError.mockRestore()
})

describe('pasteFiles', () => {
  it('saves a pasted image and puts it in place of the selection, with the caret after it', async () => {
    const editor = createEditor('Look at this: here', 14, 18)

    expect(paste(editor.view, { files: [png()] })).toBe(true)

    await vi.waitFor(() => expect(editor.doc()).toBe(`Look at this: ${reference()}`))
    expect(saveCalls.map((call) => [call.bytes, call.mediaType])).toEqual([[PNG_BYTES, 'image/png']])
    expect(editor.view.state.selection.main.head).toBe(editor.doc().length)
    expect(renderedImages(editor.view.state)).toHaveLength(1)
  })

  it('leaves a paste with plain text to the text paste, even with an image or a clip', () => {
    const editor = createEditor('', 0)

    expect(paste(editor.view, { text: 'a caption', files: [png()] })).toBe(false)
    expect(paste(editor.view, { text: 'a caption', files: [clipFile('dance.mp4', 'video/mp4', 21)] })).toBe(false)
    expect(saveCalls).toEqual([])
    expect(clipSaves).toStrictEqual([])
  })

  it('leaves a paste without an image or clip file to CodeMirror', () => {
    const editor = createEditor('', 0)
    const notes = new File(['hi'], 'notes.txt', { type: 'text/plain' })

    expect(paste(editor.view, { files: [notes, clipFile('movie.mkv', 'video/x-matroska', 21)] })).toBe(false)
    expect(paste(editor.view, {})).toBe(false)
    expect(saveCalls).toEqual([])
    expect(clipSaves).toStrictEqual([])
  })

  it('takes an image that the clipboard lists only in its items', async () => {
    const editor = createEditor('', 0)

    expect(paste(editor.view, { items: [png()] })).toBe(true)

    await vi.waitFor(() => expect(editor.doc()).toBe(reference()))
  })

  it('stores a pasted clip in the pasted clip folder of its kind, and puts its tag on a line of its own', async () => {
    const editor = createEditor('see', 3)

    expect(paste(editor.view, { files: [clipFile('dance.mp4', 'video/mp4', 21)] })).toBe(true)

    await vi.waitFor(() => expect(editor.doc()).toBe(`see\n${clipTag('video', 'video/mp4', 21, 'a')}`))
    expect(clipSaves).toStrictEqual([{
      clip: { kind: 'video', type: 'video/mp4', src: null, url: null },
      options: { bytes: new Uint8Array([21, 0, 0]), folder: 'pasted' },
    }])
    expect(editor.view.state.selection.main.head).toBe(editor.doc().length)
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

  it('stores an image of another type as a PNG, drawn whole at its own size', async () => {
    // The drawn PNG starts with byte 7, so the saved file name tells the PNG
    // from the BMP (byte 66).
    const drawings: unknown[] = []
    redraw = async (plan, mediaType) => {
      drawings.push([plan({ width: 40, height: 30 }), mediaType])
      return { bytes: new Uint8Array([7, ...PNG_BYTES.subarray(1)]), mediaType, width: 40, height: 30 }
    }
    const editor = createEditor('', 0)
    const bitmap = new File([new Uint8Array([66, 77])], 'scan.bmp', { type: 'image/bmp' })

    paste(editor.view, { files: [bitmap] })

    await vi.waitFor(() => expect(editor.doc()).toBe(reference(7)))
    expect(saveCalls.map((call) => call.mediaType)).toEqual(['image/png'])
    expect(drawings).toStrictEqual([[{ crop: { x: 0, y: 0, width: 40, height: 30 }, width: 40, height: 30 }, 'image/png']])
    expect(toasts).toEqual([])
  })

  it('leaves out an image of another type that the webview cannot decode, with a warning', async () => {
    redraw = () => Promise.reject(new Error('unknown image format'))
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

describe('dropFiles', () => {
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

  it('puts dropped images and clips in file order, the clips each on a whole line, with the caret after the last one', async () => {
    const editor = createEditor('one two', 0)
    const files = [png('a.png', 1), clipFile('dance.mp4', 'video/mp4', 21), clipFile('song.MP3', '', 22)]

    expect(drop(editor.view, 4, { files })).toBe(true)

    const text = `${reference(1)}\n${clipTag('video', 'video/mp4', 21, 'b')}\n${clipTag('audio', 'audio/mpeg', 22, 'c')}`
    await vi.waitFor(() => expect(editor.doc()).toBe(`one \n${text}\ntwo`))
    expect(editor.view.state.selection.main.head).toBe('one \n'.length + text.length)
    expect(clipSaves.map(({ clip, options }) => [clip.kind, clip.type, options.folder])).toStrictEqual([['video', 'video/mp4', 'pasted'], ['audio', 'audio/mpeg', 'pasted']])
    expect(toasts).toStrictEqual([])
  })

  it('leaves out the files that are not images or clips, with a toast', async () => {
    const editor = createEditor('', 0)
    const notes = new File(['hi'], 'notes.txt', { type: 'text/plain' })

    expect(drop(editor.view, 0, { files: [notes, clipFile('movie.mkv', 'video/x-matroska', 21), png()] })).toBe(true)
    expect(drop(editor.view, 0, { files: [notes] })).toBe(true)

    await vi.waitFor(() => expect(editor.doc()).toBe(reference()))
    expect(saveCalls).toHaveLength(1)
    expect(clipSaves).toStrictEqual([])
    expect(toasts.map((toast) => toast.message)).toStrictEqual([UNSUPPORTED_DROP_MESSAGE, UNSUPPORTED_DROP_MESSAGE])
  })

  it('leaves out a clip that is larger than the clips that Dez stores, without reading it', async () => {
    const read = vi.fn(() => Promise.resolve(new ArrayBuffer(3)))
    const editor = createEditor('', 0)

    drop(editor.view, 0, { files: [largeClipFile('trip.mov', 1.5 * 1024 ** 3, read), png()] })

    await vi.waitFor(() => expect(editor.doc()).toBe(reference()))
    expect(read).not.toHaveBeenCalled()
    expect(clipSaves).toStrictEqual([])
    expect(toasts).toStrictEqual([expect.objectContaining({ title: 'Clip not added', variant: 'warning' })])
    expect(toasts[0].message).toContain('trip.mov')
    expect(toasts[0].message).toContain('1.5 GB')
    expect(toasts[0].message).toContain('1.0 GB')
  })

  it('inserts the other files when a clip save fails', async () => {
    failingClipSaves = new Set([21])
    const editor = createEditor('', 0)

    drop(editor.view, 0, { files: [clipFile('dance.mp4', 'video/mp4', 21), clipFile('song.mp3', 'audio/mpeg', 22)] })

    await vi.waitFor(() => expect(editor.doc()).toBe(clipTag('audio', 'audio/mpeg', 22, 'a')))
    expect(clipSaves).toHaveLength(2)
  })

  it('takes a clip insert back in one undo step', async () => {
    const editor = createEditor('see', 3)

    drop(editor.view, 3, { files: [clipFile('dance.mp4', 'video/mp4', 21)] })
    await vi.waitFor(() => expect(editor.doc()).toBe(`see\n${clipTag('video', 'video/mp4', 21, 'a')}`))

    let undone = editor.view.state
    expect(undo({ state: undone, dispatch: (tr) => { undone = tr.state } })).toBe(true)
    expect(undone.doc.toString()).toBe('see')
  })

  it('says which files it did not insert in a state rebuilt during the save', async () => {
    holdSaves = true
    const editor = createEditor('first tab', 9)

    drop(editor.view, 9, { files: [png(), clipFile('dance.mp4', 'video/mp4', 21)] })
    await vi.waitFor(() => expect(saveCalls).toHaveLength(1))
    editor.replaceState(createState('first tab', 9))
    saveCalls[0].finish()

    await vi.waitFor(() => expect(toasts).toStrictEqual([expect.objectContaining({ title: 'Image and clip not inserted', variant: 'warning' })]))
    expect(editor.doc()).toBe('first tab')
  })

  it('leaves a drag without files to CodeMirror', () => {
    const editor = createEditor('', 0)

    expect(drop(editor.view, 0, { text: 'moved text' })).toBe(false)
  })

  it('links the files of a drop that have a path out of the temp and Dez folders, and copies the others, with one path read per drop', async () => {
    draggedPaths = new Map([['a.png', '/Users/u/a.png'], ['dance.mp4', '/Users/u/dance.mp4'], ['b.png', '/private/tmp/b.png']])
    linkedPaths = new Set(['/Users/u/a.png', '/Users/u/dance.mp4'])
    fileSizes = new Map([['/Users/u/dance.mp4', 3]])
    const notes = new File(['hi'], 'notes.txt', { type: 'text/plain' })
    const editor = createEditor('one two', 0)

    drop(editor.view, 4, { files: [png('a.png', 1), clipFile('dance.mp4', 'video/mp4', 21), png('b.png', 2), notes] })
    drop(editor.view, 0, { files: [notes] })

    const linkedImage = imageMarkdown('/Users/u/a.png', [{ key: 'id', value: 'a' }])
    const linkedClip = mediaTagText({ kind: 'video', id: 'b', type: 'video/mp4', src: '/Users/u/dance.mp4', url: null, expires: null, other: [] })
    await vi.waitFor(() => expect(editor.doc()).toBe(`one \n${linkedImage}\n${linkedClip}\n${reference(2, 'c')}\ntwo`))
    expect(draggedFileReads).toStrictEqual([['a.png', 'dance.mp4', 'b.png', 'notes.txt']])
    expect(saveCalls.map((call) => call.bytes[0])).toStrictEqual([2])
    expect(clipSaves).toStrictEqual([])
    expect(toasts.map((toast) => toast.message)).toStrictEqual([UNSUPPORTED_DROP_MESSAGE, UNSUPPORTED_DROP_MESSAGE])
  })
})

describe('dropFilePaths', () => {
  it('reads the dropped image files by path and puts them at the drop point, without reading the other files', async () => {
    localFiles = new Map([['/home/u/Pictures/a.png', png('a.png', 1)], ['/home/u/Pictures/b.JPG', jpeg('b.JPG')]])
    const editor = createEditor('one two', 0)

    dropFilePaths(editor.view, ['/home/u/Pictures/a.png', '/home/u/notes.txt', '/home/u/movie.mkv', '/home/u/Pictures/b.JPG'], { x: 4, y: 0 })

    const references = `${reference(1)}\n${reference(255, 'b', 'jpg')}`
    await vi.waitFor(() => expect(editor.doc()).toBe(`one ${references}two`))
    expect(editor.view.state.selection.main.head).toBe(4 + references.length)
    expect(reads).toStrictEqual([['/home/u/Pictures/a.png', {}], ['/home/u/Pictures/b.JPG', {}]])
    expect(toasts.map((toast) => toast.message)).toStrictEqual([UNSUPPORTED_DROP_MESSAGE])
  })

  it('reads the dropped clip files by path, up to the size of the clips that Dez stores, and puts their tags at the drop point', async () => {
    localFiles = new Map([
      ['/home/u/Pictures/a.png', png('a.png', 1)],
      ['/home/u/Videos/dance.mp4', clipFile('dance.mp4', '', 21)],
      ['/home/u/Music/song.MP3', clipFile('song.MP3', '', 22)],
    ])
    const editor = createEditor('one two', 0)

    dropFilePaths(editor.view, ['/home/u/Pictures/a.png', '/home/u/Videos/dance.mp4', '/home/u/Music/song.MP3'], { x: 4, y: 0 })

    const text = `${reference(1)}\n${clipTag('video', 'video/mp4', 21, 'b')}\n${clipTag('audio', 'audio/mpeg', 22, 'c')}`
    await vi.waitFor(() => expect(editor.doc()).toBe(`one \n${text}\ntwo`))
    expect(editor.view.state.selection.main.head).toBe('one \n'.length + text.length)
    expect(reads).toStrictEqual([
      ['/home/u/Pictures/a.png', {}],
      ['/home/u/Videos/dance.mp4', { maxBytes: MAX_SAVED_CLIP_BYTES }],
      ['/home/u/Music/song.MP3', { maxBytes: MAX_SAVED_CLIP_BYTES }],
    ])
    expect(toasts).toStrictEqual([])
  })

  it('leaves out a dropped clip that is larger than the clips that Dez stores', async () => {
    localFiles = new Map([['/tmp/a.png', png('a.png', 1)]])
    largeFiles = new Map([['/tmp/trip.mov', 1.5 * 1024 ** 3]])
    const editor = createEditor('', 0)

    dropFilePaths(editor.view, ['/tmp/trip.mov', '/tmp/a.png'], { x: 0, y: 0 })

    await vi.waitFor(() => expect(editor.doc()).toBe(reference(1)))
    expect(clipSaves).toStrictEqual([])
    expect(toasts).toStrictEqual([expect.objectContaining({ title: 'Clip not added', variant: 'warning' })])
    expect(toasts[0].message).toContain('trip.mov')
    expect(toasts[0].message).toContain('1.5 GB')
    expect(toasts[0].message).toContain('1.0 GB')
  })

  it('leaves out an image that cannot be read, with a warning', async () => {
    localFiles = new Map([['/tmp/a.png', png('a.png', 1)]])
    const editor = createEditor('', 0)

    dropFilePaths(editor.view, ['/tmp/gone.png', '/tmp/a.png'], { x: 0, y: 0 })

    await vi.waitFor(() => expect(editor.doc()).toBe(reference(1)))
    expect(toasts).toEqual([expect.objectContaining({
      title: 'Image not added',
      message: 'Dez cannot read gone.png: the file was moved or deleted, or Dez has no permission to read it. Check the file, and drop it again.'
        + '\n\nDetails: The file cannot be read (HTTP 404).',
      variant: 'warning',
    })])
  })

  it('puts a drop of links, with no local file, in as text', () => {
    const editor = createEditor('see ', 0)

    dropFilePaths(editor.view, ['https://example.com/a'], { x: 4, y: 0 })

    expect(editor.doc()).toBe('see https://example.com/a')
    expect(editor.view.state.selection.main.head).toBe(editor.doc().length)
    expect(reads).toStrictEqual([])
    expect(toasts).toEqual([])
  })

  it('links a dropped image and clip that are out of the temp and Dez folders, without reading or storing them', async () => {
    const photo = '/home/u/Pictures/My photo (1).JPG'
    const dance = '/home/u/Videos/dance.mp4'
    linkedPaths = new Set([photo, dance])
    fileSizes = new Map([[dance, 3]])
    const editor = createEditor('one two', 0)

    dropFilePaths(editor.view, [photo, dance], { x: 4, y: 0 })

    const linkedImage = imageMarkdown(photo, [{ key: 'id', value: 'a' }])
    const linkedClip = mediaTagText({ kind: 'video', id: 'b', type: 'video/mp4', src: dance, url: null, expires: null, other: [] })
    await vi.waitFor(() => expect(editor.doc()).toBe(`one \n${linkedImage}\n${linkedClip}\ntwo`))
    expect(reads).toStrictEqual([])
    expect(saveCalls).toStrictEqual([])
    expect(clipSaves).toStrictEqual([])
    expect(toasts).toStrictEqual([])
  })

  it('copies a dropped image of a type that Dez stores as a PNG, and a clip whose size it cannot read', async () => {
    linkedPaths = new Set(['/home/u/scan.bmp', '/home/u/song.mp3'])
    unsizedPaths = new Set(['/home/u/song.mp3'])
    localFiles = new Map([
      ['/home/u/scan.bmp', new File([new Uint8Array([66, 77])], 'scan.bmp', { type: 'image/bmp' })],
      ['/home/u/song.mp3', clipFile('song.mp3', '', 22)],
    ])
    redraw = async (_plan, mediaType) => ({ bytes: new Uint8Array([7, ...PNG_BYTES.subarray(1)]), mediaType, width: 4, height: 3 })
    const editor = createEditor('', 0)

    dropFilePaths(editor.view, ['/home/u/scan.bmp', '/home/u/song.mp3'], { x: 0, y: 0 })

    await vi.waitFor(() => expect(editor.doc()).toBe(`${reference(7)}\n${clipTag('audio', 'audio/mpeg', 22, 'b')}`))
    expect(reads.map(([path]) => path)).toStrictEqual(['/home/u/scan.bmp', '/home/u/song.mp3'])
    expect(consoleError).toHaveBeenCalledWith('Failed to read the size of a dropped clip:', expect.any(Error))
    expect(toasts).toStrictEqual([])
  })

  it('leaves out a linked clip that is larger than the clips that Dez stores, without reading it', async () => {
    linkedPaths = new Set(['/home/u/trip.mov', '/home/u/a.png'])
    fileSizes = new Map([['/home/u/trip.mov', 1.5 * 1024 ** 3]])
    const editor = createEditor('', 0)

    dropFilePaths(editor.view, ['/home/u/trip.mov', '/home/u/a.png'], { x: 0, y: 0 })

    await vi.waitFor(() => expect(editor.doc()).toBe(imageMarkdown('/home/u/a.png', [{ key: 'id', value: 'a' }])))
    expect(reads).toStrictEqual([])
    expect(toasts).toStrictEqual([expect.objectContaining({ title: 'Clip not added', variant: 'warning' })])
    expect(toasts[0].message).toContain('trip.mov')
    expect(toasts[0].message).toContain('1.5 GB')
  })
})

describe('image and clip ids', () => {
  const stored = (name: string, id?: string) => imageMarkdown(`${IMAGE_FOLDER}/${name}.png`, id ? [{ key: 'id', value: id }] : [])

  /** A one-section state with undo history, with the caret at the end. */
  function historyState(doc: string): EditorState {
    return EditorState.create({
      doc,
      selection: EditorSelection.cursor(doc.length),
      extensions: [filePasteAndDrop(), history(), sectionsField.init(() => [{ id: 's1', role: 'user' }]), pillsField.init(() => new Map())],
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

  it('gives a pasted clip a new id where it clashes, and its pasted mentions too, in one undo step', () => {
    const clip = (id: string) => mediaTagText({ kind: 'video', id, type: 'video/mp4', src: null, url: 'https://cdn.example/clip', expires: null, other: [] })
    const doc = `${stored('a', 'a')}\n`
    const state = historyState(doc)

    // The paste holds no image reference, and its tag ends at the caret.
    const pasted = state.update(clipboardPasteTransaction(state, `Make @a longer.\n<dez:pill type="agent"/>\n${clip('a')}`)).state

    expect(pasted.doc.toString()).toBe(`${doc}Make @b longer.\n${SECTION_SEP}\n${clip('b')}`)
    expect(pasted.selection.main.head).toBe(pasted.doc.length)
    expect(undoOnce(pasted).doc.toString()).toBe(doc)
  })

  it.each(['input.type', 'move.drop'])('leaves the images of an %s as they are', (userEvent) => {
    const doc = `${stored('b')} ${stored('a', 'a')} `
    const state = historyState(doc)

    const moved = state.update({ changes: [{ from: 0, to: stored('b').length }, { from: doc.length, insert: stored('b') }], userEvent }).state

    expect(moved.doc.toString()).toBe(` ${stored('a', 'a')} ${stored('b')}`)
  })
})
