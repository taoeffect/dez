import sbp from '@sbp/sbp'
import { convertFileSrc, isTauri } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { changeColors } from '../model/chat/imageColors'
import { svgOfPng, UnwritableImageTypeError, type DrawnImage, type DrawnMediaType, type ImageDrawing, type ImageSize } from '../model/chat/imageDrawing'
import { IMAGE_FOLDERS, imageExtension, storedImageFile, type ImageFolder, type ImageMediaType } from '../model/chat/images'
import { dropCopiesFile, pairDroppedFiles } from '../model/chat/linkedFiles'
import { FileTooLargeError } from '../model/chat/mediaFiles'
import { newStoredFilePath } from '../model/chat/storedFilePaths'
import { ExplainedError, errorText, rawErrorText } from '../utils/errorText'
import { fileNameOf } from '../utils/fileName'

// The quality of a drawn JPEG or WebP, from 0 to 1: high, so that a second
// encoding of a photo shows no new marks.
const LOSSY_QUALITY = 0.95

let fileDropsWatched = false

// The canonical folders whose dropped files Dez copies (`dropCopiesFile`):
// the temp folders of the OS, the app folder, and the cache root. They do
// not change while Dez runs, so they are read once; a failed read is tried
// again at the next drop.
let dropCopyFolders: Promise<string[]> | null = null

function copyFolders(): Promise<string[]> {
  dropCopyFolders ??= Promise.all([
    sbp('dez.native/tempFolders') as Promise<string[]>,
    ...(['app', 'cache'] as const).map(async (root) =>
      await sbp('dez.native/canonicalPath', await sbp('dez.native/getAppDir', root)) as string),
  ]).then(([temp, ...dez]) => [...temp, ...dez])
  dropCopyFolders.catch(() => { dropCopyFolders = null })
  return dropCopyFolders
}

