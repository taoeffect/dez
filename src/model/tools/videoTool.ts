import * as z from 'zod'
import { byteSizeText } from '../../utils/byteSize'
import { sectionPlainText } from '../chat/content'
import { findAssetMentions } from '../chat/imageMentions'
import { imageExtension, imageMediaType } from '../chat/images'
import { CLIP_FILE_EXTENSIONS, MAX_SAVED_CLIP_BYTES, storableClip } from '../chat/mediaFiles'
import { newMediaIds } from '../chat/mediaIds'
import type { Section } from '../chat/types'
import { conversationAssets, type ConversationAssets } from '../streams/mediaRequest'
import { ASSET_NAMES, jobTimeoutMs, jobTimeoutParameter } from './jobs'
import { clipInput, tellUserConsole, type ClipInput, type KeptFile, type ProgramEnd, type ShippedProgram } from './programRuns'
import { subcommandToolDefinition, type SubcommandTool } from './subcommands'
import { assetText, unknownInputsProblem } from './toolInputs'
import { ToolError, type ToolArguments, type ToolParameter } from './types'

// The `video` tool: ffmpeg and ffprobe, the programs that Dez ships
// (src-tauri/binaries/), on the clips and the images of a conversation.
// This module has the pure parts: the definition and its help texts, the
// checks of a call, the plan of a join, the rule of the new files, and
// every text that the calling model reads. controller/videoTool.ts runs
// the programs. What the `audio` tool shares with this one about a run is
// in programRuns.ts.
//
// - `join_clips` and `ffmpeg` start a job of the reply (controller/jobs.ts).
// - `ffprobe` is fast, so its call waits for it.
//
// A call names an input as `@id`. The program gets a copy of that file
// under a neutral name (`c.mp4`) in a new work folder, where it runs, and
// the name goes in place of the `@id`. So no argument and no log line
// holds a path of the user's computer, and the program cannot change a
// file of the user.
//
// The checks of the arguments (`argumentProblem`) are string checks. They
// give a model that makes a mistake, or that follows a text that it read,
// a clear refusal before any run, for an argument that opens a file outside
// of the work folder, the network, or a device. They cannot see what a
// file tells ffmpeg to open (a playlist that names other files), and a new
// option of a later ffmpeg can pass them. So the guard of the user's files
// is the OS rule of every run (src-tauri/src/confinement.rs): the program
// can open only the files of Dez's cache folder and of the assets folder
// of the Dez folder, where it can delete or move no file. Where the OS has
// no such rule (a Linux kernel with no Landlock), the program runs with
// the rights of the user, and these checks are its only guard. The OS rule
// is about files only: the network always has only these checks.
//
// Every text here is a tool result or the result of a job: it goes to the
// chat provider. So it names an image or a clip by its id only.

/** The time limit of a `join_clips` or `ffmpeg` call with no
 *  `timeout_seconds`: 10 minutes, which the help states. */
export const DEFAULT_VIDEO_TIMEOUT_SECONDS = 600

/** The time limit of an ffprobe run: it reads the facts of a file, so a
 *  longer run is one that hangs. */
export const FFPROBE_TIMEOUT_MS = 60_000

/** The most new files of one ffmpeg run that Dez keeps: a run that writes
 *  each frame of a clip as an image must not fill the reply. */
export const MAX_VIDEO_OUTPUT_FILES = 20

/** The most output (the log) that an ffmpeg run can write. Only its end
 *  goes into a result. */
export const FFMPEG_OUTPUT_BYTES = 8 * 1024 * 1024

/** The most output that an ffprobe run can write. */
export const FFPROBE_OUTPUT_BYTES = 1024 * 1024

/** The most characters of the output of ffprobe (or of an ffmpeg run that
 *  only prints a list) that a result holds: the result goes into the next
 *  request of the model and stays in the conversation. */
export const PROGRAM_OUTPUT_CAP = 20_000

// The most characters of the log of ffmpeg in the result of a run that
// made files, and in any other result.
const LOG_END_WITH_FILES = 2000
const LOG_END = 4000

/** What Dez puts before the arguments of a call. `-nostdin`: the program
 *  has no input to read. The log level: at its default, ffmpeg prints the
 *  metadata of each input file (a title, a place, the name of a camera),
 *  which would go to the chat provider with the log of every run. So the
 *  log holds warnings, errors, and the progress (`-stats`), and a call
 *  that needs more gives its own `-v`, which wins as the later option. */
export const FFMPEG_FIXED_ARGS: readonly string[] = ['-nostdin', '-hide_banner', '-v', 'warning', '-stats']

/** As `FFMPEG_FIXED_ARGS`, for ffprobe: its output is what the call asks
 *  for, so its log level stays. */
export const FFPROBE_FIXED_ARGS: readonly string[] = ['-hide_banner']

// The name of the output file of a join, without its extension, and the
// file that lists the clips of a stream copy.
const JOINED_NAME = 'joined'
const JOIN_LIST_FILE = 'list.txt'

// The endings of the files that Dez keeps, for the help and the error
// texts. This ffmpeg build has no zlib, so it writes no PNG; it has no
// WebP encoder either.
const KEPT_ENDINGS = [...CLIP_FILE_EXTENSIONS.map((extension) => `.${extension}`), '.jpg', '.gif'].join(', ')

const ARGUMENTS_PARAMETER: ToolParameter = {
  name: 'arguments',
  type: 'string',
  description: 'The arguments as one command line, without the program name. Name an input by its id with an @, as in "-i @c".',
  required: true,
}

// The help of the `ffmpeg` subcommand. It is long, and only a `help` call
// sends it: the tools array holds one short entry for the whole tool. Each
// example ran with this build (tests/e2e/video-tool.e2e.ts runs some).
const FFMPEG_HELP = [
  'Runs the ffmpeg that Dez ships once, with the arguments that you give, in a new work folder. '
    + 'The call starts a job and gives its id at once: get the result with jobs_wait. '
    + 'The result has the end of the log of ffmpeg and the id of each new clip and image; they go into your reply, where the user sees them.',
  'Inputs: name a video clip, an audio clip, or an image of this conversation by its id with an @, as in `-i @c`. '
    + 'Dez puts a copy of that file into the work folder and writes the name of the copy (as in c.mp4) in place of the @id. '
    + 'The file itself never changes. Name no other file: Dez refuses an argument that names a file outside the work folder. '
    + 'On Linux with Landlock and on macOS, the system also lets ffmpeg open no file outside the cache folder and the assets folder of Dez, so a file that names another file (a playlist, a list) cannot reach the other files of the user. '
    + 'A PNG or SVG image goes as a JPEG copy, with white in place of transparent pixels.',
  'Outputs: give each output a new file name with no folder, made of ASCII letters, digits, ".", "_", and "-" only. '
    + `Dez keeps the new files whose name ends in ${KEPT_ENDINGS}, at most ${MAX_VIDEO_OUTPUT_FILES} for one call, and deletes every other file. `
    + 'This ffmpeg writes no PNG and no WebP image. For a run whose log is the result, end the arguments with `-f null -`.',
  'Arguments: one command line without the program name. Dez splits it into words as a shell does: white space ends a word, and single or double quotes keep a word with spaces whole. '
    + 'It is not a shell: it has no pipe, no redirect, no variable, and no backslash escape. '
    + 'To give ffmpeg single quotes (around a filter value with a comma), put the whole argument in double quotes, as in "select=\'eq(n,0)\'".',
  `Dez puts \`${FFMPEG_FIXED_ARGS.join(' ')}\` before your arguments, so the log holds the warnings, the errors, and the progress. `
    + 'Add `-v info` for the lines of a filter that reports in the log (volumedetect, silencedetect, cropdetect).',
  'Dez refuses an argument with: an absolute path, "~", "..", a backslash, a URL or a protocol form (as in http:, file:, pipe:, concat:), '
    + 'a lone "-" (only `-f null -` can have one), a capture or playback device, the hls format or an .m3u8 file name (no HLS input and no HLS output), '
    + 'and the options -safe, -protocol_whitelist, -protocol_blacklist, -filter_script, -filter_complex_script, -graph_file, -hls_key_info_file, '
    + '-enable_drefs, -use_absolute_path, -dump_attachment, and each option that starts with "-/".',
  'Encoders of this build: libx264, libx265, libvpx-vp9, libvpx, libsvtav1 (video); aac, libmp3lame, libopus, flac, pcm_s16le (audio); mjpeg, gif (images). '
    + 'It has no drawtext and no subtitles filter. The ffprobe subcommand gives the full lists with no job (-encoders, -filters, -h filter=scale).',
  'Examples of `arguments`:',
  '- Put the sound of @b on the video clip @c: -i @c -i @b -map 0:v -map 1:a -c:v copy -c:a aac -shortest out.mp4',
  '- Cut 5 seconds that start at second 2: -ss 2 -t 5 -i @c -c:v libx264 -c:a aac cut.mp4',
  '- Scale to a width of 640: -i @c -vf scale=640:-2 -c:v libx264 -c:a copy small.mp4',
  '- Take the frame at second 1 as an image: -ss 1 -i @c -frames:v 1 -update 1 frame.jpg',
  '- Make a video clip from the image @a and the sound @b: -loop 1 -i @a -i @b -c:v libx264 -tune stillimage -pix_fmt yuv420p -c:a aac -shortest still.mp4',
  '- Measure the loudness of @b, with no new file: -v info -i @b -af volumedetect -f null -',
].join('\n')

