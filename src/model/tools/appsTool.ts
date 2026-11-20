import { byteSizeText } from '../../utils/byteSize'
import { countOf, countText } from '../../utils/countText'
import { oneLineCut } from '../../utils/oneLineCut'
import { startOf } from '../../utils/textCut'
import { APP_HANDLER_EXAMPLE, APP_READ_ASSET, APP_RUN_FRAME_SIZE, APP_SAVE_ASSET } from './appBridge'
import { APP_KINDS, isAppName, MANIFEST_FILE, MANIFEST_MAX_BYTES, MAX_DESCRIPTION_LENGTH, parseAppManifest, type AppKind, type AppManifest } from './appManifest'
import { appTemplateFiles, SCRIPT_MAIN_FILE, UI_CLIENT_SCRIPT_TAG, UI_INDEX_FILE, UI_OWN_SCRIPT_TAG } from './appTemplates'
import { unknownValuesText } from './arguments'
import { INTERMEDIATE_PARAMETER, JOB_CALL_NOTE, jobTimeoutParameter } from './jobs'
import { linesName, linesText, planLineEdits, textLines, type LineEdit } from './lineEdits'
import { withoutLocalPaths } from './localPaths'
import { subcommandToolDefinition, type SubcommandTool } from './subcommands'
import { ToolError, type SubcommandArguments, type SubcommandParameter, type ToolArguments } from './types'

// The `apps` tool: the files of the apps, the small programs that a model
// writes for the user. Each app is one folder of `apps/` in the app root,
// and it stays from one conversation to the next. A model names a file by
// a virtual path that starts with `/apps/` (`/apps/<app>/main.js`), so no
// call and no result holds a path of the computer.
//
// This module has the pure parts: the definition, the checks of a call,
// the rules of a path, the limits, and every text that the calling model
// reads. controller/appsTool.ts does the file work. Of `invoke`, which
// runs a script app, and of `show`, which puts a UI app into the reply, it
// has only the definition and the help: the rules and the texts of a run
// are in appInvoke.ts, and those of `show` in appShow.ts.
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

/** What a model reads and writes for the folder of the apps
 *  (`APPS_FOLDER`) in every path. */
export const APPS_VIRTUAL_ROOT = '/apps'

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
// The most names of a path after `/apps/`.
const MAX_PATH_NAMES = 12

// The most lines and characters that one `read` gives: about what a model
// reads well in one result.
const READ_MAX_LINES = 900
const READ_MAX_CHARACTERS = 50_000
// The most characters of the diff of an `edit` result.
const DIFF_MAX_CHARACTERS = 20_000
// The most rows of an `ls` and of a `list_apps` result, and the most paths
// that `rm` lists for one deleted folder.
const LS_MAX_ROWS = 500
const LIST_APPS_MAX_ROWS = 200
const RM_MAX_SHOWN_PATHS = 100

const EXAMPLE_APP = 'unit-converter'
const EXAMPLE_FILE = `${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}/main.js`

const FILE_LIMIT = byteSizeText(APPS_MAX_FILE_BYTES)
const APP_LIMITS = `An app holds at most ${countText(APPS_MAX_ENTRIES)} files and folders, and ${byteSizeText(APPS_MAX_BYTES)}.`
const APP_NAME_RULE = 'The name of an app is 1 to 64 characters: lower-case letters, digits, "-", and "_", and the first one is a letter or a digit, '
  + `as in "${EXAMPLE_APP}".`
const PATH_PARAMETER = `as in "${EXAMPLE_FILE}".`

const EXAMPLE_SCRIPT_APP = 'contact-sheet'
const SCRIPT_MAIN = `${APPS_VIRTUAL_ROOT}/<name>/${SCRIPT_MAIN_FILE}`

// What Dez stores of the files that a run gives back, for both kinds of
// app.
const STORED_TYPES = '(an image: PNG, JPEG, GIF, WebP, or SVG; a clip: MP4, MOV, WebM, WAV, MP3, M4A, AAC, FLAC, or Ogg)'

