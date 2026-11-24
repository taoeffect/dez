import { describe, expect, it } from 'vitest'
import { byteSizeText } from '../../utils/byteSize'
import { ALIAS_TIMEOUT_MS, aliasRunTexts } from './appAliases'
import { AppCallError } from './appBridge'
import { APP_KINDS, MANIFEST_MAX_BYTES, type AppKind, type AppManifest } from './appManifest'
import {
  aliasInvokeCall,
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
  NO_APP_RUN_CALLS,
  runNativeCanvas,
  SaveCount,
  savedFileType,
  type AppOutputs,
  type InvokeCall,
  type InvokeTarget,
} from './appInvoke'
import { APP_RUN_MAX_OUTPUT_BYTES, APP_RUN_MAX_OUTPUT_FILES } from './appsTool'
import { jobStartedText } from './jobs'
import { JS_EVAL_OUTPUT_BYTES, textForModel, type RunOutcome } from './jsEval'
import { aliasOf, appsArgs, CONVERSATION, fileTree, FOLDER_FACTS, folderTree, MISSING_TREE, notesAppManifest, notesManifest, PNG_BYTES, refusal, textBytes, WAV_BYTES } from './testing'
import { SHIPPED_FONTS } from './videoFonts'

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

// The run of a call of the alias `tool name` with `args`, in CONVERSATION:
// the image @a, the audio clip @b, the video clips @c and @d.
function aliasCall(tool: 'audio' | 'video', name: string, args: Record<string, string | number>): InvokeCall {
  return aliasInvokeCall(aliasOf(tool, name), args, CONVERSATION)
}

const inputIds = (call: InvokeCall) => call.inputs.map(({ id }) => id)

describe('aliasInvokeCall', () => {
  it('runs the built-in app of the alias, with the time limit of an alias and the decode of the manifest of the app', () => {
    const call = aliasCall('video', 'cuts', { clips: '@c' })

    expect([call.app.virtual, call.manifest.virtual, call.main.virtual]).toStrictEqual(['/apps/dez-cuts', '/apps/dez-cuts/manifest.json', '/apps/dez-cuts/main.ts'])
    expect([call.timeoutMs, call.decode]).toStrictEqual([ALIAS_TIMEOUT_MS, null])
  })

  // The order of the inputs is the order that the code of the app reads
  // (`dez.inputs`): the clip to find before the clip to find it in.
  it('gives the clips of the input parameters in the order of the parameters, not of the arguments, and each clip once', () => {
    expect(inputIds(aliasCall('audio', 'align', { within: '@c', clip: '@b' }))).toStrictEqual(['b', 'c'])
    expect(inputIds(aliasCall('video', 'sync', { song: '@b', edit: '@c' }))).toStrictEqual(['c', 'b'])
    expect(inputIds(aliasCall('video', 'cuts', { clips: '@d @c, @d' }))).toStrictEqual(['d', 'c'])
    // An audio clip and a video clip both have sound.
    expect(inputIds(aliasCall('audio', 'onsets', { clips: '@c @b' }))).toStrictEqual(['c', 'b'])
  })

  it('gives every other argument to the app as a parameter', () => {
    expect(aliasCall('video', 'sync', { edit: '@c', song: '@b', offset: 1.5, save_to: '/work/sync.json' }).parameters).toStrictEqual({ offset: 1.5, save_to: '/work/sync.json' })
    expect(aliasCall('audio', 'beats', { clips: '@b' }).parameters).toStrictEqual({})
    expect(aliasCall('video', 'title', { text: 'NEON CITY', fps: 24 })).toMatchObject({ parameters: { text: 'NEON CITY', fps: 24 }, inputs: [] })
  })

  it('refuses an input parameter with no clip, and one with more clips than it takes', () => {
    const none = refusal(() => aliasCall('audio', 'beats', { clips: ' , ' }))
    expect(none).toContain('`clips` names no clip')
    expect(none).toContain('Dez did not run dez-beats.')

    const two = refusal(() => aliasCall('audio', 'align', { clip: '@b @d', within: '@c' }))
    expect(two).toContain('`clip` names 2 clips, and it takes one')
    expect(two).toContain('Dez did not run dez-align.')
  })

  it('refuses a word that is no id, and an id of no image and no clip', () => {
    expect(refusal(() => aliasCall('video', 'cuts', { clips: '@c red.jpg' }))).toContain('"red.jpg"')

    const unknown = refusal(() => aliasCall('video', 'cuts', { clips: '@c @z' }))
    expect(unknown).toContain('@z')
    expect(unknown).toContain('Dez did not run dez-cuts.')
  })

  it('refuses an image, and an audio clip where the parameter takes only video clips', () => {
    expect(refusal(() => aliasCall('audio', 'beats', { clips: '@b @a' }))).toContain('@a is an image, and `clips` of audio beats takes only clips with sound.')
    expect(refusal(() => aliasCall('video', 'cuts', { clips: '@b' }))).toContain('@b is an audio clip, and `clips` of video cuts takes only video clips.')
    expect(refusal(() => aliasCall('video', 'sync', { edit: '@b', song: '@c' }))).toContain('@b is an audio clip, and `edit` of video sync takes only video clips.')
  })

  it('refuses the same clip in two input parameters', () => {
    const same = refusal(() => aliasCall('audio', 'align', { clip: '@b', within: '@b' }))

    expect(same).toContain('`clip` and `within` name the same clip @b')
    expect(same).toContain('Dez did not run dez-align.')
  })
})

