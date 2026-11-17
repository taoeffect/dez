// Unit tests only: the texts of hidden assets (hiddenAssets.ts) and of the
// tool blocks that own them, which the model tests and the editor tests
// share; the reference of an image with an id; a compaction tag, the data
// of its notes, and an origin of its notes; and the start of a JPEG file
// with no picture data, which the model tests and the controller tests
// share.
import type { PromptInput } from '../streams/mediaRequest'
import { jobStartedText } from '../tools/jobs'
import { invocationInputsText } from '../tools/modelInvoke'
import { compactionTagText } from './compaction'
import type { CompactionNotes } from './compactionNotes'
import { IMAGE_HIDDEN_KEY, IMAGE_TOOL_KEY, imageMarkdown, imageReferenceTextWithKeptMark } from './images'
import { MEDIA_HIDDEN_ATTRIBUTE, MEDIA_TOOL_ATTRIBUTE, mediaTagText, type MediaTagKind } from './mediaTags'
import { toolBlockText } from './toolBlocks'

/** The stored file of `hiddenImage`. */
export const HIDDEN_IMAGE_PATH = '/home/u/.config/dez/assets/generated/images/one.png'

/** The saved file of `hiddenClip`. */
export const HIDDEN_CLIP_PATH = '/home/u/.config/dez/assets/generated/audio/one.wav'

/** The tag of a compaction section after one compaction, whose newest id
 *  is `b`: an asset that came after it has an id from `c` on. */
export const COMPACTION_TAG = compactionTagText({ count: 1, lastId: 'b', pictures: [] })

/** The origin of the line of a made image in the notes of a compaction. */
export const FOX_ORIGIN = 'made by the model_invoke job 2 of its reply: "A red fox"'

/** The data of the notes of a compaction: the parts of the model, with no
 *  message of the user, no asset, no job, and no cost, unless `fields`
 *  give them. */
export function notesData(fields: Partial<CompactionNotes>): CompactionNotes {
  return {
    firstMessage: null,
    newestMessage: null,
    summary: 'The user wants a short fox film.',
    requirements: 'Every frame is 16:9.',
    nextSteps: 'Make scene 2.',
    assets: [],
    unnamed: [],
    jobs: [],
    jobInputs: new Map(),
    cost: undefined,
    ...fields,
  }
}

/** The reference of the image `id` at `path`, with the kept mark of a
 *  compaction when `kept`. */
export function idImage(path: string, id: string, kept = false): string {
  return imageReferenceTextWithKeptMark({ path, metadata: [{ key: 'id', value: id }] }, kept)
}

/** The reference of an image that the job `jobId` made for an intermediate
 *  call. */
export function hiddenImage(jobId: string, id = 'b'): string {
  return imageMarkdown(HIDDEN_IMAGE_PATH, [{ key: 'id', value: id }, { key: IMAGE_TOOL_KEY, value: 'model_invoke' }, { key: IMAGE_HIDDEN_KEY, value: jobId }])
}

/** The tag of a saved clip that the job `jobId` made for an intermediate
 *  call. */
export function hiddenClip(jobId: string, id = 'c', kind: MediaTagKind = 'audio'): string {
  return mediaTagText({
    kind,
    id,
    type: kind === 'audio' ? 'audio/wav' : 'video/webm',
    src: HIDDEN_CLIP_PATH,
    url: 'https://clips.example/one.wav',
    expires: '2026-11-14T00:00:00.000Z',
    other: [{ name: MEDIA_TOOL_ATTRIBUTE, value: 'model_invoke' }, { name: MEDIA_HIDDEN_ATTRIBUTE, value: jobId }],
  })
}

/** The options of `invokeBlock`. */
interface InvokeBlockOptions {
  /** The job number in the result; 1 unless given. */
  number?: number
  /** The call id; `call_<number>` unless given. */
  id?: string
  /** The prompt of the call; "A cat" unless given. */
  prompt?: string
  /** Whether the call asks to hide what its job makes; true unless given. */
  intermediate?: boolean
  /** The inputs that the result names after the start text, as the runner
   *  writes them (`invocationInputsText`); no such line unless given. */
  inputs?: readonly PromptInput[]
}

/** The block of a `model_invoke` call that started the job `jobId`. */
export function invokeBlock(jobId: string, { number = 1, id = `call_${number}`, prompt = 'A cat', intermediate = true, inputs }: InvokeBlockOptions = {}): string {
  const result = inputs === undefined ? jobStartedText(jobId, number) : `${jobStartedText(jobId, number)}\n${invocationInputsText(inputs)}`
  return toolBlockText({ id, name: 'model_invoke', status: 'success', arguments: { model: 'studio/paint', prompt, ...(intermediate && { is_intermediate: true }) }, result })
}

/** The block of a `jobs_wait` call with the result text `result`. */
export function waitBlock(result: string, id = 'call_w'): string {
  return toolBlockText({ id, name: 'jobs_wait', status: 'success', arguments: {}, result })
}

/** The start of a JPEG file of `width` by `height` pixels, as ffmpeg
 *  writes one, up to its scan, with no picture data: the start marker, a
 *  JFIF segment, a Huffman table (DHT, whose marker is in the range of the
 *  frame headers), the baseline frame header, and the scan header. */
export function jpegHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xFF, 0xD8,
    0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xFF, 0xC4, 0x00, 0x05, 0x00, 0x00, 0x00,
    0xFF, 0xC0, 0x00, 0x11, 0x08, height >> 8, height & 0xFF, width >> 8, width & 0xFF, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xFF, 0xDA, 0x00, 0x0C, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3F, 0x00,
  ])
}
