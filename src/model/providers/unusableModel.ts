import { effectiveOutputs, MODEL_OUTPUTS } from '../modelOutputs'
import type { ModelInfo } from './types'

// The texts of the refusal of a model that Dez has no request for
// (ModelInfo.request `none`) or whose output Dez cannot store. The cause is
// data on the model, so no text here names a model or a provider.
//
// Each text has two readers: the user (the toast of a refused submit,
// `dez.controller/submitTab`) and a chat model (`dez.cannotUse` of
// `model_info`, and the refusal of a `model_invoke` call, which adds where
// to find the other models). So a text tells only the cause and to choose
// another model, and it names no part of the app's window.

const CHOOSE_ANOTHER = 'Choose another model.'

/** Why Dez sends the model `modelName` no request, e.g. "Dez cannot use
 *  Painter yet. It makes image output through an API that Dez does not
 *  support. Choose another model." Such a model is one of an API that Dez
 *  does not speak (a custom provider's image-only model with no media API,
 *  for example): a message of the user and a `model_invoke` call can run it
 *  only after Dez has a request for that API. */
export function unusableModelMessage(modelName: string, model: Pick<ModelInfo, 'outputs'>): string {
  const outputs = effectiveOutputs(model)
  const labels = MODEL_OUTPUTS.filter((output) => outputs.includes(output.id)).map((output) => output.label.toLowerCase())
  const cannotUse = `Dez cannot use ${modelName} yet.`
  if (labels.length === 0) return `${cannotUse} ${CHOOSE_ANOTHER}`
  return `${cannotUse} It makes ${new Intl.ListFormat('en', { type: 'conjunction' }).format(labels)} output through an API that Dez does not support. ${CHOOSE_ANOTHER}`
}

/** Why Dez sends the model `modelName`, which makes only images of the
 *  file type `fileType` (`ModelInfo.unstoredOutput`, such as `TIFF`), no
 *  request. Dez would get an image that it cannot store or show, and the
 *  provider bills it all the same. */
export function unstoredOutputMessage(modelName: string, fileType: string): string {
  return `${modelName} makes only ${fileType} images, and Dez cannot store ${fileType} images. Choose another image model.`
}
