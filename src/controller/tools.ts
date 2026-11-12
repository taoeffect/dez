import sbp from '@sbp/sbp'
import type { CutAudio } from '../model/chat/audioCut'
import { drawnMediaType, type DrawnImage, type ImageSize } from '../model/chat/imageDrawing'
import { ClipReadError, type ClipReadProblem } from '../model/chat/mediaFiles'
import type { MediaTagData } from '../model/chat/mediaTags'
import { modelRefKey } from '../model/chat/modelRef'
import type { Tab } from '../model/chat/types'
import type { ModelCache } from '../model/persistence/types'
import type { KnownLimit } from '../model/providers/knownLimits'
import { effectiveParameterValues } from '../model/providers/modelParameters'
import { toggleRows, toggleValue } from '../model/providers/modelToggles'
import type { ProviderMediaQuote } from '../model/providers/streamTypes'
import { effectiveRequest, type ProviderInfo, type ProviderInputImageRules, type ProviderSettingsDescriptor } from '../model/providers/types'
import type { SettingsSnapshot } from '../model/state'
import { AUDIO_TOOL, audioClipId, audioClipOf, audioClipPart, audioCutResultText, audioLengthText } from '../model/tools/audioTool'
import { cropPlan, IMAGE_TOOL, imageOf, imageResultText, imageToolId, scalePlan, type ImagePlan } from '../model/tools/imageTool'
import { modelInfoParameterValues, modelInfoPart, modelInfoText, modelInfoTarget, type ModelInfoFacts, type ModelInfoTarget } from '../model/tools/modelInfo'
import { modelListText } from '../model/tools/modelList'
import { unknownToolText } from '../model/tools/registry'
import { parseSubcommandCall, type SubcommandTool } from '../model/tools/subcommands'
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
  /** Writes the tag of a saved clip that the tool made into the reply, with
   *  a new media id and the tool's name, and returns that id. Null when the
   *  reply takes no clip any more (a stop ended the tool round): the runner
   *  then deletes the file. */
  writeClip(clip: Omit<MediaTagData, 'id' | 'other'>): string | null
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

// Runs `start` and waits for its work until the user stops the reply; then
// rejects at once. The work itself goes on: a model-list check still updates
// the model cache. Nothing starts after a stop, so a stopped reply sends no
// request, and no work that nobody waits for can reject unhandled.
function untilAborted<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  const work = start()
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
    // `start` runs before the listener is added, and a stop in it (a selector
    // that stops the reply before its first await) fires no event any more.
    if (signal.aborted) onAbort()
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

// The runner of a tool with subcommands (subcommands.ts): gives the list or
// the help that a call asks for, else runs the runner of the subcommand
// with the subcommand's own checked arguments.
function subcommandRunner(tool: SubcommandTool, runners: Record<string, ToolRunner>): ToolRunner {
  return async (args, signal, context) => {
    const call = parseSubcommandCall(tool, args)
    return call.kind === 'text' ? call.text : await runners[call.name](call.arguments, signal, context)
  }
}

// The error result of an `audio` call whose clip Dez could not read
// (`ClipReadError`), by its problem.
function clipReadProblemText(id: string, problem: ClipReadProblem): string {
  switch (problem) {
    case 'deleted':
      return `The audio clip @${id} is gone: the user deleted its file, and it has no web address to download it from. `
        + `This is not a fault of the call. Tell the user, and do not call the audio tool again for @${id}.`
    case 'expired':
      return `The audio clip @${id} has expired: the provider that made it does not keep it any more, and the user did not save it. `
        + `This is not a fault of the call. Tell the user, and do not call the audio tool again for @${id}.`
    case 'unreadable':
      return `Dez could not read the audio clip @${id}: its file is gone, Dez may not read it, or its server did not send it (the details tell which). `
        + `This is not a fault of the call. Tell the user, and call the audio tool again for @${id} only when the user asks for it.`
  }
}

