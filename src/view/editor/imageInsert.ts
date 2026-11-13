import sbp from '@sbp/sbp'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, dropCursor } from '@codemirror/view'
import { SENTINEL_CHAR } from '../../model/chat/content'
import { wholeImageDrawing, type DrawnImage } from '../../model/chat/imageDrawing'
import { imageMarkdown, isImageMediaType, isLinkedImagePath, type ImageMediaType } from '../../model/chat/images'
import { CLIP_FILE_EXTENSIONS, FileTooLargeError, MAX_SAVED_CLIP_BYTES, storableClip } from '../../model/chat/mediaFiles'
import { newMediaIds, pastedMediaIdChanges } from '../../model/chat/mediaIds'
import { MEDIA_TAG_NAMES, isLinkedMediaPath, mediaTagText, type MediaTagKind } from '../../model/chat/mediaTags'
import { byteSizeText } from '../../utils/byteSize'
import { errorText, rawErrorText } from '../../utils/errorText'
import { fileNameOf } from '../../utils/fileName'
import { SECTION_SEP, sectionsField } from '../thread/cmEditor'
import { focusKeepingScroll } from './focus'
import { addPendingRange, pendingRange, pendingRanges, removePendingRange, type DocRange } from './pendingRanges'

interface StorableImage {
  bytes: Uint8Array
  mediaType: ImageMediaType
}

/** The kind and the media type of a clip file (`storableClip`). */
interface StorableClip {
  kind: MediaTagKind
  type: string
}

/** A pasted or dropped file that Dez stored or linked: its absolute path,
 *  and the kind and media type of a clip (null for an image). */
interface AddedFile {
  path: string
  clip: StorableClip | null
}

/** What a pasted or dropped file is to Dez. */
type AssetKind = 'image' | 'clip'

/** The dropped files, by path, that are read as images. A dropped file can
 *  be large, so a file that is no image and no clip (`storableClip`) is
 *  left out without being read. */
const IMAGE_FILE_PATH = /\.(?:png|jpe?g|jfif|gif|webp|bmp|tiff?|avif|svg|ico|heic|heif|jxl)$/i

/** The start of every text that has an id of the one id sequence: an image
 *  reference, and a media tag of each kind. */
const ASSET_STARTS: readonly string[] = ['![', ...MEDIA_TAG_NAMES.map((name) => `<${name}`)]

/** Gives each image reference and each media tag that a paste or a drop
 *  brings into the doc an id of its own (`pastedMediaIdChanges`), in the
 *  same transaction, so one undo removes the paste and its ids. This covers
 *  every paste and drop path: the Dez clipboard paste and the plain-text
 *  paste (ThreadEditor.vue), which bring the ids of the tab that the text
 *  was copied in, and CodeMirror's own paste and text drop. The files that
 *  `insertFiles` puts in have new ids already, so they keep them. A text
 *  drag inside the doc is a `move.drop`: its images and clips keep their
 *  ids. */
const pastedMediaIds = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !(tr.isUserEvent('input.paste') || tr.isUserEvent('input.drop'))) return tr
  const pasted: DocRange[] = []
  tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    if (toB > fromB) pasted.push({ from: fromB, to: toB })
  })
  // Only a paste with an image reference or a media tag needs the whole-doc
  // scan.
  const holdsAsset = pasted.some(({ from, to }) => {
    const text = tr.newDoc.sliceString(from, to)
    return ASSET_STARTS.some((start) => text.includes(start))
  })
  if (!holdsAsset) return tr
  const changes = pastedMediaIdChanges(tr.newDoc.toString(), pasted)
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

function showNotAddedToast(asset: AssetKind, message: string): void {
  sbp('dez.ui/toast', 'app-global', { title: asset === 'image' ? 'Image not added' : 'Clip not added', message, variant: 'warning', duration: 8000 })
}

/** The warning for a clip file that is larger than the clips that Dez
 *  stores (`MAX_SAVED_CLIP_BYTES`, the limit of Save too). */
