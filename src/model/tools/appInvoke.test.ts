import { describe, expect, it } from 'vitest'
import { byteSizeText } from '../../utils/byteSize'
import { AppCallError } from './appBridge'
import { APP_KINDS, MANIFEST_MAX_BYTES } from './appManifest'
import {
  APP_OUTPUT_LISTED_ENTRIES,
  appFrameResult,
  appRunDescription,
  appRunOutcome,
  appRunResult,
  checkedOutput,
  checkInvokeTarget,
  checkSaveSize,
  fileUrl,
  frameInputs,
  invokeCall,
  invokeInputsText,
  invokeLabel,
  listedOutputs,
  NO_APP_OUTPUTS,
  SaveCount,
  savedFileType,
  type AppOutputs,
  type InvokeTarget,
} from './appInvoke'
import { APP_RUN_MAX_OUTPUT_BYTES, APP_RUN_MAX_OUTPUT_FILES } from './appsTool'
import { JS_EVAL_OUTPUT_BYTES, textForModel, type RunOutcome } from './jsEval'
import { appsArgs, CONVERSATION, fileTree, FOLDER_FACTS, folderTree, MISSING_TREE, notesManifest, PNG_BYTES, refusal, textBytes, WAV_BYTES } from './testing'

const NOT_STARTED = 'Dez started no job.'

function invoke(parameters: Record<string, unknown>) {
  return invokeCall(appsArgs('invoke', parameters), CONVERSATION)
}

describe('invokeCall', () => {
  it('names the app, its manifest, and its main file, with no parameters, no input, and the default time limit', () => {
    const call = invoke({ name: ' notes ' })

    expect([call.app.virtual, call.manifest.virtual, call.main.virtual]).toStrictEqual(['/apps/notes', '/apps/notes/manifest.json', '/apps/notes/main.ts'])
    expect(call.main.file).toBe('apps/notes/main.ts')
    expect(call.parameters).toStrictEqual({})
    expect(call.inputs).toStrictEqual([])
    expect(call.timeoutMs).toBe(300_000)
  })

  it('takes the parameters as the call gave them, and the time limit of the call', () => {
    const call = invoke({ name: 'notes', parameters: { title: 'Trip', sizes: [1, 2], deep: { on: true } }, timeout_seconds: 20 })

    expect(call.parameters).toStrictEqual({ title: 'Trip', sizes: [1, 2], deep: { on: true } })
    expect(call.timeoutMs).toBe(20_000)
  })

  it('gives each input once, in the order of the call, with a copy name that holds only the id and the type', () => {
    const { inputs } = invoke({ name: 'notes', inputs: '@c a, @f @c\n@b e' })

    expect(inputs.map(({ id, kind, name }) => [id, kind, name])).toStrictEqual([
      ['c', 'video', 'c.webm'],
      ['a', 'image', 'a.jpg'],
      ['f', 'image', 'f.svg'],
      ['b', 'audio', 'b.wav'],
      ['e', 'image', 'e.png'],
    ])
    expect(inputs.flatMap((input) => (input.kind === 'image' ? [input.type] : []))).toStrictEqual(['image/jpeg', 'image/svg+xml', 'image/png'])
  })

  it('takes a clip that is only at the address of its provider', () => {
    expect(invoke({ name: 'notes', inputs: '@d' }).inputs.map(({ id, name }) => [id, name])).toStrictEqual([['d', 'd.webm']])
  })

  it('refuses a name that is no name of an app', () => {
    for (const name of ['My App', '../notes', 'notes/main.ts', '']) {
      expect(refusal(() => invoke({ name, inputs: '@a' })), name).toContain('is no name for an app')
    }
  })

  it('refuses a word of `inputs` that is no id, and an id of no image and no clip', () => {
    const noId = refusal(() => invoke({ name: 'notes', inputs: '@a red.jpg' }))
    expect(noId).toContain('"red.jpg"')
    expect(noId).toContain(NOT_STARTED)

    const unknown = refusal(() => invoke({ name: 'notes', inputs: '@a @z @y' }))
    expect(unknown).toContain('@z, @y name no image and no clip')
    expect(unknown).toContain(NOT_STARTED)
  })

  it('refuses a time limit outside the range of a job', () => {
    expect(refusal(() => invoke({ name: 'notes', timeout_seconds: 5 }))).toContain('timeout_seconds')
  })
})

