import sbp from '@sbp/sbp'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { DrawnImage, DrawnMediaType, ImageDrawing, ImageSize } from '../model/chat/imageDrawing'
import type { Section } from '../model/chat/types'
import { user } from '../model/streams/testing'
import { ALIAS_TIMEOUT_MS, aliasRunTexts } from '../model/tools/appAliases'
import { APP_READ_ASSET, APP_SAVE_ASSET, APP_STOPPED_TEXT, AppCallError, notAnInputText, SaveNotStoredError, type AppFrameEnd, type AppFrameRun, type SavedAssetAnswer } from '../model/tools/appBridge'
import { APP_PAGE_LOADS_STATE, APP_RUNS_STATE, appOutputNotStoredText, invokeCall, invokeInputsText, INVOKE_RUN_TEXTS, type CheckedInvokeCall } from '../model/tools/appInvoke'
import { MANIFEST_MAX_BYTES } from '../model/tools/appManifest'
import { APP_RUN_MAX_DECODED_BYTES, APP_RUN_MAX_OUTPUT_FILES, APPS_MAX_ENTRIES } from '../model/tools/appsTool'
import { assetProbeArgs } from '../model/tools/assetFacts'
import { frameEncodeArgs, frameFileName, FRAMES_ENCODE_STATE } from '../model/tools/frameSequences'
import { unreadableImageText } from '../model/tools/imageTool'
import { APP_DECODES_STATE, clipDecodeArgs, DECODE_NOT_PROBED_DETAILS, DECODED_TOO_LARGE_TEXT, decodeFailedText, NO_DECODE } from '../model/tools/inputDecode'
import { jobStartedText, jobTimedOutText } from '../model/tools/jobs'
import { JS_EVAL_OUTPUT_BYTES, JS_EVAL_RUNNER, JS_EVAL_RUNNER_FILE, RUN_DESCRIPTION_FILE } from '../model/tools/jsEval'
import { PROGRAM_READS_INPUTS, programNotStartedText } from '../model/tools/programRuns'
import { aliasOf, appsArgs, CONVERSATION, CONVERSATION_ID, FILM, OPUS, PNG_BYTES, probeOutput, protocolLine, RED, SKY, SONG, textBytes, VP9, WAV_BYTES } from '../model/tools/testing'
import type { ToolRunResult } from '../model/tools/types'
import { FFPROBE_TIMEOUT_MS } from '../model/tools/videoTool'
import { FONT_FOLDER, SHIPPED_FONTS } from '../model/tools/videoFonts'
import { checkedAppRun, runAliasCall, runAppFrameJob, runAppJob } from './appInvoke'
import { TabJobs, type MadeAsset } from './jobs'
import type { AppFileRef, BundledToolEnd, FileTree } from './nativeTypes'
import {
  APP_DIR,
  appFiles,
  builtInAppFiles,
  CACHE_DIR,
  callContext,
  callingProgram,
  CONVERSATION_WORK_FOLDER,
  deletedWorkFolder,
  ENDED,
  failureOf,
  fakeAppFiles,
  FILE_ID,
  heldStep,
  native,
  refusalOf,
  RESOURCE_DIR,
  resetNative,
  running,
  STOP,
  writes,
  type StubProgram,
} from './testing'
// Side-effect import: registers `dez.controller/tools/run`.
import './tools'

// The run of an `apps invoke` call, from the checked call to the outcome
// of its job, on the stub native side. The texts and the rules of a call,
// of the output folder, and of a result have their own tests
// (model/tools/appInvoke.test.ts); the tests here tell what a call reads,
// what a run gets, and what Dez stores of what the run left.

const MAIN = 'export default async function main() { return 1 }\n'
const TEXT = textBytes('Just some notes.\n')
// A program whose code returned `text`.
const returns = (text: string): StubProgram => writes('stdout', protocolLine({ type: 'result', text }))

let deletedImages: string[] = []
let deletedClips: string[] = []
// The states that the work of a job reported, and the files that it told
// the job to keep.
let states: string[] = []
let keptAssets: MadeAsset[] = []
// How many times Dez listed the output folder of a run.
let outputListings = 0
let consoleError: MockInstance<typeof console.error>

// The sections of the tab of a call through the tool.
let tabSections: Section[] = []

// The frame of a run of a UI app: the runs that Dez asked for, and what
// the page of the app does in one (the stub of `dez.ui/runAppFrame`).
let frameRuns: AppFrameRun[] = []
let page: (run: AppFrameRun) => Promise<AppFrameEnd>
// The paths of the images that Dez read for a page.
let readImages: string[] = []
// How many images the image tool of a tool call of the code made.
let drawnImages = 0

// The path of the `n`th image that the image tool made.
const drawnImage = (n: number) => `${APP_DIR}/assets/generated/images/drawn-${n}.png`

// The tool call of the code that flips the image @a.
const FLIP_A = { selector: 'dez.tools/image/flip', arguments: { image: 'a', direction: 'horizontal' } }

sbp('sbp/selectors/register', {
  'dez.model/tab' (): { sections: Section[] } {
    return { sections: tabSections }
  },
  async 'dez.controller/images/delete' (path: string): Promise<void> {
    deletedImages.push(path)
  },
  async 'dez.controller/media/delete' (path: string): Promise<void> {
    deletedClips.push(path)
  },
  // The read gives a file with the name of the user's file, as the real
  // one does.
  async 'dez.controller/images/readFile' (path: string): Promise<File> {
    readImages.push(path)
    return new File([PNG_BYTES], path.slice(path.lastIndexOf('/') + 1), { type: 'image/png' })
  },
  async 'dez.controller/media/readClip' (clip: { type: string }): Promise<Blob> {
    return new Blob([WAV_BYTES], { type: clip.type })
  },
  'dez.ui/runAppFrame' (run: AppFrameRun): Promise<AppFrameEnd> {
    frameRuns.push(run)
    return page(run)
  },
  // The image tool of a tool call of the code: every image is 100 by 50
  // pixels, and each image that it draws is a new file.
  async 'dez.controller/images/redraw' (_file: Blob, plan: (size: ImageSize) => ImageDrawing | null, mediaType: DrawnMediaType): Promise<DrawnImage | null> {
    const drawing = plan({ width: 100, height: 50 })
    return drawing && { bytes: PNG_BYTES, mediaType: drawing.mediaType ?? mediaType, width: drawing.width, height: drawing.height }
  },
  async 'dez.controller/images/save' (): Promise<string> {
    drawnImages += 1
    return drawnImage(drawnImages)
  },
})

// A page whose handler returned `value`.
const returned = (value?: string): AppFrameEnd => ({ kind: 'returned', value, log: '' })

// The calls of a page of the run `run`.
function save(run: AppFrameRun, bytes: Uint8Array): Promise<SavedAssetAnswer> {
  return run.onCall({ selector: APP_SAVE_ASSET, blob: new Blob([bytes]) }) as Promise<SavedAssetAnswer>
}

function read(run: AppFrameRun, id: string): Promise<Blob> {
  return run.onCall({ selector: APP_READ_ASSET, id }) as Promise<Blob>
}

function isOutputFolder(file: AppFileRef): boolean {
  return file.root === 'cache' && file.path.endsWith('/output')
}

// The path of `file` in the output folder of a run; undefined for a file
// outside it.
function outputPath(file: AppFileRef): string | undefined {
  return file.root === 'cache' ? /\/output\/(.+)$/.exec(file.path)?.[1] : undefined
}

// Makes the output folder of a run hold `files` after the run: the bytes
// of each file by its path in the folder, and null for a folder. `more`
// tells that the output folder holds more entries than its listing.
function outputFolderHolds(files: Record<string, Uint8Array | null>, more = false): void {
  const entriesIn = (start: string) => Object.entries(files)
    .filter(([path]) => path.startsWith(start))
    .map(([path, bytes]) => ({ path: path.slice(start.length), kind: bytes === null ? 'folder' as const : 'file' as const, size: bytes?.length ?? 0, updatedAt: 0 }))
  native.fileTree = (file): FileTree => {
    if (isOutputFolder(file)) {
      outputListings += 1
      return { kind: 'folder', size: 0, updatedAt: 0, entries: entriesIn(''), more }
    }
    const path = outputPath(file)
    const at = path === undefined ? undefined : files[path]
    if (at === null) return { kind: 'folder', size: 0, updatedAt: 0, entries: entriesIn(`${path}/`), more: false }
    if (at !== undefined) return { kind: 'file', size: at.length, updatedAt: 0, entries: [], more: false }
    return { kind: 'missing', size: 0, updatedAt: null, entries: [], more: false }
  }
  native.fileBytes = (file) => {
    const bytes = files[outputPath(file) ?? '']
    if (!bytes) throw new Error(`Failed to read ${CACHE_DIR}/${file.path}: not a regular file`)
    return bytes
  }
}

// A frame sequence of the output folder, as `outputFolderHolds` takes it:
// the folder `name`, its frames.json with `facts`, and `frames` PNG frames.
function frameFolder(name: string, facts: Record<string, unknown>, frames: number): Record<string, Uint8Array | null> {
  const pngs = Array.from({ length: frames }, (_, index) => [`${name}/${frameFileName(index, 'png')}`, PNG_BYTES])
  return { [name]: null, [`${name}/frames.json`]: textBytes(JSON.stringify(facts)), ...Object.fromEntries(pngs) }
}

