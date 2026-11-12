import sbp from '@sbp/sbp'
import { convertFileSrc, isTauri } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import type { DrawnImage, DrawnMediaType, ImageDrawing, ImageSize } from '../model/chat/imageDrawing'
import { IMAGE_FOLDERS, imageExtension, isImagePath, storedImageFile, type ImageFolder, type ImageMediaType } from '../model/chat/images'
import { FileTooLargeError } from '../model/chat/mediaFiles'
import { ExplainedError, errorText, rawErrorText } from '../utils/errorText'
import { fileNameOf } from '../utils/fileName'

// The quality of a drawn JPEG, from 0 to 1: high, so that a second
// encoding of a photo shows no new marks.
const JPEG_QUALITY = 0.95

let fileDropsWatched = false

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
      const appDir = await sbp('dez.native/getAppDir') as string
      const path = `${appDir}/${file}`
      // The recognizer takes only absolute paths with no brackets or line
      // breaks (e.g. not `./.config/dez` when $HOME is not set). A reference
      // to another path would show as plain text and never reach a model,
      // so no file is written for it.
      if (!isImagePath(path)) {
        throw new ExplainedError(`Dez cannot store images in the Dez folder ${appDir}. The path of this folder must start with "/" and must not hold "[", "]", or a line break. Start Dez with a HOME environment variable that gives such a path.`)
      }
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

  // The URL that loads a stored image in the webview through Tauri's asset
  // protocol. Views use this selector because they may not import Tauri APIs.
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

  // Reads a file by its absolute path through the asset protocol: a file in
  // an app folder that the protocol's scope has (a stored image, a media
  // clip), or a file of a native file drop (Tauri adds each dropped path to
  // the scope). The protocol takes the type from the bytes. With `maxBytes`,
  // a larger file is not read: one request asks its size first
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

  // Draws an image again in the webview: decodes `file` (an image of any
  // type that the webview reads), asks `plan` what to draw for an image of
  // that size (a part of it, at another size), and gives the drawing as a
  // file of `mediaType`. Null when `plan` gives null: the image stays as
  // it is, and nothing is drawn. There is no Rust code for this: the
  // webview has the decoders. Rejects when the webview cannot decode the
  // image, when `plan` throws, and when the drawing cannot be made; the
  // caller logs it, as each caller has its own answer to a failure.
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
      // An SVG without a width and height has no size to draw at.
      if (!img.naturalWidth || !img.naturalHeight) throw new Error('The image has no size.')
      const drawing = plan({ width: img.naturalWidth, height: img.naturalHeight })
      if (!drawing) return null

      const canvas = document.createElement('canvas')
      canvas.width = drawing.width
      canvas.height = drawing.height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('No canvas to draw the image on.')
      context.imageSmoothingQuality = 'high'
      const { crop } = drawing
      context.drawImage(img, crop.x, crop.y, crop.width, crop.height, 0, 0, drawing.width, drawing.height)
      const drawn = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mediaType, JPEG_QUALITY))
      // A canvas that cannot write a type writes a PNG in its place.
      if (!drawn || drawn.type !== mediaType) throw new Error(`The image could not be drawn as ${mediaType}.`)
      return { bytes: new Uint8Array(await drawn.arrayBuffer()), width: drawing.width, height: drawing.height }
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