export default sbp('sbp/selectors/register', {
  // Stores the bytes of an image under a new name in an image folder
  // (`pasted` for pasted and dropped images, `generated` for the images that
  // image models make), and returns the absolute path for its reference
  // (`imageMarkdown` in src/model/chat/images.ts). A failure is logged,
  // shows an error toast, and rejects, so the caller inserts no reference.
  async 'dez.controller/images/save' (
    bytes: Uint8Array,
    mediaType: ImageMediaType,
    { folder = 'pasted' }: { folder?: ImageFolder } = {},
  ): Promise<string> {
    try {
      const file = `${IMAGE_FOLDERS[folder]}/${crypto.randomUUID()}.${imageExtension(mediaType)}`
      const path = newStoredFilePath(await sbp('dez.native/getAppDir') as string, file, 'image')
      await sbp('dez.native/saveAppFile', file, bytes)
      return path
    } catch (error) {
      console.error('Failed to save the image:', error)
      sbp('dez.ui/toast', 'app-global', {
        title: 'Could not save the image',
        message: error instanceof ExplainedError
          ? error.message
          : errorText('The system did not let Dez write the image file. The details tell why (for example, the disk is full). Fix that, and try again.', rawErrorText(error)),
        variant: 'error',
      })
      throw error
    }
  },

  // Deletes the file of an image reference's path. Only a stored image of
  // this Dez folder, pasted or generated, is deleted (`storedImageFile`); any
  // other path (a reference copied from another home) deletes no file, as
  // the file of that name here belongs to another image. A missing file is
  // not an error. A failure is logged, shows an error toast, and rejects, so
  // the caller keeps the reference.
  async 'dez.controller/images/delete' (path: string): Promise<void> {
    try {
      const file = storedImageFile(path, await sbp('dez.native/getAppDir') as string)
      if (file) await sbp('dez.native/deleteAppFile', file)
    } catch (error) {
      console.error(`Failed to delete the image ${path}:`, error)
      sbp('dez.ui/toast', 'app-global', {
        title: 'Could not delete the image',
        message: errorText('The system did not let Dez delete the image file. The details tell why (for example, Dez has no permission to change the folder). Fix that, and try again.', rawErrorText(error)),
        variant: 'error',
      })
      throw error
    }
  },

  // The URL that loads a stored or linked image in the webview through
  // Tauri's asset protocol. Views use this selector because they may not
  // import Tauri APIs.
  'dez.controller/images/displayUrl' (path: string): string {
    return convertFileSrc(path)
  },

  // The size in bytes of the file at the absolute path `path` (a file that
  // `readFile` can read), from one request of its first byte: the asset
  // protocol gives the whole size after the `/` of `Content-Range` (in a
  // 206, and in the 416 of an empty file). So a view can show the size of a
  // file with no read of the whole file. Null when the answer has no size,
  // such as for a missing file. The body is not read: a server that does
  // not take ranges sends the whole file. Rejects when the request fails.
  async 'dez.controller/images/fileSize' (path: string): Promise<number | null> {
    const response = await fetch(convertFileSrc(path), { headers: { Range: 'bytes=0-0' } })
    response.body?.cancel().catch((error: unknown) => {
      console.error('Failed to stop the answer of a file size request:', error)
    })
    const total = /\/(\d+)\s*$/.exec(response.headers.get('Content-Range') ?? '')?.[1]
    return total === undefined ? null : Number(total)
  },

  // Reads a file by its absolute path through the asset protocol, whose
  // scope is the whole file system (tauri.conf.json): a stored image, a
  // media clip, a linked file (src/model/chat/linkedFiles.ts), or a file of
  // a native file drop. The protocol takes the type from the bytes, and for
  // a file with no magic number, such as `.svg`, from the extension. With
  // `maxBytes`, a larger file is not read: one request asks its size first
  // (`dez.controller/images/fileSize`), and when that gives no size, the
  // size of the bytes read is checked. Rejects when the file cannot be
  // read, and with a `FileTooLargeError` that tells the size when it is too
  // large; the error holds no path, as a tool can give its text to a chat
  // provider.
  async 'dez.controller/images/readFile' (path: string, { maxBytes }: { maxBytes?: number } = {}): Promise<File> {
    if (maxBytes !== undefined) {
      const size = await sbp('dez.controller/images/fileSize', path) as number | null
      if (size !== null && size > maxBytes) throw new FileTooLargeError(size, maxBytes)
    }
    const url = convertFileSrc(path)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`The file cannot be read (HTTP ${response.status}).`)
    const blob = await response.blob()
    if (maxBytes !== undefined && blob.size > maxBytes) throw new FileTooLargeError(blob.size, maxBytes)
    return new File([blob], fileNameOf(path), { type: blob.type })
  },

  // The path by which a drop links the dropped file at `path` (an absolute
  // path), or null when the drop must copy the file: it is in a temp folder
  // or a folder of Dez (`dropCopiesFile`, src/model/chat/linkedFiles.ts),
  // or its canonical path cannot be read (a missing file, which the copy
  // then reports). The check reads the canonical paths, so a link or a `..`
  // cannot hide a temp folder. The link keeps the path as the drop gave it,
  // which is the path that the user knows (on Fedora Atomic, `/home` is a
  // link to `/var/home`).
  async 'dez.controller/images/linkPath' (path: string): Promise<string | null> {
    try {
      const [canonical, folders] = await Promise.all([
        sbp('dez.native/canonicalPath', path) as Promise<string>,
        copyFolders(),
      ])
      return dropCopiesFile(canonical, folders) ? null : path
    } catch (error) {
      // The native error names no path; the path stays out of the log.
      console.error('Failed to tell whether to link or copy a dropped file:', error)
      return null
    }
  },

  // The paths of the files of an HTML5 drop (macOS), in the order of
  // `files`; null for a file whose path is not known. The drop event gives
  // no path, so the paths come from the drag pasteboard
  // (`dez.native/draggedFilePaths`), and pair up with the files by name and
  // size (`pairDroppedFiles`). Only the size of a path whose name is the
  // name of a dropped file is read. A failure gives null paths: the drop
  // then copies the files.
  async 'dez.controller/images/droppedFilePaths' (files: readonly File[]): Promise<(string | null)[]> {
    let paths: string[]
    try {
      paths = await sbp('dez.native/draggedFilePaths') as string[]
    } catch (error) {
      console.error('Failed to read the paths of the dragged files:', error)
      return files.map(() => null)
    }
    const names = new Set(files.map((file) => file.name.normalize('NFC')))
    const dragged = await Promise.all(paths
      .filter((path) => names.has(fileNameOf(path).normalize('NFC')))
      .map(async (path) => {
        try {
          return { path, size: await sbp('dez.controller/images/fileSize', path) as number | null }
        } catch (error) {
          console.error('Failed to read the size of a dragged file:', error)
          return { path, size: null }
        }
      }))
    return pairDroppedFiles(files, dragged)
  },

  // Draws an image again in the webview: decodes `file` (an image of any
  // type that the webview reads), asks `plan` what to draw for an image of
  // that size (a part of it, at another size, mirrored or turned, on a
  // background, with changed colors), and gives the drawing as a file of
  // the type that the drawing names, else of `mediaType`; the result tells
  // that type, so that the caller saves or sends the bytes under it. Null
  // when `plan` gives null: the image stays as it is, and nothing is drawn.
  // There is no Rust code for this: the webview has the decoders. Rejects
  // when the webview cannot decode the image, when `plan` throws, and when
  // the drawing cannot be made, with an `UnwritableImageTypeError` when the
  // canvas does not write the type; the caller logs it, as each caller has
  // its own answer to a failure.
  async 'dez.controller/images/redraw' (
    file: Blob,
    plan: (size: ImageSize) => ImageDrawing | null,
    mediaType: DrawnMediaType,
  ): Promise<DrawnImage | null> {
    const url = URL.createObjectURL(file)
    try {
      const img = new Image()
      img.src = url
      // A tool gives the message of this error to a model, so the message
      // says what failed; the webview's own error is the cause.
      await img.decode().catch((error: unknown) => {
        throw new Error('The image cannot be decoded.', { cause: error })
      })
      // WebKit gives every image that it decodes a size (an SVG with no
      // width and height gets its viewBox size in WebKitGTK 2.52, and
      // 300 × 150 fitted to its viewBox in 2.54), so this only keeps a plan
      // from a size of 0.
      if (!img.naturalWidth || !img.naturalHeight) throw new Error('The image has no size.')
      const drawing = plan({ width: img.naturalWidth, height: img.naturalHeight })
      if (!drawing) return null

      const canvas = document.createElement('canvas')
      canvas.width = drawing.width
      canvas.height = drawing.height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('No canvas to draw the image on.')
      context.imageSmoothingQuality = 'high'
      if (drawing.background) {
        context.fillStyle = drawing.background
        context.fillRect(0, 0, drawing.width, drawing.height)
      }
      const { crop, flip, turn, partSize } = drawing
      const part = partSize ?? drawing
      // A drawing that only crops and scales gets no transform, so that
      // each file keeps the bytes of its earlier drawings: a request sends
      // the drawing, and the provider's prompt cache needs the same bytes.
      const moved = flip !== undefined || turn !== undefined || partSize !== undefined
      if (moved) {
        // The part is drawn from (0, 0), with these steps in reverse order:
        // its center to the origin, the mirror and the turn about the
        // origin, and the origin to the center of the canvas.
        context.translate(drawing.width / 2, drawing.height / 2)
        if (turn) context.rotate(turn * Math.PI / 180)
        if (flip) context.scale(flip === 'horizontal' ? -1 : 1, flip === 'vertical' ? -1 : 1)
        context.translate(-part.width / 2, -part.height / 2)
      }
      if (file.type === 'image/svg+xml') {
        // For an SVG with no width and height, WebKit maps the source
        // rectangle of `drawImage` to the viewBox size, not to the natural
        // size, and draws the wrong part. So an SVG is drawn whole, scaled
        // and placed so that the crop fills the part. The edges of the
        // canvas cut off the rest of the SVG only when the part fills the
        // canvas; a moved part needs a clip to its own edges.
        if (moved) {
          context.beginPath()
          context.rect(0, 0, part.width, part.height)
          context.clip()
        }
        const scaleX = part.width / crop.width
        const scaleY = part.height / crop.height
        context.drawImage(img, -crop.x * scaleX, -crop.y * scaleY, img.naturalWidth * scaleX, img.naturalHeight * scaleY)
      } else {
        context.drawImage(img, crop.x, crop.y, crop.width, crop.height, 0, 0, part.width, part.height)
      }
      if (drawing.colors) {
        // The pixels of the whole canvas; the transform and the clip of
        // the draw do not apply to these two calls.
        const pixels = context.getImageData(0, 0, drawing.width, drawing.height)
        changeColors(pixels.data, drawing.colors)
        context.putImageData(pixels, 0, 0)
      }
      const type = drawing.mediaType ?? mediaType
      // No canvas writes SVG: a drawn SVG is a PNG drawing in an SVG file.
      const canvasType = type === 'image/svg+xml' ? 'image/png' : type
      const drawn = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, canvasType, LOSSY_QUALITY))
      if (!drawn) throw new Error(`The image could not be drawn as ${canvasType}.`)
      // A canvas that cannot write a type writes a PNG in its place.
      if (drawn.type !== canvasType) throw new UnwritableImageTypeError(canvasType)
      const bytes = new Uint8Array(await drawn.arrayBuffer())
      return { bytes: type === 'image/svg+xml' ? svgOfPng(bytes, drawing) : bytes, mediaType: type, width: drawing.width, height: drawing.height }
    } finally {
      URL.revokeObjectURL(url)
    }
  },

  // Tauri's native file drop is on only on Linux (tauri.linux.conf.json; see
  // run() in src-tauri/src/lib.rs). Its drop event gives the paths of the
  // dropped files and the drop point; the editor takes the drop when the
  // point is on its text.
  async 'dez.controller/images/watchFileDrops' (): Promise<void> {
    if (fileDropsWatched || !isTauri()) return
    fileDropsWatched = true
    try {
      await getCurrentWebview().onDragDropEvent(({ payload }) => {
        if (payload.type !== 'drop') return
        // The type says physical pixels, but wry on Linux gives GTK widget
        // coordinates, which are CSS pixels of the page (at page zoom 1).
        sbp('dez.editor/dropFiles', payload.paths, { x: payload.position.x, y: payload.position.y })
      })
    } catch (error) {
      fileDropsWatched = false
      console.error('Failed to watch file drops:', error)
    }
  },
})