// Makes each ffmpeg run write a clip of `size` bytes (null: none) into the
// run folder, and report that it encoded `frames` frames; or end with
// `end`, after `errors` on its error output. Deno runs as before.
function encodesClip({ frames, size = 2048, end = ENDED, errors = '' }: { frames: number, size?: number | null, end?: BundledToolEnd, errors?: string }): void {
  const deno = native.program
  const listing = native.fileTree
  const clips = new Set<string>()
  native.program = async (run, onOutput) => {
    if (run.tool !== 'dez-ffmpeg') return deno(run, onOutput)
    if (size !== null) clips.add(`${run.folder}/${run.args.at(-1)}`)
    onOutput({ stream: 'stdout', text: `frame=${frames}\nfps=0.00\nprogress=end\n` })
    if (errors !== '') onOutput({ stream: 'stderr', text: errors })
    return end
  }
  native.fileTree = (file, maxEntries) => file.root === 'cache' && clips.has(file.path)
    ? { kind: 'file', size: size ?? 0, updatedAt: 0, entries: [], more: false }
    : listing(file, maxEntries)
}

// The ffmpeg runs of a job.
function ffmpegRuns() {
  return native.runs.filter(({ run }) => run.tool === 'dez-ffmpeg').map(({ run }) => run)
}

// The files that Dez wrote into the app root: the stored outputs of a run.
function stored(): { path: string, content: string | Uint8Array }[] {
  return native.savedFiles.filter(({ file }) => file.root === 'app').map(({ file, content }) => ({ path: file.path, content }))
}

// The description of the run that Dez wrote into the work folder `folder`.
function runDescription(folder: string): Record<string, unknown> {
  const saved = native.savedFiles.find(({ file }) => file.path === `${folder}/${RUN_DESCRIPTION_FILE}`)
  return JSON.parse(saved?.content as string) as Record<string, unknown>
}

// The checked call of the script app `notes`: with the call's own decode,
// as no manifest gives one, and with no native library.
function invoke(parameters: Record<string, unknown> = {}, sections = CONVERSATION): CheckedInvokeCall {
  const call = invokeCall(appsArgs('invoke', { name: 'notes', ...parameters }), sections)
  return { ...call, kind: 'script', decode: call.decode ?? NO_DECODE, nativeCanvas: false }
}

function runJob(call = invoke(), signal: AbortSignal = running()) {
  return runAppJob(call, { toolName: 'apps', texts: INVOKE_RUN_TEXTS }, CONVERSATION_ID, signal, (state) => states.push(state), (asset) => keptAssets.push(asset))
}

function uiCall(parameters: Record<string, unknown> = {}, sections = CONVERSATION): CheckedInvokeCall {
  return { ...invoke(parameters, sections), kind: 'ui' }
}

function runFrameJob(call = uiCall(), signal: AbortSignal = running()) {
  return runAppFrameJob(call, signal, (state) => states.push(state), (asset) => keptAssets.push(asset))
}

