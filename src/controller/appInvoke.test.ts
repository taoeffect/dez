import sbp from '@sbp/sbp'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { Section } from '../model/chat/types'
import { user } from '../model/streams/testing'
import { APP_READ_ASSET, APP_SAVE_ASSET, APP_STOPPED_TEXT, AppCallError, notAnInputText, SaveNotStoredError, type AppFrameEnd, type AppFrameRun, type SavedAssetAnswer } from '../model/tools/appBridge'
import { APP_PAGE_LOADS_STATE, APP_RUNS_STATE, appOutputNotStoredText, invokeCall, invokeInputsText, type CheckedInvokeCall } from '../model/tools/appInvoke'
import { MANIFEST_MAX_BYTES } from '../model/tools/appManifest'
import { APP_RUN_MAX_OUTPUT_FILES, APPS_MAX_ENTRIES } from '../model/tools/appsTool'
import { unreadableImageText } from '../model/tools/imageTool'
import { jobStartedText, jobTimedOutText } from '../model/tools/jobs'
import { JS_EVAL_OUTPUT_BYTES, JS_EVAL_RUNNER, JS_EVAL_RUNNER_FILE, RUN_DESCRIPTION_FILE } from '../model/tools/jsEval'
import { PROGRAM_READS_INPUTS, programNotStartedText } from '../model/tools/programRuns'
import { appsArgs, CONVERSATION, CONVERSATION_ID, FILM, PNG_BYTES, protocolLine, RED, SKY, textBytes, WAV_BYTES } from '../model/tools/testing'
import type { ToolRunResult } from '../model/tools/types'
import { checkedInvokeCall, runAppFrameJob, runAppJob } from './appInvoke'
import { TabJobs, type MadeAsset } from './jobs'
import type { AppFileRef, BundledToolEnd, FileTree } from './nativeTypes'
import {
  APP_DIR,
  appFiles,
  CACHE_DIR,
  callContext,
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

// Makes the output folder of a run hold `files` after the run: the bytes
// of each file by its name, and null for a folder. `more` tells that the
// folder holds more entries than its listing.
function outputFolderHolds(files: Record<string, Uint8Array | null>, more = false): void {
  native.fileTree = (file): FileTree => {
    if (!isOutputFolder(file)) return { kind: 'missing', size: 0, updatedAt: null, entries: [], more: false }
    outputListings += 1
    const entries = Object.entries(files).map(([path, bytes]) => ({ path, kind: bytes === null ? 'folder' as const : 'file' as const, size: bytes?.length ?? 0, updatedAt: 0 }))
    return { kind: 'folder', size: 0, updatedAt: 0, entries, more }
  }
  native.fileBytes = (file) => {
    const bytes = files[file.path.slice(file.path.lastIndexOf('/') + 1)]
    if (!bytes) throw new Error(`Failed to read ${CACHE_DIR}/${file.path}: not a regular file`)
    return bytes
  }
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

function invoke(parameters: Record<string, unknown> = {}, sections = CONVERSATION) {
  return invokeCall(appsArgs('invoke', { name: 'notes', ...parameters }), sections)
}

function runJob(call = invoke(), signal: AbortSignal = running()) {
  return runAppJob(call, CONVERSATION_ID, signal, (state) => states.push(state), (asset) => keptAssets.push(asset))
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
  page = async () => returned()
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  outputFolderHolds({})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('checkedInvokeCall', () => {
  const checked = (parameters: Record<string, unknown> = {}) => checkedInvokeCall(appsArgs('invoke', { name: 'notes', ...parameters }), CONVERSATION)

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
    })
    // The code of an app gets no input of the program.
    expect(run).not.toHaveProperty('stdin')
    expect(states).toStrictEqual([PROGRAM_READS_INPUTS, APP_RUNS_STATE])
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
    const app = `${RESOURCE_DIR}/builtin-apps/dez-media`
    native.program = writes('stdout', protocolLine({ type: 'error', text: `Error: no rows\n    at main (file://${app}/main.ts:2:9)` }))

    const outcome = await runJob(invoke({ name: 'dez-media' }))

    expect(runDescription(deletedWorkFolder())).toMatchObject({ main: `file://${app}/main.ts`, appFolder: app })
    expect(native.runs[0].run).toMatchObject({ builtInApp: 'dez-media' })
    expect(native.runs[0].run).not.toHaveProperty('appFolder')
    expect(outcome.text).toContain('at main (file:///apps/dez-media/main.ts:2:9)')
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

  it('keeps none of the files when one does not go into the Dez folder', async () => {
    native.program = returns('done')
    outputFolderHolds({ 'a.png': PNG_BYTES, 'b.wav': WAV_BYTES })
    const failure = new Error(`${APP_DIR}: the disk is full`)
    native.saveAppFile = async (file) => {
      if (file.root === 'app' && file.path.endsWith('.wav')) throw failure
    }

    const refusal = await refusalOf(runJob())

    expect(refusal).toBe(appOutputNotStoredText())
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

    expect(refusal).toBe(appOutputNotStoredText())
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
