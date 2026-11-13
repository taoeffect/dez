import sbp from '@sbp/sbp'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { DrawnImage, DrawnMediaType, ImageDrawing, ImageSize } from '../model/chat/imageDrawing'
import { MAX_SAVED_CLIP_BYTES } from '../model/chat/mediaFiles'
import { mediaTagText, type MediaTagData } from '../model/chat/mediaTags'
import type { Section } from '../model/chat/types'
import { reply, user } from '../model/streams/testing'
import { unreadableImageText } from '../model/tools/imageTool'
import { jobTimedOutText } from '../model/tools/jobs'
import { INPUT_CLIP_TOO_LARGE, outputNotStoredText, programNotStartedText } from '../model/tools/programRuns'
import { CONVERSATION, FILM, LOOP, OPUS, probeOutput, SKY, SONG, VP9 } from '../model/tools/testing'
import { clipReadProblemText } from '../model/tools/toolInputs'
import { ToolError } from '../model/tools/types'
import {
  clipFacts,
  FFMPEG_OUTPUT_BYTES,
  ffmpegCall,
  ffmpegStateText,
  FFPROBE_OUTPUT_BYTES,
  FFPROBE_TIMEOUT_MS,
  ffprobeCall,
  ffprobeFailedText,
  JOIN_READS_CLIPS,
  joinClipsCall,
  joinNoVideoText,
  joinPlan,
  joinProbeArgs,
  joinProbeFailedText,
  jpegCopyFailedText,
  OutputStart,
  PROGRAM_OUTPUT_CAP,
  VIDEO_READS_INPUTS,
  type ClipFacts,
} from '../model/tools/videoTool'
import { errorText } from '../utils/errorText'
import type { BundledToolEnd } from './nativeTypes'
import { APP_DIR, CACHE_DIR, deletedWorkFolder, ENDED, failureOf, FILE_ID, native, refusalOf, resetNative, running, SAVED, STOP, writes, type StubProgram } from './testing'
import { runFfmpegJob, runFfprobe, runJoinJob } from './videoTool'

// A conversation whose only asset is the video clip `a`, in a user section.
function withClip(clip: Partial<MediaTagData>): Section[] {
  return [user('u1', mediaTagText({ kind: 'video', id: 'a', type: 'video/mp4', src: null, url: null, expires: null, other: [], ...clip }))]
}

const IMAGE_SIZE: ImageSize = { width: 40, height: 30 }
const JPEG_BYTES = new Uint8Array([7])
// A progress line as ffmpeg writes it, and as the state of a job has it.
const PROGRESS = 'frame=   10 fps=9.8 q=-0.0 Lsize=      12KiB time=00:00:02.00 bitrate=  49.1kbits/s speed=1.96x    '
const PROGRESS_STATE = ffmpegStateText('frame=10 fps=9.8 q=-0.0 Lsize=12KiB time=00:00:02.00 bitrate=49.1kbits/s speed=1.96x')

// The stub image store and webview (the native side is in testing.ts).
// Set in beforeEach and by the tests.
let readImages: string[] = []
let drawings: { drawing: ImageDrawing | null, mediaType: string }[] = []
// Set to make the webview fail to draw.
let redrawError: Error | undefined
let deletedImages: string[] = []
let deletedClips: string[] = []
// The states that the work of a job reported.
let states: string[] = []
let consoleError: MockInstance<typeof console.error>

sbp('sbp/selectors/register', {
  async 'dez.controller/images/readFile' (path: string): Promise<File> {
    readImages.push(path)
    return new File([new Uint8Array([1])], 'image')
  },
  async 'dez.controller/images/redraw' (_file: Blob, plan: (size: ImageSize) => ImageDrawing | null, mediaType: DrawnMediaType): Promise<DrawnImage> {
    if (redrawError) throw redrawError
    drawings.push({ drawing: plan(IMAGE_SIZE), mediaType })
    return { bytes: JPEG_BYTES, mediaType, ...IMAGE_SIZE }
  },
  async 'dez.controller/images/delete' (path: string): Promise<void> {
    deletedImages.push(path)
  },
  async 'dez.controller/media/delete' (path: string): Promise<void> {
    deletedClips.push(path)
  },
})