// What is at the paths of a script app that can run, with `changes`.
function target(changes: Partial<InvokeTarget> = {}): InvokeTarget {
  const manifestBytes = notesManifest('script')
  return { app: FOLDER_FACTS, manifest: { kind: 'file', size: manifestBytes.length }, manifestBytes, main: { kind: 'file', size: 120 }, index: MISSING_TREE, ...changes }
}

// What is at the paths of a UI app that can run, with `changes`.
function uiTarget(changes: Partial<InvokeTarget> = {}): InvokeTarget {
  return target({ manifestBytes: notesManifest('ui'), main: MISSING_TREE, index: { kind: 'file', size: 300 }, ...changes })
}

describe('checkInvokeTarget', () => {
  const call = invoke({ name: 'notes' })
  const check = (changes: Partial<InvokeTarget>) => refusal(() => checkInvokeTarget(call, target(changes)))

  it('takes a script app with a main file, and a UI app with a page, and tells the kind', () => {
    expect(checkInvokeTarget(call, target())).toBe('script')
    expect(checkInvokeTarget(call, uiTarget())).toBe('ui')
  })

  it('runs a built-in script app, and refuses a built-in UI app as a fault of Dez', () => {
    expect(checkInvokeTarget(invoke({ name: 'dez-media' }), target())).toBe('script')
    const text = refusal(() => checkInvokeTarget(invoke({ name: 'dez-board' }), uiTarget()))
    expect(text).toContain('/apps/dez-board is a built-in app of Dez with the kind "ui"')
    expect(text).toContain('This is a fault of Dez, not of your call: tell the user.')
    expect(text).toContain(NOT_STARTED)
  })

  it('refuses an app that is not there, and a file at its place', () => {
    expect(check({ app: MISSING_TREE })).toContain('There is no app /apps/notes')
    expect(check({ app: { kind: 'file', size: 3 } })).toContain('/apps/notes is a file and no folder')
  })

  it('refuses an app whose manifest is missing, is no plain small file, or is not valid', () => {
    const missing = check({ manifest: MISSING_TREE, manifestBytes: null })
    expect(missing).toContain('has no manifest.json')

    for (const manifest of [FOLDER_FACTS, { kind: 'other', size: 0 }, { kind: 'file', size: MANIFEST_MAX_BYTES + 1 }] as const) {
      expect(check({ manifest, manifestBytes: null }), manifest.kind).toContain('/apps/notes/manifest.json is no plain file')
    }
    // The file went between the two reads of the check.
    expect(check({ manifestBytes: null })).toContain('/apps/notes/manifest.json is no plain file')

    const invalid = check({ manifestBytes: textBytes('{"name": "notes"') })
    expect(invalid).toContain('/apps/notes/manifest.json is not valid')
    for (const text of [missing, invalid]) {
      expect(text).toContain(NOT_STARTED)
      for (const kind of APP_KINDS) expect(text).toContain(`"${kind}"`)
    }
  })

  it('refuses a UI app with no page, and one with a folder at its place', () => {
    const missing = refusal(() => checkInvokeTarget(call, uiTarget({ index: MISSING_TREE, main: { kind: 'file', size: 120 } })))
    expect(missing).toContain('has no index.html')
    expect(missing).toContain('Write /apps/notes/index.html')
    expect(missing).toContain('<script src="~dez.js"></script>')
    expect(missing).toContain('\'app/invoke\'')
    expect(missing).toContain(NOT_STARTED)

    expect(refusal(() => checkInvokeTarget(call, uiTarget({ index: FOLDER_FACTS })))).toContain('/apps/notes/index.html is a folder and no file')
  })

  it('refuses a script app with no main file, and one with a folder at its place', () => {
    const missing = check({ main: MISSING_TREE })
    expect(missing).toContain('has no main.ts')
    expect(missing).toContain('Write /apps/notes/main.ts')
    expect(missing).toContain(NOT_STARTED)

    expect(check({ main: FOLDER_FACTS })).toContain('/apps/notes/main.ts is a folder and no file')
    expect(check({ main: { kind: 'other', size: 0 } })).toContain('/apps/notes/main.ts is a link or a special file and no file')
  })

  it('checks the app before its manifest, and the manifest before the main file', () => {
    expect(check({ app: MISSING_TREE, manifest: MISSING_TREE, manifestBytes: null, main: MISSING_TREE })).toContain('There is no app')
    expect(check({ manifest: MISSING_TREE, manifestBytes: null, main: MISSING_TREE })).toContain('has no manifest.json')
  })
})

