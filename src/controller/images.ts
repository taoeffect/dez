import sbp from '@sbp/sbp'
import { convertFileSrc } from '@tauri-apps/api/core'
import { IMAGE_FOLDER, imageExtension, isImagePath, type ImageMediaType } from '../model/chat/images'

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

  // The URL that loads a stored image in the webview through Tauri's asset
  // protocol. Views use this selector because they may not import Tauri APIs.
  'dez.controller/images/displayUrl' (path: string): string {
    return convertFileSrc(path)
  },
})
