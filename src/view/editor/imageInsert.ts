import sbp from '@sbp/sbp'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, dropCursor } from '@codemirror/view'
import { SENTINEL_CHAR } from '../../model/chat/content'
import { imageMarkdown, isImageMediaType, pastedImageIdChanges, type ImageMediaType } from '../../model/chat/images'
import { focusKeepingScroll } from './focus'
import { addPendingRange, pendingRange, pendingRanges, removePendingRange, type DocRange } from './pendingRanges'

interface StorableImage {
  bytes: Uint8Array
  mediaType: ImageMediaType
}

/** The dropped files, by path, that are read as images. A dropped file can
 *  be large, so the other files are left out without being read. */
const IMAGE_FILE_PATH = /\.(?:png|jpe?g|jfif|gif|webp|bmp|tiff?|avif|svg|ico|heic|heif|jxl)$/i

/** Gives each image reference that a paste or a drop brings into the doc
 *  an id of its own (`pastedImageIdChanges`), in the same transaction, so
 *  one undo removes the paste and its ids. This covers every paste and drop
 *  path: the images that `insertImages` puts in (with no id yet), the Dez
 *  clipboard paste and the plain-text paste (ThreadEditor.vue), and
 *  CodeMirror's own paste and text drop. A text drag inside the doc is a
 *  `move.drop`: its images keep their ids. */
const pastedImageIds = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !(tr.isUserEvent('input.paste') || tr.isUserEvent('input.drop'))) return tr
  const pasted: DocRange[] = []
  tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    if (toB > fromB) pasted.push({ from: fromB, to: toB })
  })
  // Only a paste with an image reference needs the whole-doc scan.
  if (!pasted.some(({ from, to }) => tr.newDoc.sliceString(from, to).includes('!['))) return tr
  const changes = pastedImageIdChanges(tr.newDoc.toString(), pasted)
  return changes.length === 0 ? tr : [tr, { changes, sequential: true }]
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

/** Stores one image file, or the file that `source` gives. Null when it was
 *  not stored; the user has seen a toast. */
async function saveImageFile(source: File | Promise<File | null>): Promise<string | null> {
  const file = await source
  if (!file) return null
  const image = await storableImage(file)
  if (!image) return null
  try {
    return await sbp('dez.controller/images/save', image.bytes, image.mediaType) as string
  } catch {
    // The save selector has logged the error and shown a toast.
    return null
  }
}

/** The text that puts `text` (image references, or dropped links) in place
 *  of `from`..`to`, and the caret offset in it. A line with a sentinel (a
 *  section separator, a prompt pill) shows no image (`findRenderedImages`
 *  in images.ts), so there the text gets lines of its own. This also keeps
 *  a drop on a role pill out of the separator line, which must hold only
 *  the separator. */
function insertionText(state: EditorState, { from, to }: DocRange, text: string): { insert: string, caret: number } {
  const before = state.sliceDoc(state.doc.lineAt(from).from, from)
  const after = state.sliceDoc(to, state.doc.lineAt(to).to)
  if (!SENTINEL_CHAR.test(before + after)) return { insert: text, caret: text.length }
  const prefix = before ? '\n' : ''
  const suffix = after ? '\n' : ''
  return { insert: prefix + text + suffix, caret: prefix.length + text.length }
}

/** Stores the image files, then puts their references (one per line, in
 *  file order) in place of `range` in one transaction, with the caret after
 *  them. The saves are async: the range follows the edits made meanwhile
 *  (`addPendingRange`). When the view no longer shows the doc of the
 *  paste or drop (another tab, or a rebuilt state), the images stay saved
 *  but are not inserted, and a toast says so. The active tab id is checked
 *  too, because right after a tab switch the view holds the old tab's
 *  state for a tick, and its edits would go to the new tab
 *  (`syncDocToStore` in ThreadEditor.vue). The references go in with no id:
 *  `pastedImageIds` gives each one the next id in this same transaction,
 *  from the doc as it is then, so two inserts in flight never take the same
 *  id. */
async function insertImages(view: EditorView, files: ReadonlyArray<File | Promise<File | null>>, range: DocRange, userEvent: 'input.paste' | 'input.drop'): Promise<void> {
  const tabId = sbp('dez.model/tabs/activeId') as string
  const id = addPendingRange(view, range)
  const saved = await Promise.all(files.map(saveImageFile))
  const paths = saved.filter((path) => path !== null)
  const pending = pendingRange(view.state, id)
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
    view.dispatch({ effects: removePendingRange(id) })
    return
  }
  const { insert, caret } = insertionText(view.state, pending, paths.map((path) => imageMarkdown(path)).join('\n'))
  view.dispatch({
    changes: { from: pending.from, to: pending.to, insert },
    selection: { anchor: pending.from + caret },
    effects: removePendingRange(id),
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

function showNonImageDropToast(): void {
  sbp('dez.ui/toast', 'app-global', {
    message: 'Only image files can be dropped into a conversation.',
    duration: 5000,
  })
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
  if (images.length === 0 || images.length < files.length) showNonImageDropToast()
  if (images.length > 0) {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false)
    focusKeepingScroll(view)
    void insertImages(view, images, { from: pos, to: pos }, 'input.drop')
  }
  return true
}

/** Reads a dropped image file by its path. Null, after a warning toast,
 *  when it cannot be read. */
async function readDroppedImage(path: string): Promise<File | null> {
  try {
    return await sbp('dez.controller/images/readFile', path) as File
  } catch (error) {
    console.error('Failed to read the dropped image:', error)
    sbp('dez.ui/toast', 'app-global', {
      title: 'Image not added',
      message: `Dez cannot read ${path.slice(path.lastIndexOf('/') + 1)}.`,
      variant: 'warning',
      duration: 8000,
    })
    return null
  }
}

/** A drop from Tauri's native file drop (Linux only: tauri.linux.conf.json,
 *  see run() in src-tauri/src/lib.rs), at `point` in the page. As in
 *  `dropImages`, the image files go to the drop point and every other file
 *  is left out with a toast; the images are read by path. wry passes a URI
 *  that is not a `file://` URI as it is: a drop with no local path (a link
 *  dragged from a browser) goes in as text, as WebKit's own drop does. */
export function dropFilePaths(view: EditorView, paths: readonly string[], point: { x: number, y: number }): void {
  if (paths.length === 0) return
  const pos = view.posAtCoords(point, false)
  focusKeepingScroll(view)
  const localPaths = paths.filter((path) => path.startsWith('/'))
  if (localPaths.length === 0) {
    const { insert, caret } = insertionText(view.state, { from: pos, to: pos }, paths.join('\n'))
    view.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + caret }, scrollIntoView: true, userEvent: 'input.drop' })
    return
  }
  const images = localPaths.filter((path) => IMAGE_FILE_PATH.test(path))
  if (images.length < paths.length) showNonImageDropToast()
  if (images.length > 0) void insertImages(view, images.map(readDroppedImage), { from: pos, to: pos }, 'input.drop')
}

/** Paste and drop of images for the thread editor (`buildState()` in
 *  `ThreadEditor.vue`), and the ids of pasted and dropped images. The
 *  window refuses file drops outside the editor (AppLayout.vue). */
export function imagePasteAndDrop(): Extension {
  return [
    pendingRanges(),
    pastedImageIds,
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