describe('fileUrl', () => {
  it.each([
    ['/home/u/.config/dez/apps/notes/main.ts', 'file:///home/u/.config/dez/apps/notes/main.ts'],
    ['/Users/Zoë Ann/dez/apps/a/main.ts', 'file:///Users/Zo%C3%AB%20Ann/dez/apps/a/main.ts'],
    ['/h/50%/a#b?c/main.ts', 'file:///h/50%25/a%23b%3Fc/main.ts'],
    ['/h/a\\b/main.ts', 'file:///h/a%5Cb/main.ts'],
    ['/h/a\nb\rc\td/main.ts', 'file:///h/a%0Ab%0Dc%09d/main.ts'],
  ])('gives %j as a URL that names the same path', (path, url) => {
    expect(fileUrl(path)).toBe(url)
    expect(decodeURIComponent(new URL(url).pathname)).toBe(path)
  })
})

describe('appRunDescription', () => {
  const folders = { run: '/home/u/.cache/dez/work/w1', app: '/home/u/.config/dez/apps/notes', work: '/home/u/.config/dez/work/c1' }

  it('tells the main file as a URL, the parameters, the copy of each input, and the three folders of the code', () => {
    const call = invoke({ name: 'notes', parameters: { columns: 4 }, inputs: '@c @a' })

    expect(JSON.parse(appRunDescription(call, folders))).toStrictEqual({
      kind: 'app',
      main: 'file:///home/u/.config/dez/apps/notes/main.ts',
      parameters: { columns: 4 },
      inputs: [
        { id: 'c', kind: 'video', type: 'video/webm', path: '/home/u/.cache/dez/work/w1/c.webm' },
        { id: 'a', kind: 'image', type: 'image/jpeg', path: '/home/u/.cache/dez/work/w1/a.jpg' },
      ],
      outputFolder: '/home/u/.cache/dez/work/w1/output',
      appFolder: '/home/u/.config/dez/apps/notes',
      workFolder: '/home/u/.config/dez/work/c1',
    })
  })

  it('holds no path of the file of an input', () => {
    const text = appRunDescription(invoke({ name: 'notes', inputs: '@a @b @c @d @e @f' }), folders)

    expect(['red.jpg', 'sky.png', 'plan.svg', 's1.wav', 'v1.webm', 'assets/', 'clips.example'].filter((part) => text.includes(part))).toStrictEqual([])
  })
})

describe('invokeInputsText', () => {
  it('names each input by its kind and its id, in the order of the call, and where the code of the kind of app finds them', () => {
    const { inputs } = invoke({ name: 'notes', inputs: '@c @a @b' })

    expect(invokeInputsText(inputs, 'script')).toBe('The inputs of the run, in the order of dez.inputs: the video clip @c, the image @a, the audio clip @b.')
    expect(invokeInputsText(inputs, 'ui')).toBe('The inputs of the run, in the order of run.inputs: the video clip @c, the image @a, the audio clip @b.')
  })

  it('tells of a run with no input', () => {
    for (const kind of APP_KINDS) expect(invokeInputsText([], kind)).toBe('The run has no input.')
  })
})

describe('frameInputs', () => {
  it('gives the handler of a page the id, the kind, and the type of each input, and nothing of its file', () => {
    expect(frameInputs(invoke({ name: 'notes', inputs: '@c @a @d' }).inputs)).toStrictEqual([
      { id: 'c', kind: 'video', type: 'video/webm' },
      { id: 'a', kind: 'image', type: 'image/jpeg' },
      { id: 'd', kind: 'video', type: 'video/webm' },
    ])
  })
})

