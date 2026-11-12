import { IMAGE_PATH_END_SOURCE, LINKED_IMAGE_PATH_SOURCE } from './images'
import { MEDIA_CACHE_PATH_END_SOURCE, MEDIA_TAG_KINDS, SAVED_MEDIA_PATH_END_SOURCES } from './mediaTags'

// A provider must never get the path of a file that Dez stores or links:
// it holds the user's name and folders. The stored files are the images
// (images.ts), the saved clips, and the temp copies of clips (mediaTags.ts);
// the linked files are the dropped files that Dez reads in place
// (linkedFiles.ts). Every request text goes through `withoutStoredFilePaths`.

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

// The path of a linked image reference, from its `[` to its `](`: also of a
// reference that is not valid (the Backspace rule's `![<path>](id=a`, bad
// metadata), and of one in an agent section, where it is plain text. A
// stored path matches too, which gives the same word.
const LINKED_IMAGE_REFERENCE_PATH = new RegExp(String.raw`\[${LINKED_IMAGE_PATH_SOURCE}\]\(`, 'g')
// A media tag, valid or not, from its name to the end of its line: a valid
// tag goes as its request form, with no `src` (`mediaTagsForRequest`), but a
// tag that the user broke goes as plain text.
const MEDIA_TAG_LINE = new RegExp(String.raw`<dez:(${MEDIA_TAG_KINDS.join('|')})\b[^\r\n]*`, 'g')
// An absolute path as a `src` value in a media tag line: a linked clip, or a
// stored one.
const MEDIA_TAG_SRC_PATH = /(\ssrc\s*=\s*")\/[^"]*"/g

/** True when a text holds the path of a file that Dez stores, in an image
 *  reference, in a media tag, or in any other text. Linked paths do not
 *  count: Dez writes them only into image references and media tags. */
export function holdsStoredFilePath(text: string): boolean {
  return ANY_STORED_FILE_PATH_END.test(text)
}

/** A text for a provider, with each path of a file that Dez stores or
 *  links replaced by one word: `image`, `audio`, `video`, or `media` (a
 *  temp copy). So an image reference goes as `![image](id=a)`, with its
 *  metadata as it is in the text, and a reference that is not valid (the
 *  Backspace rule's `![<path>](id=a`, bad metadata), a `src` path of a media
 *  tag line that is not valid, and, for a stored file, a bare path and a
 *  path in a metadata value lose their paths too. A text with no such path
 *  comes back as it is, so text-only request bodies keep their bytes
 *  (prompt cache).
 *
 *  A linked path is found only where Dez writes it: in the alt text of an
 *  image reference (`[/…/x.png](`), and as the `src` of a media tag. So the
 *  path of an image in a markdown link (`[/a.png](https://…)`) goes too,
 *  but a path that the user types in prose stays: it is the user's own
 *  text.
 *
 *  A stored path's start in prose is not known (a home folder can hold
 *  spaces), so each run with no bracket or line break loses all from its
 *  first `/` to the end of its last stored file path, whose word stands for
 *  it all: some prose, a URL, or another path before that path can go too,
 *  but never a part of a path. That is what a global regex for a whole path
 *  would replace, in linear time: such a regex rescans the rest of the run
 *  from each `/`, which took 0.5 s on a 200 KB base64 line. */
export function withoutStoredFilePaths(text: string): string {
  const unlinked = text
    .replace(LINKED_IMAGE_REFERENCE_PATH, '[image](')
    .replace(MEDIA_TAG_LINE, (line, kind: string) => line.replace(MEDIA_TAG_SRC_PATH, `$1${kind}"`))
  if (!holdsStoredFilePath(unlinked)) return unlinked
  return unlinked.replace(BRACKET_FREE_RUN, (run) => {
    let last: RegExpExecArray | undefined
    for (const match of run.matchAll(STORED_FILE_PATH_END)) last = match
    if (!last) return run
    // Group `n` is the group of entry `n - 1`; only one group has a match.
    const { standIn } = STORED_FILE_PATH_ENDS[last.findIndex((group, index) => index > 0 && group !== undefined) - 1]
    return `${run.slice(0, run.indexOf('/'))}${standIn}${run.slice(last.index + last[0].length)}`
  })
}
