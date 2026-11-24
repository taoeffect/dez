import { byteSizeText } from '../../utils/byteSize'
import { canonicalMediaType } from '../chat/mediaFiles'
import type { MediaTagKind } from '../chat/mediaTags'
import { takesChatClip } from '../modelInputs'
import { clipsText, type ClipAttachment } from '../providers/clipInputs'
import type { ChatClipRules } from '../providers/config'
import type { ModelInfo, ProviderInfo } from '../providers/types'

// The clips of a `model_invoke` request to a text model (modelInvoke.ts):
// the checks of a call, the ffmpeg runs that make the copy of each clip,
// and the texts of their failures. controller/chatClips.ts runs ffmpeg.
//
// A clip goes as a copy that ffmpeg makes, never as its own file: the copy
// holds no metadata (a title, a place, the name of a program), as a file
// of the user can name private things, and it has a type that the provider
// takes (`ProviderInfo.chatClips`).
//
// Every text here is a tool result or the result of a job: it goes to the
// chat provider. So it names a clip by its id only.

/** Dez's own limit of the bytes of the clips of one request together: the
 *  request body holds them in base64, and it passes through the webview as
 *  one text. */
export const CHAT_CLIP_MAX_BYTES = 64 * 1024 ** 2

/** The most bytes of the copies of the clips of one request to a provider
 *  with the rules `rules`. */
export function chatClipMaxBytes(rules: ChatClipRules): number {
  return Math.min(rules.maxBytes ?? Infinity, CHAT_CLIP_MAX_BYTES)
}

/** The time limit of one ffmpeg run that makes a copy. A conversion of a
 *  long video can take minutes; a longer run is one that hangs. */
export const CHAT_CLIP_RUN_TIMEOUT_MS = 10 * 60 * 1000

/** What the request tells of the copy of a clip: the format name of an
 *  audio clip, or the media type of a video clip (`ChatClipPart`). */
export type ChatClipForm = { type: 'audio'; format: string } | { type: 'video'; mediaType: string }

/** One way to make the copy of a clip: the ffmpeg arguments of the run,
 *  the name of the new file in the work folder, and what the request
 *  tells of it. */
export interface ChatClipCopy {
  name: string
  args: string[]
  form: ChatClipForm
}

// The `input_audio.format` and the extension of the stream copy of an
// audio clip of each canonical type (`canonicalMediaType`). An Ogg clip
// and an Opus clip have none: an Ogg file can hold Opus (a voice note),
// and a pasted or dropped one gets `audio/ogg` from its name
// (`storableClip`). Dez does not know whether a server that takes `ogg`
// reads Opus in it, so the clip goes as an MP3 or a WAV copy.
const AUDIO_COPY_FORMATS: Readonly<Record<string, { format: string, extension: string }>> = {
  'audio/mpeg': { format: 'mp3', extension: 'mp3' },
  'audio/wav': { format: 'wav', extension: 'wav' },
  'audio/flac': { format: 'flac', extension: 'flac' },
  'audio/mp4': { format: 'm4a', extension: 'm4a' },
  'audio/aac': { format: 'aac', extension: 'aac' },
}

// The extension of the stream copy of a video clip of each type.
const VIDEO_COPY_EXTENSIONS: Readonly<Record<string, string>> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
}

// The names of the two copies: an id has only letters, so no input name
// has an underscore.
const STREAM_COPY_NAME = 'chat_copy'
const CONVERTED_NAME = 'chat_converted'

// The arguments of one run that reads `input` and writes `output`.
// `-map_metadata -1` drops the metadata of the file, of each stream, and
// of each chapter, `-map_chapters -1` the chapters, and `-bitexact` the
// name of the ffmpeg version that a muxer writes. `-fs` stops the run at
// one byte over `maxBytes`, so that a copy that is too large ends soon and
// shows as one.
function copyArgs(input: string, maps: readonly string[], codecs: readonly string[], maxBytes: number, output: string): string[] {
  return [
    '-nostdin', '-hide_banner', '-v', 'error',
    '-i', input,
    ...maps,
    ...codecs,
    '-map_metadata', '-1', '-map_chapters', '-1', '-bitexact',
    '-fs', String(maxBytes + 1),
    output,
  ]
}

/** The ways to make the copy of `clip`, whose file is `inputName` in the
 *  work folder, for a provider with the rules `rules`, in the order to try
 *  them. The copy can be at most `maxBytes`.
 *  - A clip of a type that the provider takes goes first as a stream copy
 *    (fast, and no loss). It fails for a stream that the container of the
 *    type does not hold, and it can be too large.
 *  - Then a conversion: an audio clip to MP3 when the provider takes it,
 *    else to WAV; a video clip to H.264 and AAC in MP4, at even sizes (the
 *    pixel format needs them). The config schema makes sure that the
 *    provider takes these types.
 *  Only the first audio stream goes, and of a video clip only the first
 *  video stream that is no cover picture (`V`), and its first audio stream
 *  when it has one. */