describe('invokeLabel', () => {
  it('names the app, and the parameters only when the call gives some', () => {
    expect(invokeLabel(appsArgs('invoke', { name: 'notes' }))).toBe('invoke notes')
    expect(invokeLabel(appsArgs('invoke', { name: 'notes', parameters: {}, inputs: '@a' }))).toBe('invoke notes')
    expect(invokeLabel(appsArgs('invoke', { name: 'notes', parameters: { title: 'Trip', columns: 4 } }))).toBe('invoke notes {\'title\':\'Trip\',\'columns\':4}')
  })

  it('stays on one short line for long parameters', () => {
    const label = invokeLabel(appsArgs('invoke', { name: 'notes', parameters: { text: 'line one\nline two '.repeat(100) } }))

    expect(label.startsWith('invoke notes {')).toBe(true)
    expect(label).not.toContain('\n')
    expect(label.length).toBeLessThan(200)
  })
})

describe('listedOutputs', () => {
  it('keeps the plain files directly in the folder, in the order of their names', () => {
    expect(listedOutputs(folderTree({ 'frame_10.png': 5, 'frame_2.png': 5, 'Chart.png': 9, 'b.wav': 1 }))).toStrictEqual({
      files: ['b.wav', 'Chart.png', 'frame_2.png', 'frame_10.png'],
      notKept: [],
      problem: null,
    })
  })

  it('keeps no folder, no file of a folder, no link, no empty file, no file over the size limit, and no name that the file calls refuse', () => {
    const { files, notKept, problem } = listedOutputs(folderTree({
      'ok.png': 10,
      'at-limit.mp4': APP_RUN_MAX_OUTPUT_BYTES,
      'big.mp4': APP_RUN_MAX_OUTPUT_BYTES + 1,
      'empty.png': 0,
      link: 'other',
      parts: null,
      'parts/deep.png': 10,
      'my chart.png': 10,
      'é.png': 10,
    }))

    expect(problem).toBeNull()
    expect(files).toStrictEqual(['at-limit.mp4', 'ok.png'])
    expect(notKept.map((note) => note.slice(0, note.indexOf(' (')))).toStrictEqual(['big.mp4', '"é.png"', 'empty.png', 'link', '"my chart.png"', 'parts/'])
    expect(notKept.find((note) => note.startsWith('big.mp4'))).toContain(byteSizeText(APP_RUN_MAX_OUTPUT_BYTES))
  })

  it('shows a name with a line break on one line, and only the start of a long name', () => {
    const [lineBreak] = listedOutputs(folderTree({ 'a\nb.png': 4 })).notKept
    expect(lineBreak.startsWith('"a\\nb.png" (')).toBe(true)

    const [long] = listedOutputs(folderTree({ [`${'x '.repeat(400)}.png`]: 4 })).notKept
    expect(long.length).toBeLessThan(400)
  })

  it('keeps as many files as the limit, and none of a run with one more', () => {
    const files = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`f${index}.png`, 4]))

    expect(listedOutputs(folderTree(files(APP_RUN_MAX_OUTPUT_FILES))).files).toHaveLength(APP_RUN_MAX_OUTPUT_FILES)

    const over = listedOutputs(folderTree({ ...files(APP_RUN_MAX_OUTPUT_FILES + 1), 'notes.txt': 0 }))
    expect(over.files).toStrictEqual([])
    expect(over.problem).toContain(`it put ${APP_RUN_MAX_OUTPUT_FILES + 1} files into its output folder`)
  })

  it('keeps none of a folder with more entries than the listing holds', () => {
    const cut = listedOutputs(folderTree({ 'a.png': 4, 'b.png': 4 }, true))

    expect(cut.files).toStrictEqual([])
    expect(cut.problem).toContain(`more than ${APP_OUTPUT_LISTED_ENTRIES} files and folders`)
  })

  // A listing has the entries of the folder itself before those of a
  // folder below, so a cut one with a deeper entry has them all.
  it('keeps the files of a cut listing that reached a folder below', () => {
    expect(listedOutputs(folderTree({ 'a.png': 4, scratch: null, 'scratch/t1.bin': 9 }, true))).toStrictEqual({
      files: ['a.png'],
      notKept: ['scratch/ (a folder: Dez keeps only the files directly in the output folder)'],
      problem: null,
    })
  })

  it('tells of an output folder that the app deleted or replaced', () => {
    for (const tree of [MISSING_TREE, fileTree(12)]) {
      const { files, notKept, problem } = listedOutputs(tree)

      expect(files).toStrictEqual([])
      expect(problem).toBeNull()
      expect(notKept).toHaveLength(1)
      expect(notKept[0]).toContain('the output folder')
    }
  })
})

