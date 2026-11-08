import sbp from '@sbp/sbp'
import { convertFileSrc, isTauri } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { IMAGE_FOLDER, imageExtension, isImagePath, storedImageFile, type ImageMediaType } from '../model/chat/images'
import { fileNameOf } from '../utils/fileName'

let fileDropsWatched = false

export default sbp('sbp/selectors/register', {
  // Stores the bytes of a pasted or dropped image under a new name, and
  // returns the absolute path for its reference (`imageMarkdown` in
  // src/model/chat/images.ts). A failure is logged, shows an error toast,
  // and rejects, so the caller inserts no reference.
  async 'dez.controller/images/save' (bytes: Uint8Array, mediaType: ImageMediaType): Promise<string> {
    try {
      const fileName = `${crypto.randomUUID()}.${imageExtension(mediaType)}`
      const appDir = await sbp('dez.native/getAppDir') as string
      const path = `${appDir}/${IMAGE_FOLDER}/${fileName}`
      // The recognizer takes only absolute paths with no brackets or line
      // breaks (e.g. not `./.config/dez` when $HOME is not set). A reference
      // to another path would show as plain text and never reach a model,
      // so no file is written for it.
      if (!isImagePath(path)) {
        throw new Error(`Images cannot be stored in this Dez folder: ${appDir}`)
      }
      await sbp('dez.native/saveAppFile', `${IMAGE_FOLDER}/${fileName}`, bytes)
      return path
    } catch (error) {
      console.error('Failed to save the image:', error)
      sbp('dez.ui/toast', 'app-global', {
        title: 'Could not save the image',
        message: String(error),
        variant: 'error',
      })
      throw error
    }
  },

  // Deletes the file of an image reference's path. Only a stored image of
  // this Dez folder is deleted (`storedImageFile`); any other path (a
  // reference copied from another home) deletes no file, as the file of
  // that name here belongs to another image. A missing file is not an
  // error. A failure is logged, shows an error toast, and rejects, so the
  // caller keeps the reference.
  async 'dez.controller/images/delete' (path: string): Promise<void> {
    try {
      const file = storedImageFile(path, await sbp('dez.native/getAppDir') as string)
      if (file) await sbp('dez.native/deleteAppFile', file)
    } catch (error) {
      console.error(`Failed to delete the image ${path}:`, error)
      sbp('dez.ui/toast', 'app-global', {
        title: 'Could not delete the image',
        message: String(error),
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

  // Reads an image file by its absolute path through the asset protocol: a
  // file in the image folder, or a file of a native file drop (Tauri adds
  // each dropped path to the protocol's scope). The protocol takes the type
  // from the bytes. Rejects when the file cannot be read.
  async 'dez.controller/images/readFile' (path: string): Promise<File> {
    const response = await fetch(convertFileSrc(path))
    if (!response.ok) throw new Error(`Failed to read ${path}: HTTP ${response.status}`)
    const blob = await response.blob()
    return new File([blob], fileNameOf(path), { type: blob.type })
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
