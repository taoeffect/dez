import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClipAttachment } from '../model/providers/clipInputs'
import type { ChatClipRules } from '../model/providers/config'
import { CHAT_CLIP_RUN_TIMEOUT_MS, chatClipCopies, chatClipNotCopiedText, chatClipsTooLargeText, chatClipTimedOutText } from '../model/tools/chatClips'
import { FFMPEG_OUTPUT_BYTES } from '../model/tools/videoTool'
import { chatClipParts } from './chatClips'
import { APP_DIR, ENDED, native, refusalOf, resetNative, running, writes } from './testing'

// The audio clip `b`, a saved MP3 file, and the video clip `c`, a WebM
// file that the provider below does not take.
const SONG: ClipAttachment = { kind: 'audio', id: 'b', type: 'audio/mpeg', src: `${APP_DIR}/assets/generated/audio/song.mp3`, url: null, expires: null }
const FILM: ClipAttachment = { kind: 'video', id: 'c', type: 'video/webm', src: `${APP_DIR}/assets/video/film.webm`, url: null, expires: null }
const RULES: ChatClipRules = { audioFormats: ['mp3', 'wav'], videoTypes: ['video/mp4'], maxBytes: 1000 }

// The file names that the runs of a clip write, in their order.
const [STREAM_COPY, CONVERTED] = chatClipCopies(SONG, 'b.mp3', RULES, 1000).map(({ name }) => name)

// A work folder that holds a file of `size` bytes of each name of `names`.
function folderWith(names: string[], size: number) {
  return () => names.map((name) => ({ name, updatedAt: 0, size }))
}

beforeEach(() => {
  resetNative()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('chatClipParts', () => {
  it('puts the stream copy of a clip that the provider takes in place of its part, and keeps the other parts', async () => {
    native.folderEntries = folderWith([STREAM_COPY], 600)
    native.fileBytes = () => new Uint8Array([1, 2, 3])

    const parts = await chatClipParts([{ type: 'text', text: 'Does @b fit?' }, { type: 'clip', clip: SONG }, { type: 'image', path: '/a.png' }], 'Listener', RULES, running())

    expect(parts).toStrictEqual([{ type: 'text', text: 'Does @b fit?' }, { type: 'audio', format: 'mp3', data: 'AQID' }, { type: 'image', path: '/a.png' }])
    const [{ run }] = native.runs
    expect(native.runs).toHaveLength(1)
    expect(run).toMatchObject({ tool: 'dez-ffmpeg', args: chatClipCopies(SONG, 'b.mp3', RULES, 1000)[0].args, inputs: [{ name: 'b.mp3', source: SONG.src }], timeoutMs: CHAT_CLIP_RUN_TIMEOUT_MS, maxOutputBytes: FFMPEG_OUTPUT_BYTES })
    expect(native.readFiles).toStrictEqual([{ root: 'cache', path: `${run.folder}/${STREAM_COPY}` }])
    expect(native.deletedFiles.at(-1)).toMatchObject({ root: 'cache', path: run.folder, folder: true })
  })

  it('converts the clip in the same folder when the stream copy fails, or is too large', async () => {
    native.program = async (run) => run.args.includes('copy') ? { kind: 'exited', code: 1 } : ENDED
    native.folderEntries = folderWith([CONVERTED], 600)

    expect(await chatClipParts([{ type: 'clip', clip: SONG }], 'Listener', RULES, running())).toMatchObject([{ type: 'audio', format: 'mp3' }])
    expect(native.runs.map(({ run }) => [run.args.at(-1), run.inputs.length])).toStrictEqual([[STREAM_COPY, 1], [CONVERTED, 0]])
    expect(new Set(native.runs.map(({ run }) => run.folder)).size).toBe(1)

    resetNative()
    native.folderEntries = (_file) => [{ name: STREAM_COPY, updatedAt: 0, size: 1001 }, { name: CONVERTED, updatedAt: 0, size: 900 }]

    expect(await chatClipParts([{ type: 'clip', clip: SONG }], 'Listener', RULES, running())).toMatchObject([{ type: 'audio', format: 'mp3' }])
    expect(native.readFiles.map(({ path }) => path.split('/').at(-1))).toStrictEqual([CONVERTED])
  })

  it('gives each later clip only what the copies before it left of the limit, and fails when no copy fits', async () => {
    native.folderEntries = folderWith([STREAM_COPY, 'chat_converted.mp4'], 600)

    const text = await refusalOf(chatClipParts([{ type: 'clip', clip: SONG }, { type: 'text', text: 'and' }, { type: 'clip', clip: FILM }], 'Listener', RULES, running()))

    expect(text).toContain(chatClipsTooLargeText('Listener', 'video', 'c', 400))
    // The WebM clip has no stream copy here: one conversion, with 400 bytes.
    expect(native.runs.map(({ run }) => run.args.slice(-3))).toStrictEqual([['-fs', '1001', STREAM_COPY], ['-fs', '401', 'chat_converted.mp4']])
    expect(native.deletedFiles.filter(({ folder }) => folder)).toHaveLength(2)
  })

  it('tells that ffmpeg made no copy, with the end of its error output, when every run fails', async () => {
    native.program = writes('stderr', 'film.webm: Invalid data found when processing input\n', { kind: 'exited', code: 183 })

    const text = await refusalOf(chatClipParts([{ type: 'clip', clip: SONG }], 'Listener', RULES, running()))

    expect(text).toContain(chatClipNotCopiedText('Listener', 'audio', 'b'))
    expect(text).toContain('Invalid data found when processing input')
    expect(native.runs).toHaveLength(2)
  })

  it('stops at a run that takes longer than its limit', async () => {
    native.program = async () => ({ kind: 'timedOut' })

    expect(await refusalOf(chatClipParts([{ type: 'clip', clip: SONG }], 'Listener', RULES, running()))).toContain(chatClipTimedOutText('Listener', 'audio', 'b'))
    expect(native.runs).toHaveLength(1)
  })
})