// Static text only (no count that changes, no date): the tools array is in
// the provider's prompt cache.
export const VIDEO_TOOL: SubcommandTool = {
  name: 'video',
  summary: 'Join, cut, mix, and convert the video clips, the audio clips, and the images of this conversation with ffmpeg, and read their facts with ffprobe.',
  subcommands: [
    {
      name: 'join_clips',
      summary: 'Join two or more video clips into one video clip, in the order that you give.',
      description: 'Joins two or more video clips of this conversation into one new video clip, in the order of `clips`. '
        + 'A video clip shows in the text as `<dez:video id="c" type="video/mp4"/>`, where `c` is its id. The clips themselves do not change. '
        + 'When the streams of the clips match (the same format, codecs, size, and frame rate), Dez joins them with no new encode. '
        + 'Else it encodes them again, at the size and the frame rate of the first clip: as WebM (VP9, Opus) when the first clip is a WebM file, else as MP4 (H.264, AAC). '
        + 'A clip of another shape gets black bars, and a clip with no sound gets silence when another clip has sound. '
        + 'The call starts a job and gives its id at once: get the result with jobs_wait. '
        + 'The new clip goes into your reply, where the user can play it, and the result gives its id. '
        + 'For other work on a clip (a cut, sound for a video clip, another size), use the ffmpeg subcommand.',
      parameters: [
        {
          name: 'clips',
          type: 'string',
          description: 'The ids of the video clips in the order of the join, as in "@c @d". A clip can be there more than once.',
          required: true,
        },
        jobTimeoutParameter(DEFAULT_VIDEO_TIMEOUT_SECONDS),
      ],
      example: { clips: '@c @d' },
    },
    {
      name: 'ffmpeg',
      summary: 'Run ffmpeg with your own arguments on the clips and the images, for example to cut or scale a clip, to put sound on a video clip, or to take a frame as an image.',
      description: FFMPEG_HELP,
      parameters: [ARGUMENTS_PARAMETER, jobTimeoutParameter(DEFAULT_VIDEO_TIMEOUT_SECONDS)],
      example: { arguments: '-i @c -i @b -map 0:v -map 1:a -c:v copy -c:a aac -shortest out.mp4' },
    },
    {
      name: 'ffprobe',
      summary: 'Run ffprobe with your own arguments to read the facts of a clip or an image (its streams, codecs, size, and length).',
      description: 'Runs the ffprobe that Dez ships once, with the arguments that you give, and gives its output as the result of this call (no job), '
        + `up to ${PROGRAM_OUTPUT_CAP} characters. Name a clip or an image by its id with an @, as in \`@c\`. `
        + 'The inputs, the split of the arguments into words, and the refusals are those of the ffmpeg subcommand: its help tells them. '
        + 'A PNG or SVG image goes as a JPEG copy, so the facts are those of the copy. '
        + 'Ask only for what you need: -show_frames and -show_packets of a whole clip are long. '
        + 'ffprobe also gives the lists of this ffmpeg build, as in -encoders, -filters, -formats, -h filter=scale, and -h encoder=libx264.',
      parameters: [ARGUMENTS_PARAMETER],
      example: { arguments: '-v error -show_format -show_streams -of json @c' },
    },
  ],
}

export const VIDEO_TOOL_DEFINITION = subcommandToolDefinition(VIDEO_TOOL)

// What Dez did not do for a call that it refuses, by the program of the
// call: `ffmpeg` runs as a job, and `ffprobe` in the call.
const NOT_DONE: Readonly<Record<ShippedProgram, string>> = {
  ffmpeg: 'Dez started no job.',
  ffprobe: 'Dez did not run ffprobe.',
}

const OTHER_PROGRAM: Readonly<Record<ShippedProgram, ShippedProgram>> = { ffmpeg: 'ffprobe', ffprobe: 'ffmpeg' }

// A word that only a shell reads: an operator between two commands, or a
// redirect (`>`, `2>&1`, `<in.txt`). A filter value such as
// `pan=stereo|c0<c0+c2` is no such word: the operator is not at its start.
const SHELL_WORD = /^(?:&&|\|\||[|;&]|\d*[<>].*)$/

/** The words of the command line `text` for `program`, as a shell splits
 *  them, since that is how every model writes an ffmpeg call:
 *  - white space ends a word;
 *  - single quotes keep their text as it is, and double quotes too, but
 *    for `\"`, which is a double quote;
 *  - the quotes themselves go away, so a single quote reaches the program
 *    only from inside double quotes (`"select='eq(n,0)'"`).
 *
 *  Nothing else of a shell is there. A backslash outside of `\"` stays in
 *  its word, where the argument rule refuses it. A first word that is the
 *  name of the program is dropped. Throws a `ToolError` for a quote that
 *  does not close, a word that only a shell reads, and a text with no
 *  word. */
export function commandLineWords(text: string, program: ShippedProgram): string[] {
  const words: string[] = []
  let word = ''
  let inWord = false
  let quote: '"' | '\'' | null = null
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote === null) {
      if (/\s/.test(char)) {
        if (inWord) words.push(word)
        word = ''
        inWord = false
      } else {
        inWord = true
        if (char === '"' || char === '\'') quote = char
        else word += char
      }
    } else if (char === quote) {
      quote = null
    } else if (quote === '"' && char === '\\' && text[index + 1] === '"') {
      word += '"'
      index++
    } else {
      word += char
    }
  }
  if (quote !== null) {
    throw new ToolError(`\`arguments\` has a ${quote === '"' ? 'double' : 'single'} quote that does not close. `
      + `Dez splits the text into words as a shell does: close the quote or remove it. ${NOT_DONE[program]}`)
  }
  if (inWord) words.push(word)

  const other = OTHER_PROGRAM[program]
  if (words[0] === other) {
    throw new ToolError(`\`arguments\` starts with ${other}, but this is the ${program} subcommand. Call the ${other} subcommand of the video tool to run ${other}. ${NOT_DONE[program]}`)
  }
  if (words[0] === program) words.shift()
  if (words.length === 0) {
    throw new ToolError(`\`arguments\` is blank. Give the arguments of ${program} as one command line, without the program name. ${NOT_DONE[program]}`)
  }
  const shellWord = words.find((candidate) => SHELL_WORD.test(candidate))
  if (shellWord !== undefined) {
    throw new ToolError(`\`arguments\` holds ${JSON.stringify(shellWord)}, which only a shell reads. Dez runs ${program} itself, with no shell: `
      + `there is no pipe, no redirect, and no second command, and the result of the call gives the output of ${program}. `
      + `Give the arguments of one ${program} run. ${NOT_DONE[program]}`)
  }
  return words
}

