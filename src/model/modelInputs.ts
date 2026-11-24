import type { MediaTagKind } from './chat/mediaTags'
import { MODEL_OUTPUT_IDS, type ModelOutput } from './modelOutputs'
import { maxInputImages, minInputImages, type InputImageRules } from './providers/clipImages'
import { maxInputClips } from './providers/clipInputs'
import type { ChatClipRules } from './providers/config'
import { effectiveRequest, sendsPrompt, type MediaKind, type ModelInfo } from './providers/types'

// What Dez can send to a model in one request, as the type ids of
// MODEL_OUTPUTS: the text of the message, images, and audio and video
// clips. It comes from the model's request kind and rules on each read, and
// is never stored. The `inputs` of `model_list` and `model_info`.

export type ModelInputFacts = Pick<ModelInfo, 'request' | 'imageInput' | 'audioInput' | 'videoInput' | 'images' | 'clips' | 'unstoredOutput'>

/** Whether a media request of `kind` carries images, for a model with the
 *  image rules `rules` and the `ModelInfo.imageInput` flag `imageInput`:
 *  the kind takes some (`maxInputImages`), and the model is not known not
 *  to read images. A model that is known not to read them still gets an
 *  image when the lowest image count of its kind is one (an upscale). */
export function takesInputImages(kind: MediaKind, imageInput: boolean | undefined, rules: InputImageRules | undefined): boolean {
  return maxInputImages(kind, rules) > 0 && (imageInput !== false || minInputImages(kind, rules) === 1)
}

/** Whether a `model_invoke` request to the chat model `model` carries
 *  clips of `kind`: the provider's chat requests carry that kind
 *  (`ProviderInfo.chatClips`), and the provider tells that the model reads
 *  it. An unknown flag counts as no, as a clip costs much and a model that
 *  does not read it can answer as if it did. */
export function takesChatClip(model: Pick<ModelInfo, 'audioInput' | 'videoInput'>, chatClips: ChatClipRules | undefined, kind: MediaTagKind): boolean {
  return kind === 'audio'
    ? model.audioInput === true && chatClips?.audioFormats !== undefined
    : model.videoInput === true && chatClips?.videoTypes !== undefined
}

/** The types that Dez can send `model`, in MODEL_OUTPUTS order, for a
 *  provider whose chat requests carry the clips `chatClips`:
 *  - chat: the text, the images unless the model is known not to read them
 *    (`dez.model/streamMessagesForTab`), and the clips of each kind that
 *    `takesChatClip` lets go. Only a `model_invoke` request carries a clip;
 *    the message of a user never does.
 *  - a media kind: the text unless the kind sends none (`sendsPrompt`);
 *    images when the kind takes some (`maxInputImages`) and they go (a
 *    message to a model that is known not to read images carries none, and
 *    then only a kind whose lowest image count is one gets the newest image
 *    of the conversation, `mediaRequestInput`); and the clips of each kind
 *    that it takes (`maxInputClips`).
 *  - `none`, or an output that Dez does not store: nothing, as Dez sends
 *    such a model no request. */
export function modelInputs(model: ModelInputFacts, chatClips?: ChatClipRules): ModelOutput[] {
  const kind = effectiveRequest(model)
  if (kind === 'none' || model.unstoredOutput !== undefined) return []
  const taken: Record<ModelOutput, boolean> = kind === 'chat'
    ? {
        text: true,
        image: model.imageInput !== false,
        audio: takesChatClip(model, chatClips, 'audio'),
        video: takesChatClip(model, chatClips, 'video'),
      }
    : {
        text: sendsPrompt(kind),
        image: takesInputImages(kind, model.imageInput, model.images),
        audio: maxInputClips(model.clips, 'audio') > 0,
        video: maxInputClips(model.clips, 'video') > 0,
      }
  return MODEL_OUTPUT_IDS.filter((type) => taken[type])
}

/** The inputs filter of `model_list`: an empty filter matches every model;
 *  else Dez must be able to send the model each of the filter's types, all
 *  of them in one request (the output filter needs only one of its types,
 *  `matchesOutputFilter`). `chatClips`: as for `modelInputs`. */
export function matchesInputFilter(model: ModelInputFacts, filter: readonly ModelOutput[], chatClips?: ChatClipRules): boolean {
  if (filter.length === 0) return true
  const inputs = modelInputs(model, chatClips)
  return filter.every((type) => inputs.includes(type))
}