beforeEach(() => {
  resetNative()
  deletedImages = []
  deletedClips = []
  states = []
  keptAssets = []
  outputListings = 0
  frameRuns = []
  readImages = []
  drawnImages = 0
  page = async () => returned()
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  outputFolderHolds({})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('checkedAppRun', () => {
  // An async function, so that a bad call (`invokeCall`) rejects as the
  // `invoke` runner sees it.
  const checked = async (parameters: Record<string, unknown> = {}) => checkedAppRun(invokeCall(appsArgs('invoke', { name: 'notes', ...parameters }), CONVERSATION))

  it('gives the run of a script app that has its main file', async () => {
    fakeAppFiles(appFiles('notes', { 'main.ts': MAIN }))

    const call = await checked({ parameters: { columns: 4 }, inputs: '@a', timeout_seconds: 20 })

    expect(call.main.virtual).toBe('/apps/notes/main.ts')
    expect(call.parameters).toStrictEqual({ columns: 4 })
    expect(call.inputs.map((input) => input.id)).toStrictEqual(['a'])
    expect(call.timeoutMs).toBe(20_000)
  })

  it('gives the run of a UI app that has its page', async () => {
    fakeAppFiles(appFiles('notes', { 'index.html': '<!doctype html>\n' }, 'ui'))

    const call = await checked({ inputs: '@a' })

    expect(call.kind).toBe('ui')
    expect(call.index.virtual).toBe('/apps/notes/index.html')
  })

  it('gives the decode of the manifest of a script app, or the decode of the call in its place', async () => {
    const manifest = JSON.stringify({ name: 'notes', description: 'Keeps notes.', kind: 'script', decode: { audio: { rate: 22050 } } })
    fakeAppFiles(appFiles('notes', { 'manifest.json': manifest, 'main.ts': MAIN }))

    expect((await checked()).decode).toStrictEqual({ audio: { rate: 22050 }, frames: null })
    expect((await checked({ decode: { frames: { width: 12, height: 9 } } })).decode).toStrictEqual({ audio: null, frames: { width: 12, height: 9, fps: null } })
  })

  it('lets the run load skia-canvas only when the manifest of the app asks for it', async () => {
    const manifest = (native: unknown) => JSON.stringify({ name: 'notes', description: 'Draws notes.', kind: 'script', native })
    fakeAppFiles(appFiles('notes', { 'manifest.json': manifest(['skia-canvas']), 'main.ts': MAIN }))
    expect((await checked()).nativeCanvas).toBe(true)

    fakeAppFiles(appFiles('notes', { 'main.ts': MAIN }))
    expect((await checked()).nativeCanvas).toBe(false)

    fakeAppFiles(appFiles('notes', { 'manifest.json': manifest(['sharp']), 'main.ts': MAIN }))
    expect(await refusalOf(checked())).toContain('The field "native" of /apps/notes/manifest.json is not valid')
  })

  it.each([
    ['an app that is not there', appFiles('other', { 'main.ts': MAIN }), 'There is no app /apps/notes'],
    ['an app with no manifest', { 'apps/notes/main.ts': MAIN }, 'has no manifest.json'],
    ['a manifest that is not valid', { 'apps/notes/manifest.json': '{"name": "notes"', 'apps/notes/main.ts': MAIN }, 'is not valid'],
    ['a UI app with no page', appFiles('notes', { 'main.ts': MAIN }, 'ui'), 'has no index.html'],
    ['a folder at the place of the page of a UI app', appFiles('notes', { 'index.html': null }, 'ui'), '/apps/notes/index.html is a folder'],
    ['an app with no main file', appFiles('notes', { 'lib/main.ts': MAIN }), 'has no main.ts'],
    ['a folder at the place of the main file', appFiles('notes', { 'main.ts': null }), '/apps/notes/main.ts is a folder'],
  ])('refuses %s', async (_, files, fragment) => {
    fakeAppFiles(files)

    expect(await refusalOf(checked())).toContain(fragment)
  })

  it('refuses a bad call before it reads a file', async () => {
    fakeAppFiles(appFiles('notes', { 'main.ts': MAIN }))

    expect(await refusalOf(checked({ inputs: '@zz' }))).toContain('@zz')
    expect(native.readFiles).toStrictEqual([])
  })

  it('does not read a manifest that is too large', async () => {
    fakeAppFiles({ 'apps/notes/manifest.json': ' '.repeat(MANIFEST_MAX_BYTES + 1), 'apps/notes/main.ts': MAIN })

    expect(await refusalOf(checked())).toContain('/apps/notes/manifest.json is no plain file of at most')
    expect(native.readFiles).toStrictEqual([])
  })

  // The code of an app is not held to the limits of the `apps` tool, so a
  // listing of the app can lack its manifest and its main file.
  it('finds the files of an app that holds more files than a listing of an app', async () => {
    const data = Object.fromEntries(Array.from({ length: APPS_MAX_ENTRIES + 50 }, (_, index) => [`apps/notes/row-${index}.json`, '{}']))
    fakeAppFiles({ ...data, ...appFiles('notes', { 'main.ts': MAIN }) })

    expect((await checked()).app.virtual).toBe('/apps/notes')
  })

  it('tells of a file that Dez could not read, with no path of this computer', async () => {
    fakeAppFiles(appFiles('notes', { 'main.ts': MAIN }))
    native.fileBytes = () => { throw new Error(`Failed to read ${APP_DIR}/apps/notes/manifest.json: Permission denied (os error 13)`) }

    const refusal = await refusalOf(checked())

    expect(refusal).toContain('Dez could not read /apps/notes/manifest.json')
    expect(refusal).not.toContain('/home/u')
    expect(consoleError).toHaveBeenCalled()
  })
})

describe('runAppJob', () => {
  it('runs the module of Dez in a new work folder with the description of the run, copies of the inputs, the output folder, the folder of the app, and the work folder of the conversation', async () => {
    const call = invoke({ parameters: { columns: 4, title: 'Trip' }, inputs: '@a @c', timeout_seconds: 20 })
    native.program = returns('done')

    const outcome = await runJob(call)

    const folder = deletedWorkFolder()
    expect(outcome).toStrictEqual({ text: 'done', isError: false, assets: [] })
    // The output folder is the first write: it makes the work folder for
    // the user only. The work folder of the conversation is there before
    // Dez asks for its real path.
    expect(native.createdFolders).toStrictEqual([{ root: 'cache', path: `${folder}/output` }, { root: 'app', path: CONVERSATION_WORK_FOLDER }])
    expect(native.savedFiles.map(({ file }) => file)).toStrictEqual([
      { root: 'cache', path: `${folder}/${JS_EVAL_RUNNER_FILE}` },
      { root: 'cache', path: `${folder}/${RUN_DESCRIPTION_FILE}` },
    ])
    expect(native.savedFiles[0].content).toBe(JS_EVAL_RUNNER)
    expect(runDescription(folder)).toStrictEqual({
      kind: 'app',
      main: `file://${APP_DIR}/apps/notes/main.ts`,
      parameters: { columns: 4, title: 'Trip' },
      inputs: [
        { id: 'a', kind: 'image', type: 'image/jpeg', path: `${CACHE_DIR}/${folder}/a.jpg` },
        { id: 'c', kind: 'video', type: 'video/webm', path: `${CACHE_DIR}/${folder}/c.webm` },
      ],
      outputFolder: `${CACHE_DIR}/${folder}/output`,
      appFolder: `${APP_DIR}/apps/notes`,
      workFolder: `${APP_DIR}/${CONVERSATION_WORK_FOLDER}`,
      fonts: SHIPPED_FONTS.map(({ file, family, weight, scripts }) => ({ file, family, weight, scripts, path: `${RESOURCE_DIR}/${FONT_FOLDER}/${file}` })),
    })
    expect(native.runs).toHaveLength(1)
    const { run } = native.runs[0]
    expect(run).toMatchObject({
      tool: 'dez-deno',
      args: [JS_EVAL_RUNNER_FILE],
      folder,
      inputs: [{ name: 'a.jpg', source: RED }, { name: 'c.webm', source: FILM.src }],
      timeoutMs: 20_000,
      maxOutputBytes: JS_EVAL_OUTPUT_BYTES,
      appFolder: 'notes',
      conversationFolder: CONVERSATION_ID,
      nativeCanvas: false,
    })
    // The code of an app gets no input of the program.
    expect(run).not.toHaveProperty('stdin')
    expect(states).toStrictEqual([PROGRAM_READS_INPUTS, APP_RUNS_STATE])
  })

  // Rust lets the run load skia-canvas only when the call tells it so.
  it('lets the run of an app whose manifest asks for skia-canvas load it, and names a font that it read by the name of its file', async () => {
    native.program = returns(`drew with ${RESOURCE_DIR}/${FONT_FOLDER}/NotoSans-Bold.ttf`)

    const outcome = await runJob({ ...invoke(), nativeCanvas: true })

    expect(native.runs[0].run).toMatchObject({ tool: 'dez-deno', nativeCanvas: true })
    expect(outcome.text).toBe('drew with NotoSans-Bold.ttf')
  })

  it('answers no tool call line of the code', async () => {
    native.program = async (_run, onOutput) => {
      onOutput({ stream: 'stdout', text: protocolLine({ type: 'call', id: 1, selector: 'dez.tools/jobs_list' }) })
      onOutput({ stream: 'stdout', text: protocolLine({ type: 'result', text: 'done' }) })
      return ENDED
    }

    const outcome = await runJob()

    expect(outcome).toMatchObject({ text: 'done', isError: false })
    expect(native.inputWrites).toStrictEqual([])
  })

  // Deno checks a path of the code against the folders of its flags as
  // text, and Rust writes the flags from the joined paths.
  it('gives the code the paths that Dez joined, and takes both forms of a path out of the texts of the run', async () => {
    native.canonicalPath = (path) => path.replace('/home/u', '/private/home/u')
    native.program = async (run, onOutput) => {
      const real = `/private${CACHE_DIR}/${run.folder}`
      onOutput({ stream: 'stderr', text: `cwd ${real}, state in /private${APP_DIR}/apps/notes/state.json\n` })
      onOutput({ stream: 'stdout', text: protocolLine({ type: 'result', text: `wrote ${CACHE_DIR}/${run.folder}/output/sheet.png with ${APP_DIR}/apps/notes/lib/draw.ts` }) })
      return ENDED
    }

    const outcome = await runJob(invoke({ inputs: '@a' }))

    const folder = deletedWorkFolder()
    expect(runDescription(folder)).toMatchObject({
      main: `file://${APP_DIR}/apps/notes/main.ts`,
      inputs: [{ id: 'a', path: `${CACHE_DIR}/${folder}/a.jpg` }],
      outputFolder: `${CACHE_DIR}/${folder}/output`,
      appFolder: `${APP_DIR}/apps/notes`,
    })
    expect(outcome.text).toContain('wrote /run/output/sheet.png with /apps/notes/lib/draw.ts')
    expect(outcome.text).toContain('cwd /run, state in /apps/notes/state.json')
    expect(outcome.text).not.toContain('/home/u')
  })

  it('gives the error of the code with the files of the app as the apps tool names them, and keeps no file of the run', async () => {
    native.program = writes('stdout', protocolLine({ type: 'error', text: `Error: no rows\n    at main (file://${APP_DIR}/apps/notes/main.ts:2:9)` }))
    outputFolderHolds({ 'sheet.png': PNG_BYTES })

    const outcome = await runJob()

    expect(outcome).toMatchObject({ isError: true, assets: [] })
    expect(outcome.text).toContain('Error: no rows\n    at main (file:///apps/notes/main.ts:2:9)')
    expect(outputListings).toBe(0)
    expect(stored()).toStrictEqual([])
    deletedWorkFolder()
  })

  // Rust finds the folder of a built-in app in the files that Dez ships by
  // its name, and a model knows it as /apps/<name> too.
  it('runs a built-in app from the files that Dez ships, and gives its paths as the apps tool names them', async () => {
    const app = `${RESOURCE_DIR}/builtin-apps/dez-beats`
    native.program = writes('stdout', protocolLine({ type: 'error', text: `Error: no rows\n    at main (file://${app}/main.ts:2:9)` }))

    const outcome = await runJob(invoke({ name: 'dez-beats' }))

    expect(runDescription(deletedWorkFolder())).toMatchObject({ main: `file://${app}/main.ts`, appFolder: app })
    expect(native.runs[0].run).toMatchObject({ builtInApp: 'dez-beats' })
    expect(native.runs[0].run).not.toHaveProperty('appFolder')
    expect(outcome.text).toContain('at main (file:///apps/dez-beats/main.ts:2:9)')
    expect(outcome.text).not.toContain(RESOURCE_DIR)
  })

  it('downloads a clip that is only at the address of its provider into the work folder', async () => {
    await runJob(invoke({ inputs: '@d' }))

    const folder = deletedWorkFolder()
    expect(native.downloads.map(({ file }) => file)).toStrictEqual([{ root: 'cache', path: `${folder}/d.webm` }])
    expect(native.runs[0].run.inputs).toStrictEqual([])
    expect(runDescription(folder).inputs).toStrictEqual([{ id: 'd', kind: 'video', type: 'video/webm', path: `${CACHE_DIR}/${folder}/d.webm` }])
  })

  // A linked file is outside the Dez folders: the code gets a copy under a
  // neutral name, and nothing that goes to the provider tells its name.
  it('gives a linked image of a user section as a copy, and no text of the run holds its path', async () => {
    const linked = '/home/u/Pictures/private-name.png'
    const call = invoke({ inputs: '@a' }, [user('u1', `![id=a](${linked})`)])
    native.program = async (run, onOutput) => {
      onOutput({ stream: 'stdout', text: protocolLine({ type: 'result', text: `read ${CACHE_DIR}/${run.folder}/a.png` }) })
      return ENDED
    }

    const outcome = await runJob(call)

    const folder = deletedWorkFolder()
    expect(native.runs[0].run.inputs).toStrictEqual([{ name: 'a.png', source: linked }])
    expect(outcome.text).toBe('read /run/a.png')
    for (const text of [JSON.stringify(runDescription(folder)), invokeInputsText(call.inputs, 'script'), outcome.text]) expect(text).not.toContain('private-name')
  })

  it('runs no program for an image that Dez cannot read', async () => {
    native.fileSize = () => null

    expect(await refusalOf(runJob(invoke({ inputs: '@a' })))).toBe(unreadableImageText('a'))
    expect(native.runs).toStrictEqual([])
    deletedWorkFolder()
  })

  it('stores a copy of each output file under the type that its bytes tell, in the order of the names', async () => {
    native.program = returns('done')
    outputFolderHolds({ 'voice.dat': WAV_BYTES, 'sheet_10.png': PNG_BYTES, 'sheet_2.txt': PNG_BYTES })

    const outcome = await runJob()

    const folder = deletedWorkFolder()
    expect(native.readFiles).toStrictEqual(['sheet_2.txt', 'sheet_10.png', 'voice.dat'].map((name) => ({ root: 'cache', path: `${folder}/output/${name}` })))
    // A copy of the bytes that Dez checked, and no move: the code could
    // have put another file at the place of a checked one.
    expect(native.moves).toStrictEqual([])
    expect(stored().map(({ path, content }) => [path.replace(FILE_ID, '<id>'), content])).toStrictEqual([
      ['assets/generated/images/<id>.png', PNG_BYTES],
      ['assets/generated/images/<id>.png', PNG_BYTES],
      ['assets/generated/audio/<id>.wav', WAV_BYTES],
    ])
    const [first, second, third] = stored().map(({ path }) => `${APP_DIR}/${path}`)
    expect(outcome.assets).toStrictEqual([
      { kind: 'image', path: first },
      { kind: 'image', path: second },
      { kind: 'clip', clip: { kind: 'audio', type: 'audio/wav', src: third, url: null, expires: null } },
    ])
    // Until the result names a file, only this list keeps it from Delete
    // Unreferenced Files.
    expect(keptAssets).toStrictEqual(outcome.assets)
    expect(outcome.isError).toBe(false)
    expect(outcome.text).toContain('sheet_2.txt (image), sheet_10.png (image), voice.dat (audio clip)')
  })

  it('keeps no entry that is no file of a type that Dez stores, reads none that the listing rules out, and tells of each', async () => {
    native.program = returns('done')
    outputFolderHolds({ 'frames': null, 'empty.png': new Uint8Array(), 'notes.png': TEXT, 'sheet.png': PNG_BYTES, 'gone.png': PNG_BYTES })
    const read = native.fileBytes
    native.fileBytes = (file) => {
      if (file.path.endsWith('/gone.png')) throw new Error(`Failed to read ${CACHE_DIR}/${file.path}: not a regular file`)
      return read(file)
    }

    const outcome = await runJob()

    const folder = deletedWorkFolder()
    expect(native.readFiles.map(({ path }) => path)).toStrictEqual(['gone.png', 'notes.png', 'sheet.png'].map((name) => `${folder}/output/${name}`))
    expect(stored().map(({ content }) => content)).toStrictEqual([PNG_BYTES])
    expect(outcome.assets).toHaveLength(1)
    expect(outcome.isError).toBe(false)
    for (const fragment of ['sheet.png (image)', 'frames/ (a folder', 'empty.png (it is empty)', 'notes.png (Dez stores no file of its type)', 'gone.png (Dez could not read it)']) {
      expect(outcome.text).toContain(fragment)
    }
    expect(outcome.text).not.toContain('/home/u')
    expect(consoleError).toHaveBeenCalledWith('Failed to read the output file gone.png of a run of an app:', expect.any(Error))
  })

  it('keeps no file of a run that left more files than Dez keeps, and still gives the value', async () => {
    native.program = returns('made 30 frames')
    outputFolderHolds(Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`frame_${index}.png`, PNG_BYTES])))

    const outcome = await runJob()

    expect(outcome).toMatchObject({ isError: true, assets: [] })
    expect(outcome.text).toContain('30 files')
    expect(outcome.text).toContain('made 30 frames')
    expect(native.readFiles).toStrictEqual([])
    expect(stored()).toStrictEqual([])
  })

  // The code ended before the encode started, so the clip at its place in
  // the run folder is the one that ffmpeg made: Dez moves it, with no read.
  it('encodes a frame sequence into one clip with ffmpeg, moves the clip into the Dez folder, and keeps it in the order of the names', async () => {
    native.program = returns('drew 3 frames')
    outputFolderHolds({ 'a.png': PNG_BYTES, ...frameFolder('intro.frames', { fps: 24, width: 64, height: 36, count: 3 }, 3) })
    encodesClip({ frames: 3 })

    const outcome = await runJob(invoke({ timeout_seconds: 20 }))

    const folder = deletedWorkFolder()
    const [encode, ...more] = ffmpegRuns()
    const clip = encode.args.at(-1) ?? ''
    expect(more).toStrictEqual([])
    expect(clip).toMatch(/^[0-9a-f-]{36}\.mp4$/)
    expect(encode).toMatchObject({
      folder,
      args: frameEncodeArgs('output/intro.frames', { fps: 24, width: 64, height: 36, count: 3, alpha: false, format: 'png' }, clip),
      inputs: [],
      timeoutMs: 20_000,
    })
    // Dez reads the frames.json of a sequence, and none of its frames.
    expect(native.readFiles.map(({ path }) => path)).toStrictEqual([`${folder}/output/a.png`, `${folder}/output/intro.frames/frames.json`])
    expect(native.moves).toStrictEqual([{ from: { root: 'cache', path: `${folder}/${clip}` }, to: { root: 'app', path: expect.stringMatching(/^assets\/generated\/video\/[0-9a-f-]{36}\.mp4$/) } }])
    const [image] = stored().map(({ path }) => `${APP_DIR}/${path}`)
    expect(outcome.assets).toStrictEqual([
      { kind: 'image', path: image },
      { kind: 'clip', clip: { kind: 'video', type: 'video/mp4', src: `${APP_DIR}/${native.moves[0].to.path}`, url: null, expires: null } },
    ])
    expect(keptAssets).toStrictEqual(outcome.assets)
    expect(states).toStrictEqual([PROGRAM_READS_INPUTS, APP_RUNS_STATE, FRAMES_ENCODE_STATE])
    expect(outcome.isError).toBe(false)
    expect(outcome.text).toContain('Dez keeps 2 files of the output folder: a.png (image), intro.frames/ (video clip: 3 frames, H.264 in MP4).')
  })

  it('runs no ffmpeg for a frame sequence that does not match its frames.json, and tells why it kept no clip', async () => {
    native.program = returns('done')
    outputFolderHolds(frameFolder('intro.frames', { fps: 24, width: 64, height: 36, count: 3 }, 2))
    encodesClip({ frames: 3 })

    const outcome = await runJob()

    expect(ffmpegRuns()).toStrictEqual([])
    expect(outcome).toMatchObject({ isError: false, assets: [] })
    expect(outcome.text).toContain('Dez did not keep intro.frames/ (its frames.json gives 3 frames, and the frame 000002.png is missing')
    deletedWorkFolder()
  })

  // ffmpeg leaves out a PNG frame that it cannot read, with no error.
  it('keeps no clip of an encode that left out a frame', async () => {
    native.program = returns('done')
    outputFolderHolds(frameFolder('glow.frames', { fps: 24, width: 64, height: 36, count: 3, alpha: true }, 3))
    encodesClip({ frames: 2 })

    const outcome = await runJob()

    expect(ffmpegRuns()[0].args.at(-1)).toMatch(/\.mov$/)
    expect(native.moves).toStrictEqual([])
    expect(outcome).toMatchObject({ isError: false, assets: [] })
    expect(outcome.text).toContain('Dez did not keep glow.frames/ (ffmpeg encoded 2 of its 3 frames: a frame is no PNG file that ffmpeg can read).')
    deletedWorkFolder()
  })

  it('keeps no clip of an encode that failed, and tells the last line of its error with no path', async () => {
    native.program = returns('done')
    outputFolderHolds(frameFolder('intro.frames', { fps: 24, width: 64, height: 36, count: 3 }, 3))
    const errors = `[image2 @ 0xffff8a444870] Could find no file with path '${CACHE_DIR}/w/output/intro.frames/%06d.png'\n`
    encodesClip({ frames: 0, size: null, end: { kind: 'exited', code: 254 }, errors })

    const outcome = await runJob()

    expect(native.moves).toStrictEqual([])
    expect(outcome).toMatchObject({ isError: false, assets: [] })
    expect(outcome.text).toContain('Dez did not keep intro.frames/ (ffmpeg could not encode it: Could find no file with path ')
    expect(outcome.text).not.toContain(CACHE_DIR)
    expect(outcome.text).not.toContain('0xffff')
    expect(consoleError).toHaveBeenCalledWith('ffmpeg could not encode the frame sequence intro.frames of a run of an app:', { kind: 'exited', code: 254 }, errors)
    deletedWorkFolder()
  })

  it('keeps no file of a run whose encode did not end within the time limit, and gives the text of the limit', async () => {
    native.program = returns('done')
    outputFolderHolds({ 'a.png': PNG_BYTES, ...frameFolder('intro.frames', { fps: 24, width: 64, height: 36, count: 3 }, 3) })
    encodesClip({ frames: 1, end: { kind: 'timedOut' } })

    const refusal = await refusalOf(runJob(invoke({ timeout_seconds: 20 })))

    expect(refusal).toBe(INVOKE_RUN_TEXTS.timedOut(20_000, FRAMES_ENCODE_STATE))
    expect(stored()).toHaveLength(1)
    expect(deletedImages).toStrictEqual(stored().map(({ path }) => `${APP_DIR}/${path}`))
    expect(native.moves).toStrictEqual([])
    deletedWorkFolder()
  })

  it('keeps none of the files when one does not go into the Dez folder', async () => {
    native.program = returns('done')
    outputFolderHolds({ 'a.png': PNG_BYTES, 'b.wav': WAV_BYTES })
    const failure = new Error(`${APP_DIR}: the disk is full`)
    native.saveAppFile = async (file) => {
      if (file.root === 'app' && file.path.endsWith('.wav')) throw failure
    }

    const refusal = await refusalOf(runJob())

    expect(refusal).toBe(appOutputNotStoredText('apps'))
    expect(deletedImages).toStrictEqual(stored().map(({ path }) => `${APP_DIR}/${path}`))
    expect(deletedImages).toHaveLength(1)
    expect(deletedClips).toStrictEqual([])
    expect(consoleError).toHaveBeenCalledWith('Failed to store the output files of a run of an app:', failure)
    deletedWorkFolder()
  })

  it('tells the model when Dez could not list the output folder, with no path', async () => {
    native.program = returns('done')
    native.fileTree = (file) => {
      if (isOutputFolder(file)) throw new Error(`Failed to list ${CACHE_DIR}/${file.path}: Input/output error (os error 5)`)
      return { kind: 'missing', size: 0, updatedAt: null, entries: [], more: false }
    }

    const refusal = await refusalOf(runJob())

    expect(refusal).toBe(appOutputNotStoredText('apps'))
    expect(refusal).not.toContain('/home/u')
    deletedWorkFolder()
  })

  it('deletes the files that it stored at a stop of the job, and rejects with the stop', async () => {
    const stop = new AbortController()
    native.program = returns('done')
    outputFolderHolds({ 'a.png': PNG_BYTES, 'b.png': PNG_BYTES })
    native.saveAppFile = async (file) => {
      if (file.root === 'app') stop.abort(STOP)
    }

    const error = await failureOf(runJob(invoke(), stop.signal))

    expect(error).toBe(STOP)
    expect(stored()).toHaveLength(1)
    expect(deletedImages).toStrictEqual([`${APP_DIR}/${stored()[0].path}`])
    deletedWorkFolder()
  })

  it('stops the program at a stop of the job, and rejects with the stop when the program is gone', async () => {
    const stop = new AbortController()
    let end: (end: BundledToolEnd) => void = () => {}
    native.program = () => new Promise((resolve) => { end = resolve })
    outputFolderHolds({ 'a.png': PNG_BYTES })

    const work = failureOf(runJob(invoke(), stop.signal))
    await vi.waitFor(() => expect(native.runs).toHaveLength(1))
    stop.abort(STOP)

    expect(native.cancelledRuns).toStrictEqual([native.runs[0].runId])
    // The program can still write into the folder.
    expect(native.deletedFiles).toStrictEqual([])

    end({ kind: 'cancelled' })

    expect(await work).toBe(STOP)
    expect(deletedWorkFolder()).toBe(native.runs[0].run.folder)
    expect(stored()).toStrictEqual([])
  })

  it('gives the text of the time limit for a run that the backend stopped at it, and keeps no file', async () => {
    native.program = async () => ({ kind: 'timedOut' })
    outputFolderHolds({ 'a.png': PNG_BYTES })

    const outcome = await runJob(invoke({ timeout_seconds: 20 }))

    expect(outcome).toStrictEqual({ text: jobTimedOutText(20_000, APP_RUNS_STATE), isError: true, assets: [] })
    expect(outputListings).toBe(0)
    deletedWorkFolder()
  })

  // Without the real path of a folder, a text of the run could show the
  // model a path of the user's computer.
  it('runs no program when Dez cannot get the real path of a folder of the run', async () => {
    const failure = new Error(`${APP_DIR}/apps: No such file or directory (os error 2)`)
    native.canonicalPath = (path) => {
      if (path.endsWith('/apps')) throw failure
      return path
    }

    const refusal = await refusalOf(runJob())

    expect(refusal).toBe(programNotStartedText('deno', 'apps'))
    expect(native.runs).toStrictEqual([])
    expect(consoleError).toHaveBeenCalledWith('Failed to get the real path of a folder of a Deno run:', failure)
    deletedWorkFolder()
  })

  it('runs no program when Dez cannot make the output folder', async () => {
    native.createFolder = async () => { throw new Error(`${CACHE_DIR}: Permission denied (os error 13)`) }

    const refusal = await refusalOf(runJob())

    expect(refusal).toBe(programNotStartedText('deno', 'apps'))
    expect(native.runs).toStrictEqual([])
  })

  // The tool calls of the code (`AppRunBridge`), on the real runners of the
  // tools: the image tool, on the stubs of the images.
  describe('with the tool calls of the code', () => {
    let jobs: TabJobs

    beforeEach(() => {
      jobs = new TabJobs()
    })

    afterEach(() => jobs.stopAll())

    function runToolJob(signal: AbortSignal = running()) {
      const tools = { context: callContext({ jobs, sections: () => CONVERSATION }), jobs }
      return runAppJob(invoke(), { toolName: 'apps', texts: INVOKE_RUN_TEXTS }, CONVERSATION_ID, signal, (state) => states.push(state), (asset) => keptAssets.push(asset), tools)
    }

    // The answers to the calls of the code, as the program got them.
    const answers = () => native.inputWrites.map(({ text }) => JSON.parse(text) as { id: number, text: string, isError: boolean })

    it('keeps the assets of the calls after the files of the output folder, with their handles, and the program gets the answers on its input', async () => {
      native.program = callingProgram([FLIP_A, { selector: 'dez.tools/image/flip', arguments: { image: '&1', direction: 'vertical' } }], { type: 'result', text: 'flipped' })
      outputFolderHolds({ 'sheet.png': PNG_BYTES })

      const outcome = await runToolJob()

      expect(native.runs[0].run.stdin).toBe(true)
      // The code knows each new image by its handle, not by an id.
      expect(answers().map(({ text, isError }) => [[...new Set(text.match(/@&?\w+/g))].sort(), isError]))
        .toStrictEqual([[['@&1', '@a'], false], [['@&1', '@&2'], false]])
      expect(readImages).toStrictEqual([RED, drawnImage(1)])
      const made = [
        { kind: 'image', path: drawnImage(1), tool: 'image', handle: '&1' },
        { kind: 'image', path: drawnImage(2), tool: 'image', handle: '&2' },
      ]
      expect(outcome.assets).toStrictEqual([{ kind: 'image', path: `${APP_DIR}/${stored()[0].path}` }, ...made])
      expect(keptAssets).toStrictEqual(expect.arrayContaining(made))
      expect(outcome.text).toContain('Dez keeps the 2 assets that the tool calls of the code made: &1 (image), &2 (image).')
    })

    it('keeps the assets of the calls of code that failed', async () => {
      native.program = callingProgram([FLIP_A], { type: 'error', text: 'Error: no rows' })

      const outcome = await runToolJob()

      expect(outcome.isError).toBe(true)
      expect(outcome.assets).toStrictEqual([{ kind: 'image', path: drawnImage(1), tool: 'image', handle: '&1' }])
      expect(outcome.text).toContain('Dez keeps the asset that a tool call of the code made: &1 (image).')
      expect(deletedImages).toStrictEqual([])
    })

    it('deletes the assets of the calls of a run that timed out', async () => {
      const calls = callingProgram([FLIP_A])
      native.program = async (run, onOutput) => {
        await calls(run, onOutput)
        return { kind: 'timedOut' }
      }

      const outcome = await runToolJob()

      expect(outcome).toStrictEqual({ text: jobTimedOutText(invoke().timeoutMs, APP_RUNS_STATE), isError: true, assets: [] })
      expect(deletedImages).toStrictEqual([drawnImage(1)])
    })

    it('deletes the assets of the calls at a stop of the job, and rejects with the stop', async () => {
      const stop = new AbortController()
      let end: ((end: BundledToolEnd) => void) | undefined
      const calls = callingProgram([FLIP_A])
      native.program = async (run, onOutput) => {
        await calls(run, onOutput)
        return await new Promise((resolve) => { end = resolve })
      }

      const work = failureOf(runToolJob(stop.signal))
      await vi.waitFor(() => expect(end).toBeDefined())
      stop.abort(STOP)
      end?.({ kind: 'cancelled' })

      expect(await work).toBe(STOP)
      expect(deletedImages).toStrictEqual([drawnImage(1)])
    })
  })

  describe('with a decode', () => {
    const DECODE = { audio: { rate: 8000 }, frames: { width: 12, height: 9 } }
    // The probe output of each clip by the name of its copy: @b has only
    // sound, @c only a picture (5 frames a second).
    const PROBES: Record<string, string> = { 'b.wav': probeOutput([OPUS]), 'c.webm': probeOutput([VP9]) }
    // The sizes of the files of the work folder after the decode runs.
    let folderSizes: Record<string, number> = {}
    // How each ffmpeg run ends, and what it writes as errors.
    let decodeEnd: BundledToolEnd = ENDED
    let decodeErrors = ''

    const runTools = () => native.runs.map(({ run }) => run.tool)

    beforeEach(() => {
      folderSizes = { 'b.f32': 64_000, 'c.rgb': 3240 }
      decodeEnd = ENDED
      decodeErrors = ''
      native.folderEntries = (file) => file.root === 'cache' ? Object.entries(folderSizes).map(([name, size]) => ({ name, updatedAt: 0, size })) : null
      native.program = async (run, onOutput) => {
        if (run.tool === 'dez-ffprobe') {
          onOutput({ stream: 'stdout', text: PROBES[run.args.at(-1) ?? ''] ?? '' })
          return ENDED
        }
        if (run.tool === 'dez-ffmpeg') {
          onOutput({ stream: 'stderr', text: decodeErrors })
          return decodeEnd
        }
        return returns('done')(run, onOutput)
      }
    })

    it('decodes each clip into the run folder before the code runs, gives the code the facts of the files, and gives the run no clip again', async () => {
      const outcome = await runJob(invoke({ inputs: '@a @c @b', decode: DECODE, timeout_seconds: 20 }))

      const folder = deletedWorkFolder()
      expect(outcome).toStrictEqual({ text: 'done', isError: false, assets: [] })
      expect(states).toStrictEqual([PROGRAM_READS_INPUTS, APP_DECODES_STATE, APP_RUNS_STATE])
      // Each later clip gets what is left of the most bytes of a run.
      expect(native.runs.map(({ run }) => [run.tool, run.args, run.inputs, run.timeoutMs])).toStrictEqual([
        ['dez-ffprobe', assetProbeArgs('c.webm'), [{ name: 'c.webm', source: FILM.src }], FFPROBE_TIMEOUT_MS],
        ['dez-ffmpeg', clipDecodeArgs('c.webm', { audio: null, frames: { name: 'c.rgb', width: 12, height: 9, fps: null, fileFps: 5 } }, APP_RUN_MAX_DECODED_BYTES), [], 20_000],
        ['dez-ffprobe', assetProbeArgs('b.wav'), [{ name: 'b.wav', source: SONG.src }], FFPROBE_TIMEOUT_MS],
        ['dez-ffmpeg', clipDecodeArgs('b.wav', { audio: { name: 'b.f32', rate: 8000 }, frames: null }, APP_RUN_MAX_DECODED_BYTES - 3240), [], 20_000],
        ['dez-deno', [JS_EVAL_RUNNER_FILE], [{ name: 'a.jpg', source: RED }], 20_000],
      ])
      expect(runDescription(folder).inputs).toStrictEqual([
        { id: 'a', kind: 'image', type: 'image/jpeg', path: `${CACHE_DIR}/${folder}/a.jpg` },
        {
          id: 'c', kind: 'video', type: 'video/webm', path: `${CACHE_DIR}/${folder}/c.webm`,
          audio: null, frames: { path: `${CACHE_DIR}/${folder}/c.rgb`, width: 12, height: 9, fps: 5, count: 10 },
        },
        {
          id: 'b', kind: 'audio', type: 'audio/wav', path: `${CACHE_DIR}/${folder}/b.wav`,
          audio: { path: `${CACHE_DIR}/${folder}/b.f32`, rate: 8000, count: 16_000 }, frames: null,
        },
      ])
    })

    it('runs no ffmpeg for a clip that has none of the streams that the decode asks for', async () => {
      await runJob(invoke({ inputs: '@b', decode: { frames: { width: 12, height: 9 } } }))

      const folder = deletedWorkFolder()
      expect(runTools()).toStrictEqual(['dez-ffprobe', 'dez-deno'])
      expect(runDescription(folder).inputs).toStrictEqual([{ id: 'b', kind: 'audio', type: 'audio/wav', path: `${CACHE_DIR}/${folder}/b.wav`, frames: null }])
    })

    it('does not run the code when the decoded files are larger than the most bytes of a run together', async () => {
      folderSizes = { 'c.rgb': APP_RUN_MAX_DECODED_BYTES - 100, 'b.f32': 200 }

      const refusal = await refusalOf(runJob(invoke({ inputs: '@c @b', decode: DECODE })))

      expect(refusal).toBe(DECODED_TOO_LARGE_TEXT)
      expect(runTools()).toStrictEqual(['dez-ffprobe', 'dez-ffmpeg', 'dez-ffprobe', 'dez-ffmpeg'])
      expect(native.runs[3].run.args).toStrictEqual(expect.arrayContaining(['-fs', '101']))
      deletedWorkFolder()
    })

    it('tells of a decode that failed with the whole lines of the end of the error output, with no path, and does not run the code', async () => {
      decodeEnd = { kind: 'exited', code: 1 }
      // ffmpeg names its input by the relative name that Dez gives it.
      decodeErrors = `${'x'.repeat(1200)}\nc.webm: Invalid data found when processing input\nError opening input file ${CACHE_DIR}/work/w1/c.webm.\n`

      const refusal = await refusalOf(runJob(invoke({ inputs: '@c', decode: DECODE })))

      expect(refusal).toContain(decodeFailedText({ kind: 'video', id: 'c' }))
      expect(refusal).toContain('ffmpeg ended with the error code 1. The end of its error output:\n')
      expect(refusal).toContain('c.webm: Invalid data found when processing input')
      expect(refusal).not.toContain('/home/u')
      expect(refusal).not.toContain('xxx')
      expect(runTools()).toStrictEqual(['dez-ffprobe', 'dez-ffmpeg'])
      expect(consoleError).toHaveBeenCalled()
      deletedWorkFolder()
    })

    it('tells of a clip that ffprobe could not read, and runs no decode', async () => {
      const refusal = await refusalOf(runJob(invoke({ inputs: '@d', decode: DECODE })))

      expect(refusal).toContain(decodeFailedText({ kind: 'video', id: 'd' }))
      expect(refusal).toContain(DECODE_NOT_PROBED_DETAILS)
      expect(runTools()).toStrictEqual(['dez-ffprobe'])
      deletedWorkFolder()
    })

    it('gives the text of the time limit for a decode that the backend stopped at it', async () => {
      decodeEnd = { kind: 'timedOut' }

      const refusal = await refusalOf(runJob(invoke({ inputs: '@c', decode: DECODE, timeout_seconds: 20 })))

      expect(refusal).toBe(jobTimedOutText(20_000, APP_DECODES_STATE))
      expect(runTools()).toStrictEqual(['dez-ffprobe', 'dez-ffmpeg'])
      deletedWorkFolder()
    })
  })
})