function showClipTooLargeToast(name: string, size: number): void {
  showNotAddedToast('clip', `Dez cannot add ${name || 'the clip'}: the file is ${byteSizeText(size)}, and Dez stores clips of up to ${byteSizeText(MAX_SAVED_CLIP_BYTES)}. `
    + 'Make the clip smaller with another app (shorter, or at a lower quality), and add it again.')
}

/** The bytes to store for an image file: the file as it is for a type that
 *  Dez stores (`isImageMediaType`, SVG too), else a PNG of any other image
 *  that the webview can decode (BMP, TIFF, AVIF, …), whole and at its own
 *  size. Null, after a warning toast, when the file cannot be read or
 *  decoded. */
async function storableImage(file: File): Promise<StorableImage | null> {
  try {
    if (isImageMediaType(file.type)) return { bytes: new Uint8Array(await file.arrayBuffer()), mediaType: file.type }
    // Never null: the plan gives a drawing for every size.
    const png = await sbp('dez.controller/images/redraw', file, wholeImageDrawing, 'image/png') as DrawnImage
    return { bytes: png.bytes, mediaType: png.mediaType }
  } catch (error) {
    console.error('Failed to read the image:', error)
    showNotAddedToast('image', errorText(
      `Dez cannot read ${file.name || 'the image'} (${file.type}). The file can be damaged, or of a type that Dez cannot read. Save it as a PNG or JPEG file, and add it again.`,
      rawErrorText(error),
    ))
    return null
  }
}

/** Stores one image file, or the file that `source` gives. Null when it was
 *  not stored; the user has seen a toast. */
async function storeImage(source: File | Promise<File | null>): Promise<AddedFile | null> {
  const file = await source
  if (!file) return null
  const image = await storableImage(file)
  if (!image) return null
  try {
    return { path: await sbp('dez.controller/images/save', image.bytes, image.mediaType) as string, clip: null }
  } catch {
    // The save selector has logged the error and shown a toast.
    return null
  }
}

/** Stores one clip file, or the file that `source` gives, as a clip of
 *  `clip` in the pasted clip folder of its kind. A file that is larger than
 *  the clips that Dez stores is not read. Null when it was not stored; the
 *  user has seen a toast. */
async function storeClip(source: File | Promise<File | null>, clip: StorableClip): Promise<AddedFile | null> {
  const file = await source
  if (!file) return null
  if (file.size > MAX_SAVED_CLIP_BYTES) {
    showClipTooLargeToast(file.name, file.size)
    return null
  }
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await file.arrayBuffer())
  } catch (error) {
    console.error('Failed to read the clip:', error)
    showNotAddedToast('clip', errorText(
      `Dez cannot read ${file.name || 'the clip'}: the file was moved or deleted, or Dez has no permission to read it. Check the file, and add it again.`,
      rawErrorText(error),
    ))
    return null
  }
  try {
    const path = await sbp('dez.controller/media/save', { kind: clip.kind, type: clip.type, src: null, url: null }, { bytes, folder: 'pasted' }) as string
    return { path, clip }
  } catch {
    // The save selector has logged the error and shown a toast.
    return null
  }
}

/** Starts to store a pasted or dropped file: an image (any `image/` type),
 *  or a clip (`storableClip`). Null for any other file, which Dez does not
 *  store. */
function storeFile(file: File): Promise<AddedFile | null> | null {
  if (file.type.startsWith('image/')) return storeImage(file)
  const clip = storableClip(file.type, file.name)
  return clip && storeClip(file, clip)
}

/** Gives the dropped file at `path` (or at the path that `path` gives;
 *  null: not known, or the drop must copy) as a linked file
 *  (src/model/chat/linkedFiles.ts), the image or the clip `clip` (null: an
 *  image), when its path has the linked form and it is not in a temp folder
 *  or a folder of Dez (`dez.controller/images/linkPath`); an image of a
 *  type that Dez converts to PNG has no linked form. The form test comes
 *  first, so a path that can never be linked makes no native call. Else
 *  gives the store that `store` starts, and Dez copies the file. A clip
 *  larger than the clips that Dez stores is not linked either: null, after
 *  a toast. `clipSize` is the size of the clip when the drop knows it;
 *  else Dez asks it. */
