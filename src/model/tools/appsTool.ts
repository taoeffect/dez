import { byteSizeText } from '../../utils/byteSize'
import { countOf, countText } from '../../utils/countText'
import { oneLineCut } from '../../utils/oneLineCut'
import { seriesText } from '../../utils/seriesText'
import { startOf } from '../../utils/textCut'
import { searchTerms, textMatches } from '../textSearch'
import { APP_HANDLER_EXAMPLE, APP_READ_ASSET, APP_RUN_FRAME_SIZE, APP_SAVE_ASSET } from './appBridge'
import { APP_KINDS, BUILT_IN_APP_PREFIX, isAppName, isBuiltInApp, MANIFEST_FILE, MANIFEST_MAX_BYTES, MAX_DESCRIPTION_LENGTH, NATIVE_CANVAS_LIBRARY, NATIVE_FIELD_EXAMPLE, parseAppManifest, UNKNOWN_APP_KIND, type AppKind, type AppManifest, type ListedAppKind } from './appManifest'
import { appTemplateFiles, DENO_ONLY_NAMES, SCRIPT_MAIN_FILE, UI_CLIENT_SCRIPT_TAG, UI_INDEX_FILE, UI_LIBS_ROUTE, UI_OWN_SCRIPT_TAG } from './appTemplates'
import { unknownValuesText } from './arguments'
import { conversationWorkFolder, WORK_VIRTUAL_ROOT } from './conversationWork'
import { GREP_LINE_MAX_CHARACTERS, GREP_MAX_CHARACTERS, GREP_MAX_CONTEXT, GREP_MAX_MATCHES, GREP_TIME_LIMIT_SECONDS } from './grepMatch'
import { INTERMEDIATE_PARAMETER, JOB_CALL_NOTE, jobTimeoutParameter } from './jobs'
import { linesName, linesText, planLineEdits, textLines, textOfBytes, type DiffHunk, type LineEdit } from './lineEdits'
import { withoutLocalPaths } from './localPaths'
import { subcommandToolDefinition, type SubcommandTool } from './subcommands'
import { ToolError, type SubcommandArguments, type SubcommandParameter, type ToolArguments } from './types'

// The `apps` tool: the files of the apps, the small programs that a model
// writes for the user. Each app is one folder of `apps/` in the app root,
// and it stays from one conversation to the next. The built-in apps of Dez
// (`isBuiltInApp`, the `dez-` names) are in the files that Dez ships
// (`BUILT_IN_APPS_FOLDER` of the resource root), and no call changes them
// (`checkChangeable`). A model names a file by a virtual path that starts
// with `/apps/` (`/apps/<app>/main.js`), so no call and no result holds a
// path of the computer.
//
// The file subcommands work on two more places (`AppsTop`): `/libs/`, the
// libraries that Dez ships, which they only read, and `/work/`, the work
// folder of the conversation of the call (conversationWork.ts). The caps
// of an app (`checkAppRoom`) do not hold in `/work/`: the runs of the
// conversation fill it, and it goes with its conversation.
//
// This module has the pure parts: the definition, the checks of a call,
// the rules of a path, the limits, and every text that the calling model
// reads. controller/appsTool.ts does the file work. Of `invoke`, which
// runs a script app, of `show`, which puts a UI app into the reply, and of
// `grep`, which searches the lines of files, it has only the definition and
// the help: the rules and the texts of a run are in appInvoke.ts, those of
// `show` in appShow.ts, and those of `grep` in appsGrep.ts and grepMatch.ts.
//
// Every text here is a tool result: it goes to the chat provider. The tool
// builds its texts from virtual paths only. It does not send them through
// `withoutLocalPaths`: that rule takes `/apps/x/home/y` for a path of the
// computer (a folder `home` or `Users` in the first folders of a path).
// Only the raw text of a failed file operation goes through it
// (`nativeFailure`). The result of code that calls this tool does go
// through that rule (toolBridge.ts), so the tool makes no path with one of
// these two names (`checkNewNames`).

// The folder of the app root that holds the apps, one folder each.
const APPS_FOLDER = 'apps'

/** The folder of the resource root that holds the built-in apps, one
 *  folder each. */
export const BUILT_IN_APPS_FOLDER = 'builtin-apps'

/** What a model reads and writes for the folder of the apps
 *  (`APPS_FOLDER`) in every path. */
export const APPS_VIRTUAL_ROOT = '/apps'

// The folder of the resource root that holds the libraries that Dez ships
// (`LIBS_FOLDER`, src-tauri/src/bundled_tools.rs).
const LIBS_FOLDER = 'libs'

/** What a model reads for the folder of the libraries (`LIBS_FOLDER`) in
 *  every path. */
export const LIBS_VIRTUAL_ROOT = '/libs'

/** The file of Dez's text for a model in the folder of a library of
 *  `/libs/`: what the library is for, how a run imports it, and the rules
 *  of Dez for it. scripts/update-libs.js carries it over. */
export const LIBRARY_SKILL_FILE = 'SKILL.md'

/** The libraries of `/libs/` that the code of a run imports by name, each
 *  with what it is for: the name is also the name of its folder, which has
 *  a `LIBRARY_SKILL_FILE`. @kurkle/color is a part of chart.js. */
export const SHIPPED_LIBRARIES: readonly { name: string, use: string }[] = [
  { name: 'three', use: '3D math, scenes, and 3D files' },
  { name: 'chart.js', use: 'charts' },
  { name: 'fft.js', use: 'the FFT' },
  { name: NATIVE_CANVAS_LIBRARY, use: 'a 2D canvas, in a script app only' },
  { name: 'dez-media', use: 'the media measurements of Dez, NumPy-style signal functions, data tables, and frame sequences' },
]

/** The libraries as the tool texts list them, with where each one tells
 *  its use: a model reads the details only when it needs them. */
export const LIBRARIES_TEXT = `${seriesText(SHIPPED_LIBRARIES.map(({ name, use }) => `${name} (${use})`), 'and')}. `
  + `Read ${LIBS_VIRTUAL_ROOT}/<library>/${LIBRARY_SKILL_FILE} before you use a library: it tells how to import it, and its rules in Dez.`

/** The largest text file that `read`, `write`, and `edit` take. Its text
 *  is in the webview as a whole, and a larger one is no source file. */
export const APPS_MAX_FILE_BYTES = 2 * 1024 * 1024

/** The most files and folders of one app, at any depth, and the most bytes
 *  of its files. The tool adds nothing to an app past them, so a model
 *  that goes wrong cannot fill the disk. The code of an app is not held to
 *  them when it writes its own files. */
export const APPS_MAX_ENTRIES = 1000
export const APPS_MAX_BYTES = 100 * 1024 * 1024

/** The limits of a run of an app (`invoke`; appInvoke.ts): the default
 *  time limit of its job, and the most files of its output folder that Dez
 *  keeps, with the most bytes of one of them. Dez reads each kept file
 *  into the webview to check its type, so the size limit is below the one
 *  of a stored clip. */
export const APP_RUN_DEFAULT_SECONDS = 300
export const APP_RUN_MAX_OUTPUT_FILES = 20
export const APP_RUN_MAX_OUTPUT_BYTES = 256 * 1024 * 1024

/** The most Dez tool calls (`dez.sbp`) of one run of the code of a script
 *  app (controller/toolBridge.ts). More than a `js_eval` run gets: an app
 *  does a planned work, such as one call for each frame of a clip, and
 *  it runs as a job, not in the round of the model. The cap still stops
 *  code that loops on a call that costs money. */
export const APP_RUN_MAX_TOOL_CALLS = 200

/** The limits of a frame sequence of a run (a folder `<name>.frames` in
 *  the output folder, which Dez encodes into one clip; frameSequences.ts):
 *  the most frames, the most pixels of a side of a frame, and the frames a
 *  second. 36,000 frames are 10 minutes at 60 frames a second. */
export const APP_RUN_MAX_FRAMES = 36_000
export const FRAMES_MAX_SIDE = 4096
export const FRAMES_MIN_FPS = 0.01
export const FRAMES_MAX_FPS = 240

/** A frames.json of a frame sequence, as the texts show it. */
export const FRAMES_JSON_EXAMPLE = '{"fps": 30, "width": 1280, "height": 720, "count": 90, "alpha": false}'

/** The limits of the decode of the input clips of a run of a script app
 *  (`decode`; inputDecode.ts): the samples a second of the audio, the most
 *  pixels of a side of a frame, the frames a second, and the most bytes of
 *  all the decoded files of one run together. The code reads a decoded
 *  file into memory as a whole. */
export const DECODE_MIN_RATE = 1000
export const DECODE_MAX_RATE = 192_000
export const DECODE_MAX_SIDE = 4096
export const DECODE_MIN_FPS = 0.01
export const DECODE_MAX_FPS = 240
export const APP_RUN_MAX_DECODED_BYTES = 2 * 1024 * 1024 * 1024

/** A `decode` value as the texts show it. */
export const DECODE_EXAMPLE = '{"audio": {"rate": 22050}, "frames": {"width": 96, "height": 54, "fps": 24}}'

/** The subcommand that changes lines of a file. Its results get the hint
 *  of `edit` (`EDIT_HINT`, editHint.ts). */
export const APPS_EDIT = 'edit'

/** The subcommand that runs an app. The readers of a call that tell it
 *  from the file subcommands name it by this (registry.ts,
 *  toolBridge.ts). */
export const APPS_INVOKE = 'invoke'

/** The subcommand that shows a UI app in the reply (appShow.ts). */
export const APPS_SHOW = 'show'

/** How many entries below a folder `ls` asks for. The entries of the
 *  folder itself come first in a listing, so only a folder with more than
 *  this many names lists without some of them. */
export const LS_MAX_ENTRIES = 5000

// The most characters of one name of a path. The file system takes 255
// bytes, and the temp file of a save adds an ending to the name.
const MAX_NAME_LENGTH = 100
// The most names of a path after its top folder (`/apps/`, `/libs/`,
// `/work/`).
const MAX_PATH_NAMES = 12

// The most lines and characters that one `read` gives: about what a model
// reads well in one result.
const READ_MAX_LINES = 900
const READ_MAX_CHARACTERS = 50_000
// The most characters of the diff of an `edit` result.
const DIFF_MAX_CHARACTERS = 20_000
// The most lines that one hunk of an `edit` result shows (the lines after
// its `@@` line). A longer hunk shows only its first and its last
// `HUNK_END_LINES` lines: the model gave the new lines and read the old
// ones, so all of them again would only fill its context. A hunk is cut
// only when the cut leaves out more than 4 lines: a note line in place of
// fewer saves little.
const HUNK_END_LINES = 8
const HUNK_MAX_LINES = 2 * HUNK_END_LINES + 4
// The most rows of an `ls` and of a `list_apps` result, and the most paths
// that `rm` lists for one deleted folder.
const LS_MAX_ROWS = 500
const LIST_APPS_MAX_ROWS = 200
const RM_MAX_SHOWN_PATHS = 100
// The most paths of a `find` result: a path is longer than a name of `ls`.
const FIND_MAX_ROWS = 300
// The most paths of one `wc` call, so that one call and its result stay
// short.
const WC_MAX_PATHS = 100

const EXAMPLE_APP = 'unit-converter'
const EXAMPLE_FILE = `${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}/main.js`

const FILE_LIMIT = byteSizeText(APPS_MAX_FILE_BYTES)
const APP_LIMITS = `An app holds at most ${countText(APPS_MAX_ENTRIES)} files and folders, and ${byteSizeText(APPS_MAX_BYTES)}.`
const APP_NAME_RULE = 'The name of an app is 1 to 64 characters: lower-case letters, digits, "-", and "_", and the first one is a letter or a digit, '
  + `as in "${EXAMPLE_APP}". A name that starts with "${BUILT_IN_APP_PREFIX}" is for the built-in apps of Dez.`
// The mark of a built-in app in `list_apps` and in `ls` of `/apps`.
const BUILT_IN_MARK = 'built-in'
const PATH_PARAMETER = `as in "${EXAMPLE_FILE}".`

const EXAMPLE_SCRIPT_APP = 'contact-sheet'
const SCRIPT_MAIN = `${APPS_VIRTUAL_ROOT}/<name>/${SCRIPT_MAIN_FILE}`

/** The types that Dez stores of the files that an app gives back (the
 *  output files of a script app, the saves of a page), as the texts of the
 *  apps tool tell them: the types of `storedTypeOfBytes`. */
export const STORED_TYPES = '(an image: PNG, JPEG, GIF, WebP, or SVG; a clip: MP4, MOV, WebM, WAV, MP3, M4A, AAC, FLAC, or Ogg)'

const SAVE_BYTES = 'a Blob, an ArrayBuffer, or a typed array'

// What the page of a UI app imports of the libraries: the import map that
// `init` writes into its index.html (`UI_IMPORT_MAP_TAG`, appTemplates.ts)
// names each one but those that only Deno loads (`DENO_ONLY_NAMES`).
const PAGE_LIBRARY_NAMES = SHIPPED_LIBRARIES.map(({ name }) => name).filter((name) => !DENO_ONLY_NAMES.includes(name))
const PAGE_LIBRARIES = `A module of the page imports the libraries of ${LIBS_VIRTUAL_ROOT}/ by name, as in \`import * as THREE from "three"\`, `
  + `through the import map that init writes into ${UI_INDEX_FILE}, before the first module (each entry is a file of ./${UI_LIBS_ROUTE}/, as in "./${UI_LIBS_ROUTE}/three/build/three.module.js"): `
  + `${seriesText(PAGE_LIBRARY_NAMES, 'and')}, but not ${seriesText(DENO_ONLY_NAMES, 'or')}.`