// The run of the page of a UI app, on a stub of the frame: the tests tell
// what a page reads, and what Dez keeps of what it saved.
describe('runAppFrameJob', () => {
  it('gives the frame the app, the parameters, and the inputs with no path, and runs no program', async () => {
    page = async (run) => {
      run.onRuns()
      return returned('done')
    }

    const outcome = await runFrameJob(uiCall({ parameters: { columns: 4 }, inputs: '@a @c' }))

    expect(frameRuns).toHaveLength(1)
    expect(frameRuns[0].name).toBe('notes')
    expect(frameRuns[0].parameters).toStrictEqual({ columns: 4 })
    expect(frameRuns[0].inputs).toStrictEqual([{ id: 'a', kind: 'image', type: 'image/jpeg' }, { id: 'c', kind: 'video', type: 'video/webm' }])
    expect(states).toStrictEqual([APP_PAGE_LOADS_STATE, APP_RUNS_STATE])
    expect(outcome).toStrictEqual({ text: 'done', isError: false, assets: [] })
    expect(native.runs).toStrictEqual([])
    expect(native.createdFolders).toStrictEqual([])
  })

  it('keeps the files that the page saved as the assets of the job, in the order of the saves', async () => {
    let answers: SavedAssetAnswer[] = []
    // The first write is the slow one.
    native.saveAppFile = async (file) => {
      if (file.path.endsWith('.png')) await new Promise((resolve) => setTimeout(resolve, 5))
    }
    page = async (run) => {
      answers = await Promise.all([save(run, PNG_BYTES), save(run, WAV_BYTES)])
      return returned('2 files')
    }

    const outcome = await runFrameJob()

    // An asset of a job has no id until a reader takes the result.
    expect(answers).toStrictEqual([{ id: null, kind: 'image', type: 'image/png' }, { id: null, kind: 'audio', type: 'audio/wav' }])
    expect(stored().map(({ path, content }) => [path.replace(FILE_ID, '<id>'), content])).toStrictEqual([
      ['assets/generated/images/<id>.png', PNG_BYTES],
      ['assets/generated/audio/<id>.wav', WAV_BYTES],
    ])
    const [first, second] = stored().map(({ path }) => `${APP_DIR}/${path}`)
    expect(outcome.assets).toStrictEqual([
      { kind: 'image', path: first },
      { kind: 'clip', clip: { kind: 'audio', type: 'audio/wav', src: second, url: null, expires: null } },
    ])
    // Until the result names a file, only this list keeps it from Delete
    // Unreferenced Files.
    expect(keptAssets).toStrictEqual(outcome.assets)
    expect(outcome.isError).toBe(false)
    expect(outcome.text).toContain('2 files')
    expect(outcome.text).toContain('in the order of the saves: image, audio clip')
    expect(outcome.text).not.toContain('/home/u')
  })

  // A linked file is outside the Dez folders: the page gets its bytes, and
  // nothing that goes to the page or to the provider tells its name.
  it('gives an input of the call as a Blob with no name, also of a linked file, and no other asset', async () => {
    const linked = '/home/u/Pictures/private-name.png'
    const call = uiCall({ inputs: '@a' }, [user('u1', `![id=a](${linked})\n![id=e](${SKY})`)])
    let blob: Blob | undefined
    let refused: unknown
    page = async (run) => {
      blob = await read(run, 'a')
      refused = await failureOf(read(run, 'e'))
      return returned(`${blob.size} bytes`)
    }

    const outcome = await runFrameJob(call)

    expect(readImages).toStrictEqual([linked])
    expect(blob).not.toBeInstanceOf(File)
    expect(blob?.type).toBe('image/png')
    expect(new Uint8Array(await (blob as Blob).arrayBuffer())).toStrictEqual(PNG_BYTES)
    expect(refused).toBeInstanceOf(AppCallError)
    expect((refused as Error).message).toBe(notAnInputText('e', call.inputs))
    expect(outcome.text).toBe(`${PNG_BYTES.length} bytes`)
    for (const text of [JSON.stringify(frameRuns[0].inputs), invokeInputsText(call.inputs, 'ui'), (refused as Error).message, outcome.text]) expect(text).not.toContain('private-name')
  })

  it.each<[string, AppFrameEnd, string]>([
    ['whose handler threw', { kind: 'threw', error: 'Error: no rows\n    at dezapp://localhost/notes/main.js:2:9', log: '' }, 'Error: no rows\n    at /apps/notes/main.js:2:9'],
    ['whose page has no handler', { kind: 'unregistered', log: '' }, 'has no handler'],
    ['whose page did not answer', { kind: 'noClient' }, 'did not answer Dez'],
    ['whose page loaded again', { kind: 'navigated' }, 'loaded again'],
  ])('keeps no file of a run %s', async (_, end, fragment) => {
    page = async (run) => {
      await save(run, PNG_BYTES)
      await save(run, WAV_BYTES)
      return end
    }

    const outcome = await runFrameJob()

    expect(outcome).toMatchObject({ isError: true, assets: [] })
    expect(outcome.text).toContain(fragment)
    expect(outcome.text).not.toContain('dezapp:')
    const [image, clip] = stored().map(({ path }) => `${APP_DIR}/${path}`)
    expect(deletedImages).toStrictEqual([image])
    expect(deletedClips).toStrictEqual([clip])
  })

  it('deletes the files that it stored at a stop of the job, and rejects with the stop', async () => {
    const stop = new AbortController()
    // As the frame does: a stop closes it and rejects with the reason.
    page = async (run) => {
      await save(run, PNG_BYTES)
      stop.abort(STOP)
      throw run.signal.reason
    }

    const error = await failureOf(runFrameJob(uiCall(), stop.signal))

    expect(error).toBe(STOP)
    expect(stored()).toHaveLength(1)
    expect(deletedImages).toStrictEqual([`${APP_DIR}/${stored()[0].path}`])
  })

  // The page of a run that ended is closed, but a write that it started
  // can still end.
  it('keeps no file of a save that ends after the run ended', async () => {
    const write = heldStep()
    native.saveAppFile = () => write.wait
    let late: Promise<unknown> = Promise.resolve()
    page = async (run) => {
      late = failureOf(save(run, PNG_BYTES))
      return returned('done')
    }

    const outcome = await runFrameJob()
    write.finish()
    const error = await late

    expect(outcome).toStrictEqual({ text: 'done', isError: false, assets: [] })
    expect(keptAssets).toStrictEqual([])
    expect(error).toBeInstanceOf(AppCallError)
    expect((error as Error).message).toBe(APP_STOPPED_TEXT)
    expect(deletedImages).toStrictEqual([`${APP_DIR}/${stored()[0].path}`])
  })

  it('refuses the save after the most files of one run', async () => {
    let refused: unknown
    page = async (run) => {
      for (let count = 0; count < APP_RUN_MAX_OUTPUT_FILES; count += 1) await save(run, PNG_BYTES)
      refused = await failureOf(save(run, PNG_BYTES))
      return returned()
    }

    const outcome = await runFrameJob()

    expect(refused).toBeInstanceOf(AppCallError)
    expect((refused as Error).message).toContain(`at most ${APP_RUN_MAX_OUTPUT_FILES} files in one run`)
    expect(stored()).toHaveLength(APP_RUN_MAX_OUTPUT_FILES)
    expect(outcome.assets).toHaveLength(APP_RUN_MAX_OUTPUT_FILES)
  })

  it.each([
    ['bytes of a type that Dez does not store', TEXT, 'no file of a type that Dez stores'],
    ['a save with no bytes', new Uint8Array(), 'the save has no bytes'],
  ])('writes no file for %s', async (_, bytes, fragment) => {
    let refused: unknown
    page = async (run) => {
      refused = await failureOf(save(run, bytes))
      return returned('done')
    }

    const outcome = await runFrameJob()

    expect(refused).toBeInstanceOf(AppCallError)
    expect((refused as Error).message).toContain(fragment)
    expect(native.savedFiles).toStrictEqual([])
    expect(outcome).toStrictEqual({ text: 'done', isError: false, assets: [] })
  })

  it('tells the page of a write that failed, with no path, and keeps the files that it stored', async () => {
    const failure = new Error(`${APP_DIR}: the disk is full`)
    native.saveAppFile = async (file) => {
      if (file.path.endsWith('.wav')) throw failure
    }
    let refused: unknown
    page = async (run) => {
      await save(run, PNG_BYTES)
      refused = await failureOf(save(run, WAV_BYTES))
      return returned('done')
    }

    const outcome = await runFrameJob()

    expect(refused).toBeInstanceOf(SaveNotStoredError)
    expect((refused as Error).message).not.toContain('/home/u')
    expect(consoleError).toHaveBeenCalledWith('Failed to store a file that an app saved:', failure)
    expect(outcome.assets).toStrictEqual([{ kind: 'image', path: `${APP_DIR}/${stored()[0].path}` }])
  })
})