const SAVE_BYTES = 'a Blob, an ArrayBuffer, or a typed array'

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
  + 'The value that the function returns is the result of the job: a string as it is, any other value as JSON. '
  + 'What the code writes with `console.log` comes after it. `parameters` is the object of the call. `dez` has three members:\n'
  + '- `dez.inputs`: one `{ id, kind, type, path }` for each id of `inputs`, in their order. `kind` is "image", "audio", or "video", `type` is the media type, '
  + 'and `path` is the path of a copy of the file. A change of the copy changes nothing of the image or the clip.\n'
  + '- `dez.outputFolder`: the path of an empty folder. After a run that ends with no error, Dez keeps each file directly in it as a new image or clip of the conversation, '
  + `and the result gives their ids. Dez keeps only a file of a type that it stores, which it reads from the first bytes of the file and not from its name ${STORED_TYPES}, `
  + `at most ${APP_RUN_MAX_OUTPUT_FILES} files of one run, and at most ${byteSizeText(APP_RUN_MAX_OUTPUT_BYTES)} for one file. A run that fails keeps no file.\n`
  + '- `dez.appFolder`: the path of the folder of the app. The code reads and writes the files of its app there, and they stay for the next run: '
  + 'keep the state of an app in a file of this folder.\n'
  + 'The code can open only two places: the folder of its app, and the work folder of the run (the copies of the inputs and the output folder), which Dez deletes after the run. '
  + 'Build each path from a path of `dez`, as in `${dez.outputFolder}/chart.png`: a relative path does not work. '
  + 'The code has no network and no environment variables, and it can start no program; no flag changes that. '
  + 'It can import the other files of its app (`import { parse } from "./parse.ts"`) and the built-in modules (`node:fs`), '
  + 'but no package of npm, of JSR, or from a URL. '
  + 'Some file calls fail in the sandbox: a rename or a hard link from one folder to another (copy the file, then delete the old one), '
  + '`Deno.chmod`, `Deno.utime`, `Deno.symlink`, and `Deno.watchFs`. '
  + 'The code calls no Dez tool (it has no `dez.sbp`): call the tools yourself, before or after the run. '
  + 'The clock and the time zone are those of the user\'s computer. '
  + `An error names a line of the code by its path in the apps tool, as in ${APPS_VIRTUAL_ROOT}/${EXAMPLE_SCRIPT_APP}/${SCRIPT_MAIN_FILE}:12.\n\n`
  + INVOKE_UI_HELP

export const APPS_TOOL: SubcommandTool<SubcommandParameter> = {
  name: 'apps',
  summary: `Make, change, show, and run apps: small programs that you write for the user, each in its own folder ${APPS_VIRTUAL_ROOT}/<name>/. `
    + 'The apps stay from one conversation to the next, and a script app keeps its own files from one run to the next. '
    + `Every path of a call starts with ${APPS_VIRTUAL_ROOT}/.`,
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
      summary: 'Read a text file of an app, with the number of each line.',
      description: 'Gives the text of a file, each line after its number (`12: text`), and tells how many lines and bytes the file has. '
        + `One call gives at most ${READ_MAX_LINES} lines and ${countText(READ_MAX_CHARACTERS)} characters: the result tells when it left lines out, and from which line to read on. `
        + `edit takes the line numbers of this result. Dez refuses a file that is no text, and one of more than ${FILE_LIMIT}.`,
      parameters: [
        { name: 'path', type: 'string', description: `The path of the file, ${PATH_PARAMETER}`, required: true },
        { name: 'from_line', type: 'integer', description: 'The first line to read; the first line of a file is line 1. Leave it out to read from line 1.', required: false },
        { name: 'to_line', type: 'integer', description: 'The last line to read. Leave it out to read to the end of the file.', required: false },
      ],
      example: { path: EXAMPLE_FILE, from_line: 1, to_line: 200 },
    },
    {
      name: 'write',
      summary: 'Write a whole text file of an app: a new file, or all new text for a file that is there.',
      description: 'Writes `content` as the whole text of a file, and makes the folders of the path that are missing. '
        + 'It replaces a file that is there: to change a part of a file, use edit. The app must be there: make it with init first. '
        + `A file is at most ${FILE_LIMIT}. ${APP_LIMITS}`,
      parameters: [
        { name: 'path', type: 'string', description: `The path of the file, ${PATH_PARAMETER}`, required: true },
        { name: 'content', type: 'string', description: 'The whole text of the file.', required: true },
      ],
      example: { path: `${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}/units.js`, content: 'export const METERS_PER_FOOT = 0.3048\n' },
    },
    {
      name: 'edit',
      summary: 'Change lines of a text file of an app by their numbers: replace lines, delete lines, or put new lines in.',
      description: 'Applies a list of edits to one file, all at once. Each edit names lines by the numbers that read gave. '
        + 'Every number is a number of the file before this call: the edits of one call do not move the lines of each other, so never change a number because of another edit of the call. '
        + 'An edit with `from_line` replaces the lines `from_line` to `to_line` with the lines of `text`. An edit with `after_line` puts the lines of `text` in after that line. '
        + 'Each edit passes or fails by itself: the result tells what each one did, or why it failed, and gives a diff of the change. '
        + 'After the call the lines have new numbers: read the file again before the next edit of it.',
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
              name: 'text',
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
        edits: [{ from_line: 12, to_line: 14, text: 'const factor = 0.3048' }, { after_line: 30, text: '\nconsole.log(factor)' }],
      },
    },
    {
      name: 'rm',
      summary: 'Delete files and folders of apps, or whole apps. A folder goes with all that is in it.',
      description: 'Deletes each path of the list. It deletes a folder with every file and folder in it, at any depth, and asks nothing: '
        + `the path of an app (${APPS_VIRTUAL_ROOT}/<name>) deletes the whole app. Nothing brings a deleted file back. `
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
        + 'The kind and the description are those of its manifest.json. A call with no parameters lists every app by name.',
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
        { name: 'path', type: 'string', description: `The folder, as in "${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}". Leave it out for ${APPS_VIRTUAL_ROOT}.`, required: false },
      ],
      example: { path: `${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}` },
    },
    {
      name: 'mkdir',
      summary: 'Make a folder in an app, with the folders above it that are missing.',
      description: 'Makes a folder in an app, and the folders of the path that are missing. A folder that is there already is no error. '
        + 'write makes the folders of its path too, so this is only for a folder that has no file yet. It makes no app: init does.',
      parameters: [
        { name: 'path', type: 'string', description: `The folder to make, as in "${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}/data/cache".`, required: true },
      ],
      example: { path: `${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}/data/cache` },
    },
    {
      name: 'mv',
      summary: 'Move or rename files and folders of apps, or rename an app.',
      description: 'Moves each `from` path to its `to` path, one after the other, in the order of the list. `to` is the full new path, not the folder to move into. '
        + 'A move replaces nothing: it fails when a file or a folder is at `to` already. It makes the folders of `to` that are missing. '
        + `Each move passes or fails by itself, and the result tells which. A move of ${APPS_VIRTUAL_ROOT}/<name> to ${APPS_VIRTUAL_ROOT}/<other name> renames an app.`,
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
        + 'A call that Dez refuses rejects with an error whose message tells why: show it to the user. The page calls no Dez tool, and it has no network and no storage.',
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
        INTERMEDIATE_PARAMETER,
        jobTimeoutParameter(APP_RUN_DEFAULT_SECONDS),
      ],
      example: { name: EXAMPLE_SCRIPT_APP, parameters: { columns: 4, title: 'Trip' }, inputs: '@a @b' },
    },
  ],
}