// The help of `invoke` for a UI app: what the page of an app needs for a
// run, and the limits of a page that make plain code fail (the frame
// bridge, appBridge.ts; the guards of the app frames,
// src-tauri/src/app_frames.rs).
const INVOKE_UI_HELP = `A UI app runs as its page (${UI_INDEX_FILE}), which Dez loads in a frame that the user does not see, `
  + `${APP_RUN_FRAME_SIZE.width} by ${APP_RUN_FRAME_SIZE.height} CSS pixels. `
  + `The page must load Dez's script before its own scripts (${UI_CLIENT_SCRIPT_TAG}), and a script of the page must register the handler of a run `
  + `while the page loads, before its first \`await\`: ${APP_HANDLER_EXAMPLE}. The run calls the handler and waits for its promise. `
  + 'The value that the handler returns is the result of the job (a string as it is, any other value as JSON), '
  + 'and what the page writes to the console comes after it, with the errors that nothing caught. '
  + `Load each script file of the page with \`crossorigin\`, as in ${UI_OWN_SCRIPT_TAG}, or as a module: the result has no details of an error of a script file that the page loads in another way. `
  + '`parameters` is the object of the call. `run.inputs` has one `{ id, kind, type }` for each id of `inputs`, in their order. The page has two calls of Dez:\n'
  + `- \`await dez.sbp('${APP_READ_ASSET}', id)\` gives the bytes of an input as a Blob. A run reads only its inputs.\n`
  + `- \`await dez.sbp('${APP_SAVE_ASSET}', bytes)\` saves ${SAVE_BYTES} as a new image or clip of the conversation, by the rules of an output file of a script app `
  + `(the type from the first bytes, at most ${APP_RUN_MAX_OUTPUT_FILES} saves of one run, at most ${byteSizeText(APP_RUN_MAX_OUTPUT_BYTES)} for one). `
  + 'In a run it gives `{ id: null, kind, type }`: the result of the job gives the ids, in the order of the saves. A run whose handler throws keeps no file.\n'
  + 'A call that Dez refuses rejects with an error whose message tells why. '
  + 'The page is new for each run and keeps no state. It has no network, no storage, and no file but those of its app, which it loads by a relative URL, and it calls no Dez tool. '
  + `${PAGE_LIBRARIES} `
  + 'Use a UI app for work that needs a page (a canvas, the Web Audio API, a layout). '
  + 'A script of the page that never yields stops Dez\'s window, and no time limit can end it: heavy work belongs in a script app.'

// The help of `invoke`: all that a model must know to write the code of
// an app that a run calls, as the system prompt tells only that the tool
// is there. For a script app it states each limit of the sandbox that
// makes plain code fail (the OS rule of src-tauri/src/confinement.rs, and
// the flags of bundled_tools.rs), so that a model does not learn them one
// failed run at a time.
const INVOKE_HELP = `Runs the code of an app on the user's computer, with the parameters of the call. ${JOB_CALL_NOTE} The kind of the app tells how it runs.\n\n`
  + 'A script app runs in a sandbox (Deno). '
  + `The run calls the default export of ${SCRIPT_MAIN} with two arguments, \`(parameters, dez)\`, and waits for its promise. `
  + 'The value that the function returns is the result of the job: a string as it is, JSON data as JSON, and any other value as Deno shows it. '
  + 'What the code writes with `console.log` comes after it. `parameters` is the object of the call. `dez` has six members:\n'
  + '- `dez.inputs`: one `{ id, kind, type, path }` for each id of `inputs`, in their order. `kind` is "image", "audio", or "video", `type` is the media type, '
  + 'and `path` is the path of a copy of the file. A change of the copy changes nothing of the image or the clip. '
  + 'When the run decodes its clips (`decode`), each clip also has the facts of its decoded files, `audio` and `frames`.\n'
  + '- `dez.outputFolder`: the path of an empty folder. After a run that ends with no error, Dez keeps each file directly in it as a new image or clip of the conversation, '
  + `and the result gives their ids. Dez keeps only a file of a type that it stores, which it reads from the first bytes of the file and not from its name ${STORED_TYPES}, `
  + `at most ${APP_RUN_MAX_OUTPUT_FILES} files of one run, and at most ${byteSizeText(APP_RUN_MAX_OUTPUT_BYTES)} for one file. A run that fails keeps no file of this folder. `
  + 'A folder `<name>.frames` directly in the output folder is a frame sequence: after the run, Dez encodes it into one clip, which counts as one file. '
  + 'It holds the frames from 0 with no gap, all PNG files (000000.png, 000001.png, and so on) or all raw RGBA (000000.rgba, and so on: 4 bytes for each pixel, row after row), '
  + `and frames.json, as in ${FRAMES_JSON_EXAMPLE}: "fps" from ${FRAMES_MIN_FPS} to ${FRAMES_MAX_FPS}, `
  + `"width" and "height" up to ${FRAMES_MAX_SIDE} pixels, and "count" up to ${countText(APP_RUN_MAX_FRAMES)}. `
  + 'The clip is H.264 in MP4, whose width and height must be even; with `"alpha": true`, it is MOV with the PNG codec, which keeps the alpha of each pixel (for an overlay with `video ffmpeg`). '
  + 'Dez scales a PNG frame of another size to width × height. '
  + '`import { FrameWriter } from "dez-media/frames"` writes such a folder: `const frames = new FrameWriter(dez.outputFolder, "intro", { fps: 30, width: 1280, height: 720 })`, '
  + 'then `frames.add(canvas)` or `frames.add(rgbaBytes)` for each frame, and `frames.end()` after the last one.\n'
  + '- `dez.appFolder`: the path of the folder of the app. The code reads and writes the files of its app there, and they stay for the next run: '
  + 'keep the state of an app in a file of this folder.\n'
  + `- \`dez.workFolder\`: the path of the work folder of this conversation, which the file subcommands name ${WORK_VIRTUAL_ROOT}/. Its files stay for the next run and for the other tools.\n`
  + '- `dez.fonts`: the fonts that Dez ships, one `{ file, family, weight, scripts, path }` for each font file.\n'
  + '- `dez.sbp`: calls a Dez tool, as `await dez.sbp("dez.tools/<tool>", { …arguments })`, or `await dez.sbp("dez.tools/<tool>/<subcommand>", { …parameters })` for a subcommand, '
  + 'as in `await dez.sbp("dez.tools/image/flip", { image: dez.inputs[0].id, direction: "horizontal" })`. '
  + 'A call gives the result text of the tool, and it throws an error with that text when the tool gives an error. '
  + `The calls run one at a time, at most ${APP_RUN_MAX_TOOL_CALLS} in one run. The code cannot call js_eval, apps invoke, or apps show. `
  + 'An image or a clip that a call makes is an asset of the job, also when the code fails later: the result of the call names it by a handle, as in "Made the image @&1.", '
  + 'and the result of the job gives the id of each handle. A later call of the run takes the handle in place of an id: as the whole value (`image: "&1"`), or as a mention in a text ("@&1"). '
  + 'A job that a call starts is a job of the run: `jobs_wait` and `jobs_list` in the code see only these jobs, and you get the ones that are still open after the run. '
  + 'Before a call that costs money, the code can ask `model_info` (with `only: "cost"` and the `parameters` of the request) for its price, '
  + 'and `conversation_info` for what the conversation cost so far.\n'
  + 'The code can open only three places: the folder of its app, the run folder (the copies of the inputs and the output folder), which Dez deletes after the run, '
  + `and the work folder. It can also read the libraries of ${LIBS_VIRTUAL_ROOT}/ and the fonts of \`dez.fonts\`. `
  + 'Build each path from a path of `dez`, as in `${dez.outputFolder}/chart.png`: a relative path does not work. '
  + 'The code has no network and no environment variables, and it can start no program; no flag changes that. '
  + 'It can import the other files of its app (`import { parse } from "./parse.ts"`), the built-in modules (`node:fs`), '
  + `and the libraries of ${LIBS_VIRTUAL_ROOT}/ by name (\`import { beatGrid } from "dez-media"\`), but no package of npm, of JSR, or from a URL. `
  + `The libraries: ${LIBRARIES_TEXT} `
  + `The code of the built-in apps (${APPS_VIRTUAL_ROOT}/${BUILT_IN_APP_PREFIX}<name>/${SCRIPT_MAIN_FILE}) is a good start for an app of your own: read it, and write a copy into your app. `
  + `To draw with ${NATIVE_CANVAS_LIBRARY} (\`import { Canvas } from "${NATIVE_CANVAS_LIBRARY}"\`), the ${MANIFEST_FILE} of the app must have the field \`${NATIVE_FIELD_EXAMPLE}\`, `
  + 'and each canvas must draw with no GPU: `new Canvas(1280, 720, { gpu: false })`. The run sees no font of the computer, so a canvas draws text only after '
  + '`const families = useShippedFonts(dez.fonts)` (`import { useShippedFonts } from "dez-media/canvas"`). It returns a list of every shipped family for `ctx.font`, '
  + 'which draws each script that the fonts cover, as in ``ctx.font = `bold 48px ${families}` ``; a family of `dez.fonts` alone draws only its own scripts. '
  + 'Some file calls fail in the sandbox: a rename or a hard link from one folder to another (copy the file, then delete the old one), '
  + '`Deno.chmod`, `Deno.utime`, `Deno.symlink`, and `Deno.watchFs`. '
  + 'In each text that the code gives a tool, Dez cuts a path of a file of the user\'s computer after its start, with the rest of its line: '
  + 'name an image or a clip by its id or its handle, not by the path of its copy. '
  + 'The clock and the time zone are those of the user\'s computer. '
  + `An error names a line of the code by its path in the apps tool, as in ${APPS_VIRTUAL_ROOT}/${EXAMPLE_SCRIPT_APP}/${SCRIPT_MAIN_FILE}:12.\n\n`
  + INVOKE_UI_HELP

/** The hint of `edit`: how to give the line numbers of a call. A model
 *  that did not know that the edits of one call do not move the lines of
 *  each other made one edit, read the file, made the next edit, and so on.
 *  The description of `edit` ends with it, so its help holds it, and the
 *  result of an `edit` call of the model ends with it while the
 *  conversation does not hold it (editHint.ts). */
export const EDIT_HINT = [
  'How to use edit:',
  '- Give each line number as it was in the file when you read it, before this call. Dez does all the edits of one call at once and moves the lines itself: never add or subtract to make up for another edit of the call.',
  '- Put all the changes of a file into one call, with no read between them.',
  '- The edits of one call must not overlap: an edit that overlaps an earlier edit of the call fails, and the others are still done.',
  '- After the call the lines have new numbers. Read the file again only before your next edit call of that file.',
].join('\n')

/** The result text `result` with the hint of `edit` after it, as a
 *  paragraph of its own. */
export function withEditHint(result: string): string {
  return `${result}\n\n${EDIT_HINT}`
}

// The text of the `decode` parameter of `invoke`: all that the code of a
// script app must know to read the decoded files (inputDecode.ts), with
// the readers of the dez-media library.
const DECODE_HELP = 'Script apps only. Dez decodes each clip of `inputs` before the run, so that the code gets its samples and its pixels, '
  + `as in ${DECODE_EXAMPLE}. `
  + `"audio" gives the first sound stream as one channel of float32 samples, little-endian, at "rate" samples a second (${DECODE_MIN_RATE} to ${DECODE_MAX_RATE}). `
  + `"frames" gives the frames of the first video stream as RGB pixels (3 bytes for each pixel, row by row), each frame exactly "width" by "height" pixels (1 to ${DECODE_MAX_SIDE}), `
  + `at "fps" frames a second (${DECODE_MIN_FPS} to ${DECODE_MAX_FPS}), or each frame of the clip once when "fps" is not there. `
  + 'Each clip of `dez.inputs` then has `audio: { path, rate, count }` (count: the samples) and `frames: { path, width, height, fps, count }` (count: the frames), '
  + 'or null for a clip with no such stream. Read them with `import { f32Samples, rgbFrames } from "dez-media"`: '
  + '`f32Samples(await Deno.readFile(input.audio.path))` and `rgbFrames(await Deno.readFile(input.frames.path), input.frames.width, input.frames.height)`. '
  + `The decoded files of one run are at most ${byteSizeText(APP_RUN_MAX_DECODED_BYTES)} together. `
  + `The field "decode" of the ${MANIFEST_FILE} of the app, of the same form, is the default. The decode of the call takes its place as a whole, and {} decodes nothing.`

