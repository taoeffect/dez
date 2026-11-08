import sbp from '@sbp/sbp'
import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { EditorView, dropCursor } from '@codemirror/view'
import { SENTINEL_CHAR } from '../../model/chat/content'
import { imageMarkdown, isImageMediaType, type ImageMediaType } from '../../model/chat/images'
import { focusKeepingScroll } from './focus'

interface InsertRange {
  from: number
  to: number
}

interface StorableImage {
  bytes: Uint8Array
  mediaType: ImageMediaType
}

const addPendingInsert = StateEffect.define<{ id: string, range: InsertRange }>()
const removePendingInsert = StateEffect.define<string>()

/** The doc ranges that pasted or dropped images replace once their files
 *  are saved, by insert id. A range moves with the edits made during the
 *  save; text typed at its point goes before the images. A new state (tab
 *  switch, the rebuild at the end of a stream) starts with no ranges, so an
 *  insert whose id is gone knows that its doc is gone. */
const pendingInsertsField = StateField.define<ReadonlyMap<string, InsertRange>>({
  create: () => new Map(),
  update(ranges, tr) {
    let next = ranges
    if (tr.docChanged && next.size > 0) {
      next = new Map(Array.from(next, ([id, range]) => {
        const from = tr.changes.mapPos(range.from, 1)
        return [id, { from, to: Math.max(from, tr.changes.mapPos(range.to, -1)) }]
      }))
    }
    for (const effect of tr.effects) {
      if (effect.is(addPendingInsert)) {
        next = new Map(next).set(effect.value.id, effect.value.range)
      } else if (effect.is(removePendingInsert) && next.has(effect.value)) {
        const copy = new Map(next)
        copy.delete(effect.value)
        next = copy
      }
    }
    return next
  },
})

function hasFiles(data: DataTransfer | null): data is DataTransfer {
  return data?.types.includes('Files') ?? false
}

/** The files of a paste or a drop. Some clipboards list an image only in
 *  `items`, not in `files`. */
function transferredFiles(data: DataTransfer): File[] {
  if (data.files.length > 0) return Array.from(data.files)
  return Array.from(data.items).flatMap((item) => {
    const file = item.kind === 'file' ? item.getAsFile() : null
    return file ? [file] : []
  })
}

/** An image that the webview can decode, drawn again as a PNG. */
async function convertToPng(file: Blob): Promise<Uint8Array> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    // An SVG without a width and height has no size to draw at.
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('The image has no size.')
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('No canvas to draw the image on.')
    context.drawImage(img, 0, 0)
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!png) throw new Error('The image could not be converted to PNG.')
    return new Uint8Array(await png.arrayBuffer())
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** The bytes to store for an image file: the file as it is for a type that
 *  Dez stores (`isImageMediaType`), else a PNG of any other image that the
 *  webview can decode (BMP, TIFF, AVIF, SVG, …). Null, after a warning
 *  toast, when the file cannot be read or decoded. */
async function storableImage(file: File): Promise<StorableImage | null> {
  try {
    if (isImageMediaType(file.type)) return { bytes: new Uint8Array(await file.arrayBuffer()), mediaType: file.type }
    return { bytes: await convertToPng(file), mediaType: 'image/png' }
  } catch (error) {
    console.error('Failed to read the image:', error)
    sbp('dez.ui/toast', 'app-global', {
      title: 'Image not added',
      message: `Dez cannot read ${file.name || 'the image'} (${file.type}).`,
      variant: 'warning',
      duration: 8000,
    })
    return null
  }
}

/** Stores one image file. Null when it was not stored; the user has seen a
 *  toast. */
async function saveImageFile(file: File): Promise<string | null> {
  const image = await storableImage(file)
  if (!image) return null
  try {
    return await sbp('dez.controller/images/save', image.bytes, image.mediaType) as string
  } catch {
    // The save selector has logged the error and shown a toast.
    return null
  }
}

/** The text that puts `references` in place of `from`..`to`, and the caret
 *  offset in it. A line with a sentinel (a section separator, a prompt
 *  pill) shows no image (`findRenderedImages` in images.ts), so there the
 *  references get lines of their own. This also keeps a drop on a role
 *  pill out of the separator line, which must hold only the separator. */
