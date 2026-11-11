import sbp from '@sbp/sbp'
import { sectionPlainText } from '../model/chat/content'
import { drawnMediaType, type DrawnImage, type ImageSize } from '../model/chat/imageDrawing'
import { findImageReferences, imageMediaType, type ImageReference } from '../model/chat/images'
import { modelRefKey } from '../model/chat/modelRef'
import type { Tab } from '../model/chat/types'
import type { ModelCache } from '../model/persistence/types'
import { effectiveParameterValues } from '../model/providers/modelParameters'
import { toggleRows, toggleValue } from '../model/providers/modelToggles'
import type { ProviderMediaQuote } from '../model/providers/streamTypes'
import { effectiveRequest, type ProviderInfo, type ProviderInputImageRules, type ProviderSettingsDescriptor } from '../model/providers/types'
import type { SettingsSnapshot } from '../model/state'
import { cropScaleDrawing, cropScaleImageId, cropScaleResultText, imageSizeText } from '../model/tools/cropScaleImage'
import { modelInfoParameterValues, modelInfoPart, modelInfoText, modelInfoTarget, type ModelInfoFacts, type ModelInfoTarget } from '../model/tools/modelInfo'
import { modelListText } from '../model/tools/modelList'
import { unknownToolText } from '../model/tools/registry'
import { ToolError, type ToolArguments, type ToolRunResult } from '../model/tools/types'
import { rawErrorText } from '../utils/errorText'

/** A call that Dez runs: a Dez tool and the arguments that its definition
 *  accepted (`checkToolCalls`). */
export interface ToolRunCall {
  name: string
  arguments: ToolArguments
}

/** What a runner gets of the reply that made its call. */
export interface ToolRunContext {
  tabId: string
  /** Writes the reference of a stored image that the tool made into the
   *  reply, with a new image id, and returns that id. Null when the reply
   *  takes no image any more (a stop ended the tool round): the runner
   *  then deletes the file. */
  writeImage(path: string): string | null
}

// The code of each Dez tool (TOOL_DEFINITIONS), by tool name. A runner gives
// the result text, or throws a `ToolError` for an error result. `signal`
// aborts when the user stops the reply; a runner that waits on something
// must stop then.
type ToolRunner = (args: ToolArguments, signal: AbortSignal, context: ToolRunContext) => Promise<string>

// The error result of a runner that threw an error that Dez did not expect.
// It leaves out the error's text, which can hold a local path: the result
// goes to the chat provider. The log has it.
function unexpectedToolErrorText(name: string): string {
  return `Dez hit an error that it did not expect while it ran ${name}. This is not a fault of the call. `
    + 'Tell the user that the tool failed (Help › Developer Console shows the error), and do not call it again with the same arguments.'
}

// Waits for `work` until the user stops the reply; then rejects at once.
// The work itself goes on: a model-list check still updates the model cache.
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

// The model that a `model_info` call names, and its raw model-list entry in
// memory (undefined when there is none). Throws for a model that the user
// cannot use (`modelInfoTarget`).
async function modelInfoLookup(args: ToolArguments): Promise<ModelInfoTarget & { entry: unknown }> {
  const providers = await sbp('dez.provider/infos') as ProviderInfo[]
  const target = modelInfoTarget(sbp('dez.model/modelCache/snapshot') as ModelCache, providers, args)
  return { ...target, entry: sbp('dez.model/modelCache/rawModel', target.provider.id, target.model.id) as unknown }
}

