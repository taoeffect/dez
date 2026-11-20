import type { JsonObject } from '../../utils/json'
import type { StoredFileType } from '../chat/fileSignatures'
import { IMAGE_ID_SOURCE } from '../chat/images'
import type { ClipReadProblem } from '../chat/mediaFiles'
import type { ConversationAssets, PromptInput } from '../streams/mediaRequest'
import { assetText } from './toolInputs'

// The frame bridge: what the page of a UI app and Dez tell each other.
// The page is the work of a model, so Dez trusts nothing of it.
//
// The page calls Dez with `dez.sbp(selector, ...args)` of Dez's client
// script (src-tauri/src/app_client.js). There are two selectors, and no
// Dez tool: a shown app runs with no reply, so a paid call from it would
// have no owner.
// - `dez.app/readAsset`: the bytes of an image or a clip, as a Blob with
//   no file name and no path.
// - `dez.app/saveAsset`: a new image or clip from the bytes of a Blob. Dez
//   checks the size, the count, and the type (by the first bytes) before
//   it writes a file (`checkSaveSize`, `SaveCount`, `savedFileType`,
//   appInvoke.ts).
// Which assets a page can read, and where a save goes, is the rule of the
// owner of the frame: an invoked app (controller/appInvoke.ts) or a shown
// app (view/editor/apps.ts).
//
// Dez calls the page with one command, `app/invoke`: the handler that the
// page registered runs with the parameters of an `apps invoke` call.
//
// This module has the pure parts: the names, the check of a call of a
// page, and the texts of a call that Dez refuses. The code of an app
// reads such a text as the message of an error, and it can show it
// to the user or return it to a model: so each one names an asset by its
// id only, holds no path, and tells no one to do something.
// view/apps/appFrame.ts moves the messages.
//
// The tool definition and the template of a UI app name the selectors
// (appsTool.ts, appTemplates.ts): this module must import neither.

/** The selector of a page that reads an image or a clip. */
export const APP_READ_ASSET = 'dez.app/readAsset'

/** The selector of a page that saves a new image or clip. */
export const APP_SAVE_ASSET = 'dez.app/saveAsset'

/** The selector of the handler of a page that an `apps invoke` call
 *  runs. */
export const APP_INVOKE_HANDLER = 'app/invoke'

/** How a page registers that handler, as a text for a model shows it. */
export const APP_HANDLER_EXAMPLE = `\`dez.sbp('sbp/selectors/register', { '${APP_INVOKE_HANDLER}': async (parameters, run) => { … } })\``

/** The URL of the folder of all apps in the scheme of the app frames
 *  (src-tauri/src/app_frames.rs): the page of the app `notes` is
 *  `dezapp://localhost/notes/index.html`. */
export const APP_FRAME_ROOT_URL = 'dezapp://localhost/'

/** The size of the frame of a run of a UI app (`apps invoke`), in CSS
 *  pixels. The user does not see the frame, but its page has a layout:
 *  the help of `invoke` tells a model this size. */
export const APP_RUN_FRAME_SIZE = { width: 1280, height: 720 } as const

/** The most characters of the selector of a call. The client script
 *  refuses a longer one itself; Dez drops a message that has one. */
export const APP_SELECTOR_MAX_CHARS = 100

/** A call of a page that Dez refuses. Its message is the text that the
 *  page gets as the error of its call: it holds no path. */
export class AppCallError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AppCallError'
  }
}

/** A checked call of a page. */
export type AppCall =
  | { selector: typeof APP_READ_ASSET, id: string }
  | { selector: typeof APP_SAVE_ASSET, blob: Blob }

const ASSET_ID = new RegExp(`^@?(${IMAGE_ID_SOURCE})$`)

// The bytes of a save as a Blob; null for a value that holds no bytes.
// What a frame posts arrives as a value of Dez's own page (a Blob, an
// ArrayBuffer, a typed array), so `instanceof` tells it.
function savedBlob(value: unknown): Blob | null {
  if (value instanceof Blob) return value
  if (value instanceof ArrayBuffer) return new Blob([value])
  if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) return new Blob([new Uint8Array(value.buffer, value.byteOffset, value.byteLength)])
  return null
}

/** The call of a page with `selector` and `args`, checked. Throws an
 *  `AppCallError` for a selector that Dez does not have and for a wrong
 *  argument. */
export function appCall(selector: string, args: readonly unknown[]): AppCall {
  const [first] = args
  if (selector === APP_READ_ASSET) {
    const id = typeof first === 'string' ? ASSET_ID.exec(first.trim())?.[1] : undefined
    if (id === undefined) {
      throw new AppCallError(`${APP_READ_ASSET} takes the id of an image or a clip, as in dez.sbp('${APP_READ_ASSET}', 'a'). It got no such id.`)
    }
    return { selector, id }
  }
  if (selector === APP_SAVE_ASSET) {
    const blob = savedBlob(first)
    if (blob === null) {
      throw new AppCallError(`${APP_SAVE_ASSET} takes the bytes of one image or clip: a Blob, an ArrayBuffer, or a typed array, as in dez.sbp('${APP_SAVE_ASSET}', blob). It got none of them.`)
    }
    return { selector, blob }
  }
  throw new AppCallError(`Dez has no selector ${JSON.stringify(selector)} for an app. An app can call ${APP_READ_ASSET} and ${APP_SAVE_ASSET}, and no Dez tool.`)
}

/** What a save gives the page: the id of the new asset, or null when it
 *  has none yet (an asset of a job gets its id when a reader takes the
 *  result of the job), the kind, and the media type. */