describe('checkedOutput', () => {
  it('takes the type of a file from its first bytes, not from its name', () => {
    expect(checkedOutput('chart.txt', PNG_BYTES)).toStrictEqual({ kept: { name: 'chart.txt', kind: 'image', type: 'image/png', extension: 'png' } })
    expect(checkedOutput('song.png', WAV_BYTES)).toStrictEqual({ kept: { name: 'song.png', kind: 'audio', type: 'audio/wav', extension: 'wav' } })
  })

  it('keeps no file of a type that Dez does not store, and no file that Dez could not read', () => {
    expect(checkedOutput('notes.png', textBytes('Three notes.'))).toStrictEqual({ notKept: 'notes.png (Dez stores no file of its type)' })
    expect(checkedOutput('page.html', textBytes('<!doctype html><html></html>'))).toStrictEqual({ notKept: 'page.html (Dez stores no file of its type)' })
    expect(checkedOutput('chart.png', null)).toStrictEqual({ notKept: 'chart.png (Dez could not read it)' })
  })
})

const EXITED = { kind: 'exited', code: 0 } as const
const asIs = (text: string) => text

describe('appRunOutcome', () => {
  it('gives the returned value as it is, and tells of a run that returned none or a blank one', () => {
    expect(appRunOutcome(EXITED, { type: 'result', text: 'Made 3 notes.' }, false)).toStrictEqual({ isError: false, lead: null, given: { text: 'Made 3 notes.', name: 'returned value' }, advice: [] })

    for (const text of [undefined, '', ' \n ']) {
      const outcome = appRunOutcome(EXITED, text === undefined ? { type: 'result' } : { type: 'result', text }, true)

      expect([outcome.isError, outcome.given]).toStrictEqual([false, null])
      expect(outcome.lead).not.toBeNull()
    }
  })

  it('gives the error of the code, and the limits of the sandbox only for an error that names a flag of Deno', () => {
    const thrown = appRunOutcome(EXITED, { type: 'error', text: 'TypeError: notes is not iterable\n    at main (/apps/notes/main.ts:4:9)' }, false)
    expect(thrown.isError).toBe(true)
    expect(thrown.given?.text).toContain('notes is not iterable')
    expect(thrown.lead).toContain('Dez kept no file of the run.')
    expect(thrown.advice).toStrictEqual([])

    const refused = appRunOutcome(EXITED, { type: 'error', text: 'NotCapable: Requires read access to "./state.json", run again with the --allow-read flag' }, false)
    expect(refused.advice).toHaveLength(1)
    expect(refused.advice[0]).toContain('dez.appFolder')
    expect(refused.advice[0]).toContain('A relative path does not work.')
  })

  it('tells why a run with no line ended', () => {
    const tooMuch = appRunOutcome({ kind: 'outputTooLarge' }, null, true)
    expect([tooMuch.isError, tooMuch.given]).toStrictEqual([true, null])
    expect(tooMuch.lead).toContain(byteSizeText(JS_EVAL_OUTPUT_BYTES))

    const killed = appRunOutcome({ kind: 'exited', code: null }, null, false)
    expect(killed.isError).toBe(true)
    expect(killed.lead).toContain('memory')
    expect(killed.lead).toContain('wrote nothing to the console')

    const exited = appRunOutcome({ kind: 'exited', code: 1 }, null, true)
    expect(exited.isError).toBe(true)
    expect(exited.lead).toContain('exit code 1')
    expect(exited.lead).toContain('The console output tells which.')
    expect(appRunOutcome({ kind: 'exited', code: 1 }, null, false).lead).toContain('wrote nothing to the console')
  })
})