async function linkOrStore(path: string | null | Promise<string | null>, clip: StorableClip | null, store: () => Promise<AddedFile | null>, clipSize?: number): Promise<AddedFile | null> {
  const dropped = await path
  if (dropped === null || !(clip === null ? isLinkedImagePath(dropped) : isLinkedMediaPath(dropped))) return await store()
  if (await sbp('dez.controller/images/linkPath', dropped) === null) return await store()
  if (clip !== null) {
    let size: number | null
    try {
      size = clipSize ?? await sbp('dez.controller/images/fileSize', dropped) as number | null
    } catch (error) {
      // The copy reads the file, and tells the user why it cannot.
      console.error('Failed to read the size of a dropped clip:', error)
      return await store()
    }
    if (size !== null && size > MAX_SAVED_CLIP_BYTES) {
      showClipTooLargeToast(fileNameOf(dropped), size)
      return null
    }
  }
  return { path: dropped, clip }
}

/** Starts to add a file of an HTML5 drop (macOS), as `storeFile` does,
 *  but links it when `pathOf` gives its path (`linkOrStore`). A clip's size
 *  is `file.size`: `pairDroppedFiles` gave only a path with that size. */
function dropFile(file: File, pathOf: () => Promise<string | null>): Promise<AddedFile | null> | null {
  if (file.type.startsWith('image/')) return linkOrStore(pathOf(), null, () => storeImage(file))
  const clip = storableClip(file.type, file.name)
  return clip && linkOrStore(pathOf(), clip, () => storeClip(file, clip), file.size)
}

/** Whether a drop at `pos` may link its files: only when `pos` is in a user
 *  section. A linked path counts only in a user section (linkedFiles.ts),
 *  so a file dropped into an agent section is copied, or it would show as
 *  its source text and go to no request. The section of `pos` is the count
 *  of the separators before it; a drop on a separator line goes into that
 *  section too (`insertionText`). With no `sectionsField`, a drop copies. */
function dropMayLink(state: EditorState, pos: number): boolean {
  const index = state.sliceDoc(0, pos).split(SECTION_SEP).length - 1
  return state.field(sectionsField, false)?.[index]?.role === 'user'
}

/** Reads a dropped file by its path; a clip only when it is not larger
 *  than the clips that Dez stores. Null, after a warning toast, when it
 *  cannot be read or is too large. */
async function readDroppedFile(path: string, asset: AssetKind): Promise<File | null> {
  try {
    return await sbp('dez.controller/images/readFile', path, asset === 'clip' ? { maxBytes: MAX_SAVED_CLIP_BYTES } : {}) as File
  } catch (error) {
    console.error(`Failed to read the dropped ${asset}:`, error)
    if (error instanceof FileTooLargeError) {
      showClipTooLargeToast(fileNameOf(path), error.size)
    } else {
      showNotAddedToast(asset, errorText(
        `Dez cannot read ${fileNameOf(path)}: the file was moved or deleted, or Dez has no permission to read it. Check the file, and drop it again.`,
        rawErrorText(error),
      ))
    }
    return null
  }
}

/** Starts to add a dropped file by its path: an image by its extension
 *  (`IMAGE_FILE_PATH`), or a clip (`storableClip`), linked (when `mayLink`)
 *  or stored (`linkOrStore`). Null for any other file, which is not read. */
function dropPath(path: string, mayLink: boolean): Promise<AddedFile | null> | null {
  const linkPath = mayLink ? path : null
  if (IMAGE_FILE_PATH.test(path)) return linkOrStore(linkPath, null, () => storeImage(readDroppedFile(path, 'image')))
  const clip = storableClip('', path)
  return clip && linkOrStore(linkPath, clip, () => storeClip(readDroppedFile(path, 'clip'), clip))
}

/** The text of an added file in the doc, with the id `id`: an image
 *  reference, or a media tag. */
function addedFileText({ path, clip }: AddedFile, id: string): string {
  if (clip === null) return imageMarkdown(path, [{ key: 'id', value: id }])
  return mediaTagText({ kind: clip.kind, id, type: clip.type, src: path, url: null, expires: null, other: [] })
}