// The protocols of ffmpeg: a word with one of these names before a `:`
// opens something that is not a file of the work folder (the network, a
// pipe, a file by another name). The list holds every protocol of the
// Linux and macOS builds (`ffmpeg -protocols`; tests/e2e/video-tool.e2e.ts
// checks the build against it), and the demuxers that take a URL of their
// own form.
export const REFUSED_PROTOCOLS: readonly string[] = [
  'async', 'cache', 'concat', 'concatf', 'crypto', 'data', 'fd', 'ffrtmpcrypt', 'ffrtmphttp', 'file', 'ftp', 'gopher', 'gophers',
  'http', 'httpproxy', 'https', 'icecast', 'ipfs', 'ipns', 'md5', 'mmsh', 'mmst', 'pipe', 'prompeg',
  'rtmp', 'rtmpe', 'rtmps', 'rtmpt', 'rtmpte', 'rtmpts', 'rtp', 'srtp', 'subfile', 'tcp', 'tee', 'tls', 'dtls', 'udp', 'udplite', 'unix',
  'rtsp', 'sap', 'sdp', 'hls',
]

// The capture and playback devices of ffmpeg (libavdevice) on Linux and
// macOS: a camera, a microphone, a screen, a sound output. `lavfi` is one
// too, but it only makes pictures and sound from a filter text. A device
// has no file name, so the path checks do not cover it
// (tests/e2e/video-tool.e2e.ts checks the build against this list).
export const REFUSED_DEVICES: readonly string[] = [
  'alsa', 'android_camera', 'audiotoolbox', 'avfoundation', 'bktr', 'caca', 'decklink', 'dshow', 'fbdev', 'gdigrab', 'iec61883', 'jack', 'kmsgrab',
  'libcdio', 'libdc1394', 'openal', 'opengl', 'oss', 'pulse', 'sdl', 'sdl2', 'sndio', 'v4l2', 'vfwcap', 'video4linux2', 'x11grab', 'xcbgrab', 'xv',
]

// The options that take the checks away: a script, a filter graph, or an
// option value that comes from a file (its text is not checked), a file
// that names another file (the key file of HLS encryption), the lists of
// the protocols that a demuxer may open, the `safe` mode of the concat
// demuxer and the file references of a MOV file (both keep a file from
// naming a file outside of its folder), and an attachment that is written
// under the name that the input file gives.
const REFUSED_OPTIONS: readonly string[] = [
  'filter_script', 'filter_complex_script', 'graph_file', 'hls_key_info_file', 'protocol_whitelist', 'protocol_blacklist', 'safe', 'enable_drefs',
  'use_absolute_path', 'dump_attachment',
]

// The chars of a name in an ffmpeg argument, as the inside of a character
// class.
const NAME_CHARS = 'A-Za-z0-9_'

// A `/` that starts an absolute path: at the start of the word, or after a
// char that ends no number, name, or bracket. So the divisions of an
// expression pass (`iw/2`, `30000/1001`, `(ow-iw)/2`, `PTS/2`), and so do
// relative names (`./x`). A `/` before white space is a division too
// (`iw / 2`).
const ABSOLUTE_PATH = new RegExp(String.raw`(?:^|[^${NAME_CHARS}.)])/(?=\S)`)
// `..` as a folder of a path.
const PARENT_FOLDER = /(?:^|\/)\.\.(?:\/|$)|\.\.\//
// A protocol name before `:`, or before `+` (`crypto+file:`); `subfile`
// takes its options after a comma. No name char comes before it: the `v`
// of `-c:v` and the `data` of `-codec:data` are no protocols, and neither
// is `expr:` or a time (`00:00:05`).
const PROTOCOL_FORM = new RegExp(String.raw`(?:^|[^${NAME_CHARS}])(?:(${REFUSED_PROTOCOLS.join('|')})[:+]|(subfile),)`, 'i')
// The `-f` option, which sets the format of the next input or output:
// ffmpeg and ffprobe take a stream part on any option, so `-f:v alsa` is
// `-f alsa`.
const FORMAT_OPTION = /^-f(?::|$)/
// A format as the value of a key of a filter or of a muxer option
// (`movie=x:f=alsa`, `[f=pulse]`).
const KEYED_FORMAT_VALUE = String.raw`(?:^|[^${NAME_CHARS}])(?:f|format|format_name)\s*=\s*`
// A format as the second value with no key of `movie` or `amovie`
// (`amovie=x:pulse`): a filter takes values with no key in the order of its
// options, and format_name comes after filename. The filter can have an
// instance name (`amovie@a=x:pulse`). The first value takes any char but `:`
// and the graph separators, `=` too: ffmpeg takes `x y=z` as a value with
// no key, as no `=` follows the name `x`. So a keyed first value matches
// too, which ffmpeg refuses before a value with no key. Quotes can put a
// separator into the name or the value, so this check needs the text of
// `filterGraphText`.
const MOVIE_FORMAT_VALUE = String.raw`(?:^|[^${NAME_CHARS}])a?movie(?:@[^=,;[]*)?\s*=[^:,;[\]]*:\s*`
// A device as the format of a filter or of a muxer option; the format of
// the `-f` option is the next word, which `argumentProblem` checks.
const DEVICE_FORMAT = new RegExp(String.raw`(?:${KEYED_FORMAT_VALUE}|${MOVIE_FORMAT_VALUE})(${REFUSED_DEVICES.join('|')})(?![${NAME_CHARS}])`, 'i')
// A refused option as a key of an option list inside a word
// (`movie=list.txt:format_opts=safe=0`).
const OPTION_KEY = new RegExp(String.raw`(?:^|[^${NAME_CHARS}])(${REFUSED_OPTIONS.join('|')})\s*=`, 'i')
// The name of the hls format, or of the one file ending of the hls muxer
// (`.m3u8`), as a whole name in a word: ffmpeg takes a format name in any
// case, from many options (`-f`, `-fifo_format`, `-segment_format`, the
// `f=` and `fifo_format=` keys of a filter or of a tee output, the second
// value of `movie`), and takes the hls muxer for an output name that ends
// in `.m3u8`. Option names such as `-hls_time` do not match.
const HLS_NAME = new RegExp(String.raw`(?:^|[^${NAME_CHARS}])(?:hls|m3u8)(?![${NAME_CHARS}])`, 'i')

// The chars that end a filter, its name, or its options in the filter
// graph parser of ffmpeg, unless they are in quotes.
const GRAPH_SEPARATORS = '[],;='

