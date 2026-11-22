import { describe, expect, it } from 'vitest'
import { invokeCall } from './appInvoke'
import { DECODE_MAX_RATE, DECODE_MAX_SIDE } from './appsTool'
import type { ClipProbeFacts } from './assetFacts'
import {
  callDecode,
  clipDecodeArgs,
  clipDecodePlan,
  decodedBytes,
  decodedClip,
  decodedInputFacts,
  manifestDecode,
  NO_DECODE,
  runDecode,
  type ClipDecodePlan,
  type InputDecode,
} from './inputDecode'
import { appsArgs, CONVERSATION, notesManifest, refusal, textBytes } from './testing'

const NOT_STARTED = 'Dez started no job.'
const BOTH: InputDecode = { audio: { rate: 22050 }, frames: { width: 96, height: 54, fps: null } }

function call(parameters: Record<string, unknown> = {}) {
  return invokeCall(appsArgs('invoke', { name: 'notes', ...parameters }), CONVERSATION)
}

// The bytes of a manifest of the app `notes` of `kind` with the field
// "decode" of `decode`.
function manifestWith(decode: unknown, kind = 'script'): Uint8Array {
  return textBytes(JSON.stringify({ name: 'notes', description: 'Keeps notes.', kind, decode }))
}

const VIDEO_WITH_SOUND: ClipProbeFacts = {
  seconds: 2,
  bytes: 1000,
  video: { width: 48, height: 36, fps: 5, codec: 'vp9' },
  audio: { codec: 'opus', sampleRate: 48000, channels: 1 },
}
const SILENT_VIDEO: ClipProbeFacts = { ...VIDEO_WITH_SOUND, audio: null }
// An MP3 with a cover picture: ffprobe gives the picture as a video stream.
const SONG_WITH_COVER: ClipProbeFacts = { ...VIDEO_WITH_SOUND, video: { width: 500, height: 500, fps: 90_000, codec: 'mjpeg' } }

describe('callDecode', () => {
  it('gives null for a call with no decode, and a decode of nothing for {}', () => {
    expect(callDecode(appsArgs('invoke', { name: 'notes' }))).toBeNull()
    expect(callDecode(appsArgs('invoke', { name: 'notes', decode: {} }))).toStrictEqual(NO_DECODE)
  })

  it('takes the audio and the frames, with no fps for each frame of the clip once', () => {
    const decode = { audio: { rate: 8000 }, frames: { width: 12, height: 9, fps: 2.5 } }

    expect(callDecode(appsArgs('invoke', { name: 'notes', decode }))).toStrictEqual(decode)
    expect(callDecode(appsArgs('invoke', { name: 'notes', decode: { frames: { width: 12, height: 9 } } }))).toStrictEqual({ audio: null, frames: { width: 12, height: 9, fps: null } })
  })

  it.each([
    [{ audio: { rate: 22050 }, video: {} }, 'it has the field "video", which Dez does not know: it takes only "audio" and "frames"'],
    [{ audio: { rate: 22050, channels: 2 } }, '`audio` has the field "channels", which Dez does not know: it takes only "rate"'],
    [{ audio: 22050 }, '`audio` must be an object, as in {"rate": 22050}'],
    [{ audio: { rate: 999 } }, `\`audio.rate\` must be a whole number from 1000 to ${DECODE_MAX_RATE}`],
    [{ audio: { rate: 22050.5 } }, '`audio.rate` must be a whole number'],
    [{ frames: { width: 96 } }, `\`frames.width\` and \`frames.height\` must each be a whole number from 1 to ${DECODE_MAX_SIDE}`],
    [{ frames: { width: DECODE_MAX_SIDE + 1, height: 54 } }, '`frames.width` and `frames.height` must each be a whole number'],
    [{ frames: { width: 96, height: 54, fps: 0 } }, '`frames.fps` must be a number from 0.01 to 240'],
    [{ frames: { width: 96, height: 54, fps: 241 } }, '`frames.fps` must be a number from 0.01 to 240'],
  ])('refuses %j and tells what is wrong', (decode, problem) => {
    const text = refusal(() => callDecode(appsArgs('invoke', { name: 'notes', decode })))

    expect(text).toContain(`\`decode\` is not valid: ${problem}`)
    expect(text).toContain(NOT_STARTED)
  })
})