// An alias call has no `decode`, no `inputs`, and no time limit to change.
describe('aliasRunTexts', () => {
  const texts = aliasRunTexts(aliasOf('video', 'cuts'))

  it('tells of a failed decode and of a long run with the call of the alias, and with no advice about parameters that an alias does not have', () => {
    const failed = texts.decodeFailed({ kind: 'video', id: 'c' })
    expect(failed).toContain('@c for video cuts')

    for (const text of [failed, texts.decodedTooLarge, texts.timedOut(ALIAS_TIMEOUT_MS, 'The code of the app runs.')]) {
      expect(['`decode`', '`inputs`', 'timeout_seconds', 'apps invoke'].filter((part) => text.includes(part)), text).toStrictEqual([])
    }
  })

  it('tells what to change after a long run of an alias that makes a clip, and not to cut clips', () => {
    const timedOut = aliasRunTexts(aliasOf('video', 'title')).timedOut(ALIAS_TIMEOUT_MS, 'The code of the app runs.')

    expect(timedOut).toContain('Give a shorter duration, a lower fps, or a smaller width and height.')
    expect(timedOut).not.toContain('Cut the clips')
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

  it('takes a script app with a main file, and a UI app with a page, and gives the manifest with the kind', () => {
    expect(checkInvokeTarget(call, target())).toStrictEqual(notesAppManifest('script'))
    expect(checkInvokeTarget(call, uiTarget()).kind).toBe('ui')
  })

  it('runs a built-in script app, and refuses a built-in UI app as a fault of Dez', () => {
    expect(checkInvokeTarget(invoke({ name: 'dez-media' }), target()).kind).toBe('script')
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

describe('runNativeCanvas', () => {
  const call = invoke({ name: 'notes' })
  const manifestWith = (native: unknown, kind: AppKind = 'script'): AppManifest => ({ name: 'notes', description: 'Draws notes.', kind, native })

  it('lets a script app load skia-canvas only when its manifest asks for it', () => {
    expect(runNativeCanvas(call, manifestWith(['skia-canvas']))).toBe(true)
    expect(runNativeCanvas(call, manifestWith(['skia-canvas', 'skia-canvas']))).toBe(true)
    expect(runNativeCanvas(call, manifestWith([]))).toBe(false)
    expect(runNativeCanvas(call, notesAppManifest('script'))).toBe(false)
  })

  it('refuses a field that is no list, and a name of another library, by the path of the manifest', () => {
    for (const [native, problem] of [
      ['skia-canvas', 'it must be a list of names of native libraries'],
      [{ 'skia-canvas': true }, 'it must be a list of names of native libraries'],
      [['skia-canvas', 'sharp'], 'it names "sharp", and the one native library that a script app can load is "skia-canvas"'],
      [[7], 'it names a value that is no name'],
    ] as const) {
      const text = refusal(() => runNativeCanvas(call, manifestWith(native)))

      expect(text).toContain(`The field "native" of /apps/notes/manifest.json is not valid: ${problem}`)
      expect(text).toContain('write the field as "native": ["skia-canvas"]; else delete it.')
      expect(text.endsWith(NOT_STARTED)).toBe(true)
    }
  })

  it('refuses the field in the manifest of a UI app, and takes an empty list there', () => {
    const text = refusal(() => runNativeCanvas(call, manifestWith(['skia-canvas'], 'ui')))

    expect(text).toContain('/apps/notes/manifest.json has the field "native", which only a script app takes')
    expect(text).toContain('Delete the field.')
    expect(runNativeCanvas(call, manifestWith([], 'ui'))).toBe(false)
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
  const folders = { run: '/home/u/.cache/dez/work/w1', app: '/home/u/.config/dez/apps/notes', work: '/home/u/.config/dez/work/c1', fonts: '/usr/lib/dez/fonts' }

  it('tells the main file as a URL, the parameters, the copy of each input, the three folders of the code, and the fonts', () => {
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
      fonts: expect.any(Array),
    })
  })

  it('lists each font that Dez ships, in the order of its manifest, with its weight and the path of its file', () => {
    const { fonts } = JSON.parse(appRunDescription(invoke({ name: 'notes' }), folders)) as { fonts: { file: string }[] }

    expect(fonts.map(({ file }) => file)).toStrictEqual(SHIPPED_FONTS.map(({ file }) => file))
    expect(fonts.slice(0, 2)).toStrictEqual([
      { file: 'NotoSans-Regular.ttf', family: 'Noto Sans', weight: 400, scripts: 'Latin, Greek, Cyrillic', path: '/usr/lib/dez/fonts/NotoSans-Regular.ttf' },
      { file: 'NotoSans-Bold.ttf', family: 'Noto Sans', weight: 700, scripts: 'Latin, Greek, Cyrillic', path: '/usr/lib/dez/fonts/NotoSans-Bold.ttf' },
    ])
  })

  it('holds no path of the file of an input', () => {
    const text = appRunDescription(invoke({ name: 'notes', inputs: '@a @b @c @d @e @f' }), folders)

    expect(['red.jpg', 'sky.png', 'plan.svg', 's1.wav', 'v1.webm', 'assets/', 'clips.example'].filter((part) => text.includes(part))).toStrictEqual([])
  })

  it('gives a decoded clip the facts of its decoded files, with their paths in the run folder', () => {
    const decoded = new Map([['c', { audio: null, frames: { name: 'c.rgb', width: 12, height: 9, fps: 5, count: 10 } }]])
    const { inputs } = JSON.parse(appRunDescription(invoke({ name: 'notes', inputs: '@c @a' }), folders, decoded)) as { inputs: unknown[] }

    expect(inputs).toStrictEqual([
      { id: 'c', kind: 'video', type: 'video/webm', path: '/home/u/.cache/dez/work/w1/c.webm', audio: null, frames: { path: '/home/u/.cache/dez/work/w1/c.rgb', width: 12, height: 9, fps: 5, count: 10 } },
      { id: 'a', kind: 'image', type: 'image/jpeg', path: '/home/u/.cache/dez/work/w1/a.jpg' },
    ])
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
  const files = (...names: string[]) => names.map((name) => ({ name, frames: false }))

  it('keeps the plain files directly in the folder, in the order of their names', () => {
    expect(listedOutputs(folderTree({ 'frame_10.png': 5, 'frame_2.png': 5, 'Chart.png': 9, 'b.wav': 1 }))).toStrictEqual({
      outputs: files('b.wav', 'Chart.png', 'frame_2.png', 'frame_10.png'),
      notKept: [],
      problem: null,
    })
  })

  it('keeps no folder, no file of a folder, no link, no empty file, no file over the size limit, and no name that the file calls refuse', () => {
    const { outputs, notKept, problem } = listedOutputs(folderTree({
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
    expect(outputs).toStrictEqual(files('at-limit.mp4', 'ok.png'))
    expect(notKept.map((note) => note.slice(0, note.indexOf(' (')))).toStrictEqual(['big.mp4', '"é.png"', 'empty.png', 'link', '"my chart.png"', 'parts/'])
    expect(notKept.find((note) => note.startsWith('big.mp4'))).toContain(byteSizeText(APP_RUN_MAX_OUTPUT_BYTES))
  })

  it('shows a name with a line break on one line, and only the start of a long name', () => {
    const [lineBreak] = listedOutputs(folderTree({ 'a\nb.png': 4 })).notKept
    expect(lineBreak.startsWith('"a\\nb.png" (')).toBe(true)

    const [long] = listedOutputs(folderTree({ [`${'x '.repeat(400)}.png`]: 4 })).notKept
    expect(long.length).toBeLessThan(400)
  })

  // The folder of a sequence holds many frames, which the listing of the
  // output folder need not hold: the encode lists the folder itself.
  it('takes a folder whose name ends with .frames as a frame sequence, in the order of the names, and no file named so', () => {
    const { outputs, notKept } = listedOutputs(folderTree({
      'b.png': 4,
      'intro.frames': null,
      'intro.frames/000000.png': 9,
      'a.frames': null,
      'notes.frames': 9,
      '.frames': null,
    }, true))

    expect(outputs).toStrictEqual([{ name: 'a.frames', frames: true }, { name: 'b.png', frames: false }, { name: 'intro.frames', frames: true }, { name: 'notes.frames', frames: false }])
    expect(notKept).toStrictEqual(['.frames/ (a folder: Dez keeps only the files directly in the output folder, and a frame sequence in a folder whose name ends with .frames)'])
  })

  it('keeps as many files as the limit, and none of a run with one more; a frame sequence counts as one file', () => {
    const many = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`f${index}.png`, 4]))

    expect(listedOutputs(folderTree(many(APP_RUN_MAX_OUTPUT_FILES))).outputs).toHaveLength(APP_RUN_MAX_OUTPUT_FILES)

    const over = listedOutputs(folderTree({ ...many(APP_RUN_MAX_OUTPUT_FILES + 1), 'notes.txt': 0 }))
    expect(over.outputs).toStrictEqual([])
    expect(over.problem).toContain(`it put ${APP_RUN_MAX_OUTPUT_FILES + 1} files into its output folder`)

    const withSequence = listedOutputs(folderTree({ ...many(APP_RUN_MAX_OUTPUT_FILES), 'clip.frames': null }))
    expect(withSequence.outputs).toStrictEqual([])
    expect(withSequence.problem).toContain(`it put ${APP_RUN_MAX_OUTPUT_FILES + 1} files into its output folder`)
  })

  it('keeps none of a folder with more entries than the listing holds', () => {
    const cut = listedOutputs(folderTree({ 'a.png': 4, 'b.png': 4 }, true))

    expect(cut.outputs).toStrictEqual([])
    expect(cut.problem).toContain(`more than ${APP_OUTPUT_LISTED_ENTRIES} files and folders`)
  })

  // A listing has the entries of the folder itself before those of a
  // folder below, so a cut one with a deeper entry has them all.
  it('keeps the files of a cut listing that reached a folder below', () => {
    expect(listedOutputs(folderTree({ 'a.png': 4, scratch: null, 'scratch/t1.bin': 9 }, true))).toStrictEqual({
      outputs: files('a.png'),
      notKept: ['scratch/ (a folder: Dez keeps only the files directly in the output folder, and a frame sequence in a folder whose name ends with .frames)'],
      problem: null,
    })
  })

  it('tells of an output folder that the app deleted or replaced', () => {
    for (const tree of [MISSING_TREE, fileTree(12)]) {
      const { outputs, notKept, problem } = listedOutputs(tree)

      expect(outputs).toStrictEqual([])
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
    expect(appRunOutcome(EXITED, { type: 'result', text: 'Made 3 notes.' }, false, false)).toStrictEqual({ isError: false, lead: null, given: { text: 'Made 3 notes.', name: 'returned value' }, advice: [] })

    for (const text of [undefined, '', ' \n ']) {
      const outcome = appRunOutcome(EXITED, text === undefined ? { type: 'result' } : { type: 'result', text }, true, false)

      expect([outcome.isError, outcome.given]).toStrictEqual([false, null])
      expect(outcome.lead).not.toBeNull()
    }
  })

  it('gives the error of the code, and the limits of the sandbox only for an error that names a flag of Deno', () => {
    const thrown = appRunOutcome(EXITED, { type: 'error', text: 'TypeError: notes is not iterable\n    at main (/apps/notes/main.ts:4:9)' }, false, false)
    expect(thrown.isError).toBe(true)
    expect(thrown.given?.text).toContain('notes is not iterable')
    expect(thrown.lead).toContain('Dez kept no file of the output folder.')
    expect(thrown.advice).toStrictEqual([])

    const refused = appRunOutcome(EXITED, { type: 'error', text: 'NotCapable: Requires read access to "./state.json", run again with the --allow-read flag' }, false, false)
    expect(refused.advice).toHaveLength(1)
    expect(refused.advice[0]).toContain('dez.appFolder')
    expect(refused.advice[0]).toContain('A relative path does not work.')
  })

  // skia-canvas reads environment variables when it loads, and then its
  // native file; Deno refuses both to a run whose manifest does not ask
  // for it.
  it('tells an app that loads skia-canvas with no field "native" to add the field, and an app with it the limits of the sandbox', () => {
    const envRefused = 'NotCapable: Requires env access to "https_proxy", run again with the --allow-env flag\n'
      + '    at Object.<anonymous> (file:///opt/dez/libs/skia-canvas/lib/urls.js:8:15)'
    const withoutField = appRunOutcome(EXITED, { type: 'error', text: envRefused }, false, false)
    expect(withoutField.advice).toHaveLength(1)
    expect(withoutField.advice[0]).toContain('Add that field to the manifest.json of the app, and run the app again.')
    expect(withoutField.advice[0]).toContain('"native": ["skia-canvas"]')

    expect(appRunOutcome(EXITED, { type: 'error', text: envRefused }, false, true).advice[0]).toContain('A relative path does not work.')
  })

  it('tells why a run with no line ended', () => {
    const tooMuch = appRunOutcome({ kind: 'outputTooLarge' }, null, true, false)
    expect([tooMuch.isError, tooMuch.given]).toStrictEqual([true, null])
    expect(tooMuch.lead).toContain(byteSizeText(JS_EVAL_OUTPUT_BYTES))

    const killed = appRunOutcome({ kind: 'exited', code: null }, null, false, false)
    expect(killed.isError).toBe(true)
    expect(killed.lead).toContain('memory')
    expect(killed.lead).toContain('wrote nothing to the console')

    const exited = appRunOutcome({ kind: 'exited', code: 1 }, null, true, false)
    expect(exited.isError).toBe(true)
    expect(exited.lead).toContain('exit code 1')
    expect(exited.lead).toContain('The console output tells which.')
    expect(appRunOutcome({ kind: 'exited', code: 1 }, null, false, false).lead).toContain('wrote nothing to the console')
  })
})

describe('appRunResult', () => {
  const RETURNED: RunOutcome = { isError: false, lead: null, given: { text: 'Made the sheet.', name: 'returned value' }, advice: [] }
  const outputs = (more: Partial<AppOutputs>): AppOutputs => ({ ...NO_APP_OUTPUTS, ...more })

  it('gives the value, then the kept files in the order of their ids, with the clip of a frame sequence, then the console output', () => {
    const { text, isError } = appRunResult(RETURNED, 'read 2 files\n', asIs, outputs({
      kept: [
        { name: 'sheet.png', kind: 'image', type: 'image/png', extension: 'png' },
        { name: 'song.bin', kind: 'audio', type: 'audio/wav', extension: 'wav' },
        { name: 'intro.frames', kind: 'video', type: 'video/mp4', extension: 'mp4', frames: { fps: 24, width: 64, height: 36, count: 90, alpha: false, format: 'png' } },
        { name: 'glow.frames', kind: 'video', type: 'video/quicktime', extension: 'mov', frames: { fps: 24, width: 64, height: 36, count: 1, alpha: true, format: 'rgba' } },
      ],
    }), NO_APP_RUN_CALLS)

    expect(isError).toBe(false)
    expect(text.split('\n\n')).toStrictEqual([
      'Made the sheet.',
      'Dez keeps 4 files of the output folder: sheet.png (image), song.bin (audio clip), intro.frames/ (video clip: 90 frames, H.264 in MP4), '
        + 'glow.frames/ (video clip: 1 frame, PNG in MOV with alpha). The lines at the end give their ids in this order.',
      'Console output of the code:\nread 2 files',
    ])
  })

  it('tells of one kept file, and of the entries that Dez did not keep', () => {
    const { text } = appRunResult(RETURNED, '', asIs, outputs({
      kept: [{ name: 'sheet.png', kind: 'image', type: 'image/png', extension: 'png' }],
      notKept: ['notes.txt (Dez stores no file of its type)', 'parts/ (a folder: Dez keeps only the files directly in the output folder)'],
    }), NO_APP_RUN_CALLS)

    expect(text).toContain('Dez keeps 1 file of the output folder: sheet.png (image).')
    expect(text).toContain('Dez did not keep notes.txt (Dez stores no file of its type), parts/ (a folder: Dez keeps only the files directly in the output folder).')
  })

  it('names at most 20 entries that Dez did not keep, with the count of the rest', () => {
    const { text } = appRunResult(RETURNED, '', asIs, outputs({ notKept: Array.from({ length: 23 }, (_, index) => `n${index}.txt (it is empty)`) }), NO_APP_RUN_CALLS)

    expect(text).toContain('n19.txt (it is empty), and 3 more of the output folder.')
    expect(text).not.toContain('n20.txt')
  })

  it('tells nothing of the output folder of a run that left nothing in it', () => {
    expect(appRunResult(RETURNED, '', asIs, NO_APP_OUTPUTS, NO_APP_RUN_CALLS)).toStrictEqual({ text: 'Made the sheet.', isError: false })
  })

  it('makes a run whose outputs have a problem an error that still gives the value', () => {
    const { problem } = listedOutputs(folderTree({ 'a.png': 4 }, true))
    const { text, isError } = appRunResult(RETURNED, '', asIs, outputs({ problem }), NO_APP_RUN_CALLS)

    expect(isError).toBe(true)
    expect(text.startsWith(`${problem} The app returned:\nMade the sheet.`)).toBe(true)

    const noValue = appRunResult(appRunOutcome(EXITED, { type: 'result' }, false, false), '', asIs, outputs({ problem }), NO_APP_RUN_CALLS)
    expect(noValue.isError).toBe(true)
    expect(noValue.text).toBe(`${problem} The app ended with no error and returned no value.`)
  })

  it('tells, after the kept files, the assets of the tool calls of the code by their handles, their open jobs, and their cut calls', () => {
    const { text, isError } = appRunResult(RETURNED, 'flipped\n', asIs, outputs({ kept: [{ name: 'sheet.png', kind: 'image', type: 'image/png', extension: 'png' }] }), {
      made: [{ kind: 'image', handle: '&1' }, { kind: 'video', handle: '&2' }],
      jobs: [{ id: 'j-aaaa', number: 2 }],
      unanswered: 1,
    })

    expect(isError).toBe(false)
    expect(text.split('\n\n')).toStrictEqual([
      'Made the sheet.',
      'Dez keeps 1 file of the output folder: sheet.png (image). The line at the end gives its id.',
      'Dez keeps the 2 assets that the tool calls of the code made: &1 (image), &2 (video clip). Their lines at the end give their ids, each with its handle.',
      `From the tool calls of the code:\n${jobStartedText('j-aaaa', 2)}`,
      expect.stringMatching(/^1 tool call of the code had not ended when the code ended, so Dez cut it short\./),
      'Console output of the code:\nflipped',
    ])
  })

  it('tells the one asset of a call of a run that failed, and no job line that the value holds', () => {
    const thrown = appRunOutcome(EXITED, { type: 'error', text: `Error: ${jobStartedText('j-aaaa', 1)}` }, false, false)
    const { text, isError } = appRunResult(thrown, '', asIs, NO_APP_OUTPUTS, { made: [{ kind: 'audio', handle: '&1' }], jobs: [{ id: 'j-aaaa', number: 1 }], unanswered: 0 })

    expect(isError).toBe(true)
    expect(text).toContain('Dez kept no file of the output folder.')
    expect(text).toContain('Dez keeps the asset that a tool call of the code made: &1 (audio clip). Its line at the end gives its id, with its handle.')
    expect(text).not.toContain('From the tool calls of the code')
  })

  it('gives each text of the run with no path of this computer', () => {
    const runFolder = '/home/ann/.cache/dez/work/w1'
    const workFolder = '/home/ann/.config/dez/work/c1'
    const forModel = (text: string) => textForModel(text, { run: [runFolder], apps: ['/home/ann/.config/dez/apps'], work: [workFolder] })
    const thrown = appRunOutcome(EXITED, { type: 'error', text: 'Error: no file /home/ann/.config/dez/apps/notes/state.json\n    at main (file:///home/ann/.config/dez/apps/notes/main.ts:7:11)' }, true, false)
    const { text, isError } = appRunResult(thrown, `wrote ${runFolder}/output/a.png and ${workFolder}/cache.json\n`, forModel, NO_APP_OUTPUTS, NO_APP_RUN_CALLS)

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
