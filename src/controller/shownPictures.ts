import sbp from '@sbp/sbp'
import { imageExtension } from '../model/chat/images'
import { SHOWN_PICTURE_FOLDER, type ShownPicture } from '../model/chat/shownPictures'
import type { ReplyPicture } from '../model/streams/replyPictures'

// The copies of the pictures that a tool call showed its model, which the
// panel of the call's chip shows (model/chat/shownPictures.ts). This module
// registers no selector: the `asset_view` runner (assetView.ts) and the tool
// loop (stream.ts) call it.

/** Saves a copy of each of `pictures` in the views folder, and gives the
 *  copies in the same order. A copy is only for the user to see, so a save
 *  that fails fails no call: that picture gets no copy, and the console
 *  tells why. */
export async function saveShownPictures(pictures: readonly ReplyPicture[]): Promise<ShownPicture[]> {
  const copies = await Promise.all(pictures.map(async ({ label, picture }): Promise<ShownPicture | null> => {
    const file = `${crypto.randomUUID()}.${imageExtension(picture.mediaType)}`
    try {
      await sbp('dez.native/saveAppFile', `${SHOWN_PICTURE_FOLDER}/${file}`, picture.bytes)
      return { file, label }
    } catch (error) {
      console.error('Failed to save the copy of a picture that a tool showed:', error)
      return null
    }
  }))
  return copies.filter((copy) => copy !== null)
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
