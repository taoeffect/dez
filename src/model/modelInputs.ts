import { MODEL_OUTPUT_IDS, type ModelOutput } from './modelOutputs'
import { maxInputImages, minInputImages, type InputImageRules } from './providers/clipImages'
import { maxInputClips } from './providers/clipInputs'
import { effectiveRequest, sendsPrompt, type MediaKind, type ModelInfo } from './providers/types'

// What Dez can send to a model in one request, as the type ids of
// MODEL_OUTPUTS: the text of the message, images, and audio and video
// clips. It comes from the model's request kind and rules on each read, and
// is never stored. The `inputs` of `model_list` and `model_info`.

export type ModelInputFacts = Pick<ModelInfo, 'request' | 'imageInput' | 'images' | 'clips' | 'unstoredOutput'>

/** Whether a media request of `kind` carries images, for a model with the
 *  image rules `rules` and the `ModelInfo.imageInput` flag `imageInput`:
 *  the kind takes some (`maxInputImages`), and the model is not known not
 *  to read images. A model that is known not to read them still gets an
 *  image when its kind needs exactly one (an upscale). */
export function takesInputImages(kind: MediaKind, imageInput: boolean | undefined, rules: InputImageRules | undefined): boolean {
  return maxInputImages(kind, rules) > 0 && (imageInput !== false || minInputImages(kind, rules) === 1)
}

/** The types that Dez can send `model`, in MODEL_OUTPUTS order:
 *  - chat: the text, and the images unless the model is known not to read
 *    them (`dez.model/streamMessagesForTab`). A chat request carries no
 *    clip, whatever the provider says that the model reads.
 *  - a media kind: the text unless the kind sends none (`sendsPrompt`);
 *    images when the kind takes some (`maxInputImages`) and they go (a
 *    message to a model that is known not to read images carries none, and
 *    then only a kind that needs exactly one image gets the newest image of
 *    the conversation, `mediaRequestInput`); and the clips of each kind
 *    that it takes (`maxInputClips`).
 *  - `none`, or an output that Dez does not store: nothing, as Dez sends
 *    such a model no request. */
export function modelInputs(model: ModelInputFacts): ModelOutput[] {
  const kind = effectiveRequest(model)
  if (kind === 'none' || model.unstoredOutput !== undefined) return []
  if (kind === 'chat') return model.imageInput === false ? ['text'] : ['text', 'image']
  const taken: Record<ModelOutput, boolean> = {
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
 *  `matchesOutputFilter`). */
export function matchesInputFilter(model: ModelInputFacts, filter: readonly ModelOutput[]): boolean {
  if (filter.length === 0) return true
  const inputs = modelInputs(model)
  return filter.every((type) => inputs.includes(type))
}
