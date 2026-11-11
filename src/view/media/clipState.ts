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