export function chatClipCopies(clip: Pick<ClipAttachment, 'kind' | 'type'>, inputName: string, rules: ChatClipRules, maxBytes: number): ChatClipCopy[] {
  const type = canonicalMediaType(clip.type)
  const plan = (name: string, maps: readonly string[], codecs: readonly string[], form: ChatClipForm): ChatClipCopy =>
    ({ name, args: copyArgs(inputName, maps, codecs, maxBytes, name), form })
  const plans: ChatClipCopy[] = []
  if (clip.kind === 'audio') {
    const maps = ['-map', '0:a:0']
    const copy = Object.hasOwn(AUDIO_COPY_FORMATS, type) ? AUDIO_COPY_FORMATS[type] : undefined
    if (copy && rules.audioFormats?.some((format) => format === copy.format)) {
      plans.push(plan(`${STREAM_COPY_NAME}.${copy.extension}`, maps, ['-c', 'copy'], { type: 'audio', format: copy.format }))
    }
    const { format, codecs } = rules.audioFormats?.includes('mp3')
      ? { format: 'mp3', codecs: ['-c:a', 'libmp3lame', '-q:a', '2'] }
      : { format: 'wav', codecs: ['-c:a', 'pcm_s16le'] }
    plans.push(plan(`${CONVERTED_NAME}.${format}`, maps, codecs, { type: 'audio', format }))
    return plans
  }
  const maps = ['-map', '0:V:0', '-map', '0:a:0?']
  const extension = Object.hasOwn(VIDEO_COPY_EXTENSIONS, type) ? VIDEO_COPY_EXTENSIONS[type] : undefined
  if (extension && rules.videoTypes?.some((taken) => taken === type)) {
    plans.push(plan(`${STREAM_COPY_NAME}.${extension}`, maps, ['-c', 'copy'], { type: 'video', mediaType: type }))
  }
  const codecs = [
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
  ]
  plans.push(plan(`${CONVERTED_NAME}.mp4`, maps, codecs, { type: 'video', mediaType: 'video/mp4' }))
  return plans
}

/** Why the clips `clips` of a prompt do not go to the text model `model` of
 *  `provider`; null when they can go:
 *  - a kind of clip that Dez does not send the model (`takesChatClip`);
 *  - more video clips than the provider takes in one request.
 *  The size of the copies is known only when the job makes them. */
export function chatClipsProblem(model: Pick<ModelInfo, 'name' | 'audioInput' | 'videoInput'>, provider: Pick<ProviderInfo, 'name' | 'chatClips'>, clips: readonly Pick<ClipAttachment, 'kind'>[]): string | null {
  const counts: Record<MediaTagKind, number> = { audio: 0, video: 0 }
  for (const clip of clips) counts[clip.kind]++
  for (const kind of ['audio', 'video'] as const) {
    if (counts[kind] === 0 || takesChatClip(model, provider.chatClips, kind)) continue
    return `Dez sends ${model.name} no ${kind} clip, and \`prompt\` names ${clipsText(counts[kind], kind)}. `
      + `Remove the @id of each ${kind} clip from \`prompt\`, or choose a model whose \`dez.inputs\` (model_info) has "${kind}": model_list finds them with \`inputs\` "${kind}".`
  }
  const maxVideos = provider.chatClips?.maxVideos
  if (maxVideos !== undefined && counts.video > maxVideos) {
    return `${provider.name} takes at most ${clipsText(maxVideos, 'video')} in one request, and the prompt names ${counts.video}. `
      + 'Join them into one clip with the video tool (`video join_clips`) and name that one, or make one call for each clip.'
  }
  return null
}

// What the model can do with a clip that is too long or too large.
function shorterClipFix(kind: MediaTagKind): string {
  return kind === 'audio'
    ? 'Cut a shorter part of it with the audio tool (`audio clip`), then name the new clip in `prompt`.'
    : 'Make a smaller clip with the video tool (`video ffmpeg`): a shorter part (`-ss`, `-t`), a lower size (as `-vf scale=-2:480`), or a lower bit rate. Then name the new clip in `prompt`.'
}

/** The error result of a job whose copy of the clip `id` would make the
 *  copies of the clips of the request larger than `maxBytes` together. */
export function chatClipsTooLargeText(modelName: string, kind: MediaTagKind, id: string, maxBytes: number): string {
  return `The copies of the clips that go to ${modelName} in one request can be at most ${byteSizeText(maxBytes)} together, and with the copy of @${id} they are larger. `
    + `Dez sent no request. ${shorterClipFix(kind)}`
}

/** The error result of a job whose copy of the clip `id` ffmpeg could not
 *  make: the details tell how the run ended (`ffmpegRunDetails`). */
export function chatClipNotCopiedText(modelName: string, kind: MediaTagKind, id: string): string {
  return `Dez could not make the copy of the ${kind} clip @${id} that goes to ${modelName}: its file is broken, or ffmpeg cannot convert it. `
    + 'Dez sent no request. Use another clip, or name a new copy that the video tool (`video ffmpeg`) makes of it.'
}

/** The error result of a job whose copy of the clip `id` took more than
 *  the time limit of a run. */
export function chatClipTimedOutText(modelName: string, kind: MediaTagKind, id: string): string {
  return `Dez stopped the copy of the ${kind} clip @${id} for ${modelName}: ffmpeg did not end within ${CHAT_CLIP_RUN_TIMEOUT_MS / 60_000} minutes. `
    + `Dez sent no request. ${shorterClipFix(kind)}`
}