describe('appRunResult', () => {
  const RETURNED: RunOutcome = { isError: false, lead: null, given: { text: 'Made the sheet.', name: 'returned value' }, advice: [] }
  const outputs = (more: Partial<AppOutputs>): AppOutputs => ({ ...NO_APP_OUTPUTS, ...more })

  it('gives the value, then the kept files in the order of their ids, then the console output', () => {
    const { text, isError } = appRunResult(RETURNED, 'read 2 files\n', asIs, outputs({
      kept: [
        { name: 'sheet.png', kind: 'image', type: 'image/png', extension: 'png' },
        { name: 'song.bin', kind: 'audio', type: 'audio/wav', extension: 'wav' },
      ],
    }))

    expect(isError).toBe(false)
    expect(text.split('\n\n')).toStrictEqual([
      'Made the sheet.',
      'Dez keeps 2 files of the output folder: sheet.png (image), song.bin (audio clip). The lines at the end give their ids in this order.',
      'Console output of the code:\nread 2 files',
    ])
  })

  it('tells of one kept file, and of the entries that Dez did not keep', () => {
    const { text } = appRunResult(RETURNED, '', asIs, outputs({
      kept: [{ name: 'sheet.png', kind: 'image', type: 'image/png', extension: 'png' }],
      notKept: ['notes.txt (Dez stores no file of its type)', 'parts/ (a folder: Dez keeps only the files directly in the output folder)'],
    }))

    expect(text).toContain('Dez keeps 1 file of the output folder: sheet.png (image).')
    expect(text).toContain('Dez did not keep notes.txt (Dez stores no file of its type), parts/ (a folder: Dez keeps only the files directly in the output folder).')
  })

  it('names at most 20 entries that Dez did not keep, with the count of the rest', () => {
    const { text } = appRunResult(RETURNED, '', asIs, outputs({ notKept: Array.from({ length: 23 }, (_, index) => `n${index}.txt (it is empty)`) }))

    expect(text).toContain('n19.txt (it is empty), and 3 more of the output folder.')
    expect(text).not.toContain('n20.txt')
  })

  it('tells nothing of the output folder of a run that left nothing in it', () => {
    expect(appRunResult(RETURNED, '', asIs, NO_APP_OUTPUTS)).toStrictEqual({ text: 'Made the sheet.', isError: false })
  })

  it('makes a run whose outputs have a problem an error that still gives the value', () => {
    const { problem } = listedOutputs(folderTree({ 'a.png': 4 }, true))
    const { text, isError } = appRunResult(RETURNED, '', asIs, outputs({ problem }))

    expect(isError).toBe(true)
    expect(text.startsWith(`${problem} The app returned:\nMade the sheet.`)).toBe(true)

    const noValue = appRunResult(appRunOutcome(EXITED, { type: 'result' }, false), '', asIs, outputs({ problem }))
    expect(noValue.isError).toBe(true)
    expect(noValue.text).toBe(`${problem} The app ended with no error and returned no value.`)
  })

  it('gives each text of the run with no path of this computer', () => {
    const runFolder = '/home/ann/.cache/dez/work/w1'
    const workFolder = '/home/ann/.config/dez/work/c1'
    const forModel = (text: string) => textForModel(text, { run: [runFolder], apps: ['/home/ann/.config/dez/apps'], work: [workFolder] })
    const thrown = appRunOutcome(EXITED, { type: 'error', text: 'Error: no file /home/ann/.config/dez/apps/notes/state.json\n    at main (file:///home/ann/.config/dez/apps/notes/main.ts:7:11)' }, true)
    const { text, isError } = appRunResult(thrown, `wrote ${runFolder}/output/a.png and ${workFolder}/cache.json\n`, forModel, NO_APP_OUTPUTS)

    expect(isError).toBe(true)
    expect(text).toContain('Error: no file /apps/notes/state.json')
    expect(text).toContain('at main (file:///apps/notes/main.ts:7:11)')
    expect(text).toContain('wrote /run/output/a.png and /work/cache.json')
    expect(text).not.toContain('/home/ann')
  })
})

