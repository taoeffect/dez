import * as z from 'zod'
import { fileNameOf } from '../../utils/fileName'
import { parseJsonAttribute } from '../../utils/markerAttribute'
import type { ImageSize } from './imageDrawing'
import { imageMediaType, type ImageMediaType } from './images'

// The pictures that an `asset_view` call shows its model. A picture is no
// asset of the conversation: no `@id` names one. Dez saves each picture as
// a copy in the views folder, and the block of the call names the copies
// in its `pictures` attribute (toolBlocks.ts); for an `asset_view` call
// that the code of a `js_eval` call made in an older Dez, that is the
// block of the `js_eval` call (code now shows no picture). The copies are
// what the model and the user see: each request that holds the round of
// the call reads them (`agentSectionMessages`, streams/messages.ts), so
// each one sends the same bytes, and the panel of the call's chip shows
// them. No request sends the name of a copy. Dez deletes the copies of a
// call whose result no block takes, such as a stopped call
// (controller/shownPictures.ts), and the copies of the calls that a
// compaction takes out; else only Delete Unreferenced Files deletes a copy,
// when no text names it (unusedFiles.ts).

/** One picture that a tool call showed its model, as its block keeps it.
 *  The size and the byte count give the cost of the picture in a request
 *  (streams/pictureBudget.ts) with no read of its file. */
export interface ShownPicture {
  /** The name of the copy in `SHOWN_PICTURE_FOLDER`: `<uuid>.<ext>`. */
  file: string
  /** The text that goes right before the picture in the requests. */
  label: string
  /** The size of the copy in pixels. Absent when Dez does not know it: in
   *  a block of an older Dez, and for a picture of ffmpeg whose size Dez
   *  could not read. */
  width?: number
  height?: number
  /** The byte count of the file of the copy. Absent in a block of an
   *  older Dez. */
  bytes?: number
}

/** The size of the copy of `picture` in pixels; null when the block does
 *  not tell both sides. */
export function shownPictureSize({ width, height }: ShownPicture): ImageSize | null {
  return width === undefined || height === undefined ? null : { width, height }
}

/** The file of a picture: its bytes, of a type that requests take. */
export interface PictureFile {
  mediaType: ImageMediaType
  bytes: Uint8Array
}

/** A picture that a tool made for its model, before Dez saves its copy. */
export interface NewPicture {
  /** What the picture shows: the text that goes right before it. */
  label: string
  file: PictureFile
  /** Its size in pixels, as it goes; null when Dez does not know it. */
  size: ImageSize | null
}

/** What a request holds in place of a picture whose copy is gone (a user
 *  can delete the file by hand), after the label of the picture. */
export const SHOWN_PICTURE_GONE_NOTE = 'Dez no longer has this picture: its file is gone. To see it again, call asset_view again.'

/** What a request holds in place of a picture that is over an image limit
 *  of its model, the one of the request or the one of one message
 *  (`takesPart`, streams/messages.ts), after the label of the picture. */
export const SHOWN_PICTURE_OVER_LIMIT_NOTE = 'Dez did not send this picture: this request, or this message of it, already holds as many images as its model takes.'

/** The folder of the copies, relative to the app folder. */
export const SHOWN_PICTURE_FOLDER = 'assets/generated/views'

const NAME_SOURCE = String.raw`[A-Za-z0-9_-]+\.[A-Za-z0-9]+`
const NAME = new RegExp(`^${NAME_SOURCE}$`)

/** Regex source of the end of the path of a copy: the views folder and a
 *  copy name. No capture groups. The folder name holds only letters and
 *  `/`, which a regex takes as they are. */
export const SHOWN_PICTURE_PATH_END_SOURCE = String.raw`${SHOWN_PICTURE_FOLDER}\/${NAME_SOURCE}`

// The name form of a copy: name characters, one `.`, and an image type
// that Dez stores. A block is text that the user can edit, so this rule
// keeps the panel from loading a file outside the views folder.
function isShownPictureName(name: string): boolean {
  return NAME.test(name) && imageMediaType(name) !== null
}

const positiveInt = z.number().int().positive()

const shownPicturesSchema = z.array(z.object({
  file: z.string().refine(isShownPictureName),
  label: z.string(),
  width: positiveInt.optional(),
  height: positiveInt.optional(),
  bytes: z.number().int().nonnegative().optional(),
}))

/** The value of the `pictures` attribute of a block. */
export function shownPicturesText(pictures: readonly ShownPicture[]): string {
  return JSON.stringify(pictures.map(({ file, label, width, height, bytes }) => ({ file, label, width, height, bytes })))
}

/** The pictures of a `pictures` attribute value. A value that is not the
 *  writer's form (a hand edit) reads as no pictures. */
export function readShownPictures(text: string): ShownPicture[] {
  return parseJsonAttribute(text, shownPicturesSchema) ?? []
}

/** The app-file path (`assets/generated/views/<file>`) of `path` when it
 *  names a copy directly in the views folder of the app folder `appDir`.
 *  Null for any other path. */
export function shownPictureFile(path: string, appDir: string): string | null {
  const name = fileNameOf(path)
  const file = `${SHOWN_PICTURE_FOLDER}/${name}`
  return isShownPictureName(name) && path === `${appDir}/${file}` ? file : null
}