export const APPS_TOOL: SubcommandTool<SubcommandParameter> = {
  name: 'apps',
  summary: `Make, change, show, and run apps: small programs that you write for the user, each in its own folder ${APPS_VIRTUAL_ROOT}/<name>/. `
    + 'The apps stay from one conversation to the next, and a script app keeps its own files from one run to the next. '
    + `The file subcommands also work in two more folders: ${LIBS_VIRTUAL_ROOT}/ holds the libraries that Dez ships, which you can only read, `
    + `and ${WORK_VIRTUAL_ROOT}/ is the work folder of this conversation, which Dez deletes with the conversation. `
    + `Every path of a call starts with ${APPS_VIRTUAL_ROOT}/, ${LIBS_VIRTUAL_ROOT}/, or ${WORK_VIRTUAL_ROOT}/. `
    + `The code of an app imports the libraries by name: ${LIBRARIES_TEXT}`,
  subcommands: [
    {
      name: 'init',
      summary: 'Make a new app from a template: its folder, its manifest.json, and its first files.',
      description: `Makes the folder ${APPS_VIRTUAL_ROOT}/<name>/ with a manifest.json (the name, the description, and the kind of the app) and the first files of its kind: `
        + `${SCRIPT_MAIN_FILE} for a script app (code with no page, which invoke runs), or ${UI_INDEX_FILE}, main.js, and style.css for a UI app (a web page, which show shows). `
        + `The call fails when ${APPS_VIRTUAL_ROOT}/<name> is there already: it replaces nothing. Change the files after it with read, edit, and write.`,
      parameters: [
        { name: 'name', type: 'string', description: `The name of the app, which is the name of its folder. ${APP_NAME_RULE}`, required: true },
        { name: 'kind', type: 'string', description: `The kind of the app: ${APP_KINDS.join(' or ')}.`, required: true },
        { name: 'description', type: 'string', description: `What the app does, in one line of at most ${MAX_DESCRIPTION_LENGTH} characters. list_apps shows it.`, required: true },
      ],
      example: { name: EXAMPLE_APP, kind: 'ui', description: 'Converts lengths, weights, and temperatures from one unit to another.' },
    },
    {
      name: 'read',
      summary: `Read a text file of an app, of ${LIBS_VIRTUAL_ROOT}/, or of ${WORK_VIRTUAL_ROOT}/, with the number of each line.`,
      description: 'Gives the text of a file, each line after its number (`12: text`), and tells how many lines and bytes the file has. '
        + 'With `ranges` it gives only the lines of those ranges, in the order of the list. '
        + `One call gives at most ${READ_MAX_LINES} lines and ${countText(READ_MAX_CHARACTERS)} characters: the result tells when it left lines out, and which ranges to read next. `
        + `edit takes the line numbers of this result. Dez refuses a file that is no text, and one of more than ${FILE_LIMIT}.`,
      parameters: [
        { name: 'path', type: 'string', description: `The path of the file, ${PATH_PARAMETER}`, required: true },
        {
          name: 'ranges',
          type: 'list',
          items: [
            { name: 'from_line', type: 'integer', description: 'The first line of the range; the first line of a file is line 1.', required: true },
            { name: 'to_line', type: 'integer', description: 'The last line of the range. Leave it out to read to the end of the file.', required: false },
          ],
          description: 'The ranges of lines to read. Leave it out to read the file from line 1. '
            + 'Give each line in one range only: a range that overlaps an earlier range of the list is left out.',
          required: false,
        },
      ],
      example: { path: EXAMPLE_FILE, ranges: [{ from_line: 1, to_line: 40 }, { from_line: 120, to_line: 160 }] },
    },
    {
      name: 'write',
      summary: `Write a whole text file of an app or of ${WORK_VIRTUAL_ROOT}/: a new file, or all new text for a file that is there.`,
      description: 'Writes `content` as the whole text of a file, and makes the folders of the path that are missing. '
        + 'It replaces a file that is there: to change a part of a file, use edit. The app of a path in an app must be there: make it with init first. '
        + `A file is at most ${FILE_LIMIT}. ${APP_LIMITS} The limits of an app do not hold in ${WORK_VIRTUAL_ROOT}/. Nothing writes in ${LIBS_VIRTUAL_ROOT}/.`,
      parameters: [
        { name: 'path', type: 'string', description: `The path of the file, ${PATH_PARAMETER}`, required: true },
        { name: 'content', type: 'string', description: 'The whole text of the file.', required: true },
      ],
      example: { path: `${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}/units.js`, content: 'export const METERS_PER_FOOT = 0.3048\n' },
    },
    {
      name: APPS_EDIT,
      summary: `Change lines of a text file of an app or of ${WORK_VIRTUAL_ROOT}/ by their numbers: replace lines, delete lines, or put new lines in.`,
      description: 'Applies a list of edits to one file, all at once. Each edit names lines by the numbers that read gave. '
        + 'An edit with `from_line` replaces the lines `from_line` to `to_line` with the lines of `content`. An edit with `after_line` puts the lines of `content` in after that line. '
        + 'Each edit passes or fails by itself: the result tells what each one did, or why it failed, and gives a diff of the change.\n\n'
        + EDIT_HINT,
      parameters: [
        { name: 'path', type: 'string', description: `The path of the file, ${PATH_PARAMETER}`, required: true },
        {
          name: 'edits',
          type: 'list',
          items: [
            { name: 'from_line', type: 'integer', description: 'The first line to replace. Give this or `after_line`, not both.', required: false },
            { name: 'to_line', type: 'integer', description: 'The last line to replace. Leave it out to replace only the line `from_line`.', required: false },
            { name: 'after_line', type: 'integer', description: 'The line after which the new lines go; no line is replaced. 0 puts them before the first line.', required: false },
            {
              name: 'content',
              type: 'string',
              description: 'The new lines, with "\\n" between them; one "\\n" at the end adds no line, and "\\n" alone is one empty line. '
                + 'With `from_line`, "" deletes the lines.',
              required: true,
            },
          ],
          description: 'The edits, at least one.',
          required: true,
        },
      ],
      example: {
        path: EXAMPLE_FILE,
        edits: [{ from_line: 12, to_line: 14, content: 'const factor = 0.3048' }, { after_line: 30, content: '\nconsole.log(factor)' }],
      },
    },
    {
      name: 'rm',
      summary: `Delete files and folders of apps or of ${WORK_VIRTUAL_ROOT}/, or whole apps. A folder goes with all that is in it.`,
      description: 'Deletes each path of the list. It deletes a folder with every file and folder in it, at any depth, and asks nothing: '
        + `the path of an app (${APPS_VIRTUAL_ROOT}/<name>) deletes the whole app. Nothing brings a deleted file back. `
        + `It does not delete ${APPS_VIRTUAL_ROOT} or ${WORK_VIRTUAL_ROOT} itself, or a file of ${LIBS_VIRTUAL_ROOT}/. `
        + 'Each path passes or fails by itself, and the result lists the paths that it deleted.',
      parameters: [
        { name: 'paths', type: 'list', items: 'string', description: `The paths to delete, as in ["${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}/old.js"].`, required: true },
      ],
      example: { paths: [`${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}/old.js`, `${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}/drafts`] },
    },
    {
      name: 'list_apps',
      summary: 'List the apps: the name, the kind, the size, and the description of each.',
      description: `Lists the apps, one line each: the name (its folder is ${APPS_VIRTUAL_ROOT}/<name>/), the kind (${APP_KINDS.join(' or ')}), the size of all its files, and the description. `
        + 'The kind and the description are those of its manifest.json. A call with no parameters lists every app by name. '
        + `A built-in app of Dez has "(${BUILT_IN_MARK})" after its kind: you can read and run it, but not change it.`,
      parameters: [
        { name: 'name', type: 'string', description: 'Only the apps whose name holds this text. Upper and lower case count as the same.', required: false },
        { name: 'min_bytes', type: 'integer', description: 'Only the apps of at least this size, in bytes.', required: false },
        { name: 'max_bytes', type: 'integer', description: 'Only the apps of at most this size, in bytes.', required: false },
        { name: 'sort', type: 'string', description: 'The order of the list: name (the default), largest (the largest app first), or smallest.', required: false },
      ],
      example: { name: 'convert', sort: 'largest' },
    },
    {
      name: 'ls',
      summary: 'List the files and the folders of one folder, with their sizes.',
      description: 'Lists what is in one folder: each file with its size, and each folder (its name ends with "/") with the number and the size of the files below it. '
        + `A call with no parameters lists ${APPS_VIRTUAL_ROOT}, which has one folder for each app.`,
      parameters: [
        {
          name: 'path',
          type: 'string',
          description: `The folder, as in "${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}", "${LIBS_VIRTUAL_ROOT}", or "${WORK_VIRTUAL_ROOT}". Leave it out for ${APPS_VIRTUAL_ROOT}.`,
          required: false,
        },
      ],
      example: { path: `${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}` },
    },
    {
      name: 'find',
      summary: 'Find files by words of their paths.',
      description: 'Lists the files below a folder whose paths have every word of `query`, sorted by path; "*" lists every file. '
        + `A word matches a part of the path after the top folder (${APPS_VIRTUAL_ROOT}/, ${LIBS_VIRTUAL_ROOT}/, or ${WORK_VIRTUAL_ROOT}/; "conv" in ${EXAMPLE_APP}/src/units.js), `
        + 'or the starts of words that follow each other in it ("ucs" or "srcunits"). '
        + 'Upper and lower case are the same, and a character other than a letter or a digit only splits words: the query is no glob and no regular expression. '
        + 'Each row of the result is a path after the top folder of `path`: put that folder before it to read the file.',
      parameters: [
        { name: 'query', type: 'string', description: 'The words to find in the paths, as in "units js", or "*" for every file.', required: true },
        { name: 'path', type: 'string', description: `The folder to search, as in "${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}". Leave it out for ${APPS_VIRTUAL_ROOT}: all the apps.`, required: false },
      ],
      example: { query: 'units js', path: `${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}` },
    },
    {
      name: 'grep',
      summary: 'Find the lines of text files that a regular expression matches.',
      description: 'Searches the text files below a folder, or one file, line by line, as `rg -n` does. It gives each matching line after its number (`12: text`), '
        + `the files sorted by path, and in a search of a folder each file under its path after the top folder (${APPS_VIRTUAL_ROOT}/, ${LIBS_VIRTUAL_ROOT}/, or ${WORK_VIRTUAL_ROOT}/). `
        + 'With `context` it gives the lines around each match too (`11- text`), and "--" between groups of lines that do not follow each other. '
        + 'The numbers are those of read, so read and edit take them. '
        + '`pattern` is a regular expression of JavaScript, with no "/" around it, which each line matches by itself: no match runs over the end of a line. '
        + 'Put a "\\" before a character that is special in a regular expression to find it as it is, or set `literal` to true. '
        + `One result shows at most ${GREP_MAX_MATCHES} matching lines, ${countText(GREP_MAX_CHARACTERS)} characters, and ${GREP_LINE_MAX_CHARACTERS} characters of a line, `
        + 'and it tells how many more lines match in which files. '
        + `It skips a file that is no text, and one of more than ${FILE_LIMIT}. Dez stops a search that runs for more than ${GREP_TIME_LIMIT_SECONDS} seconds.`,
      parameters: [
        { name: 'pattern', type: 'string', description: 'The regular expression, as in "convert(Length|Weight)".', required: true },
        {
          name: 'path',
          type: 'string',
          description: `The folder to search, or one file, as in "${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}". Leave it out for ${APPS_VIRTUAL_ROOT}: all the apps.`,
          required: false,
        },
        {
          name: 'include',
          type: 'string',
          description: 'Only the files whose name matches this glob, as in "*.js" or "*.{ts,css}": "*" is any characters, and "?" is one character. '
            + 'It matches the name of a file, not the names of its folders, and upper and lower case differ.',
          required: false,
        },
        { name: 'ignore_case', type: 'boolean', description: 'true to take upper and lower case as the same. The default is false.', required: false },
        { name: 'literal', type: 'boolean', description: 'true to find `pattern` as plain text, in which no character is special. The default is false.', required: false },
        { name: 'context', type: 'integer', description: `How many lines to show before and after each matching line, from 0 to ${GREP_MAX_CONTEXT}. The default is 0.`, required: false },
      ],
      example: { pattern: 'convert(Length|Weight)', path: `${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}`, include: '*.js', context: 2 },
    },
    {
      name: 'wc',
      summary: 'Count the lines and the bytes of files.',
      description: 'Gives the number of lines and the size of each file of the list, one row each, in the order of the list. '
        + 'The number of lines is the one that read gives: a "\\n" at the end of a file adds no line, and a last line with no "\\n" counts. '
        + `It counts no lines of a file that is no text, or of one of more than ${FILE_LIMIT} (read and edit do not take such a file): it gives only its size. `
        + `Each path passes or fails by itself. One call counts at most ${WC_MAX_PATHS} files.`,
      parameters: [
        { name: 'paths', type: 'list', items: 'string', description: `The paths of the files, as in ["${EXAMPLE_FILE}"].`, required: true },
      ],
      example: { paths: [EXAMPLE_FILE, `${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}/units.js`] },
    },
    {
      name: 'mkdir',
      summary: `Make a folder in an app or in ${WORK_VIRTUAL_ROOT}/, with the folders above it that are missing.`,
      description: `Makes a folder in an app or in ${WORK_VIRTUAL_ROOT}/, and the folders of the path that are missing. A folder that is there already is no error. `
        + 'write makes the folders of its path too, so this is only for a folder that has no file yet. It makes no app: init does.',
      parameters: [
        { name: 'path', type: 'string', description: `The folder to make, as in "${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}/data/cache".`, required: true },
      ],
      example: { path: `${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}/data/cache` },
    },
    {
      name: 'mv',
      summary: `Move or rename files and folders of apps and of ${WORK_VIRTUAL_ROOT}/, or rename an app.`,
      description: 'Moves each `from` path to its `to` path, one after the other, in the order of the list. `to` is the full new path, not the folder to move into. '
        + 'A move replaces nothing: it fails when a file or a folder is at `to` already. It makes the folders of `to` that are missing. '
        + `Each move passes or fails by itself, and the result tells which. A move of ${APPS_VIRTUAL_ROOT}/<name> to ${APPS_VIRTUAL_ROOT}/<other name> renames an app. `
        + `A move from ${WORK_VIRTUAL_ROOT}/ into an app, or back, is fine.`,
      parameters: [
        {
          name: 'moves',
          type: 'list',
          items: [
            { name: 'from', type: 'string', description: `The path to move, as in "${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}/units.js".`, required: true },
            { name: 'to', type: 'string', description: `The full new path, as in "${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}/lib/units.js".`, required: true },
          ],
          description: 'The moves, at least one.',
          required: true,
        },
      ],
      example: { moves: [{ from: `${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}/units.js`, to: `${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}/lib/units.js` }] },
    },
    {
      name: APPS_SHOW,
      summary: 'Show a UI app to the user: Dez puts it into your reply, after this call, as a card with a Run button.',
      description: `Puts a UI app into your reply, after this call, as a card with a Run button. The app starts when the user clicks Run: its page then shows in the conversation. `
        + `The page of the app is its ${UI_INDEX_FILE}: Dez refuses an app that has none, and a script app, which has no page. `
        + 'The call runs no code and changes no file. Dez writes the app into the conversation itself, as a line `<dez:app name="…"/>`: '
        + 'never write such a line yourself, as the user reads yours as plain text.\n'
        + `A page that loads Dez's script before its own scripts (${UI_CLIENT_SCRIPT_TAG}) can work with the images and the clips of the conversation:\n`
        + `- \`await dez.sbp('${APP_READ_ASSET}', id)\` gives the bytes of the image or the clip with that id as a Blob.\n`
        + `- \`await dez.sbp('${APP_SAVE_ASSET}', bytes)\` puts ${SAVE_BYTES} as a new image or clip into the message that the user writes, and gives \`{ id, kind, type }\`. `
        + `Dez takes only a file of a type that it stores ${STORED_TYPES}, at most ${byteSizeText(APP_RUN_MAX_OUTPUT_BYTES)}, and at most ${APP_RUN_MAX_OUTPUT_FILES} saves from one click on Run to Stop. `
        + 'It takes a save only while the user works in the app (save in the handler of a click or a key), and not while a reply runs.\n'
        + 'A call that Dez refuses rejects with an error whose message tells why: show it to the user. The page calls no Dez tool, and it has no network and no storage.\n'
        + PAGE_LIBRARIES,
      parameters: [
        { name: 'name', type: 'string', description: `The name of the app, as in "${EXAMPLE_APP}": the name of its folder in ${APPS_VIRTUAL_ROOT}/.`, required: true },
      ],
      example: { name: EXAMPLE_APP },
    },
    {
      name: APPS_INVOKE,
      summary: `Run an app with your parameters, on images and clips, to get a text and new images and clips: the code of the ${SCRIPT_MAIN_FILE} of a script app, or the handler of the page of a UI app.`,
      description: INVOKE_HELP,
      parameters: [
        { name: 'name', type: 'string', description: `The name of the app, as in "${EXAMPLE_SCRIPT_APP}": the name of its folder in ${APPS_VIRTUAL_ROOT}/.`, required: true },
        {
          name: 'parameters',
          type: 'object',
          description: 'The parameters of the run, a JSON object with the fields that the code of the app reads: the first argument of its function. Leave it out for {}.',
          required: false,
        },
        {
          name: 'inputs',
          type: 'string',
          description: 'The ids of the images and the clips that the run gets, as in "@a @c", in this order: '
            + 'the code of a script app finds a copy of each one in `dez.inputs`, and the handler of a UI app finds each one in `run.inputs`. '
            + 'Leave it out for a run with no input.',
          required: false,
        },
        {
          name: 'decode',
          type: 'object',
          description: DECODE_HELP,
          required: false,
        },
        INTERMEDIATE_PARAMETER,
        jobTimeoutParameter(APP_RUN_DEFAULT_SECONDS),
      ],
      example: { name: EXAMPLE_SCRIPT_APP, parameters: { columns: 4, title: 'Trip' }, inputs: '@a @b' },
    },
  ],
}