export const APPS_TOOL_DEFINITION = subcommandToolDefinition(APPS_TOOL)

/** A path of a call: the folder of all apps, an app, or a file or a folder
 *  of an app. */
export interface AppsPath {
  /** The names after `/apps`: none for the folder of all apps, and the
   *  name of the app first. */
  names: readonly string[]
  /** The path as a model writes and reads it: `/apps/notes/main.js`. */
  virtual: string
  /** The path from the app root, as the native file selectors take it:
   *  `apps/notes/main.js`. */
  file: string
}

function pathOf(names: readonly string[]): AppsPath {
  return { names, virtual: [APPS_VIRTUAL_ROOT, ...names].join('/'), file: [APPS_FOLDER, ...names].join('/') }
}

/** The folder of all apps. */
export const APPS_ROOT = pathOf([])

/** The path of the name `name` in the folder at `folder`. */
export function pathIn(folder: AppsPath, name: string): AppsPath {
  return pathOf([...folder.names, name])
}

/** The folder of the app of a path that is in an app. */
export function appOf(path: AppsPath): AppsPath {
  return pathOf(path.names.slice(0, 1))
}

/** The folder that holds what is at `path`. */
export function parentOf(path: AppsPath): AppsPath {
  return pathOf(path.names.slice(0, -1))
}

// Whether `path` is in the folder `folder`, at any depth.
function isBelow(path: AppsPath, folder: AppsPath): boolean {
  return path.names.length > folder.names.length && folder.names.every((name, index) => path.names[index] === name)
}

// The names that the native file selectors take (`is_app_file_segment`,
// persistence.rs): keep the two rules the same.
const NAME = /^[A-Za-z0-9._-]+$/

/** Whether the native file selectors take `name` as one name of a path. */
export function isPathName(name: string): boolean {
  return NAME.test(name) && name !== '.' && name !== '..'
}

/** The path that the value of the parameter `parameter` names. One `/` at
 *  its end is fine. Throws a `ToolError` for a value that is no path below
 *  `/apps`, and for a name that the file selectors do not take. `.` and
 *  `..` are refused, not resolved: a model that writes them has a wrong
 *  idea of where it is. */
