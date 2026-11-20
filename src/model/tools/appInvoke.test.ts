import { describe, expect, it } from 'vitest'
import { byteSizeText } from '../../utils/byteSize'
import { APP_KINDS, appManifestText, MANIFEST_MAX_BYTES, type AppKind } from './appManifest'
import {
  APP_OUTPUT_LISTED_ENTRIES,
  appRunDescription,
  appRunOutcome,
  appRunResult,
  checkedOutput,
  checkInvokeTarget,
  fileUrl,
  invokeCall,
  invokeInputsText,
  invokeLabel,
  listedOutputs,
  NO_APP_OUTPUTS,
  type AppOutputs,
  type InvokeTarget,
} from './appInvoke'
import { APP_RUN_MAX_OUTPUT_BYTES, APP_RUN_MAX_OUTPUT_FILES } from './appsTool'
import { JS_EVAL_OUTPUT_BYTES, textForModel, type RunOutcome } from './jsEval'
import { appsArgs, CONVERSATION, fileTree, FOLDER_FACTS, folderTree, MISSING_TREE, refusal } from './testing'

const NOT_STARTED = 'Dez started no job.'

function invoke(parameters: Record<string, unknown>) {
  return invokeCall(appsArgs('invoke', parameters), CONVERSATION)
}

const bytes = (text: string) => new TextEncoder().encode(text)
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const WAV = bytes('RIFF\0\0\0\0WAVEfmt ')

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

function manifestOf(kind: AppKind): Uint8Array {
  return bytes(appManifestText({ name: 'notes', description: 'Keeps notes.', kind }))
}

// What is at the paths of a script app that can run, with `changes`.
function target(changes: Partial<InvokeTarget> = {}): InvokeTarget {
  const manifestBytes = manifestOf('script')
  return { app: FOLDER_FACTS, manifest: { kind: 'file', size: manifestBytes.length }, manifestBytes, main: { kind: 'file', size: 120 }, ...changes }
}

describe('checkInvokeTarget', () => {
  const call = invoke({ name: 'notes' })
  const check = (changes: Partial<InvokeTarget>) => refusal(() => checkInvokeTarget(call, target(changes)))

  it('takes a script app with a main file', () => {
    expect(() => checkInvokeTarget(call, target())).not.toThrow()
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

    const invalid = check({ manifestBytes: bytes('{"name": "notes"') })
    expect(invalid).toContain('/apps/notes/manifest.json is not valid')
    for (const text of [missing, invalid]) {
      expect(text).toContain(NOT_STARTED)
      for (const kind of APP_KINDS) expect(text).toContain(`"${kind}"`)
    }
  })

  it('refuses a UI app before it looks at the main file', () => {
    const text = check({ manifestBytes: manifestOf('ui'), main: MISSING_TREE })

    expect(text).toContain('/apps/notes is a UI app')
    expect(text).toContain(NOT_STARTED)
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
  const folders = { work: '/home/u/.cache/dez/work/w1', app: '/home/u/.config/dez/apps/notes' }

  it('tells the main file as a URL, the parameters, the copy of each input, and the two folders of the code', () => {
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
    })
  })

  it('holds no path of the file of an input', () => {
    const text = appRunDescription(invoke({ name: 'notes', inputs: '@a @b @c @d @e @f' }), folders)

    expect(['red.jpg', 'sky.png', 'plan.svg', 's1.wav', 'v1.webm', 'assets/', 'clips.example'].filter((part) => text.includes(part))).toStrictEqual([])
  })
})

describe('invokeInputsText', () => {
  it('names each input by its kind and its id, in the order of the call', () => {
    expect(invokeInputsText(invoke({ name: 'notes', inputs: '@c @a @b' }).inputs)).toContain('the video clip @c, the image @a, the audio clip @b')
  })

  it('tells of a run with no input', () => {
    expect(invokeInputsText([])).toBe('The run has no input.')
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
    expect(checkedOutput('chart.txt', PNG)).toStrictEqual({ kept: { name: 'chart.txt', kind: 'image', type: 'image/png', extension: 'png' } })
    expect(checkedOutput('song.png', WAV)).toStrictEqual({ kept: { name: 'song.png', kind: 'audio', type: 'audio/wav', extension: 'wav' } })
  })

  it('keeps no file of a type that Dez does not store, and no file that Dez could not read', () => {
    expect(checkedOutput('notes.png', bytes('Three notes.'))).toStrictEqual({ notKept: 'notes.png (Dez stores no file of its type)' })
    expect(checkedOutput('page.html', bytes('<!doctype html><html></html>'))).toStrictEqual({ notKept: 'page.html (Dez stores no file of its type)' })
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
    const work = '/home/ann/.cache/dez/work/w1'
    const forModel = (text: string) => textForModel(text, [work], ['/home/ann/.config/dez/apps'])
    const thrown = appRunOutcome(EXITED, { type: 'error', text: 'Error: no file /home/ann/.config/dez/apps/notes/state.json\n    at main (file:///home/ann/.config/dez/apps/notes/main.ts:7:11)' }, true)
    const { text, isError } = appRunResult(thrown, `wrote ${work}/output/a.png\n`, forModel, NO_APP_OUTPUTS)

    expect(isError).toBe(true)
    expect(text).toContain('Error: no file /apps/notes/state.json')
    expect(text).toContain('at main (file:///apps/notes/main.ts:7:11)')
    expect(text).toContain('wrote /work/output/a.png')
    expect(text).not.toContain('/home/ann')
  })
})