function insertionText(state: EditorState, { from, to }: InsertRange, references: string): { insert: string, caret: number } {
  const before = state.sliceDoc(state.doc.lineAt(from).from, from)
  const after = state.sliceDoc(to, state.doc.lineAt(to).to)
  if (!SENTINEL_CHAR.test(before + after)) return { insert: references, caret: references.length }
  const prefix = before ? '\n' : ''
  const suffix = after ? '\n' : ''
  return { insert: prefix + references + suffix, caret: prefix.length + references.length }
}

/** Stores the image files, then puts their references (one per line, in
 *  file order) in place of `range` in one transaction, with the caret after
 *  them. The saves are async: the range follows the edits made meanwhile
 *  (`pendingInsertsField`). When the view no longer shows the doc of the
 *  paste or drop (another tab, or a rebuilt state), the images stay saved
 *  but are not inserted, and a toast says so. The active tab id is checked
 *  too, because right after a tab switch the view holds the old tab's
 *  state for a tick, and its edits would go to the new tab
 *  (`syncDocToStore` in ThreadEditor.vue). */
async function insertImages(view: EditorView, files: readonly File[], range: InsertRange, userEvent: 'input.paste' | 'input.drop'): Promise<void> {
  const id = crypto.randomUUID()
  const tabId = sbp('dez.model/tabs/activeId') as string
  view.dispatch({ effects: addPendingInsert.of({ id, range }) })
  const saved = await Promise.all(files.map(saveImageFile))
  const paths = saved.filter((path) => path !== null)
  const pending = view.state.field(pendingInsertsField, false)?.get(id)
  if (!pending || sbp('dez.model/tabs/activeId') !== tabId) {
    if (paths.length > 0) {
      sbp('dez.ui/toast', 'app-global', {
        title: paths.length === 1 ? 'Image not inserted' : 'Images not inserted',
        message: `The conversation changed while ${paths.length === 1 ? 'the image was' : 'the images were'} being saved.`,
        variant: 'warning',
        duration: 8000,
      })
    }
    return
  }
  if (paths.length === 0) {
    view.dispatch({ effects: removePendingInsert.of(id) })
    return
  }
  const { insert, caret } = insertionText(view.state, pending, paths.map(imageMarkdown).join('\n'))
  view.dispatch({
    changes: { from: pending.from, to: pending.to, insert },
    selection: { anchor: pending.from + caret },
    effects: removePendingInsert.of(id),
    scrollIntoView: true,
    userEvent,
  })
}

/** A paste with no plain text and with image files puts the images in
 *  place of the main selection. Plain text wins, so that an app that copies
 *  text and a picture of it (an office app) pastes text: the text paste
 *  (ThreadEditor.vue, or CodeMirror's own) takes it. Other paste data is
 *  left to CodeMirror. With many selections only the main one gets the
 *  images. */
export function pasteImages(event: ClipboardEvent, view: EditorView): boolean {
  const data = event.clipboardData
  if (!data || data.getData('text/plain')) return false
  const images = transferredFiles(data).filter((file) => file.type.startsWith('image/'))
  if (images.length === 0) return false
  const { from, to } = view.state.selection.main
  void insertImages(view, images, { from, to }, 'input.paste')
  return true
}

/** A drop of files puts the image files at the drop point, and leaves out
 *  every other file with a toast. CodeMirror's own drop would insert each
 *  file as text, so a file drop never reaches it. A drag with no files
 *  (text dragged in the editor) is CodeMirror's. */
export function dropImages(event: DragEvent, view: EditorView): boolean {
  const data = event.dataTransfer
  if (!hasFiles(data)) return false
  const files = transferredFiles(data)
  const images = files.filter((file) => file.type.startsWith('image/'))
  if (images.length === 0 || images.length < files.length) {
    sbp('dez.ui/toast', 'app-global', {
      message: 'Only image files can be dropped into a conversation.',
      duration: 5000,
    })
  }
  if (images.length > 0) {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false)
    focusKeepingScroll(view)
    void insertImages(view, images, { from: pos, to: pos }, 'input.drop')
  }
  return true
}

/** Paste and drop of images for the thread editor (`buildState()` in
 *  `ThreadEditor.vue`). The window refuses file drops outside the editor
 *  (AppLayout.vue). */
export function imagePasteAndDrop(): Extension {
  return [
    pendingInsertsField,
    dropCursor(),
    EditorView.domEventHandlers({
      paste: pasteImages,
      // Accepts a file drag over the text. The window refuses the ones that
      // no handler accepts.
      dragover(event) {
        if (!hasFiles(event.dataTransfer)) return false
        event.dataTransfer.dropEffect = 'copy'
        return true
      },
      drop: dropImages,
    }),
  ]
}
