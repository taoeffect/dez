import { isSavedMediaPath, isTempMediaPath } from '../../model/chat/mediaTags'

// What the player (MediaPlayer.vue, src/view/editor/media.ts) shows for a
// clip, from the fields of its tag (src/model/chat/mediaTags.ts).

/** Where a clip plays from. `none`: the clip has no source that the player
 *  can load. */
export type ClipSourceKind = 'saved' | 'temp' | 'remote' | 'none'

/** The kind of a tag's `src`. Only a file in a Dez media folder and an http
 *  or https URL play: a tag is plain text that a user can edit or paste, so
 *  any other value (another local file, a `data:` or `javascript:` URL)
 *  must not become the source of a media element. */
export function clipSourceKind(src: string | null): ClipSourceKind {
  if (src === null) return 'none'
  if (isSavedMediaPath(src)) return 'saved'
  if (isTempMediaPath(src)) return 'temp'
  return /^https?:\/\/\S+$/i.test(src) ? 'remote' : 'none'
}

/** Why a clip does not play. `gone`: its bytes are not there any more (it
 *  has no source, its file cannot be read, or its URL gives no clip).
 *  `cannot-play`: its bytes are there, and this computer cannot decode
 *  them. */
export type ClipProblem = 'gone' | 'cannot-play'

/** How the load of a clip's source failed. */
export type ClipLoadFailure =
  /** The file of a saved clip or of a temp copy could not be read. */
  | { step: 'read' }
  /** The media element gave an error, with the code of its `MediaError`. */
  | { step: 'play', code: number | undefined }
  /** After a "source not supported" error of a URL, the URL was asked
   *  whether it answers (`dez.controller/media/urlAnswers`): `answers` is
   *  true for a 2xx status. */
  | { step: 'ask', answers: boolean }

// The codes of `MediaError` (the unit tests run with no DOM, so the
// constants of the class are not there).
const MEDIA_ERR_DECODE = 3
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4

/** The problem of a clip whose source is of the kind `source`, after its
 *  load failed as `failure` (null: nothing failed). Null while the clip has
 *  no problem. `ask`: the URL must be asked first. A media element gives
 *  "source not supported" both for bytes that it cannot decode and for a
 *  URL that it could not fetch (an HTTP error), when the error comes
 *  before the clip's metadata (the resource fetch algorithm of the HTML
 *  standard). So only an answer of the URL tells the two apart.
 *  https://html.spec.whatwg.org/multipage/media.html#concept-media-load-resource */
export function clipProblem(source: ClipSourceKind, failure: ClipLoadFailure | null): ClipProblem | 'ask' | null {
  if (source === 'none') return 'gone'
  if (failure === null) return null
  if (failure.step === 'read') return 'gone'
  if (failure.step === 'ask') return failure.answers ? 'cannot-play' : 'gone'
  // A local file was read, so its bytes are there.
  if (source !== 'remote') return 'cannot-play'
  if (failure.code === MEDIA_ERR_DECODE) return 'cannot-play'
  // A network error, and any other code: the URL gave no clip.
  return failure.code === MEDIA_ERR_SRC_NOT_SUPPORTED ? 'ask' : 'gone'
}

/** The text of the card of a clip that does not play. */
export interface ProblemCard {
  /** What is wrong. */
  text: string
  /** What the user can do; null when nothing can be done. */
  hint: string | null
  /** The line that names the clip's saved file; null for a clip that is not
   *  saved, and until the path is read. */
  file: string | null
}

/** The card of a clip with `problem`. `type` is the media type of the
 *  clip's tag (null: not known). `saved` tells that the clip's source is
 *  its saved file, and `savedPath` is the path of that file as the user
 *  reads it (`~` for the home folder), or null while it is not read. */
export function problemCard(
  problem: ClipProblem,
  clip: { type: string | null, saved: boolean, savedPath: string | null },
): ProblemCard {
  if (problem === 'gone') return { text: 'This clip is no longer available.', hint: null, file: null }
  const type = clip.type?.trim() ?? ''
  const text = `This computer cannot play the format of this clip${type === '' ? '' : ` (${type})`}.`
  if (!clip.saved) {
    return { text, hint: 'Its file is still there. Save the clip to keep the file, then open the file with another app.', file: null }
  }
  return { text, hint: 'Its file is still there. Open the file with another app.', file: clip.savedPath === null ? null : `Saved file: ${clip.savedPath}` }
}

/** The clip's file on this computer, which the context menu of its player
 *  shows in the file manager (`dez.controller/menu/popupAsset`): the saved
 *  file or the temp copy, from the tag's `src`. Null when there is none: a
 *  clip that plays from its URL only or has no source, a file that cannot
 *  be read (`problem` is `gone`), and while a Save or a Delete moves or
 *  removes the file (`busy`). A file that this computer cannot play is
 *  there, so it counts. */
export function clipFile(src: string | null, problem: ClipProblem | null, busy: boolean): string | null {
  if (src === null || busy || problem === 'gone') return null
  const source = clipSourceKind(src)
  return source === 'saved' || source === 'temp' ? src : null
}

/** What the clock of a clip that is not saved tells. */
export interface ExpiryNotice {
  /** The source's time is over: it can have stopped working. */
  expired: boolean
  title: string
  text: string
  /** The line that names the clip's temp copy; null for a clip that has
   *  none (it plays from the provider's URL). */
  file: string | null
}

// The date and the time of day, in the user's locale and time zone.
const LOCAL_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** The notice for a tag's `expires` at the time `now` (ms); null when the
 *  tag gives no valid time, so the player shows no clock. `tempPath` is the
 *  path of the clip's temp copy as the user reads it (`~` for the home
 *  folder), or null for a clip with no temp copy. `formatTime` gives the
 *  time as the user reads it. */
export function expiryNotice(
  expires: string | null,
  now: number,
  tempPath: string | null,
  formatTime: (time: Date) => string = (time) => LOCAL_TIME.format(time),
): ExpiryNotice | null {
  if (expires === null) return null
  const time = new Date(expires)
  if (Number.isNaN(time.getTime())) return null
  const file = tempPath === null ? null : `Temporary file: ${tempPath}`
  return time.getTime() <= now
    ? { expired: true, title: 'Expired', text: `This clip was available until ${formatTime(time)}. It can stop playing at any time.`, file }
    : { expired: false, title: 'Not saved', text: `This clip is available until ${formatTime(time)}. Save it to keep it.`, file }
}