describe('manifestDecode', () => {
  const { manifest } = call()

  it('gives null for a manifest with no field "decode", and for bytes that are no JSON object', () => {
    expect(manifestDecode(notesManifest('script'), manifest)).toBeNull()
    expect(manifestDecode(textBytes('{"name": '), manifest)).toBeNull()
    expect(manifestDecode(null, manifest)).toBeNull()
  })

  it('takes a valid field', () => {
    expect(manifestDecode(manifestWith({ audio: { rate: 22050 } }), manifest)).toStrictEqual({ audio: { rate: 22050 }, frames: null })
  })

  it('refuses a field that is no decode, by the path of the manifest', () => {
    const text = refusal(() => manifestDecode(manifestWith(5), manifest))

    expect(text).toContain('The field "decode" of /apps/notes/manifest.json is not valid: it must be a JSON object')
    expect(text).toContain('give the call its own `decode`')
    expect(text).toContain(NOT_STARTED)
  })
})

describe('runDecode', () => {
  const fromManifest = manifestWith({ audio: { rate: 22050 } })

  it('takes the field of the manifest when the call has no decode, and decodes nothing when neither has one', () => {
    expect(runDecode(call(), 'script', fromManifest)).toStrictEqual({ audio: { rate: 22050 }, frames: null })
    expect(runDecode(call(), 'script', notesManifest('script'))).toStrictEqual(NO_DECODE)
  })

  it('takes the decode of the call in place of the field as a whole, and {} decodes nothing', () => {
    expect(runDecode(call({ decode: { frames: { width: 12, height: 9 } } }), 'script', fromManifest)).toStrictEqual({ audio: null, frames: { width: 12, height: 9, fps: null } })
    expect(runDecode(call({ decode: {} }), 'script', fromManifest)).toStrictEqual(NO_DECODE)
  })

  it('does not read a field that is not valid when the call has its own decode', () => {
    expect(runDecode(call({ decode: {} }), 'script', manifestWith('all'))).toStrictEqual(NO_DECODE)
  })

  it('refuses a decode of a UI app, from the call or from the manifest', () => {
    const fromCall = refusal(() => runDecode(call({ decode: { audio: { rate: 8000 } } }), 'ui', notesManifest('ui')))
    const fromField = refusal(() => runDecode(call(), 'ui', manifestWith({ audio: { rate: 8000 } }, 'ui')))

    expect(fromCall).toContain('/apps/notes is a UI app, and only a script app takes `decode`')
    expect(fromCall).toContain('Call again without `decode`.')
    expect(fromField).toContain('/apps/notes/manifest.json has the field "decode", which only a script app takes')
    expect(fromField).toContain('give the call `"decode": {}`')
    expect([fromCall, fromField].every((text) => text.endsWith(NOT_STARTED))).toBe(true)
  })

  it('lets a UI app run with a decode that asks for nothing', () => {
    expect(runDecode(call({ decode: {} }), 'ui', manifestWith({ audio: { rate: 8000 } }, 'ui'))).toStrictEqual(NO_DECODE)
  })
})

describe('clipDecodePlan', () => {
  it('names the files by the id of the clip, and takes the fps of the clip for each frame once', () => {
    expect(clipDecodePlan({ id: 'c', kind: 'video' }, VIDEO_WITH_SOUND, BOTH)).toStrictEqual({
      audio: { name: 'c.f32', rate: 22050 },
      frames: { name: 'c.rgb', width: 96, height: 54, fps: null, fileFps: 5 },
    })
  })

  it('gives the asked fps as the fps of the file', () => {
    const decode = { ...BOTH, frames: { width: 96, height: 54, fps: 24 } }

    expect(clipDecodePlan({ id: 'c', kind: 'video' }, VIDEO_WITH_SOUND, decode).frames).toStrictEqual({ name: 'c.rgb', width: 96, height: 54, fps: 24, fileFps: 24 })
  })

  it('gives no frames for an audio clip with a cover picture, and no audio for a video with no sound', () => {
    expect(clipDecodePlan({ id: 'b', kind: 'audio' }, SONG_WITH_COVER, BOTH)).toStrictEqual({ audio: { name: 'b.f32', rate: 22050 }, frames: null })
    expect(clipDecodePlan({ id: 'c', kind: 'video' }, SILENT_VIDEO, BOTH).audio).toBeNull()
  })

  it('gives no file for a part that the decode does not ask for', () => {
    expect(clipDecodePlan({ id: 'c', kind: 'video' }, VIDEO_WITH_SOUND, { ...BOTH, audio: null }).audio).toBeNull()
  })
})