// The runner of a subcommand of the `image` tool (imageTool.ts): a new
// image from an image of the call's tab, which stays as it is. `plan` tells
// what to draw; the webview draws it (images/redraw), the file goes into
// the generated image folder, and the reply gets its reference. A plan that
// draws nothing gives the result text, as the size of the image for a call
// that asks for it before a crop.
//
// The errors and the result name images by their ids only: both go to the
// chat provider, which gets no path of a stored file. The causes of a read
// or a save failure are in the log.
function imageRunner(plan: ImagePlan): ToolRunner {
  return async (args, signal, context) => {
    const id = imageToolId(args)
    const source = imageOf((sbp('dez.model/tab', context.tabId) as Tab | null)?.sections ?? [], id)

    let file: File
    try {
      file = await sbp('dez.controller/images/readFile', source.path) as File
    } catch (error) {
      console.error(`Failed to read the image @${id}:`, error)
      throw new ToolError(`Dez cannot read the file of the image @${id}: the file is gone, or Dez may not read it. `
        + 'This is not a fault of the call. Tell the user, who can paste the image again (it then gets a new id).')
    }

    // Only redraw knows the size of the image, so the plan runs in it. For
    // redraw, a plan that draws nothing or refuses the call gives null; the
    // text or the error waits until redraw ends, so that a failure of
    // redraw is never the call's fault.
    let text = ''
    let callError: unknown
    const mediaType = drawnMediaType(source.mediaType)
    let drawn: DrawnImage | null
    try {
      drawn = await sbp('dez.controller/images/redraw', file, (size: ImageSize) => {
        try {
          const planned = plan(id, args, size)
          if (typeof planned !== 'string') return planned
          text = planned
        } catch (error) {
          callError = error
        }
        return null
      }, mediaType) as DrawnImage | null
    } catch (error) {
      // The texts of redraw hold no path: it gets the file, not its path.
      throw new ToolError(`Dez could not draw a new image from @${id}. This is not a fault of the call. `
        + `Tell the user, and do not call the image tool again for @${id}.`, rawErrorText(error), { cause: error })
    }
    if (callError !== undefined) throw callError
    if (!drawn) return text

    signal.throwIfAborted()
    let path: string
    try {
      path = await sbp('dez.controller/images/save', drawn.bytes, mediaType, { folder: 'generated' }) as string
    } catch {
      // images/save logged the failure and showed its error toast.
      throw new ToolError('Dez could not save the new image, so there is no new image. This is not a fault of the call, and Dez showed the user the cause. '
        + 'Tell the user that the image was not made, and call the image tool again only when the user asks for it.')
    }
    const newId = context.writeImage(path)
    if (newId === null) {
      // A file that no reference names; images/delete logs its own failures.
      await sbp('dez.controller/images/delete', path).catch(() => {})
      throw new ToolError('The reply stopped before Dez could add the new image to it, so there is no new image. This is not a fault of the call. '
        + 'Call the image tool again only when the user asks for the image again.')
    }
    return imageResultText(id, newId, drawn)
  }
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
  // values, the rules of an input image, and the limits that Dez knows from
  // other places than the provider's data. For a media model it asks the
  // provider for the price of one request with those values, or for the
  // model's price records; that costs nothing. A failed price request does
  // not fail the call.
  async model_info (args, signal) {
    const part = modelInfoPart(args)
    let found = await modelInfoLookup(args)
    if (found.entry === undefined) {
      await untilAborted(() => sbp('dez.controller/modelCache/refresh', { providerIds: [found.provider.id], force: true }) as Promise<void>, signal)
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
      limits: sbp('dez.provider/knownLimits', provider.id, model.id) as KnownLimit[],
    }
    if (entry !== undefined) facts.entry = entry

    const mediaEntry = sbp('dez.model/modelCache/rawModel', provider.id, model.id, 'media') as unknown
    if (mediaEntry !== undefined) facts.mediaEntry = mediaEntry

    const kind = effectiveRequest(model)
    if (kind !== 'chat' && kind !== 'none') {
      try {
        const quote = await untilAborted(() => sbp('dez.provider/mediaQuote', { ...ref, kind, parameters: values }) as Promise<ProviderMediaQuote | null>, signal)
        if (quote?.usd !== undefined) facts.cost = { usd: quote.usd }
        if (quote?.records !== undefined) facts.priceEntry = quote.records
      } catch (error) {
        if (signal.aborted) throw error
        // The provider's error text stays in the log: it can echo details
        // of the user's account, and this result goes to a chat provider.
        console.error(`Failed to get the price of a ${model.id} request:`, error)
        facts.cost = { error: 'The price request to the provider failed. Help › Developer Console shows why.' }
      }
    }
    return modelInfoText(provider, model, facts, part)
  },
  // The `audio` tool (audioTool.ts). `clip` cuts a part of an audio clip of
  // the conversation into a new WAV clip in the reply: the webview decodes
  // and cuts it (`dez.controller/media/cutAudio`), and the clip is saved at
  // once, as it has no URL to save it from later. Its error texts name the
  // clip by its id only; the result goes to the chat provider, which gets
  // no path of a stored file and no signed URL. The causes are in the log.
  audio: subcommandRunner(AUDIO_TOOL, {
    async clip (args, signal, context) {
      const id = audioClipId(args)
      const sections = (sbp('dez.model/tab', context.tabId) as Tab | null)?.sections ?? []
      const source = audioClipOf(sections, id)

      let file: Blob
      try {
        // A download from the clip's URL can take long: a stop ends the run
        // at once, and the signal also ends the download.
        file = await untilAborted(() => sbp('dez.controller/media/readClip', source, { signal }) as Promise<Blob>, signal)
      } catch (error) {
        if (!(error instanceof ClipReadError)) throw error
        throw new ToolError(clipReadProblemText(id, error.problem), error.details, { cause: error })
      }

      // As for the `image` tool: the plan gives null for a call that names
      // no part (only the plan gets the length of the clip, for the result)
      // and for a call that it refuses, so that a failure of the cut is
      // never the call's fault.
      let lengthText = ''
      let callError: unknown
      let cut: CutAudio | null
      try {
        cut = await sbp('dez.controller/media/cutAudio', file, (duration: number) => {
          try {
            const part = audioClipPart(id, args, duration)
            if (!part) lengthText = audioLengthText(id, duration)
            return part
          } catch (error) {
            callError = error
            return null
          }
        }) as CutAudio | null
      } catch (error) {
        // The texts of cutAudio hold no path: it gets the bytes, not a path.
        throw new ToolError(`Dez could not decode the audio clip @${id} (${source.type}): this computer has no decoder for its file type, or the file is broken. `
          + `This is not a fault of the call. Tell the user, and do not call the audio tool again for @${id}.`, rawErrorText(error), { cause: error })
      }
      if (callError !== undefined) throw callError
      if (!cut) return lengthText

      signal.throwIfAborted()
      const clip = { kind: 'audio', type: 'audio/wav', src: null, url: null, expires: null } as const
      let path: string
      try {
        path = await sbp('dez.controller/media/save', clip, { bytes: cut.bytes }) as string
      } catch {
        // media/save logged the failure and showed its error toast.
        throw new ToolError('Dez could not save the new audio clip, so there is no new clip. This is not a fault of the call, and Dez showed the user the cause. '
          + 'Tell the user that the clip was not made, and call the audio tool again only when the user asks for it.')
      }
      const newId = context.writeClip({ ...clip, src: path })
      if (newId === null) {
        // A file that no tag names; media/delete logs its own failures.
        await sbp('dez.controller/media/delete', path).catch(() => {})
        throw new ToolError('The reply stopped before Dez could add the new audio clip to it, so there is no new clip. This is not a fault of the call. '
          + 'Call the audio tool again only when the user asks for the clip again.')
      }
      return audioCutResultText(id, newId, cut.part, cut.duration)
    },
  }),
  // The `image` tool (imageTool.ts): each subcommand makes a new image from
  // an image of the conversation (`imageRunner`).
  image: subcommandRunner(IMAGE_TOOL, {
    crop: imageRunner(cropPlan),
    scale: imageRunner(scalePlan),
  }),
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
