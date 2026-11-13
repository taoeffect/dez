import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_SAVED_CLIP_BYTES } from '../model/chat/mediaFiles'
import type { ClipAttachment } from '../model/providers/clipInputs'
import {
  AUDIO_CUT_FILE,
  AUDIO_CUT_TOO_LARGE_TEXT,
  AUDIO_NOT_FOUND_DETAILS,
  AUDIO_RUN_OUTPUT_BYTES,
  AUDIO_RUN_TIMEOUT_MS,
  audioCutArgs,
  audioDecodeFailedText,
  audioEmptyCutText,
  audioLengthArgs,
  audioRunDetails,
  audioTimedOutText,
} from '../model/tools/audioTool'
import { outputNotStoredText } from '../model/tools/programRuns'
import { clipReadProblemText } from '../model/tools/toolInputs'
import { errorText } from '../utils/errorText'
import { audioClipSeconds, cutAudioClip } from './audioTool'
import { APP_DIR, audioProgress, CACHE_DIR, deletedWorkFolder, ENDED, FILE_ID, native, refusalOf, resetNative, running, writes } from './testing'

// The audio clip `b`, a saved MP3 file.
const SONG: ClipAttachment = { kind: 'audio', id: 'b', type: 'audio/mpeg', src: `${APP_DIR}/assets/generated/audio/song.mp3`, url: null, expires: null }
const PART = { start: 1, end: 3.5 }