describe('clipDecodeArgs', () => {
  const plan: ClipDecodePlan = { audio: { name: 'c.f32', rate: 22050 }, frames: { name: 'c.rgb', width: 96, height: 54, fps: null, fileFps: 5 } }

  it('writes both files in one run, each with the size limit, and each frame of the clip once with no fps', () => {
    expect(clipDecodeArgs('c.webm', plan, 1000)).toStrictEqual([
      '-nostdin', '-hide_banner', '-nostats', '-v', 'error', '-i', 'c.webm',
      '-map', '0:a:0', '-ac', '1', '-ar', '22050', '-c:a', 'pcm_f32le', '-fs', '1001', '-f', 'f32le', 'c.f32',
      '-map', '0:v:0', '-vf', 'scale=96:54', '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-fs', '1001', '-f', 'rawvideo', 'c.rgb',
    ])
  })

  it('makes the frames of the asked fps before the scale', () => {
    const args = clipDecodeArgs('c.webm', { audio: null, frames: { ...plan.frames!, fps: 2.5 } }, 1000)

    expect(args.slice(7, 11)).toStrictEqual(['-map', '0:v:0', '-vf', 'fps=2.5,scale=96:54'])
    expect(args).not.toContain('0:a:0')
  })
})

describe('decodedClip', () => {
  const plan: ClipDecodePlan = { audio: { name: 'c.f32', rate: 8000 }, frames: { name: 'c.rgb', width: 12, height: 9, fps: null, fileFps: 5 } }

  it('counts the samples and the frames from the sizes of the files', () => {
    const sizes = new Map([['c.f32', 64_002], ['c.rgb', 3240], ['c.webm', 9999]])

    expect(decodedClip(plan, BOTH, sizes)).toStrictEqual({
      audio: { name: 'c.f32', rate: 8000, count: 16_000 },
      frames: { name: 'c.rgb', width: 12, height: 9, fps: 5, count: 10 },
    })
    expect(decodedBytes(plan, sizes)).toBe(67_242)
  })

  it('gives null for a part with no file, and leaves out a part that the decode does not ask for', () => {
    const noSound = { ...plan, audio: null }

    expect(decodedClip(noSound, BOTH, new Map([['c.rgb', 0]]))).toStrictEqual({ audio: null, frames: { name: 'c.rgb', width: 12, height: 9, fps: 5, count: 0 } })
    expect(decodedClip(plan, BOTH, new Map())).toStrictEqual({ audio: null, frames: null })
    expect(decodedClip(noSound, { ...BOTH, audio: null }, new Map([['c.rgb', 324]]))).toStrictEqual({ frames: { name: 'c.rgb', width: 12, height: 9, fps: 5, count: 1 } })
  })
})

describe('decodedInputFacts', () => {
  it('gives the path of each file in the run folder, null for a clip without the stream, and nothing for a part that the decode does not ask for', () => {
    const decoded = { audio: null, frames: { name: 'c.rgb', width: 12, height: 9, fps: null, count: 10 } }

    expect(decodedInputFacts(decoded, '/run')).toStrictEqual({ audio: null, frames: { path: '/run/c.rgb', width: 12, height: 9, fps: null, count: 10 } })
    expect(decodedInputFacts({ audio: { name: 'b.f32', rate: 8000, count: 3 } }, '/run')).toStrictEqual({ audio: { path: '/run/b.f32', rate: 8000, count: 3 } })
    expect(decodedInputFacts({}, '/run')).toStrictEqual({})
  })
})
