import { IMAGE_PATH_END_SOURCE } from './images'
import { MEDIA_CACHE_PATH_END_SOURCE, SAVED_MEDIA_PATH_END_SOURCES } from './mediaTags'

// A provider must never get the path of a file that Dez stores: it holds
// the user's name and folders. The stored files are the images (images.ts),
// the saved clips, and the temp copies of clips (mediaTags.ts). Every
// request text goes through `withoutStoredFilePaths`.

// The start of the end of every path in the app folder, on any machine and
// in any home: `$HOME/.config/dez/` (`base_dir()` in persistence.rs). Many
// web projects have an `assets/images` folder too (Angular, Rails, Hugo);
// the scrub leaves their paths as they are, so code and commands go to the
// model as the user wrote them.
const APP_FOLDER_SOURCE = String.raw`\/\.config\/dez\/`

// The end of every path that Dez writes into a conversation, and the word
// that stands for such a path in a text for a provider. The temp copies are
// in the OS cache folder, whose place is not known here, so their end is
// only their own folders.
const STORED_FILE_PATH_ENDS: readonly { source: string, standIn: string }[] = [
  { source: `${APP_FOLDER_SOURCE}${IMAGE_PATH_END_SOURCE}`, standIn: 'image' },
  { source: `${APP_FOLDER_SOURCE}${SAVED_MEDIA_PATH_END_SOURCES.audio}`, standIn: 'audio' },
  { source: `${APP_FOLDER_SOURCE}${SAVED_MEDIA_PATH_END_SOURCES.video}`, standIn: 'video' },
  { source: String.raw`\/${MEDIA_CACHE_PATH_END_SOURCE}`, standIn: 'media' },
]
// One capture group for each entry, in order, so a match tells its entry.
// The sources have no groups of their own.
const STORED_FILE_PATH_END_SOURCE = STORED_FILE_PATH_ENDS.map(({ source }) => `(${source})`).join('|')
// A text holds a stored file path exactly when it holds one of these ends.
// Global for `matchAll` only, which copies the regex and keeps no state in it.
const STORED_FILE_PATH_END = new RegExp(STORED_FILE_PATH_END_SOURCE, 'g')
// Not global, so `test` keeps no `lastIndex` state between calls.
const ANY_STORED_FILE_PATH_END = new RegExp(STORED_FILE_PATH_END_SOURCE)
// A run of text with no bracket or line break, the chars that no image path
// holds.
const BRACKET_FREE_RUN = /[^\[\]\r\n]+/g

/** True when a text holds the path of a file that Dez stores, in an image
 *  reference, in a media tag, or in any other text. */
export function holdsStoredFilePath(text: string): boolean {
  return ANY_STORED_FILE_PATH_END.test(text)
}

/** A text for a provider, with each path of a file that Dez stores replaced
 *  by one word: `image`, `audio`, `video`, or `media` (a temp copy). So an
 *  image reference goes as `![image](id=a)`, with its metadata as it is in
 *  the text, and a reference that is not valid (the Backspace rule's
 *  `![<path>](id=a`, bad metadata), a bare path, a path in a metadata value,
 *  and a path in a line that is not a valid media tag lose their paths too.
 *  A text with no such path comes back as it is, so text-only request
 *  bodies keep their bytes (prompt cache). A hand-written reference into an
 *  `assets/images` folder outside a `.config/dez` folder keeps its path:
 *  Dez never writes one, and a request that sends it as an image fails
 *  first (the missing image error of `readStoredImage`).
 *
 *  A path's start in prose is not known (a home folder can hold spaces), so
 *  each run with no bracket or line break loses all from its first `/` to
 *  the end of its last stored file path, whose word stands for it all: some
 *  prose, a URL, or another path before that path can go too, but never a
 *  part of a path. That is what a global regex for a whole path would
 *  replace, in linear time: such a regex rescans the rest of the run from
 *  each `/`, which took 0.5 s on a 200 KB base64 line. */
export function withoutStoredFilePaths(text: string): string {
  if (!holdsStoredFilePath(text)) return text
  return text.replace(BRACKET_FREE_RUN, (run) => {
    let last: RegExpExecArray | undefined
    for (const match of run.matchAll(STORED_FILE_PATH_END)) last = match
    if (!last) return run
    // Group `n` is the group of entry `n - 1`; only one group has a match.
    const { standIn } = STORED_FILE_PATH_ENDS[last.findIndex((group, index) => index > 0 && group !== undefined) - 1]
    return `${run.slice(0, run.indexOf('/'))}${standIn}${run.slice(last.index + last[0].length)}`
  })
}
