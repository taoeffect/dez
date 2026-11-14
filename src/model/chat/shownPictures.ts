import * as z from 'zod'
import { fileNameOf } from '../../utils/fileName'
import { imageMediaType } from './images'

// The pictures that an `asset_view` call shows its model go as bytes, and
// the section never holds them (streams/replyPictures.ts). So that the user
// can see what the model saw, Dez keeps a copy of each picture in the views
// folder, and the block of the call names the copies in its `pictures`
// attribute (toolBlocks.ts). Only the panel of the call's chip shows them:
// no request sends a copy or its name, and no `@id` names one. Dez deletes
// the copies of a call whose result no block takes, such as a stopped call
// (controller/shownPictures.ts); else only Delete Unused Files deletes a
// copy, when no text names it (unusedFiles.ts).

/** One picture that a tool call showed its model, as its block keeps it. */
export interface ShownPicture {
  /** The name of the copy in `SHOWN_PICTURE_FOLDER`: `<uuid>.<ext>`. */
  file: string
  /** The text that went right before the picture in the requests. */
  label: string
}

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

const shownPicturesSchema = z.array(z.object({
  file: z.string().refine(isShownPictureName),
  label: z.string(),
}))

/** The value of the `pictures` attribute of a block. */
export function shownPicturesText(pictures: readonly ShownPicture[]): string {
  return JSON.stringify(pictures.map(({ file, label }) => ({ file, label })))
}

/** The pictures of a `pictures` attribute value. A value that is not the
 *  writer's form (a hand edit) reads as no pictures. */
export function readShownPictures(text: string): ShownPicture[] {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return []
  }
  const parsed = shownPicturesSchema.safeParse(value)
  return parsed.success ? parsed.data : []
}

/** The app-file path (`assets/generated/views/<file>`) of `path` when it
 *  names a copy directly in the views folder of the app folder `appDir`.
 *  Null for any other path. */
export function shownPictureFile(path: string, appDir: string): string | null {
  const name = fileNameOf(path)
  const file = `${SHOWN_PICTURE_FOLDER}/${name}`
  return isShownPictureName(name) && path === `${appDir}/${file}` ? file : null
}