beforeEach(() => {
  resetNative()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('cutAudioClip', () => {
  it('cuts the part with one ffmpeg run on a copy of the clip, and stores the new WAV file as a generated clip', async () => {
    native.program = writes('stdout', audioProgress(2.5))
    native.folderFiles = ['b.mp3', AUDIO_CUT_FILE.name]

    const cut = await cutAudioClip(SONG, PART, running())

    const folder = deletedWorkFolder()
    expect(native.runs.map(({ run }) => run)).toStrictEqual([{
      tool: 'dez-ffmpeg',
      args: audioCutArgs('b.mp3', PART),
      folder,
      inputs: [{ name: 'b.mp3', source: SONG.src }],
      timeoutMs: AUDIO_RUN_TIMEOUT_MS,
      maxOutputBytes: AUDIO_RUN_OUTPUT_BYTES,
    }])
    expect(native.moves.map(({ from, to }) => [from.root, from.path, to.root, to.path.replace(FILE_ID, '<id>')])).toStrictEqual([
      ['cache', `${folder}/${AUDIO_CUT_FILE.name}`, 'app', 'assets/generated/audio/<id>.wav'],
    ])
    expect(cut).toStrictEqual({
      clip: { kind: 'audio', type: 'audio/wav', src: `${APP_DIR}/${native.moves[0].to.path}`, url: null, expires: null },
      seconds: 2.5,
    })
  })

  it('takes the last length of a long progress output, whose lines come in pieces', async () => {
    native.program = async (_run, onOutput) => {
      for (let block = 1; block <= 40; block++) {
        onOutput({ stream: 'stdout', text: `frame=N/A\nfps=0.00\nbitrate=1536.0kbits/s\nout_time_us=${block * 500_000}\nprogress=continue\n` })
      }
      onOutput({ stream: 'stdout', text: 'out_time_us=2050' })
      onOutput({ stream: 'stdout', text: '0000\nprogress=end\n' })
      return ENDED
    }
    native.folderFiles = [AUDIO_CUT_FILE.name]

    expect((await cutAudioClip(SONG, { start: 0, end: null }, running())).seconds).toBe(20.5)
  })

  it('downloads a clip that is only at its web address into the folder, so the run copies no file', async () => {
    native.program = writes('stdout', audioProgress(2.5))
    native.folderFiles = ['b.mp3', AUDIO_CUT_FILE.name]

    await cutAudioClip({ ...SONG, src: null, url: 'https://clips.example/x/song?sig=1' }, PART, running())

    expect(native.downloads.map(({ request, file }) => [request.url, file])).toStrictEqual([
      ['https://clips.example/x/song?sig=1', { root: 'cache', path: `${deletedWorkFolder()}/b.mp3` }],
    ])
    expect(native.runs.map(({ run }) => [run.args, run.inputs])).toStrictEqual([[audioCutArgs('b.mp3', PART), []]])
  })

  it('decodes the clip again for its length when the part holds no audio, and makes no clip', async () => {
    const part = { start: 12, end: null }
    // The cut wrote nothing; the clip is 10 seconds long.
    native.program = async (run, onOutput) => {
      onOutput({ stream: 'stdout', text: audioProgress(run.args.at(-1) === AUDIO_CUT_FILE.name ? null : 10) })
      return ENDED
    }
    native.folderFiles = ['b.mp3', AUDIO_CUT_FILE.name]

    const refusal = await refusalOf(cutAudioClip(SONG, part, running()))

    expect(refusal).toBe(audioEmptyCutText('b', 12, 10))
    // Only the first run of a folder copies the clip into it.
    expect(native.runs.map(({ run }) => [run.args, run.inputs])).toStrictEqual([
      [audioCutArgs('b.mp3', part), [{ name: 'b.mp3', source: SONG.src }]],
      [audioLengthArgs('b.mp3'), []],
    ])
    expect(native.moves).toStrictEqual([])
    deletedWorkFolder()
  })

  it('stores a new file of the most bytes that Dez stores for a clip, and refuses a larger one', async () => {
    native.program = writes('stdout', audioProgress(5000))
    native.folderFiles = ['b.mp3', AUDIO_CUT_FILE.name]
    native.folderFileSize = MAX_SAVED_CLIP_BYTES

    await cutAudioClip(SONG, PART, running())

    expect(native.moves).toHaveLength(1)

    native.folderFileSize = MAX_SAVED_CLIP_BYTES + 1

    expect(await refusalOf(cutAudioClip(SONG, PART, running()))).toBe(AUDIO_CUT_TOO_LARGE_TEXT)
    expect(native.moves).toHaveLength(1)
    deletedWorkFolder()
  })

  it('tells the model of a run that failed, with the end of its error output and no local path', async () => {
    const end = { kind: 'exited', code: 183 } as const
    native.program = writes('stderr', `[in#0 @ 0x55] Error opening input file ${CACHE_DIR}/work/x/b.mp3.\nInvalid data found when processing input\n`, end)
    native.folderFiles = ['b.mp3', AUDIO_CUT_FILE.name]

    const refusal = await refusalOf(cutAudioClip(SONG, PART, running()))

    expect(refusal).toBe(errorText(audioDecodeFailedText('b'), audioRunDetails(end, '[in#0 @ 0x55] Error opening input file /home/…\nInvalid data found when processing input')))
    expect(native.moves).toStrictEqual([])
    deletedWorkFolder()
  })

  it.each([
    [{ kind: 'outputTooLarge' }, errorText(audioDecodeFailedText('b'), audioRunDetails({ kind: 'outputTooLarge' }, ''))],
    [{ kind: 'timedOut' }, audioTimedOutText('b')],
  ] as const)('keeps no file of a run that Dez stopped (%j)', async (end, text) => {
    native.program = writes('stdout', audioProgress(2.5), end)
    native.folderFiles = ['b.mp3', AUDIO_CUT_FILE.name]

    expect(await refusalOf(cutAudioClip(SONG, PART, running()))).toBe(text)
    expect(native.moves).toStrictEqual([])
    deletedWorkFolder()
  })

  it('names the audio tool in the error of a clip whose file is gone, and runs no program', async () => {
    native.fileSize = () => null

    const refusal = await refusalOf(cutAudioClip(SONG, PART, running()))

    expect(refusal).toBe(errorText(clipReadProblemText('audio', 'b', 'audio', 'unreadable'), 'The file of the clip is gone, or Dez may not read it.'))
    expect(native.runs).toStrictEqual([])
    deletedWorkFolder()
  })

  it('tells the model when the new file does not move into the Dez folder, without the text of the system', async () => {
    native.program = writes('stdout', audioProgress(2.5))
    native.folderFiles = ['b.mp3', AUDIO_CUT_FILE.name]
    native.moveAppFile = async () => {
      throw new Error(`${APP_DIR}: the disk is full`)
    }

    expect(await refusalOf(cutAudioClip(SONG, PART, running()))).toBe(outputNotStoredText('audio'))
    deletedWorkFolder()
  })
})

describe('audioClipSeconds', () => {
  it('gives the length that one decode of the whole clip tells, and makes no file', async () => {
    native.program = writes('stdout', audioProgress(12.3456))

    expect(await audioClipSeconds(SONG, running())).toBe(12.3456)

    expect(native.runs.map(({ run }) => [run.tool, run.args, run.inputs])).toStrictEqual([
      ['dez-ffmpeg', audioLengthArgs('b.mp3'), [{ name: 'b.mp3', source: SONG.src }]],
    ])
    expect(native.moves).toStrictEqual([])
    deletedWorkFolder()
  })

  it('fails for a file in which ffmpeg finds no audio', async () => {
    native.program = writes('stdout', audioProgress(null))

    expect(await refusalOf(audioClipSeconds(SONG, running()))).toBe(errorText(audioDecodeFailedText('b'), AUDIO_NOT_FOUND_DETAILS))
    deletedWorkFolder()
  })
})