export const APPS_TOOL_DEFINITION = subcommandToolDefinition(APPS_TOOL)

/** The places where the paths of the tool start: the folder of the apps,
 *  the libraries that Dez ships (read only), and the work folder of the
 *  conversation of the call (conversationWork.ts). */
export type AppsPlace = 'apps' | 'libs' | 'work'

/** The top folder of a path: its place, and the folder as `AppsPath` tells
 *  it (`virtual`, `root`, `file`). */
export interface AppsTop {
  place: AppsPlace
  virtual: string
  root: 'app' | 'resource'
  file: string
}

const APPS_TOP: AppsTop = { place: 'apps', virtual: APPS_VIRTUAL_ROOT, root: 'app', file: APPS_FOLDER }
const LIBS_TOP: AppsTop = { place: 'libs', virtual: LIBS_VIRTUAL_ROOT, root: 'resource', file: LIBS_FOLDER }

// The top of the paths in the work folder of the conversation
// `conversationId`; null when its id can name no folder.
function workTop(conversationId: string): AppsTop | null {
  const file = conversationWorkFolder(conversationId)
  return file === null ? null : { place: 'work', virtual: WORK_VIRTUAL_ROOT, root: 'app', file }
}

/** A path of a call: a top folder (`/apps`, `/libs`, `/work`), or a file
 *  or a folder in it. */
export interface AppsPath {
  top: AppsTop
  /** The names after the top folder: none for the top folder itself, and
   *  in `/apps` the name of the app first. */
  names: readonly string[]
  /** The path as a model writes and reads it: `/apps/notes/main.js`. */
  virtual: string
  /** The root of `file` (`AppFileRoot`, controller/nativeTypes.ts): the
   *  resource root for a built-in app and for `/libs`, else the app root. */
  root: 'app' | 'resource'
  /** The path from `root`, as the native file selectors take it:
   *  `apps/notes/main.js`, `builtin-apps/dez-x/main.ts`, `libs/three/x.js`,
   *  `work/<conversation id>/data.json`. */
  file: string
}

// In `/apps` the name of the app alone tells where its files are: a
// built-in app is in the files that Dez ships, and its name is no name of
// the user's apps.
function pathOf(top: AppsTop, names: readonly string[]): AppsPath {
  const virtual = [top.virtual, ...names].join('/')
  if (top.place === 'apps' && names.length > 0 && isBuiltInApp(names[0])) {
    return { top, names, virtual, root: 'resource', file: [BUILT_IN_APPS_FOLDER, ...names].join('/') }
  }
  return { top, names, virtual, root: top.root, file: [top.file, ...names].join('/') }
}

/** The folder of all apps. */
export const APPS_ROOT = pathOf(APPS_TOP, [])

/** The folder of the libraries that Dez ships. */
export const LIBS_ROOT = pathOf(LIBS_TOP, [])

/** The path of the name `name` in the folder at `folder`. */
export function pathIn(folder: AppsPath, name: string): AppsPath {
  return pathOf(folder.top, [...folder.names, name])
}

// How many names of a path name its unit (`unitOf`).
function unitDepth(top: AppsTop): number {
  return top.place === 'apps' ? 1 : 0
}

/** The unit of a path below its top folder: in `/apps` the folder of its
 *  app, and in `/libs` and `/work`, which hold files directly, the top
 *  folder itself. A change in `/apps` needs its app, and the caps of an
 *  app hold for it (`checkAppRoom`). */
export function unitOf(path: AppsPath): AppsPath {
  return pathOf(path.top, path.names.slice(0, unitDepth(path.top)))
}

/** Whether `path` is the folder of an app. */
export function isAppFolder(path: AppsPath): boolean {
  return path.top.place === 'apps' && path.names.length === 1
}

/** The folder that holds what is at `path`. */
export function parentOf(path: AppsPath): AppsPath {
  return pathOf(path.top, path.names.slice(0, -1))
}

// Whether `path` is in the folder `folder`, at any depth.
function isBelow(path: AppsPath, folder: AppsPath): boolean {
  return path.top.place === folder.top.place && path.names.length > folder.names.length && folder.names.every((name, index) => path.names[index] === name)
}

// What the top folder of a path is, in a text: `the folder of all apps`.
function topName(top: AppsTop): string {
  return {
    apps: 'the folder of all apps',
    libs: 'the folder of the libraries that Dez ships',
    work: 'the work folder of this conversation',
  }[top.place]
}

// The path of a file in the top folder of a path, for a text that tells
// how to write a path of that folder: `/apps/unit-converter/main.js`.
function topExample(top: AppsTop): string {
  return {
    apps: EXAMPLE_FILE,
    libs: `${LIBS_VIRTUAL_ROOT}/dez-media/${LIBRARY_SKILL_FILE}`,
    work: `${WORK_VIRTUAL_ROOT}/clips/a.mp4`,
  }[top.place]
}

// The names that the native file selectors take (`is_app_file_segment`,
// persistence.rs): keep the two rules the same.
const NAME = /^[A-Za-z0-9._-]+$/

/** Whether the native file selectors take `name` as one name of a path. */
export function isPathName(name: string): boolean {
  return NAME.test(name) && name !== '.' && name !== '..'
}

/** The path that the value of the parameter `parameter` names, in a call
 *  of the conversation `conversationId`. One `/` at its end is fine.
 *  Throws a `ToolError` for a value that is no path below `/apps`,
 *  `/libs`, or `/work`, and for a name that the file selectors do not
 *  take. `.` and `..` are refused, not resolved: a model that writes them
 *  has a wrong idea of where it is. */
export function appsPath(value: unknown, parameter: string, conversationId: string): AppsPath {
  const text = typeof value === 'string' ? value.trim() : ''
  const form = `Every path starts with ${APPS_VIRTUAL_ROOT}/, ${LIBS_VIRTUAL_ROOT}/, or ${WORK_VIRTUAL_ROOT}/, ${PATH_PARAMETER}`
  if (text === '') throw new ToolError(`\`${parameter}\` is empty. ${form}`)
  const quoted = JSON.stringify(startOf(text, 300))
  const place = ([APPS_VIRTUAL_ROOT, LIBS_VIRTUAL_ROOT, WORK_VIRTUAL_ROOT] as const).find((root) => text === root || text.startsWith(`${root}/`))
  if (place === undefined) throw new ToolError(`${quoted} is no path of the apps tool. ${form}`)
  const top = place === APPS_VIRTUAL_ROOT ? APPS_TOP : place === LIBS_VIRTUAL_ROOT ? LIBS_TOP : workTop(conversationId)
  // Only a hand edit of app_state.json gives a conversation such an id.
  if (top === null) {
    throw new ToolError(`${quoted}: this conversation has no ${WORK_VIRTUAL_ROOT} folder, as its id can name no folder. `
      + `This is a fault of Dez, not of your call: tell the user. Use ${APPS_VIRTUAL_ROOT}/ in its place.`)
  }
  const rest = text.slice(top.virtual.length + 1).replace(/\/$/, '')
  if (rest === '') return pathOf(top, [])

  const names = rest.split('/')
  if (names.length > MAX_PATH_NAMES) throw new ToolError(`The path ${quoted} has ${names.length} names after ${top.virtual}/, and a path has at most ${MAX_PATH_NAMES}.`)
  for (const name of names) {
    if (name === '') throw new ToolError(`The path ${quoted} has an empty name: two "/" with nothing between them.`)
    if (name === '.' || name === '..') {
      throw new ToolError(`The path ${quoted} holds "${name}", which the apps tool does not resolve. Give the whole path from ${top.virtual}/, as in "${topExample(top)}".`)
    }
    if (!isPathName(name)) {
      throw new ToolError(`The path ${quoted} holds the name ${JSON.stringify(name)}, which the apps tool does not take. `
        + 'The name of a file or a folder has only ASCII letters, digits, "-", "_", and ".".')
    }
    if (name.length > MAX_NAME_LENGTH) throw new ToolError(`The path ${quoted} holds a name of ${name.length} characters, and a name has at most ${MAX_NAME_LENGTH}.`)
  }
  return pathOf(top, names)
}

/** The folder names that `withoutLocalPaths` takes for the start of a
 *  path of the computer (the top comment): no call makes a path with one. */
export const HIDDEN_NAMES = ['home', 'Users']

// Throws for a path that a call would make and that a later result could
// not show.
function checkNewNames(path: AppsPath): void {
  const name = path.names.find((candidate) => HIDDEN_NAMES.includes(candidate))
  if (name === undefined) return
  throw new ToolError(`The apps tool makes no file and no folder with the name "${name}" in its path (${path.virtual}): `
    + 'Dez takes such a path for a path of the user\'s computer and hides it from you. Use another name.')
}

// Throws for a path that a call would make, change, move, or delete in
// `/libs` or in a built-in app: Dez ships those files, and the native side
// refuses to change them too, with a text that tells the model less.
function checkChangeable(path: AppsPath): void {
  if (path.top.place === 'libs') {
    throw new ToolError(`${path.virtual}: ${LIBS_VIRTUAL_ROOT}/ holds the libraries that Dez ships, and no call makes, changes, moves, or deletes a file there. `
      + `To change a file of it, copy it into ${WORK_VIRTUAL_ROOT}/ or into an app of your own with read and write.`)
  }
  if (path.root !== 'resource') return
  throw new ToolError(`${path.virtual}: the names of apps that start with "${BUILT_IN_APP_PREFIX}" are for the built-in apps of Dez, `
    + 'and no call makes, changes, moves, or deletes a file there. Give an app of your own another name. '
    + 'To change a built-in app, copy its files into an app of your own with read and write.')
}

/** The folder of the app that a call names with `name`. Throws a
 *  `ToolError` for a text that is no name of an app. */
export function appNamed(name: string): AppsPath {
  if (!isAppName(name)) throw new ToolError(`${JSON.stringify(startOf(name, 100))} is no name for an app. ${APP_NAME_RULE}`)
  return pathIn(APPS_ROOT, name)
}

// The path of a file that the parameter `parameter` names: in an app, or
// directly in `/libs` or `/work`.
function filePath(args: SubcommandArguments, parameter: string, conversationId: string): AppsPath {
  const path = appsPath(args[parameter], parameter, conversationId)
  if (path.names.length > unitDepth(path.top)) return path
  if (isAppFolder(path)) throw new ToolError(`${path.virtual} is the folder of an app, not a file. Give the path of a file in it, as in "${path.virtual}/main.js".`)
  throw new ToolError(path.top.place === 'apps'
    ? `${path.virtual} is the folder of all apps, not a file. Give the path of a file of an app, ${PATH_PARAMETER}`
    : `${path.virtual} is ${topName(path.top)}, not a file. Give the path of a file in it. Call ls with "${path.virtual}" to see what is there.`)
}

/** The text of a call on `/libs` while it is not there: Dez is not
 *  installed in full. */
const NO_LIBS = `${LIBS_VIRTUAL_ROOT} is not there: Dez is not installed in full. This is a fault of Dez, not of your call: tell the user to install Dez again.`