/** The text that puts `text` (image references and media tags, or dropped
 *  links) in place of `from`..`to`, and the caret offset in it. With
 *  `ownLines` (a text that holds a media tag, which is a tag only as a
 *  whole line: mediaTags.ts), the text gets lines of its own. So does it on
 *  a line with a sentinel (a section separator, a prompt pill), which shows
 *  no image (`findRenderedImages` in images.ts). This also keeps a drop on
 *  a role pill out of the separator line, which must hold only the
 *  separator. */
function insertionText(state: EditorState, { from, to }: DocRange, text: string, ownLines = false): { insert: string, caret: number } {
  const before = state.sliceDoc(state.doc.lineAt(from).from, from)
  const after = state.sliceDoc(to, state.doc.lineAt(to).to)
  if (!ownLines && !SENTINEL_CHAR.test(before + after)) return { insert: text, caret: text.length }
  const prefix = before ? '\n' : ''
  const suffix = after ? '\n' : ''
  return { insert: prefix + text + suffix, caret: prefix.length + text.length }
}

/** The warning for added files that a paste or a drop did not insert,
 *  worded for images, clips, or both. */
function showNotInsertedToast(stored: readonly AddedFile[], userEvent: 'input.paste' | 'input.drop'): void {
  const clipCount = stored.filter((file) => file.clip !== null).length
  const counted = (count: number, word: string) => (count === 0 ? [] : [count === 1 ? word : `${word}s`])
  const what = [...counted(stored.length - clipCount, 'image'), ...counted(clipCount, 'clip')].join(' and ')
  const one = stored.length === 1
  sbp('dez.ui/toast', 'app-global', {
    title: `${what[0].toUpperCase()}${what.slice(1)} not inserted`,
    message: `The conversation changed while the ${what} ${one ? 'was' : 'were'} being added, so Dez did not insert ${one ? 'it' : 'them'}. `
      + `${userEvent === 'input.paste' ? 'Paste' : 'Drop'} ${one ? 'it' : 'them'} again.`,
    variant: 'warning',
    duration: 8000,
  })
}

/** Waits for the stores and links of the files of a paste or a drop
 *  (`storeFile`, `dropFile`, `dropPath`), then puts the image references
 *  and the media tags of the added files (one per line, in file order) in
 *  place of `range` in one transaction, with the caret after them. The
 *  stores are async: the range follows the edits made meanwhile
 *  (`addPendingRange`), and when its text changed, the files go after it
 *  and the new text stays. When the view no longer shows the doc of the
 *  paste or drop (another tab, or a rebuilt state), the stored files stay
 *  stored (and linked files where they are) but are not inserted, and a
 *  toast says so. Each file gets its id at the dispatch (`newMediaIds`, from
 *  the doc as it is then), as a tag with no id is no tag; so two inserts in
 *  flight never take the same id. */
async function insertFiles(view: EditorView, stores: ReadonlyArray<Promise<AddedFile | null>>, range: DocRange, userEvent: 'input.paste' | 'input.drop'): Promise<void> {
  const replacedText = view.state.sliceDoc(range.from, range.to)
  const id = addPendingRange(view, range)
  const stored = (await Promise.all(stores)).filter((file) => file !== null)
  const pending = pendingRange(view.state, id)
  if (!pending) {
    if (stored.length > 0) showNotInsertedToast(stored, userEvent)
    return
  }
  if (stored.length === 0) {
    view.dispatch({ effects: removePendingRange(id) })
    return
  }
  // An edit during the save that replaced the selection (typing, a text
  // paste, another file paste) maps the range onto its own new text
  // (ChangeDesc.mapPos): keep that text, and put the files after it.
  const target = view.state.sliceDoc(pending.from, pending.to) === replacedText ? pending : { from: pending.to, to: pending.to }
  const ids = newMediaIds([view.state.doc.toString()], stored.length)
  const text = stored.map((file, index) => addedFileText(file, ids[index])).join('\n')
  const { insert, caret } = insertionText(view.state, target, text, stored.some((file) => file.clip !== null))
  view.dispatch({
    changes: { from: target.from, to: target.to, insert },
    selection: { anchor: target.from + caret },
    effects: removePendingRange(id),
    scrollIntoView: true,
    userEvent,
  })
}