// The text of `word` as the filter graph parser of ffmpeg gives it to the
// parser of a filter's options: with no quotes, and with `_` in place of
// each separator in quotes, as that one ends nothing (`amovie@'a,b'=x:pulse`
// is one filter, `amovie` with the instance name `a,b`). The parser drops
// each quote and takes the text up to the next one as it is; Dez takes no
// backslash, its other escape.
function filterGraphText(word: string): string {
  let quoted = false
  let text = ''
  for (const char of word) {
    if (char === '\'') quoted = !quoted
    else text += quoted && GRAPH_SEPARATORS.includes(char) ? '_' : char
  }
  return text
}

const WORK_FOLDER_ONLY = 'The program works only in its own work folder: name an input as @id, and an output as a new file name with no folder.'

// Why Dez refuses the word `words[index]` of a command line of ffmpeg or
// ffprobe (one rule for both); null for a word that can go. `words` are
// the words after the split, with a bare `@` in place of each `@id` that
// names an input: the id is no part of what the program gets, and an id
// such as `fd` or `oss` must refuse nothing.
//
// The filter and option parsers of ffmpeg drop single quotes
// (`m'o'vie=…` is `movie=…`), so each check of a text inside a word also
// runs on the word without them, and on its `filterGraphText`, where a
// separator in quotes ends no filter. A backslash, their other escape, is
// refused as such.
function argumentProblem(words: readonly string[], index: number): string | null {
  const word = words[index]
  const forms = word.includes('\'') ? [word, word.replaceAll('\'', ''), filterGraphText(word)] : [word]
  const found = (pattern: RegExp) => forms.map((form) => pattern.exec(form)).find((match) => match !== null) ?? null

  if (word.includes('\\')) {
    return 'it holds a backslash, and Dez takes no backslash escape. In a filter, put the value in single quotes in place of the escape, '
      + 'and the whole argument in double quotes, as in "select=\'eq(n,0)\'".'
  }
  if (found(/:\/\//)) return `it holds a URL. ${WORK_FOLDER_ONLY}`
  if (/^-+\//.test(word)) return 'it is an option that reads its value from a file, and Dez does not check that file. Write the value into the arguments.'
  if (word.includes('~')) return `it holds "~". ${WORK_FOLDER_ONLY}`
  if (found(PARENT_FOLDER)) return `it names a parent folder (".."). ${WORK_FOLDER_ONLY}`
  if (found(ABSOLUTE_PATH)) {
    return `it holds an absolute path. ${WORK_FOLDER_ONLY} For a run with no output file, end the arguments with -f null - (not with a path of the system). `
      + 'In an expression, write a division with no space before the "/", as in iw/2.'
  }
  const protocol = found(PROTOCOL_FORM)
  if (protocol) {
    const name = (protocol[1] ?? protocol[2]).toLowerCase()
    return `it holds the protocol form "${name}". ${WORK_FOLDER_ONLY}`
      + (name.startsWith('concat') ? ' To join clips, use the join_clips subcommand or the concat filter.' : '')
  }
  const option = /^-+([^:=]+)/.exec(word)?.[1].toLowerCase()
  const key = option !== undefined && REFUSED_OPTIONS.includes(option) ? option : found(OPTION_KEY)?.[1].toLowerCase()
  if (key !== undefined) return `Dez does not allow the option ${key}: with it, the program could open a file outside of its work folder.`
  const format = FORMAT_OPTION.test(words[index - 1] ?? '') ? word.toLowerCase() : undefined
  const device = format !== undefined && REFUSED_DEVICES.includes(format) ? format : found(DEVICE_FORMAT)?.[1].toLowerCase()
  if (device !== undefined) return `it names the device ${device}. Dez lets the program use no camera, no microphone, no screen, and no sound output of this computer.`
  // An HLS playlist names its segments by any path, and a playlist that an
  // earlier run wrote into a kept file passes every check of the words.
  // The hls demuxer opens those segments. The hls muxer with
  // `-hls_flags append_list+delete_segments` reads the playlist that has
  // the name of its output (the output can be the copy of such a file) and
  // deletes its old segments, each one by the folder of the newest line.
  if (found(HLS_NAME)) {
    return 'it names the hls format or an .m3u8 file. An HLS playlist can name files outside the work folder by paths that Dez cannot check, '
      + 'and ffmpeg reads those files as segments, or deletes them as old segments. So Dez lets the program read and write no HLS playlist. '
      + 'To cut a clip into short clips, use the segment format, as in -f segment -segment_time 5 -reset_timestamps 1 part%03d.mp4.'
  }
  // The null muxer opens no file, so its `-` names nothing: `-f null -` is
  // the usual form of a run whose log is the result.
  if (word === '-' && !(words[index - 1] === 'null' && FORMAT_OPTION.test(words[index - 2] ?? ''))) {
    return 'it is the standard input or output. The program gets no input stream, and Dez keeps no output stream: name an output as a new file name. '
      + 'Only -f null - can have a lone "-", for a run with no output file.'
  }
  return null
}

/** An image of a call, as the program gets it. */
export interface ImageInput {
  kind: 'image'
  id: string
  /** The name of its copy in the work folder. */
  name: string
  path: string
  /** The copy is a JPEG drawing of the image, not its file: this ffmpeg
   *  build reads no PNG (it has no zlib) and no SVG. */
  jpegCopy: boolean
}

export type VideoInput = ImageInput | ClipInput

// The image types whose files this ffmpeg build reads, with the extension
// of the copy.
const READ_IMAGE_TYPES: Readonly<Record<string, string>> = { 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

// The input that the id `id` names; null for an id of no image and no
// clip. The name of an image's copy is the id and the extension of the
// file's type, as for a clip (`clipInput`).
function inputOf(id: string, assets: ConversationAssets): VideoInput | null {
  const path = assets.images.get(id)
  if (path !== undefined) {
    const type = imageMediaType(path)
    const extension = type !== null && Object.hasOwn(READ_IMAGE_TYPES, type) ? READ_IMAGE_TYPES[type] : null
    return { kind: 'image', id, name: `${id}.${extension ?? 'jpg'}`, path, jpegCopy: extension === null }
  }
  const clip = assets.clips.get(id)
  return clip ? clipInput(clip) : null
}

/** A run of a program that a call asks for. */
export interface ProgramCall {
  /** The arguments of the program: what Dez adds, then the words of the
   *  call with the name of each copy in place of its `@id`. */
  args: string[]
  /** The images and the clips that the arguments name, each one once, in
   *  the order of their first mention. */
  inputs: VideoInput[]
}

// The run that the `arguments` of a call ask for. An `@id` mention
// (imageMentions.ts) in a word is an input; any other `@` word is plain
// text, as in a prompt. Throws a `ToolError` for a text that is no command
// line (`commandLineWords`), a word that the argument rule refuses, and an
// `@id` that names nothing (`unknownInputsProblem`).
function programCall(program: ShippedProgram, fixedArgs: readonly string[], args: ToolArguments, sections: readonly Section[]): ProgramCall {
  const words = commandLineWords(typeof args.arguments === 'string' ? args.arguments : '', program)
  const assets = conversationAssets(sections)
  const inputs = new Map<string, VideoInput>()
  const unknownIds = new Set<string>()
  const named: string[] = []
  const masked: string[] = []
  for (const word of words) {
    const mentions = findAssetMentions(word)
    for (const { id } of mentions) {
      const input = inputs.get(id) ?? inputOf(id, assets)
      if (input) inputs.set(id, input)
      else unknownIds.add(id)
    }
    let name = word
    let mask = word
    // From the last mention to the first, so that the offsets of the
    // earlier ones stay true.
    for (const { from, to, id } of mentions.reverse()) {
      const input = inputs.get(id)
      if (!input) continue
      name = name.slice(0, from) + input.name + name.slice(to)
      mask = `${mask.slice(0, from)}@${mask.slice(to)}`
    }
    named.push(name)
    masked.push(mask)
  }

  const refused = masked.findIndex((_, index) => argumentProblem(masked, index) !== null)
  if (refused >= 0) {
    throw new ToolError(`Dez refuses ${JSON.stringify(words[refused])} in \`arguments\`: ${argumentProblem(masked, refused)} ${NOT_DONE[program]}`)
  }
  const [nextId] = newMediaIds(sections.map(sectionPlainText), 1)
  const unknown = unknownInputsProblem([...unknownIds], assets, nextId, { argument: '`arguments`', notDone: NOT_DONE[program] })
  if (unknown !== null) throw new ToolError(unknown)
  return { args: [...fixedArgs, ...named], inputs: [...inputs.values()] }
}

/** The run of an `ffmpeg` call, as a job. */
export interface FfmpegCall extends ProgramCall {
  timeoutMs: number
  /** The arguments name the null format (`-f null`): a run that makes no
   *  file did what the call asked for. */
  nullOutput: boolean
}

/** The run that a `video ffmpeg` call asks for, from its checked arguments
 *  and the sections of its tab. Throws a `ToolError`, whose text tells the
 *  model how to fix the call, for a bad time limit and for arguments that
 *  Dez does not run (`programCall`). */
export function ffmpegCall(args: ToolArguments, sections: readonly Section[]): FfmpegCall {
  const timeoutMs = jobTimeoutMs(args, DEFAULT_VIDEO_TIMEOUT_SECONDS)
  const call = programCall('ffmpeg', FFMPEG_FIXED_ARGS, args, sections)
  return { ...call, timeoutMs, nullOutput: call.args.some((word, index) => word === 'null' && FORMAT_OPTION.test(call.args[index - 1] ?? '')) }
}

/** The run that a `video ffprobe` call asks for, as `ffmpegCall`. */
export function ffprobeCall(args: ToolArguments, sections: readonly Section[]): ProgramCall {
  return programCall('ffprobe', FFPROBE_FIXED_ARGS, args, sections)
}

// What the result of a call tells of an image that goes as a JPEG copy.
const JPEG_COPY_NOTE = 'a JPEG copy, with white in place of transparent pixels'

/** What the result of a call that started a job adds after
 *  `jobStartedText`: the inputs of the run with the names of their copies,
 *  so that the model sees at once what the program gets, and by which
 *  names the log calls them. */
export function videoInputsText(inputs: readonly VideoInput[]): string {
  if (inputs.length === 0) return 'The run has no input image and no input clip.'
  const parts = inputs.map((input) => `${assetText(input)} as ${input.name}${input.kind === 'image' && input.jpegCopy ? ` (${JPEG_COPY_NOTE})` : ''}`)
  return `The inputs of the run: ${parts.join(', ')}.`
}

/** The clips of a `join_clips` call. */
export interface JoinCall {
  /** The clips in the order of the join. A clip can be there twice. */
  clips: ClipInput[]
  /** The clips as input files, each one once. */
  inputs: ClipInput[]
  timeoutMs: number
}

/** The join that a `video join_clips` call asks for, from its checked
 *  arguments and the sections of its tab. Throws a `ToolError` for a bad
 *  time limit, fewer than two ids, a word that is no id, and an id that
 *  names no video clip; the text tells the model the ids that it can
 *  name. */
export function joinClipsCall(args: ToolArguments, sections: readonly Section[]): JoinCall {
  const timeoutMs = jobTimeoutMs(args, DEFAULT_VIDEO_TIMEOUT_SECONDS)
  const words = (typeof args.clips === 'string' ? args.clips : '').split(/[\s,]+/).filter((word) => word !== '')
  const form = 'Give the ids of the video clips in the order of the join, as in "@c @d".'
  const ids = words.map((word) => {
    const id = /^@?([a-z]+)$/.exec(word)?.[1]
    if (id === undefined) throw new ToolError(`\`clips\` holds ${JSON.stringify(word)}, which is no id of a clip. ${form} Dez started no job.`)
    return id
  })
  if (ids.length < 2) {
    throw new ToolError(`\`clips\` names ${ids.length === 0 ? 'no clip' : 'one clip'}, and a join needs two or more video clips. ${form} Dez started no job.`)
  }

  const assets = conversationAssets(sections)
  const videoIds = Array.from(assets.clips.values()).filter((clip) => clip.kind === 'video').map((clip) => `@${clip.id}`)
  const inputs = new Map<string, ClipInput>()
  const clips = ids.map((id) => {
    const input = inputs.get(id) ?? inputOf(id, assets)
    if (input?.kind === 'video') {
      inputs.set(id, input)
      return input
    }
    if (input?.kind === 'image') {
      throw new ToolError(`@${id} is an image, and join_clips joins video clips only. To make a video clip from an image, use the ffmpeg subcommand: its help has an example. Dez started no job.`)
    }
    if (input?.kind === 'audio') {
      throw new ToolError(`@${id} is an audio clip, and join_clips joins video clips only. To put sound on a video clip, use the ffmpeg subcommand: its help has an example. Dez started no job.`)
    }
    throw new ToolError(videoIds.length === 0
      ? `This conversation has no video clips, so it has no video clip @${id}. Dez started no job. Do not call join_clips until the conversation has two video clips.`
      : `No video clip of this conversation has the id @${id}. Its video clips are ${videoIds.join(', ')}: call again with these ids. Dez started no job.`)
  })
  return { clips, inputs: [...inputs.values()], timeoutMs }
}

// What ffprobe tells of each stream and of the file, for the plan of a
// join. `-show_data_hash` gives the hash of a stream's codec setup data
// (`extradata_hash`).
const JOIN_PROBE_ENTRIES = 'stream=index,codec_type,codec_name,profile,level,width,height,pix_fmt,r_frame_rate,avg_frame_rate,time_base,'
  + 'sample_rate,channels,channel_layout,sample_aspect_ratio,extradata_hash:stream_side_data=rotation:format=format_name,duration'

/** The arguments of the ffprobe run that reads the facts of the clip file
 *  `name` for a join (`clipFacts` reads its output). */
export function joinProbeArgs(name: string): string[] {
  return [...FFPROBE_FIXED_ARGS, '-v', 'error', '-show_data_hash', 'md5', '-show_entries', JOIN_PROBE_ENTRIES, '-of', 'json', name]
}

// The output of `joinProbeArgs`. It comes from a program that read a file
// of any origin, so every field can be missing or of another type.
const probeSchema = z.object({
  streams: z.array(z.record(z.string(), z.unknown())).catch([]),
  format: z.record(z.string(), z.unknown()).catch({}),
})

/** The facts of a clip that the plan of a join needs. */
export interface ClipFacts {
  /** Every fact that must be the same in two clips for a stream copy of
   *  both into one file, as one text. */
  signature: string
  /** The size of the picture as a player shows it. */
  width: number
  height: number
  /** The frame rate as ffprobe writes it (`30000/1001`); blank when the
   *  file tells none that a clip can have. */
  frameRate: string
  hasAudio: boolean
  /** The length in seconds; null when the file tells none. */
  duration: number | null
}

// A scalar of the probe output as text; blank for none.
function probeText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

// A frame rate of the probe output, when it is one that a clip can have
// (ffprobe gives `0/0` for none, and the tick rate of a container for a
// clip with a changing rate). The text goes into a filter, so only a
// fraction of two whole numbers passes.
function usableFrameRate(value: unknown): string {
  const match = /^(\d+)\/(\d+)$/.exec(probeText(value))
  if (!match) return ''
  const rate = Number(match[1]) / Number(match[2])
  return Number.isFinite(rate) && rate > 0 && rate <= 120 ? match[0] : ''
}

/** The facts of a clip from the output of its `joinProbeArgs` run. Null
 *  when the output names no video stream with a size: the file holds only
 *  sound, or the program could not read it. */
export function clipFacts(probeOutput: string): ClipFacts | null {
  let probe: z.infer<typeof probeSchema>
  try {
    probe = probeSchema.parse(JSON.parse(probeOutput))
  } catch {
    return null
  }
  const { streams, format } = probe
  const video = streams.find((stream) => stream.codec_type === 'video')
  const audio = streams.find((stream) => stream.codec_type === 'audio')
  if (!video) return null
  const { width, height } = video
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null

  const sideData = Array.isArray(video.side_data_list) ? video.side_data_list as unknown[] : []
  const rotation = sideData
    .map((data) => (data !== null && typeof data === 'object' ? (data as Record<string, unknown>).rotation : undefined))
    .find((value): value is number => typeof value === 'number') ?? 0
  // ffmpeg turns the frames of a clip with a rotation when it decodes them.
  const turned = Math.abs(rotation) % 180 === 90
  const duration = Number(probeText(format.duration))
  const facts = (stream: Record<string, unknown>, keys: readonly string[]) => keys.map((key) => probeText(stream[key]))
  return {
    signature: JSON.stringify([
      probeText(format.format_name),
      streams.map((stream) => probeText(stream.codec_type)),
      [...facts(video, ['index', 'codec_name', 'profile', 'level', 'width', 'height', 'pix_fmt', 'r_frame_rate', 'time_base', 'sample_aspect_ratio', 'extradata_hash']), rotation],
      audio ? facts(audio, ['index', 'codec_name', 'profile', 'sample_rate', 'channels', 'channel_layout', 'time_base', 'extradata_hash']) : null,
    ]),
    width: turned ? height : width,
    height: turned ? width : height,
    frameRate: usableFrameRate(video.avg_frame_rate) || usableFrameRate(video.r_frame_rate),
    hasAudio: audio !== undefined,
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
  }
}

/** A clip of a join: the name of its file in the work folder, and its
 *  facts. */
export interface JoinClip {
  name: string
  facts: ClipFacts
}

/** How Dez joins clips. */
export type JoinPlan =
  | {
    /** A stream copy: no new encode. */
    kind: 'copy'
    /** The file that lists the clips, which Dez writes into the work
     *  folder before the run. */
    list: { name: string, text: string }
    args: string[]
    output: string
  }
  | {
    /** A new encode of every clip. */
    kind: 'encode'
    args: string[]
    output: string
    /** The new clip, for the result text. */
    format: string
    width: number
    height: number
    hasAudio: boolean
  }

// The containers into which a stream copy of matching clips goes as it is.
const COPY_EXTENSIONS: readonly string[] = ['mp4', 'mov', 'webm']

// An encoder takes only even sizes for the usual pixel format.
function evenSize(size: number): number {
  return Math.max(2, size - size % 2)
}

/** The plan of the join of `clips` (two or more, in order; a clip can be
 *  there twice):
 *  - A stream copy, when every clip has the same streams (`signature`) and
 *    a container that takes a copy. The concat demuxer reads the clips
 *    from a list file.
 *  - Else a new encode into the format family of the first clip (WebM for
 *    a WebM file, else MP4), at the size and the frame rate of the first
 *    clip: the concat filter needs the same size, rate, and sound format
 *    in every part, so each clip is scaled into that size (with bars for
 *    another shape) and its sound made stereo at 48 kHz. When some clip
 *    has sound, a clip with none gets silence of its own length. */
export function joinPlan(clips: readonly JoinClip[]): JoinPlan {
  const [first] = clips
  const extension = first.name.slice(first.name.lastIndexOf('.') + 1)
  if (COPY_EXTENSIONS.includes(extension) && clips.every((clip) => clip.facts.signature === first.facts.signature)) {
    const output = `${JOINED_NAME}.${extension}`
    return {
      kind: 'copy',
      list: { name: JOIN_LIST_FILE, text: ['ffconcat version 1.0', ...clips.map((clip) => `file '${clip.name}'`), ''].join('\n') },
      args: [...FFMPEG_FIXED_ARGS, '-f', 'concat', '-i', JOIN_LIST_FILE, '-c', 'copy', ...(extension === 'webm' ? [] : ['-movflags', '+faststart']), output],
      output,
    }
  }

  const width = evenSize(first.facts.width)
  const height = evenSize(first.facts.height)
  const frameRate = first.facts.frameRate || '30'
  const hasAudio = clips.some((clip) => clip.facts.hasAudio)
  const parts = clips.flatMap((clip, index) => [
    `[${index}:v:0]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${frameRate},format=yuv420p[v${index}]`,
    ...(!hasAudio
      ? []
      : [clip.facts.hasAudio
          ? `[${index}:a:0]aformat=sample_rates=48000:channel_layouts=stereo[a${index}]`
          // The concat filter makes a sound part as long as its picture, so
          // a clip with no known length needs only a start of silence.
          : `anullsrc=r=48000:cl=stereo,atrim=duration=${(clip.facts.duration ?? 0.1).toFixed(3)}[a${index}]`]),
  ])
  const pads = clips.map((_, index) => `[v${index}]${hasAudio ? `[a${index}]` : ''}`).join('')
  const graph = [...parts, `${pads}concat=n=${clips.length}:v=1:a=${hasAudio ? 1 : 0}[v]${hasAudio ? '[a]' : ''}`].join(';')
  const webm = extension === 'webm'
  const output = `${JOINED_NAME}.${webm ? 'webm' : 'mp4'}`
  return {
    kind: 'encode',
    args: [
      ...FFMPEG_FIXED_ARGS,
      ...clips.flatMap((clip) => ['-i', clip.name]),
      '-filter_complex', graph,
      '-map', '[v]',
      ...(hasAudio ? ['-map', '[a]'] : []),
      ...(webm
        ? ['-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-row-mt', '1', ...(hasAudio ? ['-c:a', 'libopus'] : [])]
        : ['-c:v', 'libx264', '-crf', '18', '-preset', 'medium', ...(hasAudio ? ['-c:a', 'aac'] : []), '-movflags', '+faststart']),
      output,
    ],
    output,
    format: webm ? `WebM (VP9${hasAudio ? ', Opus' : ''})` : `MP4 (H.264${hasAudio ? ', AAC' : ''})`,
    width,
    height,
    hasAudio,
  }
}

/** A file of a work folder (`dez.native/listAppFiles`). */
export interface WorkFile {
  name: string
  size: number
}

/** The new files of a run. */
export interface OutputFiles {
  kept: KeptFile[]
  /** Each new file that Dez does not keep, with the cause, as a part of a
   *  sentence: `notes.txt (Dez stores no file of its type)`. */
  notKept: string[]
}

/** The new files of a run from the files of its work folder after the run,
 *  in the order of their names (`frame_2.jpg` before `frame_10.jpg`).
 *  `inputNames` are the files that Dez put there. Dez keeps a file of a
 *  type that it stores, by the ending of its name: a clip (`storableClip`)
 *  or an image; no SVG, which no ffmpeg run draws. An empty file and a
 *  file over the size limit of a stored clip are not kept. */
export function outputFiles(files: readonly WorkFile[], inputNames: ReadonlySet<string>): OutputFiles {
  const kept: KeptFile[] = []
  const notKept: string[] = []
  const made = files.filter(({ name }) => !inputNames.has(name)).sort((one, other) => one.name.localeCompare(other.name, 'en', { numeric: true }))
  for (const { name, size } of made) {
    const clip = storableClip('', name)
    const imageType = clip ? null : imageMediaType(name)
    const file: KeptFile | null = clip
      // `storableClip` found the type by this ending of the name.
      ? { name, kind: clip.kind, type: clip.type, extension: name.slice(name.lastIndexOf('.') + 1).toLowerCase() }
      : imageType !== null && imageType !== 'image/svg+xml' ? { name, kind: 'image', type: imageType, extension: imageExtension(imageType) } : null
    if (!file) notKept.push(`${name} (Dez stores no file of its type)`)
    else if (size === 0) notKept.push(`${name} (it is empty)`)
    else if (size > MAX_SAVED_CLIP_BYTES) notKept.push(`${name} (it is larger than ${byteSizeText(MAX_SAVED_CLIP_BYTES)}, the most that Dez stores)`)
    else kept.push(file)
  }
  return { kept, notKept }
}

// A progress line of ffmpeg: `frame=   20 fps=0.0 q=30.0 Lsize=…`, or
// `size=…` for a run with no picture.
const PROGRESS_LINE = /^(?:frame|size)=/

// The most characters of the log that `ProgramLog` keeps, and the most of
// one line: a program that writes data with no line end must not push the
// lines before it out of the log.
const LOG_KEPT_CHARS = 16_000
const LOG_LINE_CHARS = 2000

/** The log of an ffmpeg run, from the pieces of its error output
 *  (`dez.native/runBundledTool` gives pieces, not lines). It keeps the end
 *  of the log, as a long run writes megabytes, and the last progress
 *  line: ffmpeg writes a new one every half second over the last one (with
 *  a carriage return), so only the last one tells something. */
export class ProgramLog {
  /** The last progress line, with its columns closed up; blank before
   *  the first one. It is the state of the job. */
  progress = ''
  // The start of a line whose end has not come yet.
  private pending = ''
  private lines: string[] = []
  private size = 0

  add(piece: string): void {
    const parts = (this.pending + piece).split(/[\r\n]+/)
    this.pending = (parts.pop() ?? '').slice(-LOG_LINE_CHARS)
    for (const part of parts) this.addLine(part)
  }

  private addLine(text: string): void {
    const line = text.trimEnd().slice(-LOG_LINE_CHARS)
    if (line === '') return
    if (PROGRESS_LINE.test(line)) {
      this.progress = line.replace(/=\s+/g, '=').replace(/\s+/g, ' ')
      return
    }
    this.lines.push(line)
    this.size += line.length + 1
    while (this.size > LOG_KEPT_CHARS && this.lines.length > 1) this.size -= (this.lines.shift() ?? '').length + 1
  }

  /** The end of the log, in at most `maxChars` characters: its last lines,
   *  then the last progress line. A log that is longer starts with `…`
   *  and a whole line. Blank for a run that wrote nothing. */
  end(maxChars: number): string {
    // The run ended, so the pending text is the last line.
    this.add('\n')
    const text = [...this.lines, ...(this.progress === '' ? [] : [this.progress])].join('\n')
    if (text.length <= maxChars) return text
    const end = text.slice(-maxChars)
    const lineStart = end.indexOf('\n')
    return `…${lineStart < 0 ? end : end.slice(lineStart)}`
  }
}

/** The start of an output of a program, in at most `PROGRAM_OUTPUT_CAP`
 *  characters, from its pieces. */
export class OutputStart {
  text = ''
  /** The program wrote more than `text` holds. */
  cut = false

  add(piece: string): void {
    const room = PROGRAM_OUTPUT_CAP - this.text.length
    this.text += piece.slice(0, room)
    if (piece.length > room) this.cut = true
  }
}

/** The state of a job before its program runs. */
export const VIDEO_READS_INPUTS = 'Dez gets the input files ready.'

/** The state of a `join_clips` job while ffprobe reads its clips. */
export const JOIN_READS_CLIPS = 'Dez reads the facts of the clips.'

/** The state of a job while ffmpeg runs: the last progress line of ffmpeg
 *  (`ProgramLog.progress`). */
export function ffmpegStateText(progress: string): string {
  return progress === '' ? 'ffmpeg runs.' : `ffmpeg runs. Its last progress line: ${progress}`
}

const TELL_USER_CONSOLE = tellUserConsole(VIDEO_TOOL.name)

/** The error result of a call whose input image `id` Dez could not draw as
 *  a JPEG copy. */
export function jpegCopyFailedText(id: string): string {
  return `Dez could not make the JPEG copy of the image @${id} for the program: the webview could not decode or draw the image. ${TELL_USER_CONSOLE}`
}

function withLog(text: string, logEnd: string): string {
  return logEnd.trim() === '' ? `${text}\nffmpeg wrote no log.` : `${text}\nThe end of the log of ffmpeg:\n${logEnd}`
}

function notKeptText(notKept: readonly string[]): string {
  return notKept.length === 0 ? '' : ` Dez did not keep ${notKept.join(', ')}.`
}

// What the failure text of an ffmpeg run tells the model to do. A `video
// ffmpeg` call gives the arguments; Dez builds those of `join_clips`
// (`joinPlan`), so its call can change only its clips.
interface FfmpegAdvice {
  /** After a run that ended with an error code, before its log. */
  failed: string
  /** After a run that wrote more output than Dez takes. */
  tooMuchOutput: string
}

const FFMPEG_CALL_ADVICE: FfmpegAdvice = {
  // A model that read the name of a copy in an earlier result (`c.mp4`)
  // can take it for a file that stays.
  failed: 'Read the end of its log: fix the arguments and call again, or, when the log tells that an input file is the problem, tell the user. '
    + 'Each call has a new work folder, which holds only the inputs that the call names as @id.',
  tooMuchOutput: 'Call again with a lower log level (-v error gives only the errors), and with no option that prints data.',
}

const JOIN_ADVICE: FfmpegAdvice = {
  failed: 'When the end of its log tells of a clip that is broken (the log names a clip by its id: c.mp4 is @c), call again without that clip. '
    + 'Else this is not a fault of the call: tell the user.',
  tooMuchOutput: 'This is not a fault of the call. Tell the user.',
}

// The error result of an ffmpeg run that did not end with the code 0;
// null for one that did. `timedOut` is not here: the job has the text of
// its own time limit (`jobTimedOutText`).
function ffmpegFailureText(end: Exclude<ProgramEnd, { kind: 'timedOut' }>, log: ProgramLog, advice: FfmpegAdvice): string | null {
  if (end.kind === 'outputTooLarge') {
    return `Dez stopped ffmpeg: it wrote more than ${byteSizeText(FFMPEG_OUTPUT_BYTES)} of output. Dez kept no file. ${advice.tooMuchOutput}`
  }
  if (end.code === null) {
    return withLog('The system ended ffmpeg before it was done (for example, the computer had no memory left). Dez kept no file. '
      + 'This is not a fault of the call. Tell the user, and call again only for a smaller task or when the user asks for it.', log.end(LOG_END))
  }
  if (end.code === 0) return null
  return withLog(`ffmpeg ended with the error code ${end.code}, and Dez kept no file. ${advice.failed}`, log.end(LOG_END))
}

/** The result of an ffmpeg run that ended, before its new files move:
 *  `isError` with the text of a run that failed or that gave nothing, else
 *  the text that goes with the kept files. */
export function ffmpegRunResult(
  call: Pick<FfmpegCall, 'nullOutput'>,
  end: Exclude<ProgramEnd, { kind: 'timedOut' }>,
  files: OutputFiles,
  log: ProgramLog,
  output: OutputStart,
): { text: string, isError: boolean } {
  const failure = ffmpegFailureText(end, log, FFMPEG_CALL_ADVICE)
  if (failure !== null) return { text: failure, isError: true }
  const { kept, notKept } = files
  if (kept.length > MAX_VIDEO_OUTPUT_FILES) {
    return {
      text: `ffmpeg made ${kept.length} files that Dez stores, and Dez keeps at most ${MAX_VIDEO_OUTPUT_FILES} of one call, so it kept none. `
        + `Call again for at most ${MAX_VIDEO_OUTPUT_FILES} files (for frames: a lower rate, as in -vf fps=1, or a count, as in -frames:v 10).`,
      isError: true,
    }
  }
  if (kept.length > 0) {
    const names = kept.map(({ name, kind }) => `${name} (${ASSET_NAMES[kind]})`).join(', ')
    const ids = kept.length === 1 ? 'The line at the end gives its id.' : 'The lines at the end give their ids in this order.'
    return {
      text: withLog(`ffmpeg ended with no error and made ${kept.length === 1 ? '1 file' : `${kept.length} files`} that Dez keeps: ${names}. ${ids}${notKeptText(notKept)}`, log.end(LOG_END_WITH_FILES)),
      isError: false,
    }
  }
  // A run that only prints (`-encoders`, `-h filter=scale`) writes to the
  // standard output; a run with files or with the null format does not.
  if (output.text.trim() !== '') {
    const cut = output.cut ? ` This is its first ${PROGRAM_OUTPUT_CAP} characters.` : ''
    return { text: `ffmpeg ended with no error and made no file.${notKeptText(notKept)} Its output:${cut}\n${output.text.trim()}`, isError: false }
  }
  if (call.nullOutput) {
    return { text: withLog(`ffmpeg ended with no error. It made no file, as the call asked for with -f null.${notKeptText(notKept)}`, log.end(LOG_END)), isError: false }
  }
  return {
    text: withLog(`ffmpeg ended with no error, but it made no new file that Dez keeps.${notKeptText(notKept)} `
      + 'Give each output a new file name with no folder, made of ASCII letters, digits, ".", "_", and "-" only (Dez does not see a file with another name), '
      + `with an ending that Dez stores (${KEPT_ENDINGS}). An output with the name of an input is not written.`, log.end(LOG_END)),
    isError: true,
  }
}

// How an ffprobe run that read no facts ended, as a part of a sentence.
function probeEndText(end: ProgramEnd): string {
  if (end.kind === 'timedOut') return `it did not end within ${FFPROBE_TIMEOUT_MS / 1000} seconds`
  if (end.kind === 'outputTooLarge') return `it wrote more than ${byteSizeText(FFPROBE_OUTPUT_BYTES)} of output`
  return end.code === null ? 'the system ended it' : `error code ${end.code}`
}

/** The error result of a `join_clips` job whose clip `id` ffprobe could
 *  not read: `end` tells how its run ended, and `output` what it wrote. */
export function joinProbeFailedText(id: string, end: ProgramEnd, output: string): string {
  return `ffprobe could not read the video clip @${id} (${probeEndText(end)}), so Dez joined nothing: `
    + 'the file is broken, or this ffmpeg does not read its format. This is not a fault of the call. Tell the user.'
    + (output.trim() === '' ? '' : `\nThe output of ffprobe:\n${output.trim().slice(-LOG_END)}`)
}

/** The error result of a `join_clips` job whose clip `id` has no video
 *  stream. */
export function joinNoVideoText(id: string): string {
  return `The video clip @${id} has no picture that ffmpeg can read (its file holds only sound, or it is broken), so Dez joined nothing. `
    + 'join_clips joins only clips with a picture. Call again without it, or tell the user.'
}

/** The result of a `join_clips` job whose ffmpeg run ended: `isError` with
 *  the text of a run that failed or that made no file, else the text that
 *  goes with the new clip. `joined` tells that the output file is there;
 *  `notKept` gives the reason of each new file that Dez did not keep
 *  (`OutputFiles`). */
export function joinRunResult(plan: JoinPlan, count: number, end: Exclude<ProgramEnd, { kind: 'timedOut' }>, joined: boolean, notKept: readonly string[], log: ProgramLog): { text: string, isError: boolean } {
  const failure = ffmpegFailureText(end, log, JOIN_ADVICE)
  if (failure !== null || !joined) {
    return {
      text: failure !== null
        ? `Dez could not join the clips. ${failure}`
        : withLog(`Dez could not join the clips: ffmpeg ended with no error, but it made no clip that Dez can store.${notKeptText(notKept)} This is not a fault of the call. Tell the user.`, log.end(LOG_END)),
      isError: true,
    }
  }
  if (plan.kind === 'copy') return { text: `Joined the ${count} clips into one clip with no new encode: their streams match.`, isError: false }
  return {
    text: `Joined the ${count} clips into one ${plan.width}x${plan.height} ${plan.format} clip. Dez encoded them again, as their streams do not match `
      + '(a join with no new encode needs the same format, codecs, size, and frame rate in every clip).'
      + (plan.hasAudio ? ' A clip with no sound has silence in the new clip.' : ''),
    isError: false,
  }
}

/** The result of an ffprobe run that ended with the code 0: what it wrote
 *  to its standard output, then what it wrote to its error output (a plain
 *  `ffprobe @c` writes its facts only there), in at most
 *  `PROGRAM_OUTPUT_CAP` characters. A first line tells of a cut and of a
 *  JPEG copy. */
export function ffprobeResultText(inputs: readonly VideoInput[], output: OutputStart, errorOutput: OutputStart): string {
  const whole = [output.text.trim(), errorOutput.text.trim()].filter((text) => text !== '').join('\n\n')
  const cut = output.cut || errorOutput.cut || whole.length > PROGRAM_OUTPUT_CAP
  const notes = [
    ...(cut ? [`ffprobe wrote more than a result holds: this is the first ${PROGRAM_OUTPUT_CAP} characters. Ask for less, for example with -show_entries or -read_intervals.`] : []),
    ...inputs
      .filter((input) => input.kind === 'image' && input.jpegCopy)
      .map(({ id }) => `The image @${id} went to ffprobe as ${JPEG_COPY_NOTE}: the facts are those of the copy.`),
  ]
  return [...notes, whole === '' ? 'ffprobe ended with no error and wrote nothing.' : whole.slice(0, PROGRAM_OUTPUT_CAP)].join('\n')
}

/** The error result of an ffprobe run that did not end with the code 0,
 *  with the end of what it wrote. */
export function ffprobeFailedText(end: ProgramEnd, output: OutputStart, errorOutput: OutputStart): string {
  if (end.kind === 'timedOut') {
    return `Dez stopped ffprobe: it did not end within ${FFPROBE_TIMEOUT_MS / 1000} seconds. Ask for less (no -show_frames or -show_packets of a whole clip, or with -read_intervals).`
  }
  if (end.kind === 'outputTooLarge') {
    return `Dez stopped ffprobe: it wrote more than ${byteSizeText(FFPROBE_OUTPUT_BYTES)} of output. Ask for less, for example with -show_entries or -read_intervals.`
  }
  const written = [output.text.trim(), errorOutput.text.trim()].filter((text) => text !== '').join('\n\n')
  const lead = end.code === null
    ? 'The system ended ffprobe before it was done. This is not a fault of the call. Tell the user.'
    : `ffprobe ended with the error code ${end.code}. Read its output: fix the arguments and call again, or, when the output tells that the file is the problem, tell the user.`
  return written === '' ? `${lead}\nffprobe wrote nothing.` : `${lead}\nThe output of ffprobe:\n${written.slice(-LOG_END)}`
}