export interface SavedAssetAnswer {
  id: string | null
  kind: StoredFileType['kind']
  type: string
}

/** A save of the page of a shown app that Dez stored, for the view that
 *  puts it into the conversation. `path` is the absolute path of the file:
 *  it never goes to a page. */
export interface SavedAppFile {
  path: string
  kind: StoredFileType['kind']
  /** The media type. */
  type: string
}

function listed(assets: readonly PromptInput[]): string {
  return assets.map(assetText).join(', ')
}

/** The error of a read of the id `id` in a run whose call gave the inputs
 *  `inputs`: an invoked app reads only them. */
export function notAnInputText(id: string, inputs: readonly PromptInput[]): string {
  return inputs.length === 0
    ? `Dez gave no bytes for @${id}: this run has no input. A run reads only the images and the clips that its call names in \`inputs\`.`
    : `Dez gave no bytes for @${id}: it is no input of this run. The inputs of this run are ${listed(inputs)}.`
}

/** The error of a read of the id `id` in a shown app, in a conversation
 *  with the images and the clips `assets`. */
export function unknownAssetText(id: string, assets: ConversationAssets): string {
  const known: PromptInput[] = [...Array.from(assets.images.keys(), (image) => ({ id: image, kind: 'image' as const })), ...assets.clips.values()]
  return known.length === 0
    ? `Dez gave no bytes for @${id}: this conversation has no image and no clip.`
    : `Dez gave no bytes for @${id}: it names no image and no clip of this conversation. The conversation has ${listed(known)}.`
}

/** The error of a read of an image whose file Dez could not read. */
export function imageNotReadText(id: string): string {
  return `Dez cannot read the image @${id}: its file is gone or moved, or Dez may not read it.`
}

/** The error of a read of the clip `clip` that Dez could not read, by the
 *  problem (`ClipReadError`). */
export function clipNotReadText(clip: PromptInput, problem: ClipReadProblem): string {
  const name = assetText(clip)
  switch (problem) {
    case 'deleted':
      return `Dez cannot read ${name}: its file was deleted, and it has no web address to download it from.`
    case 'expired':
      return `Dez cannot read ${name}: it has expired at the provider that made it, and it was not saved.`
    case 'unreadable':
      return `Dez cannot read ${name}: its file is gone, Dez may not read it, or its server did not send it.`
  }
}

/** The error of a save whose checked bytes Dez could not write: a fault
 *  of Dez or of the computer, and not of the app. `cause` is the error of
 *  the write, for the log and for a text for the user. */
export class SaveNotStoredError extends AppCallError {
  constructor(cause: unknown) {
    super('Dez saved nothing: it could not write the file into the Dez folder. This is not a fault of the app.', { cause })
    this.name = 'SaveNotStoredError'
  }
}

/** The error of a save of a shown app at a time when the user does not
 *  work in the app: such a save would put a file into the user's message
 *  behind the user's back. */
export const SAVE_NEEDS_USER_TEXT = 'Dez saved nothing: a shown app can save only while the user works in it (a click or a key in the app, or the pointer over it). '
  + 'Save as the answer to an action of the user, such as a click on a button.'

/** The error of a save of a shown app in a conversation whose last
 *  section is no message of the user: the new asset has no place. */
export const SAVE_NEEDS_DRAFT_TEXT = 'Dez saved nothing: a shown app saves into the message that the user writes, the last section of the conversation, and the last section is a reply now. '
  + 'Save again after the reply has ended.'

/** The error of a call that ends after its app stopped. */
export const APP_STOPPED_TEXT = 'The app stopped before Dez could do the call.'

/** The error of a call that failed in Dez's own code. The console of Dez
 *  has the details. */
export const APP_CALL_FAILED_TEXT = 'Dez could not do the call: an error of Dez, not of the app.'

/** An image or a clip of an `apps invoke` call, as the handler of the page
 *  gets it in `run.inputs`. The page reads its bytes with
 *  `dez.app/readAsset`. */
export interface AppFrameInput extends PromptInput {
  /** The media type. */
  type: string
}

/** One run of the handler of the page of a UI app in a hidden frame
 *  (`dez.ui/runAppFrame`). */
export interface AppFrameRun {
  /** The name of the app. */
  name: string
  parameters: JsonObject
  inputs: readonly AppFrameInput[]
  /** Its stop closes the frame and rejects the run with its reason. */
  signal: AbortSignal
  /** Does a checked call of the page, and gives its answer. An
   *  `AppCallError` goes to the page as it is. */
  onCall (call: AppCall): Promise<unknown>
  /** The page loaded and Dez's client script answered: the handler runs
   *  now. */
  onRuns (): void
}

/** How a run of the handler of a page ended. `log` is the console output
 *  of the page and the errors that nothing in it caught, as the client
 *  script kept them.
 *  - `returned`: the handler gave `value` (the text that the client
 *    script made of it; undefined for no value).
 *  - `threw`: the handler threw; `error` is the text of what it threw.
 *  - `unregistered`: the page registered no handler.
 *  - `noClient`: the page loaded, but Dez's client script did not answer.
 *  - `navigated`: the frame loaded a second time, which may be another
 *    page. */
export type AppFrameEnd =
  | { kind: 'returned', value: string | undefined, log: string }
  | { kind: 'threw', error: string, log: string }
  | { kind: 'unregistered', log: string }
  | { kind: 'noClient' }
  | { kind: 'navigated' }