// The call as a model makes it, through the runner of the tools.
describe('apps invoke', () => {
  let jobs: TabJobs
  // What the reply got for the files of a job, and the ids that it gives.
  let written: unknown[] = []
  let newIds: string[]

  function tool(name: string, args: Record<string, unknown>): Promise<ToolRunResult> {
    const context = callContext({
      jobs,
      writeImage: (path, options) => {
        written.push({ path, ...options })
        return newIds.shift() ?? null
      },
      writeClip: (clip, options) => {
        written.push({ path: clip.src, ...options })
        return newIds.shift() ?? null
      },
    })
    return sbp('dez.controller/tools/run', { name, arguments: args }, running(), context) as Promise<ToolRunResult>
  }

  const invokeTool = (parameters: Record<string, unknown>) => tool('apps', { command: 'invoke', parameters: JSON.stringify({ name: 'notes', ...parameters }) })

  beforeEach(() => {
    jobs = new TabJobs()
    written = []
    newIds = ['g', 'h']
    tabSections = CONVERSATION
  })

  // Ends the time limits of the jobs that a test left.
  afterEach(() => jobs.stopAll())

  it('starts a job at once and tells its inputs; jobs_wait gives what the code returned and puts the output files into the reply', async () => {
    native.program = returns('2 rows')
    outputFolderHolds({ 'sheet.png': PNG_BYTES })
    fakeAppFiles(appFiles('notes', { 'main.ts': MAIN }))

    const started = await invokeTool({ parameters: { rows: 2 }, inputs: '@c @a' })

    const [job] = jobs.list()
    expect(started.isError).toBe(false)
    expect(started.content.split('\n')[0]).toBe(jobStartedText(job.id, 1))
    expect(started.content).toContain('the video clip @c, the image @a')
    // A compaction keeps an input of an open job (`openJobInputs`).
    expect(job.inputs).toStrictEqual(['c', 'a'])
    expect(job.tool).toBe('apps')

    const result = (await tool('jobs_wait', {})).content
    expect(result).toContain(`<job id="${job.id}" number="1" tool="apps" status="finished" call="invoke notes `)
    expect(result).toContain('2 rows')
    expect(result).toContain('Made the image @g.')
    expect(written).toStrictEqual([{ path: `${APP_DIR}/${stored()[0].path}`, tool: 'apps', madeBy: job.id }])
  })

  it('marks the files of a call with `is_intermediate` as hidden assets of its job', async () => {
    native.program = returns('done')
    outputFolderHolds({ 'voice.wav': WAV_BYTES })
    fakeAppFiles(appFiles('notes', { 'main.ts': MAIN }))

    await invokeTool({ is_intermediate: true })
    const [{ id }] = jobs.list()
    await tool('jobs_wait', {})

    expect(written).toStrictEqual([{ path: `${APP_DIR}/${stored()[0].path}`, tool: 'apps', madeBy: id, hidden: id }])
  })

  it('runs the tool calls of the code with the jobs of its job, and jobs_wait puts their assets into the reply with their tools and handles', async () => {
    native.program = callingProgram([FLIP_A, 'dez.tools/jobs_list'])
    fakeAppFiles(appFiles('notes', { 'main.ts': MAIN }))
    newIds = ['k']

    await invokeTool({})
    const [job] = jobs.list()
    const result = (await tool('jobs_wait', {})).content

    // The code sees no job that it did not start: not the job of its run.
    const listed = JSON.parse(native.inputWrites[1].text) as { text: string }
    expect(listed.text).not.toContain(job.id)
    expect(result).toContain('Dez keeps the asset that a tool call of the code made: &1 (image).')
    expect(result).toContain('Made the image @k (handle &1).')
    expect(written).toStrictEqual([{ path: drawnImage(1), tool: 'image', madeBy: job.id }])
  })

  it('runs the page of a UI app in a frame with no program, and puts the files that it saved into the reply', async () => {
    fakeAppFiles(appFiles('notes', { 'index.html': '<!doctype html>\n' }, 'ui'))
    page = async (run) => {
      await save(run, PNG_BYTES)
      return { kind: 'returned', value: 'drawn', log: 'a line of the page\n' }
    }

    const started = await invokeTool({ parameters: { rows: 2 }, inputs: '@a' })

    const [job] = jobs.list()
    expect(started.content.split('\n')[0]).toBe(jobStartedText(job.id, 1))
    expect(started.content).toContain('in the order of run.inputs: the image @a')

    const result = (await tool('jobs_wait', {})).content
    expect(frameRuns).toHaveLength(1)
    expect(frameRuns[0].parameters).toStrictEqual({ rows: 2 })
    expect(result).toContain('drawn')
    expect(result).toContain('a line of the page')
    expect(result).toContain('Made the image @g.')
    expect(written).toStrictEqual([{ path: `${APP_DIR}/${stored()[0].path}`, tool: 'apps', madeBy: job.id }])
    expect(native.runs).toStrictEqual([])
    expect(native.createdFolders).toStrictEqual([])
  })

  it('starts no job, no program, and no frame for an app that cannot run', async () => {
    fakeAppFiles(appFiles('notes', { 'main.ts': MAIN }, 'ui'))

    const result = await invokeTool({ inputs: '@a' })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('has no index.html')
    expect(jobs.list()).toStrictEqual([])
    expect(native.runs).toStrictEqual([])
    expect(frameRuns).toStrictEqual([])
    expect(native.createdFolders).toStrictEqual([])
  })
})

