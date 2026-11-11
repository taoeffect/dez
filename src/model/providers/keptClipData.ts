import { effectiveRequest, type ModelInfo } from './types'

// The clip data of a model: what a media request to it can set, the rules
// of its text, the rules of its input images, and the file type of an
// image that Dez cannot store. Image models have some of it too (the
// parameters of an upscale, the image rules of an edit;
// `Provider.withClipData`). A media format can read it from model lists
// that only the media API has (`MediaFormat.modelLists`), and such a list
// can fail while the provider's own model list loads.

/** `models`, the list of a model check of which one or more media lists
 *  did not load, each model with the clip data that it lacks and that
 *  `cached` (the models that the model cache has of the provider, from the
 *  checks before) has for it. Without this, a video model would lose its
 *  lengths, and a request to it would be refused until the next good
 *  check.
 *
 *  Data that the new list has wins, field by field: it is newer (the
 *  voices of a speech model come from the provider's own list). So a
 *  model of a media list that loaded keeps an old field only when the new
 *  data has none of it. Only a model that has the same request kind as
 *  before keeps data, because the parameters of another kind are not its
 *  request fields. A model that the cache does not have keeps nothing.
 *
 *  The result shares the kept data with `cached`: the caller copies the
 *  models before it stores them. */
export function withKeptClipData(models: readonly ModelInfo[], cached: readonly ModelInfo[]): ModelInfo[] {
  const cachedById = new Map(cached.map((model) => [model.id, model]))
  return models.map((model) => {
    const known = cachedById.get(model.id)
    if (!known || effectiveRequest(known) !== effectiveRequest(model)) return model
    return {
      ...model,
      ...(model.parameters === undefined && known.parameters && { parameters: known.parameters }),
      ...(model.text === undefined && known.text && { text: known.text }),
      ...(model.images === undefined && known.images && { images: known.images }),
      ...(model.unstoredOutput === undefined && known.unstoredOutput !== undefined && { unstoredOutput: known.unstoredOutput }),
    }
  })
}