/** A paste with no plain text and with image or clip files puts them in
 *  place of the main selection; other files are left out. Plain text wins,
 *  so that an app that copies text and a picture of it (an office app)
 *  pastes text: the text paste (ThreadEditor.vue, or CodeMirror's own)
 *  takes it. Other paste data is left to CodeMirror. With many selections
 *  only the main one gets the files. */
export function pasteFiles(event: ClipboardEvent, view: EditorView): boolean {
  const data = event.clipboardData
  if (!data || data.getData('text/plain')) return false
  const stores = transferredFiles(data).map(storeFile).filter((store) => store !== null)
  if (stores.length === 0) return false
  const { from, to } = view.state.selection.main
  void insertFiles(view, stores, { from, to }, 'input.paste')
  return true
}

// The clip file extensions as a list in a sentence: `a, b, or c`.
const CLIP_EXTENSIONS_TEXT = `${CLIP_FILE_EXTENSIONS.slice(0, -1).join(', ')}, or ${CLIP_FILE_EXTENSIONS.at(-1)}`

function showUnsupportedDropToast(): void {
  sbp('dez.ui/toast', 'app-global', {
    message: `Only images and audio and video clips can be dropped into a conversation. Clips must be ${CLIP_EXTENSIONS_TEXT} files.`,
    duration: 8000,
  })
}

/** A drop of files puts the image and clip files at the drop point, and
 *  leaves out every other file with a toast. CodeMirror's own drop would
 *  insert each file as text, so a file drop never reaches it. A drag with
 *  no files (text dragged in the editor) is CodeMirror's. The drop event
 *  gives no paths, so they are read once per drop, and only when the drop
 *  has an image or a clip and may link it (`dropMayLink`,
 *  `dez.controller/images/droppedFilePaths`). */
export function dropFiles(event: DragEvent, view: EditorView): boolean {
  const data = event.dataTransfer
  if (!hasFiles(data)) return false
  const files = transferredFiles(data)
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false)
  const mayLink = dropMayLink(view.state, pos)
  let paths: Promise<(string | null)[]> | undefined
  const stores = files
    .map((file, index) => dropFile(file, async () => {
      if (!mayLink) return null
      paths ??= sbp('dez.controller/images/droppedFilePaths', files) as Promise<(string | null)[]>
      return (await paths)[index]
    }))
    .filter((store) => store !== null)
  if (stores.length === 0 || stores.length < files.length) showUnsupportedDropToast()
  if (stores.length > 0) {
    focusKeepingScroll(view)
    void insertFiles(view, stores, { from: pos, to: pos }, 'input.drop')
  }
  return true
}

/** A drop from Tauri's native file drop (Linux only: tauri.linux.conf.json,
 *  see run() in src-tauri/src/lib.rs), at `point` in the page. As in
 *  `dropFiles`, the image and clip files go to the drop point and every
 *  other file is left out with a toast; the files are linked (in a user
 *  section only: `dropMayLink`), or read by path (`dropPath`). wry passes a
 *  URI that is not a `file://` URI as it is: a drop with no local path (a
 *  link dragged from a browser) goes in as text, as WebKit's own drop
 *  does. */
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
  const mayLink = dropMayLink(view.state, pos)
  const stores = localPaths.map((path) => dropPath(path, mayLink)).filter((store) => store !== null)
  if (stores.length < paths.length) showUnsupportedDropToast()
  if (stores.length > 0) void insertFiles(view, stores, { from: pos, to: pos }, 'input.drop')
}

/** Paste and drop of images and clips for the thread editor (`buildState()`
 *  in `ThreadEditor.vue`), and the ids of the images and clips that a
 *  paste or a drop brings in. The window refuses file drops outside the
 *  editor (AppLayout.vue). */
export function filePasteAndDrop(): Extension {
  return [
    pendingRanges(),
    pastedMediaIds,
    dropCursor(),
    EditorView.domEventHandlers({
      paste: pasteFiles,
      // Accepts a file drag over the text. The window refuses the ones that
      // no handler accepts.
      dragover(event) {
        if (!hasFiles(event.dataTransfer)) return false
        event.dataTransfer.dropEffect = 'copy'
        return true
      },
      drop: dropFiles,
    }),
  ]
}