// A call of an alias subcommand of the `audio` or the `video` tool: one run
// of its built-in app, which the call waits for.
describe('the alias subcommands', () => {
  let jobs: TabJobs
  // What the reply got for the files of a call, and the ids that it gives.
  let written: unknown[] = []
  let newIds: (string | null)[]

  function tool(name: 'audio' | 'video', command: string, parameters: Record<string, unknown>): Promise<ToolRunResult> {
    const call = { name, arguments: { command, parameters: JSON.stringify(parameters) } }
    const context = callContext({
      jobs,
      writeImage: (path, options) => {
        written.push({ path, ...options })
        return newIds.shift() ?? null
      },
      writeClip: (clip, options) => {
        written.push({ path: clip.src, ...options })
        return newIds.shift() ?? null
      },
    })
    return sbp('dez.controller/tools/run', call, running(), context) as Promise<ToolRunResult>
  }

  // A program that runs until the test ends it with `end`.
  let end: (end: BundledToolEnd) => void = () => {}
  const heldProgram = (): Promise<BundledToolEnd> => new Promise((resolve) => { end = resolve })

  beforeEach(() => {
    jobs = new TabJobs()
    written = []
    newIds = ['g', 'h']
    tabSections = CONVERSATION
  })

  afterEach(() => {
    vi.useRealTimers()
    jobs.stopAll()
  })

  it('runs the built-in app of the alias on the clips of the call with the other arguments as parameters, waits for it, and gives what it returned', async () => {
    fakeAppFiles({}, builtInAppFiles('dez-sync', { 'main.ts': MAIN }))
    native.program = returns('@c: 3 cuts, all on the beat. In /work/sync-c-to-b.json.')

    const result = await tool('video', 'sync', { song: '@b', edit: '@c', offset: 0.5 })

    expect(result).toStrictEqual({ content: '@c: 3 cuts, all on the beat. In /work/sync-c-to-b.json.', isError: false })
    expect(runDescription(deletedWorkFolder())).toMatchObject({
      main: `file://${RESOURCE_DIR}/builtin-apps/dez-sync/main.ts`,
      parameters: { offset: 0.5 },
      inputs: [{ id: 'c', kind: 'video' }, { id: 'b', kind: 'audio' }],
      workFolder: `${APP_DIR}/${CONVERSATION_WORK_FOLDER}`,
    })
    expect(native.runs.map(({ run }) => run)).toMatchObject([{ tool: 'dez-deno', builtInApp: 'dez-sync', timeoutMs: ALIAS_TIMEOUT_MS, conversationFolder: CONVERSATION_ID }])
    expect(jobs.list()).toStrictEqual([])
  })

  it('tells the model of the tool and the call that it made when a run cannot start or a clip cannot be decoded', async () => {
    const manifest = JSON.stringify({ name: 'dez-onsets', description: 'Finds onsets.', kind: 'script', decode: { audio: { rate: 22050 } } })
    fakeAppFiles({}, builtInAppFiles('dez-onsets', { 'manifest.json': manifest, 'main.ts': MAIN }))
    native.program = async (run) => {
      if (run.tool === 'dez-deno') throw new Error('spawn failed')
      // ffprobe reads nothing of the clip.
      return ENDED
    }

    const undecoded = await tool('audio', 'onsets', { clips: '@b' })
    expect(undecoded.isError).toBe(true)
    expect(undecoded.content).toContain(aliasRunTexts(aliasOf('audio', 'onsets')).decodeFailed({ kind: 'audio', id: 'b' }))
    expect(native.runs.map(({ run }) => run.tool)).toStrictEqual(['dez-ffprobe'])
    deletedWorkFolder()

    fakeAppFiles({}, builtInAppFiles('dez-cuts', { 'main.ts': MAIN }))
    expect(await tool('video', 'cuts', { clips: '@c' })).toStrictEqual({ content: programNotStartedText('deno', 'video'), isError: true })
    deletedWorkFolder()
  })

  it('puts the files that Dez keeps of the run into the reply as assets of the call, and names each one in the result', async () => {
    outputFolderHolds({ 'title.png': PNG_BYTES, 'voice.wav': WAV_BYTES })
    fakeAppFiles({}, builtInAppFiles('dez-title', { 'main.ts': MAIN }))
    native.program = returns('The title "NEON CITY".')

    const result = await tool('video', 'title', { text: 'NEON CITY', duration: 2 })

    const [image, clip] = stored().map(({ path }) => `${APP_DIR}/${path}`)
    expect(result.isError).toBe(false)
    expect(result.content.startsWith('The title "NEON CITY".')).toBe(true)
    expect(result.content.endsWith('\nMade the image @g.\nMade the audio clip @h.')).toBe(true)
    // No job made them: no job id, and the tool of the call.
    expect(written).toStrictEqual([{ path: image }, { path: clip }])
    expect(jobs.list()).toStrictEqual([])
    expect(runDescription(deletedWorkFolder())).toMatchObject({ parameters: { text: 'NEON CITY', duration: 2 }, inputs: [] })
    expect(deletedImages).toStrictEqual([])
  })

  it('deletes the file of each asset that the reply takes no more, and tells that the call did not make it', async () => {
    outputFolderHolds({ 'title.png': PNG_BYTES, 'voice.wav': WAV_BYTES })
    fakeAppFiles({}, builtInAppFiles('dez-title', { 'main.ts': MAIN }))
    native.program = returns('The title "NEON CITY".')
    newIds = ['g', null]

    const result = await tool('video', 'title', { text: 'NEON CITY' })

    const [, clip] = stored().map(({ path }) => `${APP_DIR}/${path}`)
    expect(result.isError).toBe(true)
    expect(result.content.endsWith('\nMade the image @g.\nThe reply stopped before Dez could add the audio clip to it, so there is no new audio clip. This is not a fault of the call.')).toBe(true)
    expect(deletedImages).toStrictEqual([])
    expect(deletedClips).toStrictEqual([clip])
    deletedWorkFolder()
  })

  it('stops the program at the end of the time limit of the call, and gives the text of the limit', async () => {
    fakeAppFiles({}, builtInAppFiles('dez-beats', { 'main.ts': MAIN }))
    native.program = heldProgram
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const beats = aliasOf('audio', 'beats')

    const work = runAliasCall(beats, { clips: '@b' }, CONVERSATION, CONVERSATION_ID, callContext(), running())
    await vi.waitFor(() => expect(native.runs).toHaveLength(1))
    vi.advanceTimersByTime(ALIAS_TIMEOUT_MS)

    expect(native.cancelledRuns).toStrictEqual([native.runs[0].runId])
    end({ kind: 'cancelled' })
    expect(await work).toStrictEqual({ content: aliasRunTexts(beats).timedOut(ALIAS_TIMEOUT_MS, APP_RUNS_STATE), isError: true })
    deletedWorkFolder()
  })

  it('stops the program at a stop of the reply, and rejects with the stop', async () => {
    fakeAppFiles({}, builtInAppFiles('dez-beats', { 'main.ts': MAIN }))
    native.program = heldProgram
    const stop = new AbortController()

    const work = failureOf(runAliasCall(aliasOf('audio', 'beats'), { clips: '@b' }, CONVERSATION, CONVERSATION_ID, callContext(), stop.signal))
    await vi.waitFor(() => expect(native.runs).toHaveLength(1))
    stop.abort(STOP)

    expect(native.cancelledRuns).toStrictEqual([native.runs[0].runId])
    end({ kind: 'cancelled' })
    expect(await work).toBe(STOP)
    deletedWorkFolder()
  })
})