export function appsPath(value: unknown, parameter: string): AppsPath {
  const text = typeof value === 'string' ? value.trim() : ''
  const form = `Every path starts with ${APPS_VIRTUAL_ROOT}/, ${PATH_PARAMETER}`
  if (text === '') throw new ToolError(`\`${parameter}\` is empty. ${form}`)
  const quoted = JSON.stringify(startOf(text, 300))
  if (text !== APPS_VIRTUAL_ROOT && !text.startsWith(`${APPS_VIRTUAL_ROOT}/`)) throw new ToolError(`${quoted} is no path of the apps tool. ${form}`)
  const rest = text.slice(APPS_VIRTUAL_ROOT.length + 1).replace(/\/$/, '')
  if (rest === '') return pathOf([])

  const names = rest.split('/')
  if (names.length > MAX_PATH_NAMES) throw new ToolError(`The path ${quoted} has ${names.length} names after ${APPS_VIRTUAL_ROOT}/, and a path has at most ${MAX_PATH_NAMES}.`)
  for (const name of names) {
    if (name === '') throw new ToolError(`The path ${quoted} has an empty name: two "/" with nothing between them.`)
    if (name === '.' || name === '..') {
      throw new ToolError(`The path ${quoted} holds "${name}", which the apps tool does not resolve. Give the whole path from ${APPS_VIRTUAL_ROOT}/, ${PATH_PARAMETER}`)
    }
    if (!isPathName(name)) {
      throw new ToolError(`The path ${quoted} holds the name ${JSON.stringify(name)}, which the apps tool does not take. `
        + 'The name of a file or a folder has only ASCII letters, digits, "-", "_", and ".".')
    }
    if (name.length > MAX_NAME_LENGTH) throw new ToolError(`The path ${quoted} holds a name of ${name.length} characters, and a name has at most ${MAX_NAME_LENGTH}.`)
  }
  return pathOf(names)
}

// The folder names that `withoutLocalPaths` takes for the start of a path
// of the computer (the top comment).
const HIDDEN_NAMES = ['home', 'Users']

// Throws for a path that a call would make and that a later result could
// not show.
function checkNewNames(path: AppsPath): void {
  const name = path.names.find((candidate) => HIDDEN_NAMES.includes(candidate))
  if (name === undefined) return
  throw new ToolError(`The apps tool makes no file and no folder with the name "${name}" in its path (${path.virtual}): `
    + 'Dez takes such a path for a path of the user\'s computer and hides it from you. Use another name.')
}

/** The folder of the app that a call names with `name`. Throws a
 *  `ToolError` for a text that is no name of an app. */
export function appNamed(name: string): AppsPath {
  if (!isAppName(name)) throw new ToolError(`${JSON.stringify(startOf(name, 100))} is no name for an app. ${APP_NAME_RULE}`)
  return pathOf([name])
}

// The path of a file of an app that the parameter `parameter` names.
function filePath(args: SubcommandArguments, parameter: string): AppsPath {
  const path = appsPath(args[parameter], parameter)
  if (path.names.length >= 2) return path
  throw new ToolError(path.names.length === 0
    ? `${path.virtual} is the folder of all apps, not a file. Give the path of a file of an app, ${PATH_PARAMETER}`
    : `${path.virtual} is the folder of an app, not a file. Give the path of a file in it, as in "${path.virtual}/main.js".`)
}

// The values of a call that `checkArgumentValues` checked: each one is of
// the type of its parameter, and an absent one has no key.

function textArgument(args: SubcommandArguments | ToolArguments, name: string): string {
  const value = args[name]
  return typeof value === 'string' ? value : ''
}