/** The listing `tree` of `path` as `ls`, `find`, and `grep` read it: the
 *  work folder of a conversation, which Dez makes at the first change in
 *  it, is an empty folder before. Throws for a `/libs` that is not
 *  there. */
export function listingOf(path: AppsPath, tree: AppsTree): AppsTree {
  if (tree.kind !== 'missing' || path.names.length > 0) return tree
  if (path.top.place === 'libs') throw new ToolError(NO_LIBS)
  return path.top.place === 'work' ? { kind: 'folder', size: 0, entries: [], more: false } : tree
}

/** The values of a call that `checkArgumentValues` checked: each one is of
 *  the type of its parameter, and an absent one has no key. A text
 *  parameter gives `''` when it is absent. */
export function textArgument(args: SubcommandArguments | ToolArguments, name: string): string {
  const value = args[name]
  return typeof value === 'string' ? value : ''
}

/** An integer parameter of a checked call, or undefined when it is
 *  absent. */
export function integerArgument(args: SubcommandArguments | ToolArguments, name: string): number | undefined {
  const value = args[name]
  return typeof value === 'number' ? value : undefined
}

function textItems(args: SubcommandArguments, name: string): string[] {
  const value = args[name]
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}

function objectItems(args: SubcommandArguments, name: string): ToolArguments[] {
  const value = args[name]
  return Array.isArray(value) ? value.filter((item) => typeof item === 'object') : []
}

/** What an entry of a folder is: `other` is a link or a special file,
 *  which the tool never opens. */
export type AppsEntryKind = 'file' | 'folder' | 'other'

/** One entry below a listed folder: `path` is from that folder, with `/`
 *  between its names, and `size` is its bytes (0 for a folder). */
export interface AppsTreeEntry {
  path: string
  kind: AppsEntryKind
  size: number
}

/** What is at a path, and below it when it is a folder
 *  (`dez.native/listFileTree` gives one). `more` tells that the folder
 *  holds more entries than the listing asked for. */
export interface AppsTree {
  kind: AppsEntryKind | 'missing'
  size: number
  entries: readonly AppsTreeEntry[]
  more: boolean
}

/** What is at a path, with nothing of what is below it. */
export type PathFacts = Pick<AppsTree, 'kind' | 'size'>

/** The listing of `/apps`, from the listings of the two places of the
 *  apps, each with `maxEntries`: `own` of the apps folder of the app root,
 *  and `builtIn` of the built-in apps of the resource root. Each place
 *  gives only its own names (`pathOf`): a `dez-` folder of `own` is one of
 *  an older Dez, which no path reaches, and so is a folder of `builtIn`
 *  with another name. The entries stay in the order of a native listing:
 *  those nearer to the folder first. */
export function appsRootTree<T extends AppsTree>(own: T, builtIn: T, maxEntries: number): T {
  const appName = (entry: AppsTreeEntry) => entry.path.split('/', 1)[0]
  const depth = (entry: AppsTreeEntry) => entry.path.split('/').length
  const entries = [
    ...builtIn.entries.filter((entry) => isBuiltInApp(appName(entry))),
    ...own.entries.filter((entry) => !isBuiltInApp(appName(entry))),
  ].sort((a, b) => depth(a) - depth(b))
  return {
    ...own,
    kind: own.kind === 'folder' || builtIn.kind === 'folder' ? 'folder' : own.kind,
    entries: entries.slice(0, maxEntries),
    more: own.more || builtIn.more || entries.length > maxEntries,
  } as T
}

const OTHER_KIND = 'a link or a special file'

/** What an entry is, in a text for a model: `a file`, `a folder`. */
export function kindName(kind: AppsEntryKind): string {
  return kind === 'other' ? OTHER_KIND : `a ${kind}`
}

/** The size of an app: the bytes of the files of its listing. `more` tells
 *  that the app has more files and folders than the listing, so it is
 *  larger than `bytes`. */
export interface AppSize {
  bytes: number
  more: boolean
}

/** The size of the folder with the listing `tree`. The one rule of the
 *  size of an app: the results of the tool and the card of an app in a
 *  conversation tell the same number. */
export function appSize(tree: AppsTree): AppSize {
  return { bytes: tree.entries.reduce((bytes, entry) => bytes + (entry.kind === 'file' ? entry.size : 0), 0), more: tree.more }
}

/** A size as a text: `12 KB`, or `more than 12 KB`. */
export function appSizeText({ bytes, more }: AppSize): string {
  return `${more ? 'more than ' : ''}${byteSizeText(bytes)}`
}

// A path of a listing as a result shows it. A program can make a name that
// no call takes, also one with a line break: such a path shows as a JSON
// text, so that it stays on its line.
function shownEntryPath(path: string): string {
  return path.split('/').every(isPathName) ? path : JSON.stringify(path)
}

/** Throws unless the app of a call is there. `facts` is what is at
 *  `app`. */
export function checkAppIsThere(app: AppsPath, facts: PathFacts): void {
  if (facts.kind === 'folder') return
  throw new ToolError(facts.kind === 'missing'
    ? `There is no app ${app.virtual}. Make it with init first, or call list_apps to see the apps that are there.`
    : `${app.virtual} is ${kindName(facts.kind)} and no folder, so it is no app. list_apps shows the apps.`)
}

// The folders from the unit of `folder` (`unitOf`) down to `folder` that
// `unit`, the listing of the unit, does not have, the top one first.
// Throws when one of them is there and is no folder. The listing of the
// work folder can hold only a part of it (it has no cap): a folder that is
// there and not in the listing is made again, which changes nothing.
function foldersToMake(folder: AppsPath, unit: AppsTree): AppsPath[] {
  const kinds = new Map(unit.entries.map((entry) => [entry.path, entry.kind]))
  const unitNames = unitDepth(folder.top)
  const missing: AppsPath[] = []
  for (let depth = unitNames + 1; depth <= folder.names.length; depth += 1) {
    const step = pathOf(folder.top, folder.names.slice(0, depth))
    const kind = kinds.get(step.names.slice(unitNames).join('/'))
    if (kind === undefined) missing.push(step)
    else if (kind !== 'folder') throw new ToolError(`${step.virtual} is ${kindName(kind)}, so nothing can be in it.`)
  }
  return missing
}

// The folder that a change makes before it writes in `folder`, with the
// missing ones above it: the last of `missing` (`foldersToMake`), or the
// work folder of the conversation while it is not there; null when every
// folder is there. Dez makes the work folder only at a change in it.
function folderToMake(folder: AppsPath, missing: readonly AppsPath[], unit: AppsTree): AppsPath | null {
  return missing.at(-1) ?? (unit.kind === 'missing' ? unitOf(folder) : null)
}

/** Whether the caps of an app (`checkAppRoom`) hold for a change at
 *  `path`: only in `/apps`. */
export function capsHold(path: AppsPath): boolean {
  return path.top.place === 'apps'
}

// Throws unless a change at `path` has the unit that it needs: in `/apps`
// its app (`unit` is the listing of the unit).
function checkUnitIsThere(path: AppsPath, unit: AppsTree): void {
  if (path.top.place === 'apps') checkAppIsThere(unitOf(path), unit)
}

/** Throws when the app `app` has no room for what a call adds: `entries`
 *  new files and folders, and `bytes` more bytes. `tree` is the listing of
 *  the app with `APPS_MAX_ENTRIES`. A call that adds nothing passes, also
 *  in an app that is over a limit: a model must be able to make a file of
 *  such an app smaller. Call it only where the caps hold (`capsHold`). */
export function checkAppRoom(app: AppsPath, tree: AppsTree, added: { entries: number, bytes: number }): void {
  if (added.entries <= 0 && added.bytes <= 0) return
  const advice = `${APP_LIMITS} Delete files of the app with rm first.`
  if (tree.more) throw new ToolError(`The app ${app.virtual} has more than ${countText(APPS_MAX_ENTRIES)} files and folders, so Dez adds nothing to it. ${advice}`)
  const entries = tree.entries.length
  if (added.entries > 0 && entries + added.entries > APPS_MAX_ENTRIES) {
    throw new ToolError(`The app ${app.virtual} has ${countText(entries)} files and folders, and this call would add ${countText(added.entries)}. ${advice}`)
  }
  const { bytes } = appSize(tree)
  if (added.bytes > 0 && bytes + added.bytes > APPS_MAX_BYTES) {
    throw new ToolError(`The app ${app.virtual} has ${byteSizeText(bytes)}, and this call would add ${byteSizeText(added.bytes)}. ${advice}`)
  }
}

// `checkAppRoom` for a change at `path` where the caps hold.
function checkUnitRoom(path: AppsPath, unit: AppsTree, added: { entries: number, bytes: number }): void {
  if (capsHold(path)) checkAppRoom(unitOf(path), unit, added)
}

/** The error of a file operation that failed for a cause that Dez did not
 *  check before: `what` is what Dez tried, as in `read /apps/a/main.js`,
 *  and `details` is the raw text of the failure. */
export function nativeFailure(what: string, details: string): ToolError {
  return new ToolError(`Dez could not ${what}. This is most likely no fault of the call: try it again, and tell the user when it fails again.`, withoutLocalPaths(details))
}

export interface InitCall {
  app: AppsPath
  manifest: AppManifest
  /** The files to write, the manifest first. */
  files: { path: AppsPath, content: string }[]
}

/** The app that an `init` call makes. Throws for a name that is no name of
 *  an app, an unknown kind, and a description that is empty or too long.
 *  A description of more lines becomes one line. */
export function initCall(args: SubcommandArguments): InitCall {
  const app = appNamed(textArgument(args, 'name').trim())
  const [name] = app.names
  checkChangeable(app)
  checkNewNames(app)

  const kindText = textArgument(args, 'kind').trim()
  const kind = APP_KINDS.find((candidate) => candidate === kindText.toLowerCase())
  if (!kind) throw new ToolError(unknownValuesText('kind', [kindText], `one of: ${APP_KINDS.join(', ')}`))

  const description = textArgument(args, 'description').replace(/\s+/g, ' ').trim()
  if (description === '') throw new ToolError('`description` is empty. Tell in one line what the app does: list_apps shows it.')
  const length = [...description].length
  if (length > MAX_DESCRIPTION_LENGTH) {
    throw new ToolError(`\`description\` has ${length} characters, and it has at most ${MAX_DESCRIPTION_LENGTH}. Give a shorter one.`)
  }

  const manifest: AppManifest = { name, description, kind }
  return { app, manifest, files: appTemplateFiles(manifest).map((file) => ({ path: pathIn(app, file.name), content: file.content })) }
}

/** Throws when something is at the path of the new app already. */
export function checkInitTarget({ app }: InitCall, facts: PathFacts): void {
  if (facts.kind === 'missing') return
  throw new ToolError(facts.kind === 'folder'
    ? `The app ${app.virtual} is there already, and init replaces nothing. Change its files with edit and write, give another name, or delete the app with rm first.`
    : `${app.virtual} is there already, and it is ${kindName(facts.kind)}. Give another name.`)
}

export function initText({ app, manifest, files }: InitCall): string {
  return [
    `Made the ${manifest.kind === 'ui' ? 'UI' : 'script'} app ${app.virtual} with ${countOf(files.length, 'file')}:`,
    ...files.map((file) => file.path.virtual),
    'Change them with read, edit, and write.',
  ].join('\n')
}

/** One range of lines of a `read` call, as the model gave it. */
export interface ReadRange {
  fromLine: number
  /** null: to the end of the file. */
  toLine: number | null
}

export interface ReadCall {
  path: AppsPath
  /** In the order of the call, at least one: a call with no ranges reads
   *  from line 1. */
  ranges: ReadRange[]
}

export function readCall(args: SubcommandArguments, conversationId: string): ReadCall {
  const path = filePath(args, 'path', conversationId)
  const ranges = objectItems(args, 'ranges').map((range): ReadRange => ({
    // The argument check makes `from_line` required.
    fromLine: integerArgument(range, 'from_line') ?? 1,
    toLine: integerArgument(range, 'to_line') ?? null,
  }))
  return { path, ranges: ranges.length > 0 ? ranges : [{ fromLine: 1, toLine: null }] }
}

/** A size over `limit` and the limit, as texts for a refusal. They are byte
 *  counts when the rounded sizes read the same (2 MiB and 1 byte reads
 *  `2.0 MB`), so that the model sees by how much the size is over. */
function overLimitSizes(bytes: number, limit: number): [string, string] {
  const [size, most] = [byteSizeText(bytes), byteSizeText(limit)]
  return size === most ? [`${countText(bytes)} bytes`, `${countText(limit)} bytes`] : [size, most]
}

// Throws unless a plain file is at `path`: not nothing, no folder, and no
// link or special file.
function checkPlainFile(path: AppsPath, facts: PathFacts): void {
  if (facts.kind === 'missing') {
    throw new ToolError(`There is no file ${path.virtual}. Call ls to see the files of its folder, as in {"path": "${parentOf(path).virtual}"}.`)
  }
  if (facts.kind === 'folder') throw new ToolError(`${path.virtual} is a folder, not a file. Call ls to see what is in it.`)
  if (facts.kind === 'other') throw new ToolError(`${path.virtual} is ${OTHER_KIND}, and the apps tool opens plain files only.`)
}

/** Throws unless a file that `read` and `edit` take is at `path`: a plain
 *  file of at most `APPS_MAX_FILE_BYTES`. */
export function checkTextFile(path: AppsPath, facts: PathFacts): void {
  checkPlainFile(path, facts)
  if (facts.size > APPS_MAX_FILE_BYTES) {
    const [size, limit] = overLimitSizes(facts.size, APPS_MAX_FILE_BYTES)
    throw new ToolError(`${path.virtual} has ${size}, and the apps tool reads and edits a file of at most ${limit}.`)
  }
}

