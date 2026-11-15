import sbp from '@sbp/sbp'
import { imageExtension } from '../model/chat/images'
import { SHOWN_PICTURE_FOLDER, type NewPicture, type ShownPicture } from '../model/chat/shownPictures'

// The copies of the pictures that a tool call shows its model
// (model/chat/shownPictures.ts): the requests of the conversation read
// them until a compaction takes the call out, and the panel of the call's
// chip shows them. This module registers no selector: the `asset_view`
// runner (assetView.ts) and the tool loop (stream.ts) call it.

/** Saves a copy of each of `pictures` in the views folder, and gives the
 *  copies in the same order, each with the size and the byte count of its
 *  picture. A save that fails fails no call: that picture gets null, so
 *  the model does not get it, and the console tells why. */
export async function saveShownPictures(pictures: readonly NewPicture[]): Promise<(ShownPicture | null)[]> {
  return Promise.all(pictures.map(async ({ label, file: { mediaType, bytes }, size }): Promise<ShownPicture | null> => {
    const file = `${crypto.randomUUID()}.${imageExtension(mediaType)}`
    try {
      await sbp('dez.native/saveAppFile', `${SHOWN_PICTURE_FOLDER}/${file}`, bytes)
      return { file, label, ...(size && { width: size.width, height: size.height }), bytes: bytes.length }
    } catch (error) {
      console.error('Failed to save the copy of a picture that a tool showed:', error)
      return null
    }
  }))
}

/** Deletes the copies `pictures` of a call whose result no block took (a
 *  stopped reply). A delete that fails leaves the file to Delete Unused
 *  Files, as no text names it. */
export async function discardShownPictures(pictures: readonly ShownPicture[]): Promise<void> {
  await Promise.all(pictures.map(async ({ file }) => {
    try {
      await sbp('dez.native/deleteAppFile', `${SHOWN_PICTURE_FOLDER}/${file}`)
    } catch (error) {
      console.error(`Failed to delete the copy ${file} of a picture that a tool showed:`, error)
    }
  }))
}
