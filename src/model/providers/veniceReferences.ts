import type { MediaTagKind } from '../chat/mediaTags'
import type { ClipKindRules, ClipUse, InputClipRules } from './clipInputs'

// Venice's reference-to-video models: they make a video that shows the
// people, things, and places of the input images, and they take those
// images in a reference field of the queue request, not as frames
// (`image_url`, `end_image_url`). Nothing in Venice's model list marks
// them: they have `model_type: image-to-video` and the same constraint keys
// as the models that take frames. Only the id says `reference-to-video`, so
// the id chooses the family. A model that takes frames refuses the
// reference fields ("This model does not support reference images").
//
// The fields and the counts are facts of Venice's request schema, so they
// are data of the `venice` media format (mediaFormats.ts) and not of the
// provider config: a custom provider of the `venice` format gets them too.
// The counts come from the API's own refusals (validation 400s, which cost
// nothing; checked 2026-11-11): "reference_image_urls must have at most 7
// images". A count of images that changes gets the same refusal, which
// `ClipFormat.refusedImages` reads.
//
// The prompt names the images by their order in the request. The guides
// tell the names of Kling O3 and Grok (`@Element1`, `@Image1`), Seedance
// (`<Image 1>`, "canonical and case-sensitive"), and Wan 3.0 (`@Image1`).
// The others have no guide: they get `@Image1`, the name of most families
// and the default `ref_name` of `image_references` ("defaults to Image1,
// Image2 and so on").
//
// Some families also take reference clips: videos (a motion, a camera
// move, a look) and audio clips (a voice, a sound, a beat). The counts come
// from the same refusals ("reference_video_urls must have at most 3
// items"; "This model does not support reference audios"), and the
// lengths, types, and sizes from the queue docs: "Per-clip 2–15 s, .mp4 or
// .mov, ≤50 MB; aggregate duration ≤15 s" for the videos of Seedance 2.0,
// ".wav or .mp3; aggregate ≤15 s. Must be paired with at least one
// reference image or reference video" for its audio clips. The guides
// name the clips as the images: `<Video 1>` and `<Audio 1>` for Seedance,
// `@Video1` and `@Audio1` for Wan 3.0; the other families get `@Video1`
// and `@Audio1` too, by inference.
// https://docs.venice.ai/api-reference/endpoint/video/queue
// https://docs.venice.ai/guides/media/reference-to-video
// https://docs.venice.ai/guides/media/seedance-2-0
// https://docs.venice.ai/guides/media/wan-3-0

// The request field of a family's images:
// - `reference_image_urls`: a list of URLs. The reference clips of such a
//   family go in `reference_video_urls` and `reference_audio_urls`.
// - `image_references`: a list of `{ image_url }` objects, for Wan 2.7 and
//   PixVerse C1: the schema names them as the models that read the other
//   fields of an object (a voice, a type, a name). Dez sends the voice
//   (`audio_url`) of a model whose entry says that it takes one
//   (`per_reference_audio`). The reference videos of such a family go in
//   `video_references`, a list of `{ video_url, audio_url? }` objects.
// - `elements`: Kling's list of `{ frontal_image_url }`, at most 4. An
//   element holds the look of a person or a thing over the whole video,
//   which is what "make @a move" asks for, and one meets Kling's rule of
//   at least one visual input. Kling's other list, `scene_image_urls`, is
//   for the place and the style (`@Image1`); Dez sends none.
export type VeniceReferenceField = 'reference_image_urls' | 'image_references' | 'elements'

// The reference clips of a family.
interface VeniceReferenceClips {
  // The most video and audio clips of one request; 0 for a kind that the
  // family does not take as a reference.
  videos: number
  audios: number
  // The least and the most seconds of one clip, and the most seconds of
  // all the clips of one kind together; missing where the docs tell none.
  seconds?: { min: number, max: number, total: number }
  // The name of the n-th clip of a kind in the prompt, with `{n}` for the
  // number; missing where the docs tell none and the family names no
  // image either.
  promptNames?: Partial<Record<MediaTagKind, string>>
}

export interface VeniceReferenceFamily {
  // The start of the ids of the family's models.
  idPrefix: string
  field: VeniceReferenceField
  // The most images of one request.
  maxImages: number
  // The name of the n-th image in the prompt, with `{n}` for the number.
  promptName: string
  // Missing: the family takes no reference clip.
  clips?: VeniceReferenceClips
}