/** Why a file is no text file, for a text that tells it. */
export const NO_TEXT = 'it holds a zero byte, or bytes that are no UTF-8'

/** The text of the file at `path` from its bytes (`textOfBytes`). Throws
 *  for a file that is no text. */
export function fileText(path: AppsPath, bytes: Uint8Array): string {
  // The file can have grown after the size check.
  checkTextFile(path, { kind: 'file', size: bytes.length })
  const text = textOfBytes(bytes)
  if (text === null) throw new ToolError(`${path.virtual} is no text file (${NO_TEXT}), and the apps tool reads and edits text files only.`)
  return text
}

// The lines `from` to `last` of a file, both in it. A range of a `read`
// call names its part: the part of an empty file is the empty one, from
// line 1 to line 0.
interface LinePart {
  from: number
  last: number
}

// "line 4, lines 7-9, and line 12".
function linePartsName(parts: readonly LinePart[]): string {
  return new Intl.ListFormat('en', { type: 'conjunction' }).format(parts.map(({ from, last }) => linesName(from, last)))
}

// A range of a `read` call as JSON, for the texts that tell how to call
// read; with no `to_line`, it reads to the end of the file.
function rangeJson(from: number, to: number | null): string {
  return to === null ? `{"from_line": ${from}}` : `{"from_line": ${from}, "to_line": ${to}}`
}

// The part of a file with `total` lines that `range` names, or the text
// of why it gives none. `taken` are the parts of the earlier ranges of the
// call that passed: a range shows no line twice, as an edit of `edit`
// changes no line of an earlier edit of its call (lineEdits.ts).
function readPart({ fromLine, toLine }: ReadRange, total: number, path: AppsPath, taken: readonly (LinePart & { number: number })[]): LinePart | string {
  if (fromLine < 1) return `\`from_line\` is ${fromLine}. The first line of a file is line 1.`
  if (toLine !== null && toLine < fromLine) {
    return `\`to_line\` (${toLine}) is before \`from_line\` (${fromLine}). Give the first and the last line to read, as in ${rangeJson(fromLine, fromLine + 99)}.`
  }
  if (total === 0) return fromLine === 1 ? { from: 1, last: 0 } : `\`from_line\` is ${fromLine}, and ${path.virtual} is an empty file.`
  if (fromLine > total) return `\`from_line\` is ${fromLine}, and ${path.virtual} has ${countOf(total, 'line')}.`
  const last = Math.min(toLine ?? total, total)
  const other = taken.find((part) => part.from <= last && fromLine <= part.last)
  if (!other) return { from: fromLine, last }
  return `It names ${linesName(fromLine, last)}, and range ${other.number} names ${linesName(other.from, other.last)} already. `
    + `Make one range of the two, as in ${rangeJson(Math.min(fromLine, other.from), Math.max(last, other.last))}.`
}

/** The result of a `read` call: the lines of the ranges of the call, in
 *  their order, of the file with `text` and `size` bytes, each after its
 *  number, under a line that tells which lines these are. A range that
 *  the file does not have, or that overlaps an earlier range, shows no
 *  line: a note line tells why. The limits of one call count the lines of
 *  all ranges, and a last line gives the ranges that they left out. Throws
 *  when no range shows a line. */
export function readText({ path, ranges }: ReadCall, text: string, size: number): string {
  const lines = textLines(text)
  const total = lines.length
  const parts: (LinePart & { number: number })[] = []
  const refusals: string[] = []
  for (const [index, range] of ranges.entries()) {
    const part = readPart(range, total, path, parts)
    if (typeof part !== 'string') {
      parts.push({ ...part, number: index + 1 })
    } else {
      // The one range of a call is the call: its text needs no number.
      refusals.push(ranges.length === 1 ? part : `Range ${index + 1} is left out. ${part}`)
    }
  }
  if (parts.length === 0) throw new ToolError(refusals.join('\n'))
  if (total === 0) return [`${path.virtual} is an empty file.`, ...refusals].join('\n')

  const rows: string[] = []
  const notes: string[] = []
  const shown: LinePart[] = []
  const left: LinePart[] = []
  let characters = 0
  let full = false
  for (const part of parts) {
    let line = part.from
    for (; !full && line <= part.last && rows.length < READ_MAX_LINES; line += 1) {
      const row = `${line}: ${lines[line - 1]}`
      if (characters + row.length > READ_MAX_CHARACTERS) {
        full = true
        if (rows.length > 0) break
        // One line that is longer than a whole result (a minified file):
        // its start shows, and the next call goes on after it.
        rows.push(`${startOf(row, READ_MAX_CHARACTERS)}…`)
        notes.push(`Line ${line} has ${countText(lines[line - 1].length)} characters, and only its start shows.`)
        line += 1
        break
      }
      rows.push(row)
      characters += row.length + 1
    }
    if (line > part.from) shown.push({ from: part.from, last: line - 1 })
    if (line <= part.last) left.push({ from: line, last: part.last })
  }
  if (left.length > 0) {
    const next = left.map(({ from, last }) => rangeJson(from, last < total ? last : null)).join(', ')
    notes.push(`Not shown: ${linePartsName(left)}. One call gives at most ${READ_MAX_LINES} lines and ${countText(READ_MAX_CHARACTERS)} characters: `
      + `call read again with "ranges": [${next}] for the next ones.`)
  }
  return [`${path.virtual}: ${linePartsName(shown)} of ${total} (${byteSizeText(size)})`, ...rows, ...refusals, ...notes].join('\n')
}

export interface WriteCall {
  path: AppsPath
  bytes: Uint8Array
  /** How many lines the text has. */
  lines: number
}

export function writeCall(args: SubcommandArguments, conversationId: string): WriteCall {
  const path = filePath(args, 'path', conversationId)
  checkChangeable(path)
  checkNewNames(path)
  const content = textArgument(args, 'content')
  const bytes = new TextEncoder().encode(content)
  if (bytes.length > APPS_MAX_FILE_BYTES) {
    const [size, limit] = overLimitSizes(bytes.length, APPS_MAX_FILE_BYTES)
    throw new ToolError(`\`content\` has ${size}, and a file is at most ${limit}. Write a smaller file, or put the text into more files.`)
  }
  return { path, bytes, lines: textLines(content).length }
}

/** What a `write` call does before it writes: the folder to make (it and
 *  the missing ones above it), and the size of the file that it replaces;
 *  null for none. `target` is what is at the path, and `unit` the listing
 *  of its unit (`unitOf`) with `APPS_MAX_ENTRIES`. Throws when the app is
 *  not there, when a folder or a link is at the path or a file is where a
 *  folder must be, and when the app has no room. */
export function writePlan(call: WriteCall, target: PathFacts, unit: AppsTree): { folder: AppsPath | null, replaced: number | null } {
  const { path } = call
  checkUnitIsThere(path, unit)
  if (target.kind === 'folder') throw new ToolError(`${path.virtual} is a folder. Give the path of a file, as in "${path.virtual}/main.js".`)
  if (target.kind === 'other') throw new ToolError(`${path.virtual} is ${OTHER_KIND}, and the apps tool writes plain files only. Give another path.`)
  const replaced = target.kind === 'file' ? target.size : null
  // The folders of a file that is there are there too. The listing of an
  // app that is over its limit can lack them.
  const missing = replaced === null ? foldersToMake(parentOf(path), unit) : []
  checkUnitRoom(path, unit, { entries: missing.length + (replaced === null ? 1 : 0), bytes: call.bytes.length - (replaced ?? 0) })
  return { folder: replaced === null ? folderToMake(parentOf(path), missing, unit) : null, replaced }
}

export function writeText({ path, bytes, lines }: WriteCall, replaced: number | null): string {
  const facts = `${byteSizeText(bytes.length)}, ${countOf(lines, 'line')}`
  return replaced === null
    ? `Wrote the new file ${path.virtual} (${facts}).`
    : `Wrote ${path.virtual} (${facts}) in place of the file that was there (${byteSizeText(replaced)}).`
}

export interface EditCall {
  path: AppsPath
  edits: LineEdit[]
}

export function editCall(args: SubcommandArguments, conversationId: string): EditCall {
  const path = filePath(args, 'path', conversationId)
  checkChangeable(path)
  const edits = objectItems(args, 'edits').map((edit): LineEdit => ({
    fromLine: integerArgument(edit, 'from_line'),
    toLine: integerArgument(edit, 'to_line'),
    afterLine: integerArgument(edit, 'after_line'),
    content: textArgument(edit, 'content'),
  }))
  if (edits.length === 0) throw new ToolError('`edits` is an empty list. Give at least one edit, as in {"edits": [{"from_line": 3, "to_line": 4, "content": "..."}]}.')
  return { path, edits }
}

/** What became of the items of a call that pass or fail each by itself
 *  (the edits of `edit`, the paths of `rm` and `wc`, the moves of `mv`). */
export interface ItemOutcome {
  done: boolean
  text: string
}

// One numbered line for each item of a call.
function outcomeLines(outcomes: readonly ItemOutcome[]): string[] {
  return outcomes.map((outcome, index) => `${index + 1}. ${outcome.done ? 'Done' : 'Failed'}. ${outcome.text}`)
}

// One row of the diff of an `edit` result, and the number of lines of the
// diff that it stands for: 1, or for the note of a long hunk the lines
// that the note leaves out.
interface DiffRow {
  text: string
  lines: number
}

// The rows of one hunk of an `edit` result: a long hunk shows its ends,
// and between them a row with no diff mark that tells how many lines it
// leaves out. The `@@` line keeps the counts of the whole hunk.
function hunkRows({ header, lines }: DiffHunk): DiffRow[] {
  const row = (text: string): DiffRow => ({ text, lines: 1 })
  if (lines.length <= HUNK_MAX_LINES) return [header, ...lines].map(row)
  const hidden = lines.length - 2 * HUNK_END_LINES
  return [
    row(header),
    ...lines.slice(0, HUNK_END_LINES).map(row),
    { text: `… ${countOf(hidden, 'line')} of this hunk are not shown, to save context. read gives the file as it is now.`, lines: hidden },
    ...lines.slice(-HUNK_END_LINES).map(row),
  ]
}

// The first rows of a diff that fit a result, and a row that tells how
// many lines of the diff the rows after them stand for. The lines that a
// shown note of a long hunk leaves out are told already, so they do not
// count.
function cutDiff(rows: readonly DiffRow[]): string[] {
  const shown: string[] = []
  let characters = 0
  let rest = rows.reduce((sum, row) => sum + row.lines, 0)
  for (const { text, lines } of rows) {
    if (characters + text.length + 1 > DIFF_MAX_CHARACTERS) break
    shown.push(text)
    characters += text.length + 1
    rest -= lines
  }
  return rest === 0 ? shown : [...shown, `… ${countOf(rest, 'more line')} of the diff ${rest === 1 ? 'is' : 'are'} not shown. read gives the file as it is now.`]
}

/** The result of an `edit` call on the file with `text`, and the bytes to
 *  write: null when no edit passed (an error result) and when the edits
 *  change no line. The file keeps the line end, or none, after its last
 *  line. Throws when the edits make the file larger than
 *  `APPS_MAX_FILE_BYTES`. */
export function editResult({ path, edits }: EditCall, text: string): { content: string, isError: boolean, bytes: Uint8Array | null } {
  const before = textLines(text)
  const plan = planLineEdits(before, edits)
  const outcomes = outcomeLines(plan.outcomes)
  const passed = plan.outcomes.filter((outcome) => outcome.done).length
  if (passed === 0) {
    return { content: [`No edit of ${path.virtual} was done, and the file did not change.`, ...outcomes].join('\n'), isError: true, bytes: null }
  }
  if (!plan.changed) {
    return { content: [`${path.virtual} did not change: the lines had the new text already.`, ...outcomes].join('\n'), isError: false, bytes: null }
  }

  const bytes = new TextEncoder().encode(linesText(plan.lines, text === '' || text.endsWith('\n')))
  if (bytes.length > APPS_MAX_FILE_BYTES) {
    const [size, limit] = overLimitSizes(bytes.length, APPS_MAX_FILE_BYTES)
    throw new ToolError(`With these edits ${path.virtual} would have ${size}, and a file is at most ${limit}. Dez did not change the file.`)
  }
  const content = [
    `Edited ${path.virtual}: ${passed} of ${countOf(edits.length, 'edit')} done. The file had ${countOf(before.length, 'line')}, and it has ${countText(plan.lines.length)} now.`,
    ...outcomes,
    'The lines have new numbers now: read the file again before the next edit of it.',
    'The change:',
    ...cutDiff(plan.hunks.flatMap(hunkRows)),
  ].join('\n')
  return { content, isError: false, bytes }
}

/** The text of the failure of one item, on one line. */
export function itemFailureText(error: ToolError): string {
  return error.details === '' ? error.explanation : `${error.explanation} Details: ${error.details}`
}

// The result of a call from what became of its items: an error when every
// item failed.
function itemsResult(head: string, outcomes: readonly ItemOutcome[]): { content: string, isError: boolean } {
  return { content: [head, ...outcomeLines(outcomes)].join('\n'), isError: outcomes.every((outcome) => !outcome.done) }
}

/** How many entries below a folder `rm` asks for, to list what it
 *  deletes. */
export const RM_LISTED_ENTRIES = APPS_MAX_ENTRIES

/** The paths that an `rm` call deletes: each one once, and none that is in
 *  a folder of the call, as the delete of that folder deletes it. Throws
 *  for an empty list, for a top folder, and for a path that no call
 *  changes. */
