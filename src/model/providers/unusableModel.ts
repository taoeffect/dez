import type { MediaTagKind } from '../chat/mediaTags'
import { effectiveOutputs, MODEL_OUTPUTS } from '../modelOutputs'
import type { ModelInfo } from './types'

// The text of the refusal of a model that Dez has no request for
// (ModelInfo.request `none`). The cause is data on the model, so no text
// here names a model or a provider.

const CLIP_INPUT_NAMES: Readonly<Record<MediaTagKind, string>> = {
  audio: 'an audio clip',
  video: 'a video clip',
}

/** Why a submit to the model `modelName` is refused, as text for the user.
 *  A model that needs a clip as its input (`clipInput`) gets a text that
 *  names the clip, e.g. "Whisper needs an audio clip as its input. …". Each
 *  other model gets the general text, e.g. "Dez cannot use Painter yet. It
 *  makes image output through an API that Dez does not support." */
export function unusableModelMessage(modelName: string, model: Pick<ModelInfo, 'outputs' | 'clipInput'>): string {
  if (model.clipInput !== undefined) {
    // A message in the editor cannot hold a clip as an input, so a person
    // cannot use such a model directly.
    // MODEL_INVOKE: change this text when model_invoke exists. It must then
    // tell the user how to give the clip to the model (ask a chat model to
    // call the tool with the clip's `@id`).
    return `${modelName} needs ${CLIP_INPUT_NAMES[model.clipInput]} as its input. Only a chat model can give it one, with the model_invoke tool, and Dez does not have this tool yet.`
  }
  const outputs = effectiveOutputs(model)
  const labels = MODEL_OUTPUTS.filter((output) => outputs.includes(output.id)).map((output) => output.label.toLowerCase())
  // MODEL_INVOKE: check this text too when model_invoke exists. A model of
  // this group (an image-only model of another API, such as OpenRouter's
  // image API) needs a request for its API first.
  const cannotUse = `Dez cannot use ${modelName} yet.`
  if (labels.length === 0) return cannotUse
  return `${cannotUse} It makes ${new Intl.ListFormat('en', { type: 'conjunction' }).format(labels)} output through an API that Dez does not support.`
}