const TOOL_RUNNERS: Record<string, ToolRunner> = {
  // The models as the model picker shows them, from the model cache as it
  // is (refreshed at startup and when the picker opens): no network request.
  async model_list (args) {
    const providers = await sbp('dez.provider/infos') as ProviderInfo[]
    const cache = sbp('dez.model/modelCache/snapshot') as ModelCache
    return modelListText(cache, providers, args)
  },
  // All that Dez knows about one model. The raw entries of the provider's
  // model list are in memory only, so after a start they are missing until
  // the provider's next model check; then this one runs a check of that
  // provider now, and looks again (the model may be gone).
  //
  // The result also tells the value that a request sends for each
  // parameter now (the call's own value, else the user's from the provider
  // settings popup, else the default), the toggles that apply with their
  // values, and the rules of an input image. For a media model it asks the
  // provider for the price of one request with those values, or for the
  // model's price records; that costs nothing. A failed price request does
  // not fail the call.
  async model_info (args, signal) {
    const part = modelInfoPart(args)
    let found = await modelInfoLookup(args)
    if (found.entry === undefined) {
      await untilAborted(sbp('dez.controller/modelCache/refresh', { providerIds: [found.provider.id], force: true }) as Promise<void>, signal)
      found = await modelInfoLookup(args)
    }
    const { provider, model, entry } = found
    const ref = { providerId: provider.id, modelId: model.id }
    const called = modelInfoParameterValues(model, args)
    const settings = sbp('dez.model/settings/snapshot') as SettingsSnapshot
    const chosen = settings.modelParameters[modelRefKey(ref)]
    const values = effectiveParameterValues(model.parameters ?? [], { ...chosen, ...called })
    const descriptor = sbp('dez.provider/settingsDescriptor', provider.id, model.id) as ProviderSettingsDescriptor | null
    const stored = settings.providerSettings[provider.id]
    const facts: ModelInfoFacts = {
      values,
      toggles: descriptor ? toggleRows(descriptor).map((row) => ({ key: row.key, label: row.label, on: toggleValue(row, stored) })) : [],
      inputImages: sbp('dez.provider/inputImageRules', provider.id, model.id) as ProviderInputImageRules,
    }
    if (entry !== undefined) facts.entry = entry

    const mediaEntry = sbp('dez.model/modelCache/rawModel', provider.id, model.id, 'media') as unknown
    if (mediaEntry !== undefined) facts.mediaEntry = mediaEntry

    const kind = effectiveRequest(model)
    if (kind !== 'chat' && kind !== 'none') {
      try {
        const quote = await untilAborted(sbp('dez.provider/mediaQuote', { ...ref, kind, parameters: values }) as Promise<ProviderMediaQuote | null>, signal)
        if (quote?.usd !== undefined) facts.cost = { usd: quote.usd }
        if (quote?.records !== undefined) facts.priceEntry = quote.records
      } catch (error) {
        if (signal.aborted) throw error
        // The provider's error text stays in the log: it can echo details
        // of the user's account, and this result goes to a chat provider.
        console.error(`Failed to get the price of a ${model.id} request:`, error)
        facts.cost = { error: 'The provider did not answer the price request.' }
      }
    }
    return modelInfoText(provider, model, facts, part)
  },
  // A new image from an image of the call's tab: a part of it, at another
  // size (`cropScaleDrawing`). The webview draws it (images/redraw), the
  // file goes into the generated image folder, and the reply gets its
  // reference. The image that the call names stays as it is. A call that
  // names no part and no size draws nothing and tells the size of the
  // image, so that a model can ask before a crop.
  //
  // The errors and the result name images by their ids only: both go to the
  // chat provider, which gets no path of a stored file. The causes of a read
  // or a save failure are in the log.
  async crop_scale_image (args, signal, context) {
    const id = cropScaleImageId(args)
    const sections = (sbp('dez.model/tab', context.tabId) as Tab | null)?.sections ?? []
    // The newest reference with an id is its image, as for an `@id` mention
    // (`sectionsToStreamMessages`).
    const images = new Map<string, ImageReference>()
    for (const reference of sections.flatMap((section) => findImageReferences(sectionPlainText(section)))) {
      if (reference.id !== null) images.set(reference.id, reference)
    }
    const source = images.get(id)
    const sourceType = source && imageMediaType(source.path)
    if (!source || !sourceType) {
      const ids = [...images].filter(([, reference]) => imageMediaType(reference.path)).map(([imageId]) => `@${imageId}`)
      throw new ToolError(ids.length === 0
        ? `This conversation has no images, so it has no image @${id}. Do not call crop_scale_image until the user adds an image to the conversation.`
        : `No image of this conversation has the id @${id}. Its images are ${ids.join(', ')}: call again with one of these ids.`)
    }

    let file: File
    try {
      file = await sbp('dez.controller/images/readFile', source.path) as File
    } catch (error) {
      console.error(`Failed to read the image @${id}:`, error)
      throw new ToolError(`Dez cannot read the file of the image @${id}: the file is gone, or Dez may not read it. `
        + 'This is not a fault of the call. Tell the user, who can paste the image again (it then gets a new id).')
    }

    // The plan gives null for a call that names no part and no size (only
    // the plan gets the size of the image, for the result) and for a call
    // that it refuses, so that a failure of redraw is never the call's fault.
    let sizeText = ''
    let callError: unknown
    const mediaType = drawnMediaType(sourceType)
    let drawn: DrawnImage | null
    try {
      drawn = await sbp('dez.controller/images/redraw', file, (size: ImageSize) => {
        try {
          const drawing = cropScaleDrawing(args, size)
          if (!drawing) sizeText = imageSizeText(id, size)
          return drawing
        } catch (error) {
          callError = error
          return null
        }
      }, mediaType) as DrawnImage | null
    } catch (error) {
      // The texts of redraw hold no path: it gets the file, not its path.
      throw new ToolError(`Dez could not draw a new image from @${id}. This is not a fault of the call. `
        + `Tell the user, and do not call crop_scale_image again for @${id}.`, rawErrorText(error), { cause: error })
    }
    if (callError !== undefined) throw callError
    if (!drawn) return sizeText

    signal.throwIfAborted()
    let path: string
    try {
      path = await sbp('dez.controller/images/save', drawn.bytes, mediaType, { folder: 'generated' }) as string
    } catch {
      // images/save logged the failure and showed its error toast.
      throw new ToolError('Dez could not save the new image, so there is no new image. This is not a fault of the call, and Dez showed the user the cause. '
        + 'Tell the user that the image was not made, and call crop_scale_image again only when the user asks for it.')
    }
    const newId = context.writeImage(path)
    if (newId === null) {
      // A file that no reference names; images/delete logs its own failures.
      await sbp('dez.controller/images/delete', path).catch(() => {})
      throw new ToolError('The reply stopped before Dez could add the new image to it, so there is no new image. This is not a fault of the call. '
        + 'Call crop_scale_image again only when the user asks for the image again.')
    }
    return cropScaleResultText(id, newId, drawn)
  },
}

export default sbp('sbp/selectors/register', {
  /** Runs one call of a reply's tool round. Never throws: a tool with no
   *  runner and a runner that throws give an error result, which the model
   *  reads in the next round. */
  async 'dez.controller/tools/run' (call: ToolRunCall, signal: AbortSignal, context: ToolRunContext): Promise<ToolRunResult> {
    const runner = Object.hasOwn(TOOL_RUNNERS, call.name) ? TOOL_RUNNERS[call.name] : undefined
    if (!runner) {
      console.error(`No runner for the tool ${JSON.stringify(call.name)}`)
      return { content: unknownToolText(call.name), isError: true }
    }
    try {
      return { content: await runner(call.arguments, signal, context), isError: false }
    } catch (error) {
      // A run that the user stopped did not fail; the reply drops its result.
      if (!signal.aborted) console.error(`The tool ${call.name} failed:`, error)
      return { content: error instanceof ToolError ? error.message : unexpectedToolErrorText(call.name), isError: true }
    }
  },
})