function integerArgument(args: SubcommandArguments | ToolArguments, name: string): number | undefined {
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

// The folders from the app of `folder` down to `folder` that the listing
// of the app does not have, the top one first. Throws when one of them is
// there and is no folder.
function foldersToMake(folder: AppsPath, app: AppsTree): AppsPath[] {
  const kinds = new Map(app.entries.map((entry) => [entry.path, entry.kind]))
  const missing: AppsPath[] = []
  for (let depth = 2; depth <= folder.names.length; depth += 1) {
    const step = pathOf(folder.names.slice(0, depth))
    const kind = kinds.get(step.names.slice(1).join('/'))
    if (kind === undefined) missing.push(step)
    else if (kind !== 'folder') throw new ToolError(`${step.virtual} is ${kindName(kind)}, so nothing can be in it.`)
  }
  return missing
}

/** Throws when the app `app` has no room for what a call adds: `entries`
 *  new files and folders, and `bytes` more bytes. `tree` is the listing of
 *  the app with `APPS_MAX_ENTRIES`. A call that adds nothing passes, also
 *  in an app that is over a limit: a model must be able to make a file of
 *  such an app smaller. */
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
  return { app, manifest, files: appTemplateFiles(manifest).map((file) => ({ path: pathOf([name, file.name]), content: file.content })) }
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

export interface ReadCall {
  path: AppsPath
  fromLine: number
  /** null: to the end of the file. */
  toLine: number | null
}

export function readCall(args: SubcommandArguments): ReadCall {
  const path = filePath(args, 'path')
  const fromLine = integerArgument(args, 'from_line') ?? 1
  const toLine = integerArgument(args, 'to_line') ?? null
  if (fromLine < 1) throw new ToolError(`\`from_line\` is ${fromLine}. The first line of a file is line 1.`)
  if (toLine !== null && toLine < fromLine) {
    throw new ToolError(`\`to_line\` (${toLine}) is before \`from_line\` (${fromLine}). Give the first and the last line to read, as in {"from_line": ${fromLine}, "to_line": ${fromLine + 99}}.`)
  }
  return { path, fromLine, toLine }
}

/** Throws unless a file that `read` and `edit` take is at `path`: a plain
 *  file of at most `APPS_MAX_FILE_BYTES`. */
export function checkTextFile(path: AppsPath, facts: PathFacts): void {
  if (facts.kind === 'missing') {
    throw new ToolError(`There is no file ${path.virtual}. Call ls to see the files of its folder, as in {"path": "${parentOf(path).virtual}"}.`)
  }
  if (facts.kind === 'folder') throw new ToolError(`${path.virtual} is a folder, not a file. Call ls to see what is in it.`)
  if (facts.kind === 'other') throw new ToolError(`${path.virtual} is ${OTHER_KIND}, and the apps tool opens plain files only.`)
  if (facts.size > APPS_MAX_FILE_BYTES) {
    throw new ToolError(`${path.virtual} has ${byteSizeText(facts.size)}, and the apps tool reads and edits a file of at most ${FILE_LIMIT}.`)
  }
}

/** The text of the file at `path` from its bytes. Throws for a file that
 *  is no text: one with a zero byte, or with bytes that are no UTF-8. A
 *  byte order mark stays in the text, so that an edit writes it back. */
export function fileText(path: AppsPath, bytes: Uint8Array): string {
  // The file can have grown after the size check.
  checkTextFile(path, { kind: 'file', size: bytes.length })
  if (!bytes.includes(0)) {
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      // No UTF-8: the error below.
    }
  }
  throw new ToolError(`${path.virtual} is no text file (it holds a zero byte, or bytes that are no UTF-8), and the apps tool reads and edits text files only.`)
}

/** The result of a `read` call: the lines that the call asks for of the
 *  file with `text` and `size` bytes, each after its number, under a line
 *  that tells which lines these are. A last line tells which lines the
 *  limits of one call left out. Throws for a first line that the file does
 *  not have. */