describe('appFrameResult', () => {
  it('gives the value, then the saved files in the order of the saves, then the console output of the page', () => {
    const { text, isError } = appFrameResult({ kind: 'returned', value: 'Drew the chart.', log: 'drew 3 bars\n' }, ['image', 'audio'])

    expect(isError).toBe(false)
    expect(text.split('\n\n')).toStrictEqual([
      'Drew the chart.',
      'Dez keeps the 2 files that the app saved, in the order of the saves: image, audio clip. The lines at the end give their ids in this order.',
      'Console output of the code:\ndrew 3 bars',
    ])
  })

  it('tells of one saved file, and of a handler that returned no value', () => {
    expect(appFrameResult({ kind: 'returned', value: undefined, log: '' }, ['video'])).toStrictEqual({
      text: 'The app ended with no error and returned no value.\n\nDez keeps the 1 file that the app saved (video clip). The line at the end gives its id.',
      isError: false,
    })
  })

  it('gives the error of a handler that threw, with the files of the app by their paths in the apps tool, and the console output', () => {
    const { text, isError } = appFrameResult({
      kind: 'threw',
      error: 'TypeError: bars is not iterable\ndraw@dezapp://localhost/notes/chart.js:4:9\n@dezapp://localhost/notes/main.js:12:20',
      log: 'error: no file at /home/ann/Pictures/bars.png\n',
    }, [])

    expect(isError).toBe(true)
    expect(text).toContain('The code of the app threw an error. Dez kept no file of the run. The error:\nTypeError: bars is not iterable')
    expect(text).toContain('draw@/apps/notes/chart.js:4:9\n@/apps/notes/main.js:12:20')
    expect(text).toContain('Console output of the code:')
    expect(text).not.toContain('dezapp:')
    expect(text).not.toContain('/home/ann')
  })

  it('tells a model how to fix a page that has no handler, and one that does not load the script of Dez', () => {
    const unregistered = appFrameResult({ kind: 'unregistered', log: 'ready\n' }, [])
    expect(unregistered.isError).toBe(true)
    expect(unregistered.text).toContain('dez.sbp(\'sbp/selectors/register\', { \'app/invoke\': async (parameters, run) => { … } })')
    expect(unregistered.text).toContain('before its first `await`')
    expect(unregistered.text).toContain('Console output of the code:\nready')

    const noClient = appFrameResult({ kind: 'noClient' }, [])
    expect(noClient.isError).toBe(true)
    expect(noClient.text).toContain('<script src="~dez.js"></script>')
  })

  it('tells of a page that Dez stopped because it loaded again', () => {
    const { text, isError } = appFrameResult({ kind: 'navigated' }, [])

    expect(isError).toBe(true)
    expect(text).toContain('Dez stopped the app')
    expect(text).toContain('Dez kept no file of the run.')
  })
})

describe('the checks of a save of a page', () => {
  it('takes a size from one byte to the limit of one file', () => {
    expect(() => checkSaveSize(1)).not.toThrow()
    expect(() => checkSaveSize(APP_RUN_MAX_OUTPUT_BYTES)).not.toThrow()
    expect(refusal(() => checkSaveSize(0), AppCallError)).toContain('no bytes')
    expect(refusal(() => checkSaveSize(APP_RUN_MAX_OUTPUT_BYTES + 1), AppCallError)).toContain(byteSizeText(APP_RUN_MAX_OUTPUT_BYTES))
  })

  it('counts as many saves as the limit of a run, and refuses each one after them', () => {
    const count = new SaveCount()

    for (let save = 0; save < APP_RUN_MAX_OUTPUT_FILES; save++) count.take()
    expect(refusal(() => count.take(), AppCallError)).toContain(`at most ${APP_RUN_MAX_OUTPUT_FILES} files`)
    expect(refusal(() => count.take(), AppCallError)).toContain(`at most ${APP_RUN_MAX_OUTPUT_FILES} files`)
    // Each run has its own count.
    expect(() => new SaveCount().take()).not.toThrow()
  })

  it('takes the type of a save from its first bytes, and refuses bytes of a type that Dez does not store', () => {
    expect(savedFileType(PNG_BYTES)).toStrictEqual({ kind: 'image', type: 'image/png', extension: 'png' })
    expect(savedFileType(WAV_BYTES)).toStrictEqual({ kind: 'audio', type: 'audio/wav', extension: 'wav' })
    expect(refusal(() => savedFileType(textBytes('<!doctype html><html></html>')), AppCallError)).toContain('no file of a type that Dez stores')
  })
})