export function rmCall(args: SubcommandArguments, conversationId: string): { paths: AppsPath[] } {
  const all = textItems(args, 'paths').map((value) => appsPath(value, 'paths', conversationId))
  if (all.length === 0) throw new ToolError(`\`paths\` is an empty list. Give the paths to delete, as in {"paths": ["${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}/old.js"]}.`)
  for (const path of all) {
    checkChangeable(path)
    if (path.names.length > 0) continue
    throw new ToolError(path.top.place === 'apps'
      ? `${APPS_VIRTUAL_ROOT} is the folder of all apps, and rm does not delete it. To delete an app, give its folder, as in "${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}".`
      : `${path.virtual} is ${topName(path.top)}, and rm does not delete it: it goes with the conversation. `
        + `To delete what is in it, give the paths in it, as in "${path.virtual}/old.json".`)
  }
  const unique = all.filter((path, index) => all.findIndex((other) => other.file === path.file) === index)
  return { paths: unique.filter((path) => !unique.some((folder) => isBelow(path, folder))) }
}

/** What `rm` does for one path: whether it deletes a folder, and what the
 *  result tells when the delete is done. `tree` is the listing of the path
 *  with `RM_LISTED_ENTRIES`. Throws when nothing is at the path, and for a
 *  link or a special file: the native side deletes one only with its
 *  folder. */
export function rmStep(path: AppsPath, tree: AppsTree): { folder: boolean, text: string } {
  if (tree.kind === 'missing') throw new ToolError(`Nothing is at ${path.virtual}.`)
  if (tree.kind === 'other') throw new ToolError(`${path.virtual} is ${OTHER_KIND}, which Dez deletes only with its folder: give the folder to rm.`)
  if (tree.kind === 'file') return { folder: false, text: `Deleted the file ${path.virtual} (${byteSizeText(tree.size)}).` }
  if (tree.entries.length === 0) return { folder: true, text: `Deleted the empty folder ${path.virtual}.` }

  const below = tree.entries.map((entry) => `${path.virtual}/${shownEntryPath(entry.path)}${entry.kind === 'folder' ? '/' : ''}`).sort()
  const rest = below.length - RM_MAX_SHOWN_PATHS
  // A cut listing (`tree.more`) holds only a part of the folder.
  const count = tree.more ? `more than ${countText(below.length)}` : `the ${countText(below.length)}`
  return {
    folder: true,
    text: [
      `Deleted the folder ${path.virtual} with ${count} files and folders in it (${appSizeText(appSize(tree))}):`,
      ...below.slice(0, RM_MAX_SHOWN_PATHS),
      ...(rest > 0 ? [tree.more ? `… and more than ${countText(rest)} others.` : `… and ${countText(rest)} more.`] : []),
    ].join('\n'),
  }
}

export function rmResult(outcomes: readonly ItemOutcome[]): { content: string, isError: boolean } {
  const passed = outcomes.filter((outcome) => outcome.done).length
  return itemsResult(`Deleted ${passed} of ${countOf(outcomes.length, 'path')}.`, outcomes)
}

export interface Move {
  from: AppsPath
  to: AppsPath
}

/** The moves of an `mv` call. Throws for an empty list, for a top folder
 *  on either side, for a path that no call changes, and for a `to` that
 *  the tool does not make: a path directly in `/apps/` whose name is no
 *  name of an app, or a path with a name of `HIDDEN_NAMES`. */
export function mvCall(args: SubcommandArguments, conversationId: string): { moves: Move[] } {
  const moves = objectItems(args, 'moves').map((move): Move => ({ from: appsPath(move.from, 'from', conversationId), to: appsPath(move.to, 'to', conversationId) }))
  const example = `{"moves": [{"from": "${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}/units.js", "to": "${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}/lib/units.js"}]}`
  if (moves.length === 0) throw new ToolError(`\`moves\` is an empty list. Give the moves, as in ${example}.`)
  for (const { from, to } of moves) {
    checkChangeable(from)
    if (from.names.length === 0) throw new ToolError(`${from.virtual} is ${topName(from.top)}, and mv does not move it.`)
    checkChangeable(to)
    if (to.names.length === 0) throw new ToolError(`\`to\` is ${to.virtual}, ${topName(to.top)}. Give the full new path of what you move, as in ${example}.`)
    if (isAppFolder(to) && !isAppName(to.names[0])) {
      throw new ToolError(`${to.virtual} is directly in ${APPS_VIRTUAL_ROOT}/, where only the folders of apps are, and "${to.names[0]}" is no name for an app. ${APP_NAME_RULE} `
        + `To move into an app, give the full new path, as in "${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}/${from.names.at(-1)}".`)
    }
    checkNewNames(to)
  }
  return { moves }
}

/** What is at the paths of one move, before it. */
export interface MoveFacts {
  source: PathFacts
  target: PathFacts
  /** The listing of the unit of `to` (`unitOf`), with `APPS_MAX_ENTRIES`. */
  unit: AppsTree
}

/** What `mv` does for one move: the folder to make first (it and the
 *  missing ones above it), null for none, and what the result tells when
 *  the move is done. Throws for a move that Dez does not make: one to the
 *  same path or into the moved folder itself, one of nothing or of a link,
 *  one onto a path that is taken, a file directly in `/apps/`, one into an
 *  app that is not there, and one below a file. */
export function moveStep({ from, to }: Move, facts: MoveFacts): { folder: AppsPath | null, text: string } {
  if (from.file === to.file) throw new ToolError(`\`from\` and \`to\` are the same path, ${from.virtual}.`)
  if (isBelow(to, from)) throw new ToolError(`${to.virtual} is in ${from.virtual}, and a folder cannot move into itself.`)
  const { source, target } = facts
  if (source.kind === 'missing') throw new ToolError(`Nothing is at ${from.virtual}.`)
  if (source.kind === 'other') throw new ToolError(`${from.virtual} is ${OTHER_KIND}, which the apps tool does not move.`)
  if (target.kind !== 'missing') {
    throw new ToolError(`${to.virtual} is taken: ${kindName(target.kind)} is there already, and a move replaces nothing. Delete it with rm first, or give another \`to\`.`)
  }

  if (isAppFolder(to)) {
    if (source.kind === 'file') {
      throw new ToolError(`${to.virtual} would be a file directly in ${APPS_VIRTUAL_ROOT}/, where only the folders of apps are. Give a path in an app, as in "${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}/${from.names.at(-1)}".`)
    }
    return {
      folder: null,
      text: isAppFolder(from)
        ? `Renamed the app ${from.virtual} to ${to.virtual}. Its manifest.json still has the old name: change "name" in it with edit.`
        : `Moved the folder ${from.virtual} to ${to.virtual}, where it is an app now. An app needs a manifest.json: write one if it has none.`,
    }
  }

  checkUnitIsThere(to, facts.unit)
  return { folder: folderToMake(parentOf(to), foldersToMake(parentOf(to), facts.unit), facts.unit), text: `Moved ${from.virtual} to ${to.virtual}.` }
}

export function mvResult(outcomes: readonly ItemOutcome[]): { content: string, isError: boolean } {
  const passed = outcomes.filter((outcome) => outcome.done).length
  return itemsResult(`Did ${passed} of ${countOf(outcomes.length, 'move')}.`, outcomes)
}

export function mkdirCall(args: SubcommandArguments, conversationId: string): { path: AppsPath } {
  const path = appsPath(args.path, 'path', conversationId)
  if (path.top.place === 'apps' && path.names.length < 2) {
    throw new ToolError(`mkdir makes folders in an app or in ${WORK_VIRTUAL_ROOT}, as in "${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}/data", `
      + `and ${path.virtual} is ${path.names.length === 0 ? 'the folder of all apps' : 'the folder of an app'}. init makes a new app.`)
  }
  checkChangeable(path)
  checkNewNames(path)
  return { path }
}

/** What an `mkdir` call does: whether it makes the folder, and the result
 *  text. `target` is what is at the path, and `unit` the listing of its
 *  unit (`unitOf`) with `APPS_MAX_ENTRIES`. Throws when the app is not
 *  there, when a file is at the path or where a folder must be, and when
 *  the app has no room. */
export function mkdirStep(path: AppsPath, target: PathFacts, unit: AppsTree): { make: boolean, text: string } {
  if (target.kind === 'folder') return { make: false, text: `The folder ${path.virtual} is there already.` }
  if (target.kind !== 'missing') throw new ToolError(`${path.virtual} is ${kindName(target.kind)}, so Dez makes no folder there. Give another path.`)
  checkUnitIsThere(path, unit)
  const missing = foldersToMake(path, unit)
  checkUnitRoom(path, unit, { entries: missing.length, bytes: 0 })
  const above = missing.slice(0, -1).map((folder) => folder.virtual)
  return { make: true, text: `Made the folder ${path.virtual}${above.length === 0 ? '' : `, and above it ${above.join(' and ')}`}.` }
}

/** The folder that the `path` of a call of the conversation
 *  `conversationId` names: the folder of all apps for a call with no
 *  `path`. */
export function folderArgument(args: SubcommandArguments, conversationId: string): AppsPath {
  return args.path === undefined ? APPS_ROOT : appsPath(args.path, 'path', conversationId)
}

export function lsCall(args: SubcommandArguments, conversationId: string): { path: AppsPath } {
  return { path: folderArgument(args, conversationId) }
}

/** The text of a call on the folder of all apps while there is none. */
export const NO_APPS = 'There are no apps yet. Make one with init.'

/** The refusal of a call that names a folder where nothing is. */
export function noFolderError(path: AppsPath): ToolError {
  return new ToolError(isAppFolder(path)
    ? `There is no app ${path.virtual}. Call list_apps to see the apps that are there.`
    : `There is no folder ${path.virtual}. Call ls with "${parentOf(path).virtual}" to see what is there.`)
}

/** The note of a `find` or `grep` result whose listing holds only a part
 *  of its folder. */
export function cutListingNote(subcommand: 'find' | 'grep'): string {
  return ` The folder holds more than ${countText(LS_MAX_ENTRIES)} files and folders at all depths, so ${subcommand} searched only a part of them: search the folders in it one by one.`
}

/** The result of an `ls` call: the files and the folders in the folder at
 *  `path`, by name, each with its size; a folder with the number and the
 *  bytes of the files below it. `tree` is the listing of the path with
 *  `LS_MAX_ENTRIES`. A path that is a file gives the facts of the file.
 *  Throws when nothing is at the path. */
export function lsText(path: AppsPath, listing: AppsTree): string {
  const tree = listingOf(path, listing)
  const isAppsRoot = path.top.place === 'apps' && path.names.length === 0
  if (tree.kind === 'missing') {
    if (isAppsRoot) return NO_APPS
    throw noFolderError(path)
  }
  if (tree.kind === 'file') return `${path.virtual} is a file (${byteSizeText(tree.size)}), not a folder. read gives its text.`
  if (tree.kind === 'other') return `${path.virtual} is ${OTHER_KIND}, not a folder.`
  if (tree.entries.length === 0) return isAppsRoot ? NO_APPS : `${path.virtual} is an empty folder.`

  // One row for each name in the folder. The entries below a folder add
  // to its row, in whatever order the listing has them.
  interface Row { name: string, kind: AppsEntryKind, bytes: number, files: number }
  const rows = new Map<string, Row>()
  const rowOf = (name: string): Row => {
    const row = rows.get(name) ?? { name, kind: 'folder', bytes: 0, files: 0 }
    rows.set(name, row)
    return row
  }
  for (const entry of tree.entries) {
    const slash = entry.path.indexOf('/')
    const row = rowOf(slash === -1 ? entry.path : entry.path.slice(0, slash))
    if (slash === -1) row.kind = entry.kind
    if (entry.kind === 'file') {
      row.bytes += entry.size
      if (slash !== -1) row.files += 1
    }
  }

  const sorted = [...rows.values()].sort((a, b) => (a.name < b.name ? -1 : 1))
  const atLeast = tree.more ? 'at least ' : ''
  const texts = sorted.slice(0, LS_MAX_ROWS).map((row) => {
    const name = shownEntryPath(row.name)
    const unusable = name === row.name ? '' : ' | a name that the apps tool does not take'
    const builtIn = isAppsRoot && row.kind === 'folder' && isBuiltInApp(row.name) ? ` | ${BUILT_IN_MARK}` : ''
    if (row.kind === 'folder') return `${name}/ | ${atLeast}${countOf(row.files, 'file')}, ${byteSizeText(row.bytes)}${unusable}${builtIn}`
    return `${name} | ${row.kind === 'file' ? byteSizeText(row.bytes) : OTHER_KIND}${unusable}`
  })
  if (sorted.length > LS_MAX_ROWS) texts.push(`… and ${countText(sorted.length - LS_MAX_ROWS)} more.`)

  const folders = sorted.filter((row) => row.kind === 'folder').length
  const cut = tree.more
    ? ` The folder holds more than ${countText(LS_MAX_ENTRIES)} files and folders at all depths, so the numbers of its folders count only a part of them, and names can be missing.`
    : ''
  return [`${path.virtual}: ${countOf(folders, 'folder')} and ${countOf(sorted.length - folders, 'file')} (name | size).${cut}`, ...texts].join('\n')
}

export interface FindCall {
  /** The query of the call, with no space at its ends. */
  query: string
  /** The words of the query (`searchTerms`): none for `*`, which lists
   *  every file. */
  terms: string[]
  path: AppsPath
}

export function findCall(args: SubcommandArguments, conversationId: string): FindCall {
  const query = textArgument(args, 'query').trim()
  return { query, terms: searchTerms(query), path: folderArgument(args, conversationId) }
}

/** The result of a `find` call: the files below the folder at `path` whose
 *  path after its top folder (`/apps/`, `/libs/`, `/work/`) matches the
 *  terms of the call (`textMatches`, the rule of the model picker), sorted
 *  by path. `listing` is the listing of the path with `LS_MAX_ENTRIES`.
 *  Throws when no folder is at the path. */
