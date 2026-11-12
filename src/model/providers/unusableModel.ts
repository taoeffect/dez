import { effectiveOutputs, MODEL_OUTPUTS } from '../modelOutputs'
import type { ModelInfo } from './types'

// The texts of the refusal of a model that Dez has no request for
// (ModelInfo.request `none`) or whose output Dez cannot store. The cause is
// data on the model, so no text here names a model or a provider.

const CHOOSE_ANOTHER = 'Choose another model.'

/** Why a submit to the model `modelName` is refused, as text for the user,
 *  e.g. "Dez cannot use Painter yet. It makes image output through an API
 *  that Dez does not support. Choose another model." */
export function unusableModelMessage(modelName: string, model: Pick<ModelInfo, 'outputs'>): string {
  const outputs = effectiveOutputs(model)
  const labels = MODEL_OUTPUTS.filter((output) => outputs.includes(output.id)).map((output) => output.label.toLowerCase())
  // MODEL_INVOKE: check this text too when model_invoke exists. A model of
  // this group (a model of an API that Dez does not speak, such as a
  // custom provider's image-only model with no media API) needs a request
  // for its API first.
  const cannotUse = `Dez cannot use ${modelName} yet.`
  if (labels.length === 0) return `${cannotUse} ${CHOOSE_ANOTHER}`
  return `${cannotUse} It makes ${new Intl.ListFormat('en', { type: 'conjunction' }).format(labels)} output through an API that Dez does not support. ${CHOOSE_ANOTHER}`
}

/** Why a submit to the model `modelName`, which makes only images of the
 *  file type `fileType` (`ModelInfo.unstoredOutput`, such as `TIFF`), is
 *  refused, as text for the user. Dez would get an image that it cannot
 *  store or show, and the provider bills it all the same. */
export function unstoredOutputMessage(modelName: string, fileType: string): string {
  return `${modelName} makes only ${fileType} images, and Dez cannot store ${fileType} images. Choose another image model.`
}
