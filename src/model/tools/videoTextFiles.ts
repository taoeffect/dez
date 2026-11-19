import { byteSizeText } from '../../utils/byteSize'
import { countOf } from '../../utils/countText'
import { ToolError, type ToolArguments } from './types'

// The text files of an ffmpeg run of the `video` tool (videoTool.ts): the
// texts that a call gives in its `text_files` parameter, which Dez writes
// into the work folder before the run (controller/videoTool.ts). drawtext
// reads one with `textfile=` (a `text=` value cannot hold ":" without a
// backslash escape, which Dez refuses), and the `subtitles` and `ass`
// filters read subtitle files.
//
// So a model chooses the content of a file of the work folder. A demuxer
// that reads names from the text of a file can open those names, and the
// `subtitles` filter, `-i`, and `movie` give a text file to the probe of
// every demuxer of the build. Those of FFmpeg n9.0.2 (check them again
// after each scripts/update-ffmpeg.js):
// - hls: a playlist names its segments by any path. Its probe takes only a
//   name that ends in .m3u8 or .m3u, which no text file has, and Dez also
//   refuses a text that starts as a playlist (`HLS_PLAYLIST_START`).
// - concat: its default `safe=1` takes only relative names with no `..`
//   and no protocol, and the argument checks refuse the `safe` option.
// - vobsub opens the `.sub` file of its own input name, and mov opens the
//   files that it references only with `enable_drefs`, which the argument
//   checks refuse.
// The build has no dash, imf, or sdp demuxer. The OS rule of the run
// (src-tauri/src/confinement.rs) still guards the files of the user.

/** A text file of a run: its name in the work folder, and its text, which
 *  Dez writes as UTF-8. */
export interface TextFile {
  name: string
  text: string
}

/** The most text files of one run. */
export const MAX_TEXT_FILES = 8

/** The most bytes (UTF-8) of all the text files of one run. */
export const MAX_TEXT_FILES_BYTES = 256 * 1024

// The name of a text file: no folder, and an ending of a text that one of
// the text filters reads. No ending of a clip or an image, so a text file
// never has the name of an input copy (`<id>.<ending of its type>`).
const TEXT_FILE_NAME = /^[A-Za-z0-9_-]{1,64}\.(?:txt|srt|ass)$/

/** The rule of a text file name, for the parameter's description and the
 *  error texts. */
export const TEXT_FILE_NAME_TEXT = 'a name is 1 to 64 ASCII letters, digits, "_", and "-", then .txt, .srt, or .ass, with no folder'

// The start of an HLS playlist: the probe of the hls demuxer reads
// `#EXTM3U` at the start of the file. Its case, a byte order mark, and
// white space before it do not count here, so that a later probe that
// takes them finds no playlist either.
const HLS_PLAYLIST_START = /^\uFEFF?\s*#EXTM3U/i

const OBJECT_FORM = 'Give `text_files` as the text of a JSON object from file name to text, as in {"title.txt":"Night: Drive"}.'

/** The text files that the `text_files` argument of an ffmpeg call gives
 *  (the text of a JSON object from file name to text), in the order of the
 *  call; none for no argument or a blank one. Throws a `ToolError` that
 *  ends with `notDone` (what Dez did not do) for a text that is no such
 *  object, a name that breaks `TEXT_FILE_NAME`, two names that differ only
 *  in case (one file on macOS), more than `MAX_TEXT_FILES` files or
 *  `MAX_TEXT_FILES_BYTES`, and a text that starts as an HLS playlist. */
export function textFilesArgument(args: ToolArguments, notDone: string): TextFile[] {
  const value = typeof args.text_files === 'string' ? args.text_files : ''
  if (value.trim() === '') return []
  let given: unknown
  try {
    given = JSON.parse(value)
  } catch {
    given = undefined
  }
  if (given === null || typeof given !== 'object' || Array.isArray(given)) {
    throw new ToolError(`\`text_files\` is not the text of a JSON object. ${OBJECT_FORM} ${notDone}`)
  }

  const entries = Object.entries(given as Record<string, unknown>)
  const noText = entries.filter(([, text]) => typeof text !== 'string').map(([name]) => JSON.stringify(name))
  if (noText.length > 0) {
    const values = noText.length === 1 ? `the value of ${noText[0]} is no text` : `the values of ${noText.join(', ')} are no texts`
    throw new ToolError(`In \`text_files\`, ${values}. ${OBJECT_FORM} ${notDone}`)
  }
  const files = entries.map(([name, text]): TextFile => ({ name, text: text as string }))
  const badNames = files.filter(({ name }) => !TEXT_FILE_NAME.test(name)).map(({ name }) => JSON.stringify(name))
  if (badNames.length > 0) {
    throw new ToolError(`Dez refuses the text file name${badNames.length === 1 ? '' : 's'} ${badNames.join(', ')} in \`text_files\`: ${TEXT_FILE_NAME_TEXT}. ${notDone}`)
  }
  const lowerNames = files.map(({ name }) => name.toLowerCase())
  const twinIndex = lowerNames.findIndex((name, index) => lowerNames.indexOf(name) !== index)
  if (twinIndex >= 0) {
    const first = files[lowerNames.indexOf(lowerNames[twinIndex])]
    throw new ToolError(`In \`text_files\`, the names ${JSON.stringify(first.name)} and ${JSON.stringify(files[twinIndex].name)} differ only in case: on macOS they name one file. `
      + `Give each text file another name. ${notDone}`)
  }
  if (files.length > MAX_TEXT_FILES) {
    throw new ToolError(`\`text_files\` has ${countOf(files.length, 'file')}, and a run takes at most ${MAX_TEXT_FILES}. Put the texts into fewer files. ${notDone}`)
  }

  const encoder = new TextEncoder()
  const bytes = files.reduce((sum, { text }) => sum + encoder.encode(text).byteLength, 0)
  if (bytes > MAX_TEXT_FILES_BYTES) {
    throw new ToolError(`The texts of \`text_files\` have ${countOf(bytes, 'byte')} in all (UTF-8), and a run takes at most ${countOf(MAX_TEXT_FILES_BYTES, 'byte')} `
      + `(${byteSizeText(MAX_TEXT_FILES_BYTES)}). Put a shorter text into the files. ${notDone}`)
  }
  const playlist = files.find(({ text }) => HLS_PLAYLIST_START.test(text))
  if (playlist) {
    throw new ToolError(`Dez refuses the text file ${playlist.name}: it starts as an HLS playlist (#EXTM3U). A playlist can name files outside the work folder, `
      + `and ffmpeg reads those files, so Dez writes no playlist. ${notDone}`)
  }
  return files
}