export function findText({ query, terms, path }: FindCall, listing: AppsTree): string {
  const tree = listingOf(path, listing)
  const isAppsRoot = path.top.place === 'apps' && path.names.length === 0
  if (tree.kind === 'missing') {
    if (isAppsRoot) return NO_APPS
    throw noFolderError(path)
  }
  if (tree.kind !== 'folder') {
    throw new ToolError(`${path.virtual} is ${kindName(tree.kind)}, not a folder: find searches the files below a folder. `
      + `Give a folder in \`path\`, as in "${parentOf(path).virtual}".`)
  }
  if (isAppsRoot && tree.entries.length === 0) return NO_APPS

  // A row is the path after the top folder, the one field that the terms
  // match, so a term can run from a folder into a file name. A row names
  // no app as `/apps/<name>` does (appNames.ts): a list of the files of
  // every app must not keep every app from Delete Unreferenced Apps.
  const files = tree.entries.flatMap((entry) => (entry.kind === 'file' ? [[...path.names, entry.path].join('/')] : []))
  const cut = tree.more ? cutListingNote('find') : ''
  if (files.length === 0) return `${path.virtual} has no files.${cut}`

  const quotedQuery = JSON.stringify(query)
  const matches = files.filter((file) => textMatches([file], terms)).sort((a, b) => (a < b ? -1 : 1))
  if (matches.length === 0) {
    return `No file in ${path.virtual} matches ${quotedQuery} (${countOf(files.length, 'file')} searched). Give fewer or shorter words, or "*" to list every file.${cut}`
  }

  const rows = matches.slice(0, FIND_MAX_ROWS).map((file) => {
    const shown = shownEntryPath(file)
    return shown === file ? file : `${shown} (a path that the apps tool does not take)`
  })
  if (matches.length > FIND_MAX_ROWS) {
    rows.push(`… and ${countText(matches.length - FIND_MAX_ROWS)} more. Give more words, or a folder in \`path\`, to get a shorter list.`)
  }
  const count = terms.length === 0
    ? countOf(files.length, 'file')
    : `${matches.length} of ${countOf(files.length, 'file')} ${matches.length === 1 ? 'matches' : 'match'} ${quotedQuery}`
  return [`${path.virtual}: ${count} (paths after ${path.top.virtual}/), by path.${cut}`, ...rows].join('\n')
}

/** The paths of a `wc` call, in its order. A path that the call gives
 *  twice gives two rows, as in `wc`. Throws for an empty list, for a list
 *  of more than `WC_MAX_PATHS`, and for a value that is no path of the
 *  tool. */
export function wcCall(args: SubcommandArguments, conversationId: string): { paths: AppsPath[] } {
  const values = textItems(args, 'paths')
  if (values.length === 0) throw new ToolError(`\`paths\` is an empty list. Give the files to count, as in {"paths": ["${EXAMPLE_FILE}"]}.`)
  if (values.length > WC_MAX_PATHS) {
    throw new ToolError(`\`paths\` has ${countText(values.length)} paths, and wc counts at most ${WC_MAX_PATHS} files in one call. Call wc again for the rest.`)
  }
  return { paths: values.map((value) => appsPath(value, 'paths', conversationId)) }
}

// The row of `wc` for a file of `size` bytes, more than `read` takes: it
// has no line count. The two sizes are byte counts when they read the same
// rounded (`overLimitSizes`).
function wcLargeRow(path: AppsPath, size: number): string {
  const [sizeText, limit] = overLimitSizes(size, APPS_MAX_FILE_BYTES)
  return `${path.virtual} | not counted: more than ${limit} | ${sizeText}`
}

/** The row of `wc` for a path with the facts `facts` when Dez does not
 *  read the file to make it: a file of more than `APPS_MAX_FILE_BYTES`,
 *  which `read` does not take and the webview need not hold. Null for a
 *  file whose bytes give its row (`wcRowOfBytes`). Throws for a path that
 *  is no plain file. */
export function wcRowOfFacts(path: AppsPath, facts: PathFacts): string | null {
  checkPlainFile(path, facts)
  return facts.size > APPS_MAX_FILE_BYTES ? wcLargeRow(path, facts.size) : null
}

/** The row of `wc` for the file at `path` with `bytes`: its number of
 *  lines as `read` counts them (`textLines`), and its size. A file that is
 *  no text gets only its size, and so does one that grew past
 *  `APPS_MAX_FILE_BYTES` after its size check. */
export function wcRowOfBytes(path: AppsPath, bytes: Uint8Array): string {
  if (bytes.length > APPS_MAX_FILE_BYTES) return wcLargeRow(path, bytes.length)
  const text = textOfBytes(bytes)
  const lines = text === null ? 'not counted: no text file' : countOf(textLines(text).length, 'line')
  return `${path.virtual} | ${lines} | ${byteSizeText(bytes.length)}`
}

/** The result of a `wc` call from what became of its paths, in their
 *  order: the rows of the files that it counted under a line that names
 *  the columns, then a line for each path that failed. An error when every
 *  path failed. */
export function wcResult(outcomes: readonly ItemOutcome[]): { content: string, isError: boolean } {
  const rows = outcomes.flatMap((outcome) => (outcome.done ? [outcome.text] : []))
  // The one path of a call is the call: its failure needs no number.
  if (outcomes.length === 1 && rows.length === 0) return { content: outcomes[0].text, isError: true }
  const failures = outcomes.flatMap((outcome, index) => (outcome.done ? [] : [`Path ${index + 1} is left out. ${outcome.text}`]))
  if (rows.length === 0) return { content: failures.join('\n'), isError: true }
  return { content: [`${countOf(rows.length, 'file')} (path | lines | size).`, ...rows, ...failures].join('\n'), isError: false }
}

const APPS_SORTS = ['name', 'largest', 'smallest'] as const

export interface ListAppsCall {
  /** In lower case; `''` for every name. */
  name: string
  minBytes: number | null
  maxBytes: number | null
  sort: typeof APPS_SORTS[number]
}

export function listAppsCall(args: SubcommandArguments): ListAppsCall {
  const minBytes = integerArgument(args, 'min_bytes') ?? null
  const maxBytes = integerArgument(args, 'max_bytes') ?? null
  for (const [name, value] of [['min_bytes', minBytes], ['max_bytes', maxBytes]] as const) {
    if (value !== null && value < 0) throw new ToolError(`\`${name}\` is ${value}. Give a size in bytes, from 0 on.`)
  }
  if (minBytes !== null && maxBytes !== null && maxBytes < minBytes) {
    throw new ToolError(`\`max_bytes\` (${maxBytes}) is less than \`min_bytes\` (${minBytes}), so no app can match.`)
  }
  const sortText = textArgument(args, 'sort').trim()
  const sort = sortText === '' ? 'name' : APPS_SORTS.find((candidate) => candidate === sortText.toLowerCase())
  if (!sort) throw new ToolError(unknownValuesText('sort', [sortText], `one of: ${APPS_SORTS.join(', ')}`))
  return { name: textArgument(args, 'name').trim().toLowerCase(), minBytes, maxBytes, sort }
}

/** One folder of `/apps/` for the list: its name, its listing with
 *  `APPS_MAX_ENTRIES`, and the bytes of its manifest file; null when Dez
 *  did not read one (`hasReadableManifest`). */
export interface ListedApp {
  name: string
  tree: AppsTree
  manifest: Uint8Array | null
}

function manifestEntry(tree: AppsTree): AppsTreeEntry | undefined {
  return tree.entries.find((entry) => entry.path === MANIFEST_FILE)
}

/** Whether Dez reads what is at the path of a manifest: only a plain file
 *  of at most `MANIFEST_MAX_BYTES`. */
export function isReadableManifest(facts: PathFacts | undefined): boolean {
  return facts !== undefined && facts.kind === 'file' && facts.size <= MANIFEST_MAX_BYTES
}

/** Whether the list reads the manifest of an app (`isReadableManifest`). */
export function hasReadableManifest(tree: AppsTree): boolean {
  return isReadableManifest(manifestEntry(tree))
}

const MANIFEST_NEEDS = `a JSON object with "name", "description", and "kind", which is ${APP_KINDS.map((kind) => `"${kind}"`).join(' or ')}`

/** The manifest of the app at `app`, with the kind of the app: the first
 *  check of a subcommand that works only on one kind of app (`invoke`,
 *  `show`). `facts` is what is at `manifest`, the path of the manifest,
 *  and `bytes` are the bytes of that file, null when Dez did not read it
 *  (`isReadableManifest`). Throws a `ToolError` for a manifest that is
 *  missing, that Dez does not read, or that is not valid; `notDone` is its
 *  last sentence, which tells what Dez did not do. */
export function checkedManifest(app: AppsPath, manifest: AppsPath, facts: PathFacts, bytes: Uint8Array | null, notDone: string): AppManifest {
  if (facts.kind === 'missing') {
    throw new ToolError(`The app ${app.virtual} has no ${MANIFEST_FILE}, so Dez does not know its kind. Write ${manifest.virtual}: ${MANIFEST_NEEDS}. ${notDone}`)
  }
  if (!isReadableManifest(facts) || bytes === null) {
    throw new ToolError(`${manifest.virtual} is no plain file of at most ${byteSizeText(MANIFEST_MAX_BYTES)}, so Dez does not read it and does not know the kind of the app. `
      + `Write it again: ${MANIFEST_NEEDS}. ${notDone}`)
  }
  const parsed = parseAppManifest(new TextDecoder().decode(bytes))
  if (!parsed) {
    throw new ToolError(`${manifest.virtual} is not valid, so Dez does not know the kind of the app. Write it again: ${MANIFEST_NEEDS}. ${notDone}`)
  }
  return parsed
}

/** Throws a `ToolError` for a built-in app of the kind `ui`: Dez ships
 *  only script apps, and no app frame serves the files of the resource
 *  root (src-tauri/src/app_frames.rs). `notDone` is the last sentence of
 *  the text, as in `checkedManifest`. */
export function checkBuiltInKind(app: AppsPath, kind: AppKind, notDone: string): void {
  if (app.root !== 'resource' || kind !== 'ui') return
  throw new ToolError(`${app.virtual} is a built-in app of Dez with the kind "ui", and Dez shows and runs no built-in UI app. `
    + `This is a fault of Dez, not of your call: tell the user. ${notDone}`)
}

/** The kind and the description of an app for a list, each with no column
 *  mark. An app with no manifest that Dez can read still lists: a model
 *  must see it to repair it. */
export function manifestColumns({ tree, manifest }: ListedApp): [ListedAppKind, string] {
  if (!manifestEntry(tree)) return [UNKNOWN_APP_KIND, '(no manifest.json)']
  if (!manifest) return [UNKNOWN_APP_KIND, `(a manifest.json that Dez does not read: it is no plain file of at most ${byteSizeText(MANIFEST_MAX_BYTES)})`]
  const parsed = parseAppManifest(new TextDecoder().decode(manifest))
  if (!parsed) return [UNKNOWN_APP_KIND, `(a manifest.json that is not valid: it needs "name", "description", and "kind", which is ${APP_KINDS.map((kind) => `"${kind}"`).join(' or ')})`]
  // A `|` in a description would read as the end of the column.
  const description = oneLineCut(parsed.description.replaceAll('|', '/'), MAX_DESCRIPTION_LENGTH)
  return [parsed.kind, description === '' ? '(no description)' : description]
}

/** The result of a `list_apps` call: one row for each app that the call
 *  selects, in its order. An entry of `apps` that is no folder is no
 *  app. The size of an app with more than `APPS_MAX_ENTRIES` files and
 *  folders is the size of the listed ones, and the row tells so. */
export function listAppsText(call: ListAppsCall, apps: readonly ListedApp[]): string {
  const all = apps.filter((app) => app.tree.kind === 'folder').map((app) => ({ app, size: appSize(app.tree) }))
  if (all.length === 0) return NO_APPS

  const criteria = [
    ...(call.name === '' ? [] : [`\`name\` ${JSON.stringify(call.name)}`]),
    ...(call.minBytes === null ? [] : [`\`min_bytes\` ${call.minBytes}`]),
    ...(call.maxBytes === null ? [] : [`\`max_bytes\` ${call.maxBytes}`]),
  ].join(' and ')
  const matches = all.filter(({ app, size: { bytes } }) => app.name.toLowerCase().includes(call.name)
    && (call.minBytes === null || bytes >= call.minBytes)
    && (call.maxBytes === null || bytes <= call.maxBytes))
  if (matches.length === 0) {
    return `No app matches ${criteria}. ${APPS_VIRTUAL_ROOT}/ has ${countOf(all.length, 'app')}: call list_apps with no parameters to list ${all.length === 1 ? 'it' : 'them all'}.`
  }

  const byName = (a: typeof all[number], b: typeof all[number]) => (a.app.name < b.app.name ? -1 : 1)
  const sorted = [...matches].sort(byName)
  if (call.sort !== 'name') {
    const direction = call.sort === 'largest' ? -1 : 1
    // The sort keeps the order by name for apps of one size.
    sorted.sort((a, b) => direction * (a.size.bytes - b.size.bytes))
  }
  const rows = sorted.slice(0, LIST_APPS_MAX_ROWS).map(({ app, size }) => {
    const [kind, description] = manifestColumns(app)
    const shownKind = isBuiltInApp(app.name) ? `${kind} (${BUILT_IN_MARK})` : kind
    return [app.name, shownKind, appSizeText(size), description].join(' | ')
  })
  if (sorted.length > LIST_APPS_MAX_ROWS) rows.push(`… and ${countText(sorted.length - LIST_APPS_MAX_ROWS)} more. Use \`name\` to get a shorter list.`)

  const count = criteria === '' ? countOf(all.length, 'app') : `${matches.length} of ${countOf(all.length, 'app')} ${matches.length === 1 ? 'matches' : 'match'} ${criteria}`
  const order = { name: 'by name', largest: 'the largest first', smallest: 'the smallest first' }[call.sort]
  return [`${count} (name | kind | size | description), ${order}.`, ...rows].join('\n')
}
