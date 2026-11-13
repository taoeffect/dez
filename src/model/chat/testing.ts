// Unit tests only: the texts of hidden assets (hiddenAssets.ts) and of the
// tool blocks that own them, which the model tests and the editor tests
// share.
import { jobStartedText } from '../tools/jobs'
import { IMAGE_HIDDEN_KEY, IMAGE_TOOL_KEY, imageMarkdown } from './images'
import { MEDIA_HIDDEN_ATTRIBUTE, MEDIA_TOOL_ATTRIBUTE, mediaTagText, type MediaTagKind } from './mediaTags'
import { toolBlockText } from './toolBlocks'

/** The stored file of `hiddenImage`. */
export const HIDDEN_IMAGE_PATH = '/home/u/.config/dez/assets/generated/images/one.png'

/** The saved file of `hiddenClip`. */
export const HIDDEN_CLIP_PATH = '/home/u/.config/dez/assets/generated/audio/one.wav'

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

/** The block of an intermediate `model_invoke` call that started the job
 *  `jobId`. */
export function invokeBlock(jobId: string, id = 'call_1'): string {
  return toolBlockText({ id, name: 'model_invoke', status: 'success', arguments: { model: 'studio/paint', prompt: 'A cat', is_intermediate: true }, result: jobStartedText(jobId) })
}

/** The block of a `jobs_wait` call with the result text `result`. */
export function waitBlock(result: string, id = 'call_w'): string {
  return toolBlockText({ id, name: 'jobs_wait', status: 'success', arguments: {}, result })
}