export function readText({ path, fromLine, toLine }: ReadCall, text: string, size: number): string {
  const lines = textLines(text)
  const total = lines.length
  if (total === 0) {
    if (fromLine > 1) throw new ToolError(`\`from_line\` is ${fromLine}, and ${path.virtual} is an empty file.`)
    return `${path.virtual} is an empty file.`
  }
  if (fromLine > total) throw new ToolError(`\`from_line\` is ${fromLine}, and ${path.virtual} has ${countOf(total, 'line')}.`)
  const last = Math.min(toLine ?? total, total)

  const rows: string[] = []
  const notes: string[] = []
  let characters = 0
  let line = fromLine
  for (; line <= last && rows.length < READ_MAX_LINES; line += 1) {
    const row = `${line}: ${lines[line - 1]}`
    if (characters + row.length > READ_MAX_CHARACTERS) {
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
  const shownLast = line - 1
  if (shownLast < last) {
    notes.push(`Not shown: ${linesName(shownLast + 1, last)}. One call gives at most ${READ_MAX_LINES} lines and ${countText(READ_MAX_CHARACTERS)} characters: `
      + `call read again with "from_line": ${shownLast + 1} for the next ones.`)
  }
  return [`${path.virtual}: ${linesName(fromLine, shownLast)} of ${total} (${byteSizeText(size)})`, ...rows, ...notes].join('\n')
}

export interface WriteCall {
  path: AppsPath
  bytes: Uint8Array
  /** How many lines the text has. */
  lines: number
}

export function writeCall(args: SubcommandArguments): WriteCall {
  const path = filePath(args, 'path')
  checkNewNames(path)
  const content = textArgument(args, 'content')
  const bytes = new TextEncoder().encode(content)
  if (bytes.length > APPS_MAX_FILE_BYTES) {
    throw new ToolError(`\`content\` has ${byteSizeText(bytes.length)}, and a file is at most ${FILE_LIMIT}. Write a smaller file, or put the text into more files.`)
  }
  return { path, bytes, lines: textLines(content).length }
}

/** What a `write` call does before it writes: the folder to make (it and
 *  the missing ones above it), and the size of the file that it replaces;
 *  null for none. `target` is what is at the path, and `app` the listing
 *  of its app with `APPS_MAX_ENTRIES`. Throws when the app is not there,
 *  when a folder or a link is at the path or a file is where a folder must
 *  be, and when the app has no room. */
export function writePlan(call: WriteCall, target: PathFacts, app: AppsTree): { folder: AppsPath | null, replaced: number | null } {
  const { path } = call
  checkAppIsThere(appOf(path), app)
  if (target.kind === 'folder') throw new ToolError(`${path.virtual} is a folder. Give the path of a file, as in "${path.virtual}/main.js".`)
  if (target.kind === 'other') throw new ToolError(`${path.virtual} is ${OTHER_KIND}, and the apps tool writes plain files only. Give another path.`)
  const replaced = target.kind === 'file' ? target.size : null
  // The folders of a file that is there are there too. The listing of an
  // app that is over its limit can lack them.
  const missing = replaced === null ? foldersToMake(parentOf(path), app) : []
  checkAppRoom(appOf(path), app, { entries: missing.length + (replaced === null ? 1 : 0), bytes: call.bytes.length - (replaced ?? 0) })
  return { folder: missing.at(-1) ?? null, replaced }
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

export function editCall(args: SubcommandArguments): EditCall {
  const path = filePath(args, 'path')
  const edits = objectItems(args, 'edits').map((edit): LineEdit => ({
    fromLine: integerArgument(edit, 'from_line'),
    toLine: integerArgument(edit, 'to_line'),
    afterLine: integerArgument(edit, 'after_line'),
    text: textArgument(edit, 'text'),
  }))
  if (edits.length === 0) throw new ToolError('`edits` is an empty list. Give at least one edit, as in {"edits": [{"from_line": 3, "to_line": 4, "text": "..."}]}.')
  return { path, edits }
}

/** What became of the items of a call that pass or fail each by itself
 *  (the edits of `edit`, the paths of `rm`, the moves of `mv`). */
export interface ItemOutcome {
  done: boolean
  text: string
}

// One numbered line for each item of a call.
function outcomeLines(outcomes: readonly ItemOutcome[]): string[] {
  return outcomes.map((outcome, index) => `${index + 1}. ${outcome.done ? 'Done' : 'Failed'}. ${outcome.text}`)
}

// The first lines of a diff that fit a result, and a line that tells how
// many it leaves out.
function cutDiff(diff: readonly string[]): string[] {
  const shown: string[] = []
  let characters = 0
  for (const line of diff) {
    if (characters + line.length + 1 > DIFF_MAX_CHARACTERS) break
    shown.push(line)
    characters += line.length + 1
  }
  const rest = diff.length - shown.length
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
    throw new ToolError(`With these edits ${path.virtual} would have ${byteSizeText(bytes.length)}, and a file is at most ${FILE_LIMIT}. Dez did not change the file.`)
  }
  const content = [
    `Edited ${path.virtual}: ${passed} of ${countOf(edits.length, 'edit')} done. The file had ${countOf(before.length, 'line')}, and it has ${countText(plan.lines.length)} now.`,
    ...outcomes,
    'The lines have new numbers now: read the file again before the next edit of it.',
    'The change:',
    ...cutDiff(plan.diff),
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
 *  for an empty list, and for the folder of all apps. */
export function rmCall(args: SubcommandArguments): { paths: AppsPath[] } {
  const all = textItems(args, 'paths').map((value) => appsPath(value, 'paths'))
  if (all.length === 0) throw new ToolError(`\`paths\` is an empty list. Give the paths to delete, as in {"paths": ["${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}/old.js"]}.`)
  if (all.some((path) => path.names.length === 0)) {
    throw new ToolError(`${APPS_VIRTUAL_ROOT} is the folder of all apps, and rm does not delete it. To delete an app, give its folder, as in "${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}".`)
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
  const more = tree.more ? 'more than ' : ''
  return {
    folder: true,
    text: [
      `Deleted the folder ${path.virtual} with the ${more}${countText(below.length)} files and folders in it (${appSizeText(appSize(tree))}):`,
      ...below.slice(0, RM_MAX_SHOWN_PATHS),
      ...(rest > 0 ? [`… and ${more}${countText(rest)} more.`] : []),
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

/** The moves of an `mv` call. Throws for an empty list, for the folder of
 *  all apps on either side, and for a `to` that the tool does not make: a
 *  path directly in `/apps/` whose name is no name of an app, or a path
 *  with a name of `HIDDEN_NAMES`. */
export function mvCall(args: SubcommandArguments): { moves: Move[] } {
  const moves = objectItems(args, 'moves').map((move): Move => ({ from: appsPath(move.from, 'from'), to: appsPath(move.to, 'to') }))
  const example = `{"moves": [{"from": "${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}/units.js", "to": "${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}/lib/units.js"}]}`
  if (moves.length === 0) throw new ToolError(`\`moves\` is an empty list. Give the moves, as in ${example}.`)
  for (const { from, to } of moves) {
    if (from.names.length === 0) throw new ToolError(`${APPS_VIRTUAL_ROOT} is the folder of all apps, and mv does not move it.`)
    if (to.names.length === 0) throw new ToolError(`\`to\` is ${APPS_VIRTUAL_ROOT}, the folder of all apps. Give the full new path of what you move, as in ${example}.`)
    if (to.names.length === 1 && !isAppName(to.names[0])) {
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
  /** The app of `to`. */
  app: PathFacts
  /** The folder of `to`. */
  parent: PathFacts
}

/** What `mv` does for one move: the folder to make first (it and the
 *  missing ones above it), null for none, and what the result tells when
 *  the move is done. Throws for a move that Dez does not make: one to the
 *  same path or into the moved folder itself, one of nothing or of a link,
 *  one onto a path that is taken, a file directly in `/apps/`, and one
 *  into an app that is not there. */
export function moveStep({ from, to }: Move, facts: MoveFacts): { folder: AppsPath | null, text: string } {
  if (from.file === to.file) throw new ToolError(`\`from\` and \`to\` are the same path, ${from.virtual}.`)
  if (isBelow(to, from)) throw new ToolError(`${to.virtual} is in ${from.virtual}, and a folder cannot move into itself.`)
  const { source, target } = facts
  if (source.kind === 'missing') throw new ToolError(`Nothing is at ${from.virtual}.`)
  if (source.kind === 'other') throw new ToolError(`${from.virtual} is ${OTHER_KIND}, which the apps tool does not move.`)
  if (target.kind !== 'missing') {
    throw new ToolError(`${to.virtual} is taken: ${kindName(target.kind)} is there already, and a move replaces nothing. Delete it with rm first, or give another \`to\`.`)
  }

  if (to.names.length === 1) {
    if (source.kind === 'file') {
      throw new ToolError(`${to.virtual} would be a file directly in ${APPS_VIRTUAL_ROOT}/, where only the folders of apps are. Give a path in an app, as in "${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}/${from.names.at(-1)}".`)
    }
    return {
      folder: null,
      text: from.names.length === 1
        ? `Renamed the app ${from.virtual} to ${to.virtual}. Its manifest.json still has the old name: change "name" in it with edit.`
        : `Moved the folder ${from.virtual} to ${to.virtual}, where it is an app now. An app needs a manifest.json: write one if it has none.`,
    }
  }

  checkAppIsThere(appOf(to), facts.app)
  const parent = parentOf(to)
  if (facts.parent.kind !== 'folder' && facts.parent.kind !== 'missing') {
    throw new ToolError(`${parent.virtual} is ${kindName(facts.parent.kind)}, so nothing can be in it.`)
  }
  return { folder: facts.parent.kind === 'missing' ? parent : null, text: `Moved ${from.virtual} to ${to.virtual}.` }
}

export function mvResult(outcomes: readonly ItemOutcome[]): { content: string, isError: boolean } {
  const passed = outcomes.filter((outcome) => outcome.done).length
  return itemsResult(`Did ${passed} of ${countOf(outcomes.length, 'move')}.`, outcomes)
}

export function mkdirCall(args: SubcommandArguments): { path: AppsPath } {
  const path = appsPath(args.path, 'path')
  if (path.names.length < 2) {
    throw new ToolError(`mkdir makes folders in an app only, as in "${APPS_VIRTUAL_ROOT}/${EXAMPLE_APP}/data", and ${path.virtual} is ${path.names.length === 0 ? 'the folder of all apps' : 'the folder of an app'}. `
      + 'init makes a new app.')
  }
  checkNewNames(path)
  return { path }
}

/** What an `mkdir` call does: whether it makes the folder, and the result
 *  text. `target` is what is at the path, and `app` the listing of its app
 *  with `APPS_MAX_ENTRIES`. Throws when the app is not there, when a file
 *  is at the path or where a folder must be, and when the app has no
 *  room. */
export function mkdirStep(path: AppsPath, target: PathFacts, app: AppsTree): { make: boolean, text: string } {
  if (target.kind === 'folder') return { make: false, text: `The folder ${path.virtual} is there already.` }
  if (target.kind !== 'missing') throw new ToolError(`${path.virtual} is ${kindName(target.kind)}, so Dez makes no folder there. Give another path.`)
  checkAppIsThere(appOf(path), app)
  const missing = foldersToMake(path, app)
  checkAppRoom(appOf(path), app, { entries: missing.length, bytes: 0 })
  const above = missing.slice(0, -1).map((folder) => folder.virtual)
  return { make: true, text: `Made the folder ${path.virtual}${above.length === 0 ? '' : `, and above it ${above.join(' and ')}`}.` }
}

export function lsCall(args: SubcommandArguments): { path: AppsPath } {
  return { path: args.path === undefined ? pathOf([]) : appsPath(args.path, 'path') }
}

const NO_APPS = 'There are no apps yet. Make one with init.'

/** The result of an `ls` call: the files and the folders in the folder at
 *  `path`, by name, each with its size; a folder with the number and the
 *  bytes of the files below it. `tree` is the listing of the path with
 *  `LS_MAX_ENTRIES`. A path that is a file gives the facts of the file.
 *  Throws when nothing is at the path. */
export function lsText(path: AppsPath, tree: AppsTree): string {
  const isRoot = path.names.length === 0
  if (tree.kind === 'missing') {
    if (isRoot) return NO_APPS
    throw new ToolError(path.names.length === 1
      ? `There is no app ${path.virtual}. Call list_apps to see the apps that are there.`
      : `There is no folder ${path.virtual}. Call ls with "${parentOf(path).virtual}" to see what is there.`)
  }
  if (tree.kind === 'file') return `${path.virtual} is a file (${byteSizeText(tree.size)}), not a folder. read gives its text.`
  if (tree.kind === 'other') return `${path.virtual} is ${OTHER_KIND}, not a folder.`
  if (tree.entries.length === 0) return isRoot ? NO_APPS : `${path.virtual} is an empty folder.`

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
    if (row.kind === 'folder') return `${name}/ | ${atLeast}${countOf(row.files, 'file')}, ${byteSizeText(row.bytes)}${unusable}`
    return `${name} | ${row.kind === 'file' ? byteSizeText(row.bytes) : OTHER_KIND}${unusable}`
  })
  if (sorted.length > LS_MAX_ROWS) texts.push(`… and ${countText(sorted.length - LS_MAX_ROWS)} more.`)

  const folders = sorted.filter((row) => row.kind === 'folder').length
  const cut = tree.more
    ? ` The folder holds more than ${countText(LS_MAX_ENTRIES)} files and folders at all depths, so the numbers of its folders count only a part of them, and names can be missing.`
    : ''
  return [`${path.virtual}: ${countOf(folders, 'folder')} and ${countOf(sorted.length - folders, 'file')} (name | size).${cut}`, ...texts].join('\n')
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

/** The kind of the app at `app`, as its manifest tells it: the first
 *  check of a subcommand that works only on one kind of app (`invoke`,
 *  `show`). `facts` is what is at `manifest`, the path of the manifest,
 *  and `bytes` are the bytes of that file, null when Dez did not read it
 *  (`isReadableManifest`). Throws a `ToolError` for a manifest that is
 *  missing, that Dez does not read, or that is not valid; `notDone` is its
 *  last sentence, which tells what Dez did not do. */
export function checkedAppKind(app: AppsPath, manifest: AppsPath, facts: PathFacts, bytes: Uint8Array | null, notDone: string): AppKind {
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
  return parsed.kind
}

// The kind and the description columns of an app. An app with no manifest
// that Dez can read still lists: a model must see it to repair it.
function manifestColumns({ tree, manifest }: ListedApp): [string, string] {
  if (!manifestEntry(tree)) return ['?', '(no manifest.json)']
  if (!manifest) return ['?', `(a manifest.json that Dez does not read: it is no plain file of at most ${byteSizeText(MANIFEST_MAX_BYTES)})`]
  const parsed = parseAppManifest(new TextDecoder().decode(manifest))
  if (!parsed) return ['?', `(a manifest.json that is not valid: it needs "name", "description", and "kind", which is ${APP_KINDS.map((kind) => `"${kind}"`).join(' or ')})`]
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
    return [app.name, kind, appSizeText(size), description].join(' | ')
  })
  if (sorted.length > LIST_APPS_MAX_ROWS) rows.push(`… and ${countText(sorted.length - LIST_APPS_MAX_ROWS)} more. Use \`name\` to get a shorter list.`)

  const count = criteria === '' ? countOf(all.length, 'app') : `${matches.length} of ${countOf(all.length, 'app')} ${matches.length === 1 ? 'matches' : 'match'} ${criteria}`
  const order = { name: 'by name', largest: 'the largest first', smallest: 'the smallest first' }[call.sort]
  return [`${count} (name | kind | size | description), ${order}.`, ...rows].join('\n')
}