beforeEach(() => {
  resetNative()
  readImages = []
  drawings = []
  redrawError = undefined
  deletedImages = []
  deletedClips = []
  states = []
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

function report(state: string): void {
  states.push(state)
}

describe('runFfmpegJob', () => {
  it('runs ffmpeg in a new work folder on copies of the input files, and stores its new files as the assets of the job', async () => {
    const call = ffmpegCall({ arguments: '-i @c -i @b -map 0:v -map 1:a out.mp4', timeout_seconds: 90 }, CONVERSATION)
    native.program = writes('stderr', `${PROGRESS}\r`)
    native.folderFiles = ['b.wav', 'c.webm', 'out.mp4', 'frame_1.jpg', 'notes.txt']

    const outcome = await runFfmpegJob(call, running(), report)

    const folder = deletedWorkFolder()
    expect(native.runs.map(({ run }) => run)).toStrictEqual([{
      tool: 'dez-ffmpeg',
      args: call.args,
      folder,
      inputs: [{ name: 'c.webm', source: FILM.src }, { name: 'b.wav', source: SONG.src }],
      timeoutMs: 90_000,
      maxOutputBytes: FFMPEG_OUTPUT_BYTES,
    }])
    expect(native.listedFolders).toStrictEqual([{ root: 'cache', path: folder }])
    expect(native.moves.map(({ from, to }) => [from.root, from.path, to.root, to.path.replace(FILE_ID, '<id>')])).toStrictEqual([
      ['cache', `${folder}/frame_1.jpg`, 'app', 'assets/generated/images/<id>.jpg'],
      ['cache', `${folder}/out.mp4`, 'app', 'assets/generated/video/<id>.mp4'],
    ])
    expect(outcome.assets).toStrictEqual([
      { kind: 'image', path: `${APP_DIR}/${native.moves[0].to.path}` },
      { kind: 'clip', clip: { kind: 'video', type: 'video/mp4', src: `${APP_DIR}/${native.moves[1].to.path}`, url: null, expires: null } },
    ])
    expect(outcome.isError).toBe(false)
    expect(outcome.text).toContain('frame_1.jpg (image), out.mp4 (video clip)')
    expect(outcome.text).toContain('notes.txt')
    expect(states).toStrictEqual([VIDEO_READS_INPUTS, ffmpegStateText(''), PROGRESS_STATE])
    expect(native.deletedFiles).toHaveLength(1)
  })

  it('gives a PNG image as a JPEG copy that the webview draws on white', async () => {
    const call = ffmpegCall({ arguments: '-loop 1 -i @e -t 2 out.mp4' }, CONVERSATION)

    await runFfmpegJob(call, running(), report)

    const folder = deletedWorkFolder()
    expect(readImages).toStrictEqual([SKY])
    expect(drawings).toStrictEqual([{ drawing: { crop: { x: 0, y: 0, ...IMAGE_SIZE }, ...IMAGE_SIZE, background: '#ffffff' }, mediaType: 'image/jpeg' }])
    expect(native.savedFiles).toStrictEqual([{ file: { root: 'cache', path: `${folder}/e.jpg` }, content: JPEG_BYTES }])
    expect(native.runs[0].run.inputs).toStrictEqual([])
  })

  it('downloads a clip that is only at its web address into the folder, with no provider header', async () => {
    const call = ffmpegCall({ arguments: '-i @d out.webm' }, CONVERSATION)

    await runFfmpegJob(call, running(), report)

    const folder = deletedWorkFolder()
    expect(native.downloads).toStrictEqual([{
      request: { method: 'GET', url: LOOP.url, timeoutMs: 30 * 60 * 1000 },
      requestId: expect.any(String),
      file: { root: 'cache', path: `${folder}/d.webm` },
      rule: { maxBytes: MAX_SAVED_CLIP_BYTES },
    }])
    expect(native.runs[0].run.inputs).toStrictEqual([])
  })

  it('takes the web address of a clip whose temp copy is gone', async () => {
    const call = ffmpegCall({ arguments: '-i @a out.mp4' }, withClip({ src: `${CACHE_DIR}/media/gone.mp4`, url: 'https://clips.example/a.mp4' }))
    native.fileSize = () => null

    await runFfmpegJob(call, running(), report)

    expect(native.downloads.map(({ request, file }) => [request.url, file.path])).toStrictEqual([['https://clips.example/a.mp4', `${deletedWorkFolder()}/a.mp4`]])
    expect(native.runs[0].run.inputs).toStrictEqual([])
  })

  it('deletes the part of a download that failed, and runs no program', async () => {
    const call = ffmpegCall({ arguments: '-i @d out.webm' }, CONVERSATION)
    native.downloadAppFile = async () => ({ ...SAVED, saved: false, status: 403 })

    const refusal = await refusalOf(runFfmpegJob(call, running(), report))

    const folder = deletedWorkFolder()
    expect(refusal).toBe(errorText(clipReadProblemText('video', 'd', 'video', 'unreadable'), 'The server of the clip answered HTTP 403.'))
    expect(native.deletedFiles).toStrictEqual([{ root: 'cache', path: `${folder}/d.webm`, folder: false }, { root: 'cache', path: folder, folder: true }])
    expect(native.runs).toStrictEqual([])
  })

  it.each([
    ['a clip with no file and no web address', {}, () => {}, 'deleted', ''],
    [
      'a clip whose web address has expired',
      { url: 'https://clips.example/a.mp4', expires: '2020-01-01T00:00:00.000Z' },
      () => { native.downloadAppFile = async () => ({ ...SAVED, saved: false, status: 403 }) },
      'expired',
      'The server of the clip answered HTTP 403.',
    ],
    [
      'a saved clip whose file is gone',
      { src: `${APP_DIR}/assets/video/v.mp4` },
      () => { native.fileSize = () => null },
      'unreadable',
      'The file of the clip is gone, or Dez may not read it.',
    ],
    [
      'a linked clip that is larger than a stored clip can be',
      { src: '/home/u/Videos/trip.mp4' },
      () => { native.fileSize = () => MAX_SAVED_CLIP_BYTES + 1 },
      'unreadable',
      INPUT_CLIP_TOO_LARGE,
    ],
  ] as const)('refuses %s, and tells the model that the call is not at fault', async (_, clip, setup, problem, details) => {
    const call = ffmpegCall({ arguments: '-i @a out.mp4' }, withClip(clip))
    setup()

    const refusal = await refusalOf(runFfmpegJob(call, running(), report))

    expect(refusal).toBe(errorText(clipReadProblemText('video', 'a', 'video', problem), details))
    expect(refusal).not.toContain('/home/u')
    expect(native.runs).toStrictEqual([])
    deletedWorkFolder()
  })

  it('gives a linked clip of a user section to the program as a copy', async () => {
    const call = ffmpegCall({ arguments: '-i @a out.mp4' }, withClip({ src: '/home/u/Videos/trip.mp4' }))
    native.fileSize = () => MAX_SAVED_CLIP_BYTES

    await runFfmpegJob(call, running(), report)

    expect(native.runs[0].run.inputs).toStrictEqual([{ name: 'a.mp4', source: '/home/u/Videos/trip.mp4' }])
  })

  it('refuses an image whose file is gone, and one that the webview cannot draw', async () => {
    native.fileSize = () => null
    redrawError = new Error('The image did not decode.')

    const gone = await refusalOf(runFfmpegJob(ffmpegCall({ arguments: '-i @a out.mp4' }, CONVERSATION), running(), report))
    const notDrawn = await refusalOf(runFfmpegJob(ffmpegCall({ arguments: '-i @e out.mp4' }, CONVERSATION), running(), report))

    expect(gone).toBe(unreadableImageText('a'))
    expect(notDrawn).toBe(jpegCopyFailedText('e'))
    expect(native.runs).toStrictEqual([])
    expect(native.deletedFiles).toHaveLength(2)
  })

  it('stops the program at a stop of the call, and rejects with the stop when the program is gone', async () => {
    const call = ffmpegCall({ arguments: '-i @c out.mp4' }, CONVERSATION)
    const stop = new AbortController()
    let end: (end: BundledToolEnd) => void = () => {}
    native.program = () => new Promise((resolve) => { end = resolve })
    native.folderFiles = ['c.webm', 'out.mp4']

    const work = failureOf(runFfmpegJob(call, stop.signal, report))
    await vi.waitFor(() => expect(native.runs).toHaveLength(1))
    stop.abort(STOP)

    expect(native.cancelledRuns).toStrictEqual([native.runs[0].runId])
    // The program can still write into the folder.
    expect(native.deletedFiles).toStrictEqual([])

    end({ kind: 'cancelled' })

    expect(await work).toBe(STOP)
    expect(deletedWorkFolder()).toBe(native.runs[0].run.folder)
    expect(native.moves).toStrictEqual([])
  })

  it('starts no program after a stop while it gets the inputs ready', async () => {
    const call = ffmpegCall({ arguments: '-i @d out.webm' }, CONVERSATION)
    const stop = new AbortController()
    let fail: (error: Error) => void = () => {}
    native.downloadAppFile = () => new Promise((_resolve, reject) => { fail = reject })

    const work = failureOf(runFfmpegJob(call, stop.signal, report))
    await vi.waitFor(() => expect(native.downloads).toHaveLength(1))
    stop.abort(STOP)
    fail(new Error('The request was cancelled.'))

    expect(await work).toBe(STOP)
    expect(native.cancelledDownloads).toStrictEqual([native.downloads[0].requestId])
    expect(native.runs).toStrictEqual([])
    expect(native.deletedFiles.map(({ path }) => path)).toStrictEqual([native.downloads[0].file.path, deletedWorkFolder()])
  })

  it('fails with no tool text when a run was cancelled with no stop of its call', async () => {
    native.program = async () => ({ kind: 'cancelled' })

    const error = await failureOf(runFfmpegJob(ffmpegCall({ arguments: '-i @c out.mp4' }, CONVERSATION), running(), report))

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(ToolError)
    deletedWorkFolder()
  })

  it('tells the model of a program that did not start, without the text of the system', async () => {
    const failure = new Error(`Could not copy ${FILM.src}: permission denied`)
    native.program = async () => { throw failure }

    const refusal = await refusalOf(runFfmpegJob(ffmpegCall({ arguments: '-i @c out.mp4' }, CONVERSATION), running(), report))

    expect(refusal).toBe(programNotStartedText('ffmpeg', 'video'))
    expect(consoleError).toHaveBeenCalledWith('Failed to run ffmpeg:', failure)
    expect(native.listedFolders).toStrictEqual([])
    deletedWorkFolder()
  })

  it('gives the time limit text for a run that the backend stopped at the limit, and keeps no file', async () => {
    const call = ffmpegCall({ arguments: '-i @c out.mp4', timeout_seconds: 30 }, CONVERSATION)
    native.program = writes('stderr', `${PROGRESS}\r`, { kind: 'timedOut' })
    native.folderFiles = ['c.webm', 'out.mp4']

    const outcome = await runFfmpegJob(call, running(), report)

    expect(outcome).toStrictEqual({ text: jobTimedOutText(30_000, PROGRESS_STATE), isError: true, assets: [] })
    expect(native.moves).toStrictEqual([])
    deletedWorkFolder()
  })

  it('keeps no file of a run that failed, and gives its log with no local path', async () => {
    native.program = writes('stderr', `[in#0 @ 0x55] Error opening input: ${CACHE_DIR}/work/x/c.webm\n`, { kind: 'exited', code: 1 })
    native.folderFiles = ['c.webm', 'out.mp4']

    const outcome = await runFfmpegJob(ffmpegCall({ arguments: '-i @c out.mp4' }, CONVERSATION), running(), report)

    expect(outcome).toMatchObject({ isError: true, assets: [] })
    expect(outcome.text).toContain('ffmpeg ended with the error code 1')
    expect(outcome.text).toContain('Error opening input: /home/…')
    expect(outcome.text).not.toContain('/home/u')
    expect(native.moves).toStrictEqual([])
  })

  it('gives the standard output of a run that only prints, and a state with no local path', async () => {
    native.program = async (_run, onOutput) => {
      onOutput({ stream: 'stdout', text: ' V....D libvpx-vp9\n' })
      onOutput({ stream: 'stderr', text: `size=1KiB title=/home/u/Videos/trip.mp4\r` })
      return ENDED
    }

    const outcome = await runFfmpegJob(ffmpegCall({ arguments: '-encoders' }, CONVERSATION), running(), report)

    expect(outcome).toStrictEqual({ text: expect.stringContaining('Its output:\nV....D libvpx-vp9'), isError: false, assets: [] })
    expect(states.at(-1)).toBe(ffmpegStateText('size=1KiB title=/home/…'))
  })

  it('keeps none of the new files when one does not move into the Dez folder', async () => {
    native.folderFiles = ['c.webm', 'frame_1.jpg', 'out.mp4']
    native.moveAppFile = async (from) => {
      if (from.path.endsWith('/out.mp4')) throw new Error(`${APP_DIR}: the disk is full`)
    }

    const refusal = await refusalOf(runFfmpegJob(ffmpegCall({ arguments: '-i @c out.mp4 frame_%d.jpg' }, CONVERSATION), running(), report))

    expect(refusal).toBe(outputNotStoredText('video'))
    expect(deletedImages).toStrictEqual([`${APP_DIR}/${native.moves[0].to.path}`])
    expect(deletedClips).toStrictEqual([])
    deletedWorkFolder()
  })

  it('gives the result of a run whose work folder Dez could not delete', async () => {
    native.folderFiles = ['c.webm', 'out.mp4']
    native.deleteAppFile = async () => { throw new Error('The folder is busy.') }

    const outcome = await runFfmpegJob(ffmpegCall({ arguments: '-i @c out.mp4' }, CONVERSATION), running(), report)

    expect(outcome.assets).toHaveLength(1)
    expect(consoleError).toHaveBeenCalledWith(`Failed to delete the work folder ${native.runs[0].run.folder}:`, expect.any(Error))
  })
})

describe('runJoinJob', () => {
  const facts = clipFacts(probeOutput([VP9])) as ClipFacts
  // Two video clips with files on this computer: `a` and `b`.
  const CLIPS = [
    user('u1', mediaTagText({ ...FILM, id: 'a' })),
    reply('a1', mediaTagText({ kind: 'video', id: 'b', type: 'video/webm', src: `${APP_DIR}/assets/generated/video/v2.webm`, url: null, expires: null, other: [] })),
  ]

  // A backend whose ffprobe gives `probes[name of the clip file]`, and
  // whose ffmpeg ends with no error.
  function probing(probes: Record<string, string>): StubProgram {
    return async (run, onOutput) => {
      if (run.tool === 'dez-ffprobe') onOutput({ stream: 'stdout', text: probes[run.args.at(-1) ?? ''] })
      return ENDED
    }
  }

  it('reads each clip once, and joins clips whose streams match from a list file, with no new encode', async () => {
    const call = joinClipsCall({ clips: '@a @b @a', timeout_seconds: 45 }, CLIPS)
    const plan = joinPlan(['a.webm', 'b.webm', 'a.webm'].map((name) => ({ name, facts })))
    native.program = probing({ 'a.webm': probeOutput([VP9]), 'b.webm': probeOutput([VP9]) })
    native.folderFiles = ['a.webm', 'b.webm', 'list.txt', 'joined.webm', 'other.mp4']

    const outcome = await runJoinJob(call, running(), report)

    const folder = deletedWorkFolder()
    const probe = { tool: 'dez-ffprobe', folder, timeoutMs: FFPROBE_TIMEOUT_MS, maxOutputBytes: FFPROBE_OUTPUT_BYTES }
    expect(native.runs.map(({ run }) => run)).toStrictEqual([
      // Only the first run of a folder copies the input files into it.
      { ...probe, args: joinProbeArgs('a.webm'), inputs: [{ name: 'a.webm', source: FILM.src }, { name: 'b.webm', source: `${APP_DIR}/assets/generated/video/v2.webm` }] },
      { ...probe, args: joinProbeArgs('b.webm'), inputs: [] },
      { tool: 'dez-ffmpeg', args: plan.args, folder, inputs: [], timeoutMs: 45_000, maxOutputBytes: FFMPEG_OUTPUT_BYTES },
    ])
    expect(plan.kind).toBe('copy')
    expect(native.savedFiles).toStrictEqual([{ file: { root: 'cache', path: `${folder}/list.txt` }, content: 'ffconcat version 1.0\nfile \'a.webm\'\nfile \'b.webm\'\nfile \'a.webm\'\n' }])
    // Only the joined clip is kept, not another file that ffmpeg made.
    expect(native.moves.map(({ from }) => from.path)).toStrictEqual([`${folder}/joined.webm`])
    expect(outcome).toStrictEqual({
      text: 'Joined the 3 clips into one clip with no new encode: their streams match.',
      isError: false,
      assets: [{ kind: 'clip', clip: { kind: 'video', type: 'video/webm', src: `${APP_DIR}/${native.moves[0].to.path}`, url: null, expires: null } }],
    })
    expect(states).toStrictEqual([VIDEO_READS_INPUTS, JOIN_READS_CLIPS, ffmpegStateText('')])
  })

  it('encodes clips whose streams do not match again, with no list file', async () => {
    const call = joinClipsCall({ clips: '@a @b' }, CLIPS)
    const withSound = clipFacts(probeOutput([{ ...VP9, width: 64 }, OPUS])) as ClipFacts
    const plan = joinPlan([{ name: 'a.webm', facts }, { name: 'b.webm', facts: withSound }])
    native.program = probing({ 'a.webm': probeOutput([VP9]), 'b.webm': probeOutput([{ ...VP9, width: 64 }, OPUS]) })
    native.folderFiles = ['a.webm', 'b.webm', 'joined.webm']

    const outcome = await runJoinJob(call, running(), report)

    expect(plan.kind).toBe('encode')
    expect(native.runs.at(-1)?.run.args).toStrictEqual(plan.args)
    expect(native.savedFiles).toStrictEqual([])
    expect(outcome.text).toContain('Joined the 2 clips into one 48x36 WebM (VP9, Opus) clip.')
    expect(outcome.assets).toHaveLength(1)
  })

  it('reads the facts of a clip whose probe output is longer than a result holds', async () => {
    // A clip with many sound tracks, for which ffprobe writes more than
    // `PROGRAM_OUTPUT_CAP` characters of JSON.
    const long = probeOutput([VP9, ...Array.from({ length: 150 }, (_, index) => ({ ...OPUS, index: index + 1 }))])
    expect(long.length).toBeGreaterThan(PROGRAM_OUTPUT_CAP)
    native.program = probing({ 'a.webm': long, 'b.webm': long })
    native.folderFiles = ['a.webm', 'b.webm', 'list.txt', 'joined.webm']

    const outcome = await runJoinJob(joinClipsCall({ clips: '@a @b' }, CLIPS), running(), report)

    expect(outcome).toMatchObject({ text: 'Joined the 2 clips into one clip with no new encode: their streams match.', isError: false })
    expect(outcome.assets).toHaveLength(1)
  })

  it('joins nothing when ffprobe cannot read a clip, and gives its output with no local path', async () => {
    const end: BundledToolEnd = { kind: 'exited', code: 1 }
    native.program = writes('stderr', `${CACHE_DIR}/work/x/a.webm: Invalid data found when processing input\n`, end)

    const refusal = await refusalOf(runJoinJob(joinClipsCall({ clips: '@a @b' }, CLIPS), running(), report))

    expect(refusal).toBe(joinProbeFailedText('a', end, '/home/…'))
    expect(native.runs).toHaveLength(1)
    deletedWorkFolder()
  })

  it('joins nothing when the file of a clip holds no picture', async () => {
    native.program = probing({ 'a.webm': probeOutput([VP9]), 'b.webm': probeOutput([OPUS]) })

    const refusal = await refusalOf(runJoinJob(joinClipsCall({ clips: '@a @b' }, CLIPS), running(), report))

    expect(refusal).toBe(joinNoVideoText('b'))
    expect(native.runs.map(({ run }) => run.tool)).toStrictEqual(['dez-ffprobe', 'dez-ffprobe'])
  })

  it('gives an error when ffmpeg ended with no error and made no joined clip', async () => {
    native.program = probing({ 'a.webm': probeOutput([VP9]), 'b.webm': probeOutput([VP9]) })
    native.folderFiles = ['a.webm', 'b.webm', 'list.txt', 'other.mp4']

    const outcome = await runJoinJob(joinClipsCall({ clips: '@a @b' }, CLIPS), running(), report)

    expect(outcome).toMatchObject({ isError: true, assets: [] })
    expect(outcome.text).toContain('it made no clip that Dez can store')
    expect(native.moves).toStrictEqual([])
  })

  it('tells why Dez did not keep a joined clip that is too large', async () => {
    native.program = probing({ 'a.webm': probeOutput([VP9]), 'b.webm': probeOutput([VP9]) })
    native.folderFiles = ['a.webm', 'b.webm', 'list.txt', 'joined.webm']
    native.folderFileSize = MAX_SAVED_CLIP_BYTES + 1

    const outcome = await runJoinJob(joinClipsCall({ clips: '@a @b' }, CLIPS), running(), report)

    expect(outcome).toMatchObject({ isError: true, assets: [] })
    expect(outcome.text).toContain('it made no clip that Dez can store. Dez did not keep joined.webm (it is larger than')
    expect(native.moves).toStrictEqual([])
  })

  it('runs no ffmpeg when Dez cannot write the list file', async () => {
    native.program = probing({ 'a.webm': probeOutput([VP9]), 'b.webm': probeOutput([VP9]) })
    native.saveAppFile = async () => { throw new Error(`${CACHE_DIR}: the disk is full`) }

    const refusal = await refusalOf(runJoinJob(joinClipsCall({ clips: '@a @b' }, CLIPS), running(), report))

    expect(refusal).toBe(programNotStartedText('ffmpeg', 'video'))
    expect(native.runs.map(({ run }) => run.tool)).toStrictEqual(['dez-ffprobe', 'dez-ffprobe'])
    deletedWorkFolder()
  })
})

describe('runFfprobe', () => {
  it('gives what ffprobe wrote, with no local path, from one run on copies of the inputs', async () => {
    const call = ffprobeCall({ arguments: '-show_format -of json @c' }, CONVERSATION)
    native.program = async (_run, onOutput) => {
      onOutput({ stream: 'stdout', text: '{ "format": { "filename": "c.webm", "tags": { "comment": "/home/u/Videos/trip.mp4" } } }\n' })
      onOutput({ stream: 'stderr', text: 'Input #0, matroska,webm\n' })
      return ENDED
    }

    const text = await runFfprobe(call, running())

    expect(text).toBe('{ "format": { "filename": "c.webm", "tags": { "comment": "/home/…\n\nInput #0, matroska,webm')
    expect(native.runs.map(({ run }) => run)).toStrictEqual([{
      tool: 'dez-ffprobe',
      args: call.args,
      folder: deletedWorkFolder(),
      inputs: [{ name: 'c.webm', source: FILM.src }],
      timeoutMs: FFPROBE_TIMEOUT_MS,
      maxOutputBytes: FFPROBE_OUTPUT_BYTES,
    }])
  })

  it.each([
    [{ kind: 'exited', code: 1 }],
    [{ kind: 'timedOut' }],
    [{ kind: 'outputTooLarge' }],
  ] as const)('fails with what ffprobe wrote for a run that ended with %j', async (end) => {
    native.program = writes('stderr', 'c.webm: Invalid data found when processing input\n', end)
    const written = new OutputStart()
    written.add('c.webm: Invalid data found when processing input\n')

    const refusal = await refusalOf(runFfprobe(ffprobeCall({ arguments: '@c' }, CONVERSATION), running()))

    expect(refusal).toBe(ffprobeFailedText(end, new OutputStart(), written))
    deletedWorkFolder()
  })

  it('stops ffprobe at a stop of the call', async () => {
    const stop = new AbortController()
    let end: (end: BundledToolEnd) => void = () => {}
    native.program = () => new Promise((resolve) => { end = resolve })

    const work = failureOf(runFfprobe(ffprobeCall({ arguments: '@c' }, CONVERSATION), stop.signal))
    await vi.waitFor(() => expect(native.runs).toHaveLength(1))
    stop.abort(STOP)
    end({ kind: 'cancelled' })

    expect(await work).toBe(STOP)
    expect(native.cancelledRuns).toStrictEqual([native.runs[0].runId])
    deletedWorkFolder()
  })
})