const AT_IMAGE = '@Image{n}'
const AT_CLIP = { video: '@Video{n}', audio: '@Audio{n}' }

// The first entry whose prefix starts the id wins, so a longer prefix comes
// before a shorter one of the same family.
const VENICE_REFERENCE_FAMILIES: readonly VeniceReferenceFamily[] = [
  { idPrefix: 'grok-imagine-', field: 'reference_image_urls', maxImages: 7, promptName: AT_IMAGE },
  {
    idPrefix: 'seedance-2-0-',
    field: 'reference_image_urls',
    maxImages: 9,
    promptName: '<Image {n}>',
    clips: { videos: 3, audios: 3, seconds: { min: 2, max: 15, total: 15 }, promptNames: { video: '<Video {n}>', audio: '<Audio {n}>' } },
  },
  {
    idPrefix: 'seedance-',
    field: 'reference_image_urls',
    maxImages: 30,
    promptName: '<Image {n}>',
    clips: { videos: 10, audios: 10, seconds: { min: 2, max: 30, total: 30 }, promptNames: { video: '<Video {n}>', audio: '<Audio {n}>' } },
  },
  {
    idPrefix: 'wan-3-0-',
    field: 'reference_image_urls',
    maxImages: 10,
    promptName: AT_IMAGE,
    clips: { videos: 5, audios: 5, seconds: { min: 1, max: 15, total: 15 }, promptNames: AT_CLIP },
  },
  // The schema names no prompt name of a reference video
  // (`video_references[].ref_name` is free), so the prompt keeps the @id.
  { idPrefix: 'wan-2-7-', field: 'image_references', maxImages: 5, promptName: AT_IMAGE, clips: { videos: 5, audios: 0 } },
  { idPrefix: 'gemini-omni-flash-1-1-', field: 'reference_image_urls', maxImages: 10, promptName: AT_IMAGE },
  { idPrefix: 'gemini-omni-flash-', field: 'reference_image_urls', maxImages: 3, promptName: AT_IMAGE },
  { idPrefix: 'happyhorse-1-0-', field: 'reference_image_urls', maxImages: 5, promptName: AT_IMAGE },
  { idPrefix: 'happyhorse-', field: 'reference_image_urls', maxImages: 9, promptName: AT_IMAGE },
  // The video-to-video model MiniMax H3 Max Recast takes fewer reference
  // images than its reference-to-video siblings: "reference_image_urls
  // must have at most 4 images" (a refusal of 40 images, which costs
  // nothing; 2026-11-12).
  { idPrefix: 'minimax-h3-max-recast', field: 'reference_image_urls', maxImages: 4, promptName: AT_IMAGE },
  { idPrefix: 'minimax-h3-', field: 'reference_image_urls', maxImages: 9, promptName: AT_IMAGE, clips: { videos: 3, audios: 3, promptNames: AT_CLIP } },
  { idPrefix: 'kling-o3-', field: 'elements', maxImages: 4, promptName: '@Element{n}' },
  { idPrefix: 'kling-v3-', field: 'elements', maxImages: 4, promptName: '@Element{n}' },
  { idPrefix: 'kling-v4-', field: 'reference_image_urls', maxImages: 10, promptName: AT_IMAGE, clips: { videos: 5, audios: 0, promptNames: { video: AT_CLIP.video } } },
  { idPrefix: 'pixverse-c1-', field: 'image_references', maxImages: 7, promptName: AT_IMAGE },
]

// A reference model of no family above: the plain list, with the count of
// the schema (`maxItems: 30`).
const OTHER_REFERENCE_MODELS: VeniceReferenceFamily = { idPrefix: '', field: 'reference_image_urls', maxImages: 30, promptName: AT_IMAGE }

/** The reference fields that a Venice refusal can name. */
export const VENICE_REFERENCE_FIELDS: readonly VeniceReferenceField[] = ['reference_image_urls', 'image_references', 'elements']

/** The types of the video and audio clips that Venice takes, in the
 *  `clipMediaType` form: ".mp4 or .mov", "WAV, MP3". */
export const VENICE_VIDEO_TYPES = ['video/mp4', 'video/quicktime']
export const VENICE_AUDIO_TYPES = ['audio/wav', 'audio/mpeg']

/** The most bytes of one video and one audio clip: "≤50 MB" for a
 *  reference video, and "Max: 30s, 15MB" for an audio clip. */
export const VENICE_MAX_VIDEO_BYTES = 50 * 1024 ** 2
export const VENICE_MAX_AUDIO_BYTES = 15 * 1024 ** 2

/** The family of the Venice model `modelId` by the start of its id alone:
 *  a family above, else the plain list. For a model that is known to take
 *  reference images: a reference-to-video model
 *  (`veniceReferenceFamily`), or a video-to-video model whose entry tells
 *  the sizes of reference images (`reference_image_…`). */
export function veniceFamilyByIdPrefix(modelId: string): VeniceReferenceFamily {
  return VENICE_REFERENCE_FAMILIES.find((family) => modelId.startsWith(family.idPrefix)) ?? OTHER_REFERENCE_MODELS
}

/** The family of the Venice model `modelId`; undefined for a model that
 *  takes its images as frames. */
export function veniceReferenceFamily(modelId: string): VeniceReferenceFamily | undefined {
  return modelId.includes('reference-to-video') ? veniceFamilyByIdPrefix(modelId) : undefined
}

/** The clips that a model of `family` takes as references; undefined for
 *  none. `voices`: the model's entry says that it takes the voice of each
 *  reference (`per_reference_audio`), which only the `image_references`
 *  field can carry. */
export function veniceReferenceClipRules(family: VeniceReferenceFamily, voices: boolean): InputClipRules | undefined {
  const { clips } = family
  const seconds = clips?.seconds && { minSeconds: clips.seconds.min, maxSeconds: clips.seconds.max, maxTotalSeconds: clips.seconds.total }
  const video: ClipKindRules | undefined = clips && clips.videos > 0
    ? {
        use: 'reference',
        maxClips: clips.videos,
        ...seconds,
        maxBytes: VENICE_MAX_VIDEO_BYTES,
        types: [...VENICE_VIDEO_TYPES],
        ...(clips.promptNames?.video !== undefined && { promptName: clips.promptNames.video }),
      }
    : undefined
  const audio: ClipKindRules | undefined = clips && clips.audios > 0
    ? {
        use: 'reference',
        maxClips: clips.audios,
        ...seconds,
        maxBytes: VENICE_MAX_AUDIO_BYTES,
        types: [...VENICE_AUDIO_TYPES],
        ...(clips.promptNames?.audio !== undefined && { promptName: clips.promptNames.audio }),
      }
    : undefined
  const voice: ClipKindRules | undefined = voices && family.field === 'image_references' ? { use: 'voice', types: [...VENICE_AUDIO_TYPES] } : undefined
  const audioRules = audio ?? voice
  if (!video && !audioRules) return undefined
  return {
    ...(video && { video }),
    ...(audioRules && { audio: audioRules }),
    ...(audio && { audioNeedsVisual: true }),
  }
}

/** A clip of a reference request, as a data URL, with the way that the
 *  model uses it. */
export interface VeniceReferenceClip {
  kind: MediaTagKind
  use: ClipUse
  url: string
}

/** The request fields of `family` with the images `imageUrls` and the
 *  reference and voice clips `clips`, each list in its order. A list with
 *  no item goes as no field, so a request with only reference videos has
 *  no image field. The n-th voice is the voice of the n-th reference: the
 *  images first, then the videos. */
export function veniceReferenceBody(family: VeniceReferenceFamily, imageUrls: readonly string[], clips: readonly VeniceReferenceClip[]): Record<string, unknown> {
  const urls = (kind: MediaTagKind, use: ClipUse) => clips.filter((clip) => clip.kind === kind && clip.use === use).map((clip) => clip.url)
  const videos = urls('video', 'reference')
  const audios = urls('audio', 'reference')
  const voices = urls('audio', 'voice')
  switch (family.field) {
    case 'reference_image_urls':
      return {
        ...(imageUrls.length > 0 && { reference_image_urls: [...imageUrls] }),
        ...(videos.length > 0 && { reference_video_urls: videos }),
        ...(audios.length > 0 && { reference_audio_urls: audios }),
      }
    case 'image_references':
      return {
        ...(imageUrls.length > 0 && { image_references: imageUrls.map((url, index) => ({ image_url: url, ...(voices[index] !== undefined && { audio_url: voices[index] }) })) }),
        ...(videos.length > 0 && {
          video_references: videos.map((url, index) => ({ video_url: url, ...(voices[imageUrls.length + index] !== undefined && { audio_url: voices[imageUrls.length + index] }) })),
        }),
      }
    case 'elements':
      return imageUrls.length > 0 ? { elements: imageUrls.map((url) => ({ frontal_image_url: url })) } : {}
  }
}
