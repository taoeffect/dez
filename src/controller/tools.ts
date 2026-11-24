import sbp from '@sbp/sbp'
import type { Compactions } from '../model/chat/compaction'
import type { ContextSize } from '../model/chat/contextSize'
import type { ConversationCost } from '../model/chat/conversationCost'
import { drawnMediaType, UnwritableImageTypeError, type DrawnImage, type ImageSize } from '../model/chat/imageDrawing'
import { findAssetMentions } from '../model/chat/imageMentions'
import type { MediaTagData } from '../model/chat/mediaTags'
import { modelRefKey } from '../model/chat/modelRef'
import { chatRequestPrice, type RequestPrice, type TabMoney } from '../model/chat/moneyLimit'
import type { ModelRef, Section } from '../model/chat/types'
import type { ModelCache } from '../model/persistence/types'
import type { KnownLimit } from '../model/providers/knownLimits'
import { contextWindowOf } from '../model/providers/modelFamilies'
import { effectiveParameterValues } from '../model/providers/modelParameters'
import { isFreshPrice } from '../model/providers/modelPrices'
import { toggleRows, toggleValue } from '../model/providers/modelToggles'
import type { ProviderMediaQuote } from '../model/providers/streamTypes'
import { effectiveRequest, type ModelInfo, type ProviderInfo, type ProviderInputImageRules, type ProviderSettingsDescriptor } from '../model/providers/types'
import type { SettingsSnapshot } from '../model/state'
import type { CallPictureBudget } from '../model/streams/pictureBudget'
import { AUDIO_ALIASES, VIDEO_ALIASES, type AppAlias } from '../model/tools/appAliases'
import { codeRunCall, invokeCall, invokeInputsText, invokeLabel, INVOKE_RUN_TEXTS } from '../model/tools/appInvoke'
import { APPS_TOOL } from '../model/tools/appsTool'
import { AUDIO_TOOL, audioClipId, audioClipOf, audioCutPart, audioCutRequest, audioCutResultText, audioLengthText } from '../model/tools/audioTool'
import { conversationInfoText } from '../model/tools/conversationInfo'
import { brightnessPlan, contrastPlan, convertPlan, cropPlan, flipPlan, IMAGE_TOOL, imageIdArgument, imageOf, imageResultText, invertPlan, rotatePlan, saturationPlan, scalePlan, unreadableImageText, unwritableFormatError, type ImagePlan } from '../model/tools/imageTool'
import { cancelledJobIds, isIntermediate, jobCancelText, jobInspectText, jobResultText, jobsListText, jobStartedText, jobsWaitText, unknownJobText, waitedJobIds, type JobResult } from '../model/tools/jobs'
import { parameterValuesArgument, type ModelTarget } from '../model/tools/modelArguments'
import { modelCost, modelInfoSelection, modelInfoText, modelInfoTarget, type ModelInfoFacts } from '../model/tools/modelInfo'
import { invocationInputsText, invocationLabel, MODEL_INVOKE_TOOL, modelInvocation } from '../model/tools/modelInvoke'
import { modelListArguments, modelListText } from '../model/tools/modelList'
import { unexpectedToolErrorText, unknownToolText } from '../model/tools/registry'
import { parseSubcommandCall, type SubcommandTool } from '../model/tools/subcommands'
import { ToolError, type ArgumentsOf, type SubcommandParameter, type ToolArguments, type ToolRunResult } from '../model/tools/types'
import { ffmpegCall, ffprobeCall, joinClipsCall, VIDEO_TOOL, videoCallLabel, videoInputsText } from '../model/tools/videoTool'
import { untilAborted } from '../utils/abort'
import { rawErrorText } from '../utils/errorText'
import { checkedAppRun, runAliasCall, runAppFrameJob, runScriptJob } from './appInvoke'
import { editAppFile, findAppFiles, grepAppFiles, initApp, listAppFolder, listApps, makeAppFolder, moveAppPaths, readAppFile, removeAppPaths, showApp, wcAppFiles, writeAppFile } from './appsTool'
import { assetInfoResult } from './assetInfo'
import { assetViewResult } from './assetView'
import { audioClipSeconds, cutAudioClip } from './audioTool'
import { discardMadeAssets, writeJobAssets, type JobOptions, type JobWork, type ToolJobs } from './jobs'
import { runJsEval } from './jsEval'
import { invokeModel } from './modelInvoke'
import { checkWorkPaths, runFfmpegJob, runFfprobe, runJoinJob } from './videoTool'

/** A call that Dez runs: a Dez tool and the arguments that its definition
 *  accepted (`checkToolCalls`). */
export interface ToolRunCall {
  name: string
  arguments: ToolArguments
}

/** What a runner gets of the reply that made its call. */
export interface ToolRunContext {
  tabId: string
  /** The conversation of the tab: the runs of code get its work folder
   *  (model/tools/conversationWork.ts). */
  conversationId: string
  /** The model of the reply: the one that the user chose for it and that
   *  makes the call. Not the tab's active model, which the user can change
   *  while the reply runs. */
  model: ModelRef
  /** The sections where a tool finds the images and the clips that the
   *  call names: those of the tab (none for a tab that is gone), and for a
   *  call of the code of a script run (`js_eval`, the run of an app), also
   *  the assets that the earlier calls of that run made
   *  (controller/toolBridge.ts). */
  sections(): readonly Section[]
  /** The jobs that the caller sees (jobs.ts): for the model, the jobs of
   *  the tab, which the reply holds while it runs; for the code of a
   *  script run, the jobs that its own calls started. A tool whose work
   *  can take long starts it as a job and returns `jobStartedText` with
   *  the job's id. */
  jobs: ToolJobs
  /** Writes the reference of a stored image that the tool made into the
   *  reply, with a new image id, and returns that id. The reference names
   *  the tool of the call, or `tool` (the `jobs_wait` runner writes what
   *  the job of another tool made). `model` is the model that made the
   *  image for the tool (`model_invoke`), which the reference keeps as its
   *  model mark (`imageModelMark`, chat/assetModels.ts). `madeBy` is the id
   *  of the Dez job that made the image (`IMAGE_MADE_BY_KEY`), which
   *  `asset_info` reads. `hidden` is the id of the Dez job that made the
   *  image as a part of its work: the reference keeps it
   *  (`IMAGE_HIDDEN_KEY`), and the editor shows the image under the chip
   *  of that job's call. Null when the reply takes no image any more (a
   *  stop ended the tool round): the runner then deletes the file.
   *
   *  The result of the call must name the new id with `madeAssetText`
   *  (tools/jobs.ts): a request sends that result and not the reference,
   *  so only the result tells the model of the image. */
  writeImage(path: string, options?: { tool?: string, model?: ModelRef, madeBy?: string, hidden?: string }): string | null
  /** Writes the tag of a clip that the tool made into the reply, with a new
   *  media id and the tool's name (`tool`, as for `writeImage`), and
   *  returns that id. `jobId` is the provider's id of the job that made
   *  the clip, which the tag keeps (`MEDIA_JOB_ATTRIBUTE`); `model`,
   *  `madeBy`, and `hidden` are as for `writeImage` (`clipModelMark`,
   *  `MEDIA_MADE_BY_ATTRIBUTE`, `MEDIA_HIDDEN_ATTRIBUTE`). Null when the
   *  reply takes no clip any more (a stop ended the tool round): the
   *  runner then deletes the file. The result of the call must name the
   *  new id, as for `writeImage`. */
  writeClip(clip: Omit<MediaTagData, 'id' | 'other'>, options?: { tool?: string, model?: ModelRef, jobId?: string, madeBy?: string, hidden?: string }): string | null
  /** Writes the tag of the app `name` into the reply (`<dez:app>`,
   *  chat/appTags.ts), after the blocks of the calls, as the writers above
   *  write an asset. False when the reply takes no text any more (a stop
   *  ended the tool round).
   *
   *  The result of the call must name the app with `shownAppText`
   *  (tools/appShow.ts): a request sends that result and not the tag. */
  showApp(name: string): boolean
  /** What the pictures of the call can cost (streams/pictureBudget.ts): the
   *  limits of a request to the model of the reply, less the images and
   *  the pictures that the context holds now, and less the pictures of the
   *  earlier calls of the round; and how many more pictures the round can
   *  show. No budget when the reply takes no picture any more (a stop
   *  ended the tool round). The pictures themselves go back with the
   *  result of the call (`ToolRunResult.pictures`): their block names the
   *  saved copies, and each later request of the conversation reads them,
   *  after the results of the call's round, until a compaction takes the
   *  round out. */
  pictureBudget(): Promise<CallPictureBudget>
  /** The money limit of the tab (model/chat/moneyLimit.ts), read now: the
   *  limit (undefined with none), and what the tab spent, with the quotes
   *  of the paid requests that still run. */
  money(): TabMoney
  /** Throws a `ToolError` when the money limit of the tab refuses a
   *  request with `price` now; its text tells the model to stop and ask
   *  the user. A tool calls it right before each paid request, also in a
   *  job that runs on after the end of the reply. */
  checkMoney(price: RequestPrice): void
}

// The code of each Dez tool (TOOL_DEFINITIONS), by tool name. A runner gives
// the result text, or the result with what its block keeps next to the
// text (`ToolRunResult.pictures`, `bridged`), or throws a `ToolError` for
// an error result. A runner whose error result has more than its text
// gives it with `isError` (`runJsEval`). `signal` aborts when the user
// stops the reply; a runner that waits on something must stop then. `A` is
// what the runner gets as the arguments: those of the call, or those of a
// subcommand, which can hold lists (`subcommandRunner`).
type ToolRunner<A = ToolArguments> = (args: A, signal: AbortSignal, context: ToolRunContext) => Promise<string | (Omit<ToolRunResult, 'isError'> & { isError?: boolean })>

// The result of the output of a runner: a string, or a result with no
// `isError`, is a result that is no error.
function runnerResult(output: Awaited<ReturnType<ToolRunner>>): ToolRunResult {
  return typeof output === 'string' ? { content: output, isError: false } : { isError: false, ...output }
}

// The model of a `model_info` call (the one that it names, else the reply's
// model `replyModel`), its raw model-list entry in memory (undefined when
// there is none), and the time of its provider's last model check. Throws
// for a model that the user cannot use (`modelInfoTarget`).
async function modelInfoLookup(args: ToolArguments, replyModel: ModelRef): Promise<ModelTarget & { entry: unknown, lastCheckedAt: number }> {
  const providers = await sbp('dez.provider/infos') as ProviderInfo[]
  const cache = sbp('dez.model/modelCache/snapshot') as ModelCache
  const target = modelInfoTarget(cache, providers, args, replyModel)
  return {
    ...target,
    entry: sbp('dez.model/modelCache/rawModel', target.provider.id, target.model.id) as unknown,
    lastCheckedAt: cache.providers[target.provider.id]?.lastCheckedAt ?? 0,
  }
}

// The runner of a tool with subcommands (subcommands.ts): gives the list or
// the help that a call asks for, else runs the runner of the subcommand
// with the subcommand's own checked arguments.
function subcommandRunner<P extends SubcommandParameter>(tool: SubcommandTool<P>, runners: Record<string, ToolRunner<ArgumentsOf<P>>>): ToolRunner {
  return async (args, signal, context) => {
    const call = parseSubcommandCall(tool, args)
    return call.kind === 'text' ? call.text : await runners[call.name](call.arguments, signal, context)
  }
}

// The runners of the alias subcommands `aliases` of one tool, by the
// names of the subcommands: each call waits for one run of the built-in
// app of its alias (`runAliasCall`), and the context writes the images
// and the clips of the run into the reply.
function aliasRunners(aliases: readonly AppAlias[]): Record<string, ToolRunner> {
  return Object.fromEntries(aliases.map((alias): [string, ToolRunner] => [
    alias.subcommand.name,
    (args, signal, context) => runAliasCall(alias, args, context.sections(), context.conversationId, context, signal),
  ]))
}

// Starts `work` as a job of the reply for a call of `tool` (`options` as
// for `ToolJobs.start`), and gives the result of the call: the id and the
// number of the job, then `inputsText`, which tells the inputs that go. The
// job keeps the `@id` mentions of `inputsText` as its inputs, which a
// compaction keeps while the job is open (`openJobInputs`). A call that a
// stop or a new submit cut (`callSignal`, the signal of the call) starts
// no job: the next reply takes the jobs, and this call has no reader.
function startJob(context: ToolRunContext, callSignal: AbortSignal, tool: string, work: JobWork, options: Omit<JobOptions, 'inputs' | 'signal'>, inputsText: string): string {
  const inputs = findAssetMentions(inputsText).map((mention) => mention.id)
  const job = context.jobs.start(tool, work, { ...options, inputs, signal: callSignal })
  return `${jobStartedText(job.id, job.number)}\n${inputsText}`
}

// The runner of a subcommand of the `image` tool (imageTool.ts): a new
// image from an image of the call's tab, which stays as it is. `plan` tells
// what to draw; the webview draws it (images/redraw), the file goes into
// the generated image folder, and the reply gets its reference. A plan that
// draws nothing gives the result text, as the size of the image for a call
// that asks for it before a crop.
//
// The errors and the result name images by their ids only: both go to the
// chat provider, which gets no path of a stored or linked file. The causes
// of a read or a save failure are in the log.
function imageRunner(plan: ImagePlan): ToolRunner {
  return async (args, signal, context) => {
    const id = imageIdArgument(args)
    const source = imageOf(context.sections(), id)

    let file: File
    try {
      file = await sbp('dez.controller/images/readFile', source.path) as File
    } catch (error) {
      console.error(`Failed to read the image @${id}:`, error)
      throw new ToolError(unreadableImageText(id))
    }

    // Only redraw knows the size of the image, so the plan runs in it. For
    // redraw, a plan that draws nothing or refuses the call gives null; the
    // text or the error waits until redraw ends, so that a failure of
    // redraw is never the call's fault. A plan can choose the file type of
    // its drawing (a PNG for transparent pixels, the type of a convert);
    // redraw draws that type and tells it.
    let text = ''
    let callError: unknown
    let drawn: DrawnImage | null
    try {
      drawn = await sbp('dez.controller/images/redraw', file, (size: ImageSize) => {
        try {
          const planned = plan(id, args, size, source.mediaType)
          if (typeof planned !== 'string') return planned
          text = planned
        } catch (error) {
          callError = error
        }
        return null
      }, drawnMediaType(source.mediaType)) as DrawnImage | null
    } catch (error) {
      if (error instanceof UnwritableImageTypeError) throw unwritableFormatError(id, error.mediaType, source.mediaType, { cause: error })
      // The texts of redraw hold no path: it gets the file, not its path.
      throw new ToolError(`Dez could not draw a new image from @${id}. This is not a fault of the call. `
        + `Tell the user, and do not call the image tool again for @${id}.`, rawErrorText(error), { cause: error })
    }
    if (callError !== undefined) throw callError
    if (!drawn) return text

    signal.throwIfAborted()
    let path: string
    try {
      path = await sbp('dez.controller/images/save', drawn.bytes, drawn.mediaType, { folder: 'generated' }) as string
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
  // The models as the model picker shows them, from the model cache. First
  // it runs a model check of each provider in the cache whose last check
  // is older than PRICE_LIFETIME_MS, so that the list prices are fresh. A
  // model check is free. A check that fails hides its provider, as in the
  // picker; a provider whose check runs already is not checked again, and
  // the result tells that its prices can be old. Bad arguments fail the
  // call before any check.
  async model_list (args, signal) {
    const listArguments = modelListArguments(args)
    const providers = await sbp('dez.provider/infos') as ProviderInfo[]
    const checked = (sbp('dez.model/modelCache/snapshot') as ModelCache).providers
    const now = Date.now()
    const providerIds = providers.flatMap((provider) => {
      const entry = checked[provider.id]
      return provider.configured && entry && !isFreshPrice(entry.lastCheckedAt, now) ? [provider.id] : []
    })
    if (providerIds.length > 0) {
      await untilAborted(() => sbp('dez.controller/modelCache/refresh', { providerIds }) as Promise<void>, signal)
    }
    return modelListText(sbp('dez.model/modelCache/snapshot') as ModelCache, providers, listArguments)
  },
  // All that Dez knows about one model: the one that the call names, else
  // the reply's model. The raw entries of the provider's model list are in
  // memory only, so after a start they are missing until the provider's
  // next model check; then this one runs a check of that provider now, and
  // looks again (the model may be gone). It also runs one when the call
  // asks for the price and the last check is older than PRICE_LIFETIME_MS,
  // so that the list prices are fresh. A call whose `only` leaves out
  // `cost` gives no entry and no price, so it runs no check.
  //
  // The result also tells the value that a request sends for each
  // parameter now (the call's own value, else the user's from the provider
  // settings popup, else the default), the toggles that apply with their
  // values, the rules of an input image, and the limits that Dez knows from
  // other places than the provider's data. Unless `only` leaves out `cost`,
  // it gives the price (`modelCost`): for a media model it asks the
  // provider for the price of one request with those values, or for the
  // model's price records, which costs nothing. It always asks, never the
  // quote cache, so that a new price of the provider shows at once. A
  // failed price request does not fail the call.
  async model_info (args, signal, context) {
    const selection = modelInfoSelection(args)
    const only = selection && 'only' in selection ? selection.only : undefined
    const wantsCost = !only || only.includes('cost')
    let found = await modelInfoLookup(args, context.model)
    if (wantsCost && (found.entry === undefined || !isFreshPrice(found.lastCheckedAt, Date.now()))) {
      await untilAborted(() => sbp('dez.controller/modelCache/refresh', { providerIds: [found.provider.id], force: true }) as Promise<void>, signal)
      found = await modelInfoLookup(args, context.model)
    }
    const { provider, model, entry } = found
    const ref = { providerId: provider.id, modelId: model.id }
    const called = parameterValuesArgument(model, args)
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

    if (wantsCost) {
      const kind = effectiveRequest(model)
      try {
        const quote = kind === 'chat' || kind === 'none'
          ? null
          : await untilAborted(() => sbp('dez.provider/mediaQuote', { ...ref, kind, parameters: values }) as Promise<ProviderMediaQuote | null>, signal)
        facts.cost = modelCost(provider, model, quote)
        if (quote?.records !== undefined) facts.priceEntry = quote.records
      } catch (error) {
        if (signal.aborted) throw error
        // The provider's error text stays in the log: it can echo details
        // of the user's account, and this result goes to a chat provider.
        console.error(`Failed to get the price of a ${model.id} request:`, error)
        facts.cost = { error: 'The price request to the provider failed. Help › Developer Console shows why.' }
      }
    }
    return modelInfoText(provider, model, facts, selection)
  },
  // The `audio` tool (audioTool.ts). `clip` cuts a part of an audio clip of
  // the conversation into a new stored WAV clip in the reply; ffmpeg does
  // the work (controller/audioTool.ts), and the call waits for it. A call
  // with values that are a part of no clip is refused before Dez reads the
  // clip. The result and the error texts name a clip by its id only: they
  // go to the chat provider, which gets no path of a stored file and no
  // signed URL. The causes are in the log. The other subcommands are
  // aliases (appAliases.ts): each runs a built-in app that measures clips.
  audio: subcommandRunner(AUDIO_TOOL, {
    async clip (args, signal, context) {
      const id = audioClipId(args)
      const source = audioClipOf(context.sections(), id)
      const request = audioCutRequest(args)
      if (!request) return audioLengthText(id, await audioClipSeconds(source, signal))

      const cut = await cutAudioClip(source, request, signal)
      const newId = context.writeClip(cut.clip)
      if (newId === null) {
        // A file that no tag names.
        await discardMadeAssets([{ kind: 'clip', clip: cut.clip }])
        throw new ToolError('The reply stopped before Dez could add the new audio clip to it, so there is no new clip. This is not a fault of the call. '
          + 'Call the audio tool again only when the user asks for the clip again.')
      }
      return audioCutResultText(id, newId, audioCutPart(request, cut.seconds), cut.seconds)
    },
    ...aliasRunners(AUDIO_ALIASES),
  }),
  // The `image` tool (imageTool.ts): each subcommand makes a new image from
  // an image of the conversation (`imageRunner`).
  image: subcommandRunner(IMAGE_TOOL, {
    crop: imageRunner(cropPlan),
    scale: imageRunner(scalePlan),
    flip: imageRunner(flipPlan),
    rotate: imageRunner(rotatePlan),
    brightness: imageRunner(brightnessPlan),
    contrast: imageRunner(contrastPlan),
    saturation: imageRunner(saturationPlan),
    invert: imageRunner(invertPlan),
    convert: imageRunner(convertPlan),
  }),
  // The job tools (model/tools/jobs.ts) read the jobs that the caller sees
  // (`ToolRunContext.jobs`): for the model, the jobs of the tab (`TabJobs`,
  // jobs.ts), which the reply took at its start: its own, and the ones of
  // the replies that the user cut before it; for the code of a run of an
  // app, only the jobs that the calls of that run started
  // (`TabJobs.scoped`).
  // `jobs_wait` gives the results of the jobs that ended since the last
  // one, and waits for the next end when there is none (with `all`: until
  // no job runs; with `jobs`: until none of the named jobs runs, and only
  // their results). A stop ends the wait, but not the jobs: the next reply
  // gets their results (`dez.stream/stop`).
  // It also puts the images and the clips of those jobs into the reply,
  // under the names of the tools that started them: a job writes nothing
  // itself, so its asset comes with the result that names it, after the
  // blocks of this call's group. Its result is never an error result: each
  // part tells in words whether its job failed, and a named job that
  // `job_cancel` cancelled is named as one with no result.
  async jobs_wait (args, signal, context) {
    const ids = waitedJobIds(args, context.jobs.list().map((job) => job.id)) ?? undefined
    const results: JobResult[] = []
    for (const job of await context.jobs.wait(signal, { all: args.all === true, ids })) {
      results.push({ id: job.id, tool: job.tool, status: job.status, text: jobResultText(job.text, await writeJobAssets(job, context)), call: job.call })
    }
    const cancelled = context.jobs.list().filter((job) => job.status === 'cancelled' && ids?.includes(job.id)).map((job) => job.id)
    return jobsWaitText(results, context.jobs.running, context.jobs.ready, cancelled)
  },
  async jobs_list (_args, _signal, context) {
    return jobsListText(context.jobs.list(), context.money())
  },
  async job_inspect (args, _signal, context) {
    const id = String(args.job_id).trim()
    const jobs = context.jobs.list()
    const job = jobs.find((candidate) => candidate.id === id)
    if (!job) throw new ToolError(unknownJobText([id], jobs.map((known) => known.id)))
    return jobInspectText(job)
  },
  // `job_cancel` checks every id first (an unknown id cancels nothing),
  // then ends the named jobs that run; a named job that ended keeps its
  // result.
  async job_cancel (args, _signal, context) {
    const ids = cancelledJobIds(args, context.jobs.list().map((job) => job.id))
    const cancelled = context.jobs.cancel(ids)
    const jobs = context.jobs.list()
    const named = ids.flatMap((id) => jobs.find((job) => job.id === id) ?? [])
    return jobCancelText(named, cancelled, context.jobs.running)
  },
  // The `model_invoke` tool (model/tools/modelInvoke.ts): one request to
  // a model, as a job of the reply (`invokeModel`, modelInvoke.ts).
  // Every check that needs no request runs first (`modelInvocation`): a
  // call that cannot work starts no job, costs nothing, and gets its
  // answer at once. A refusal of the provider comes as the result of the
  // job. The result of the call tells the inputs that go, so that the
  // model sees a wrong input before it waits.
  //
  // The caller is a text model (only a chat reply runs tools), so an
  // invoked text model gets no tools (`InvocationRights.toolsAllowed`).
  //
  // The money limit of the tab refuses the call before its job when the
  // tab spent the limit, or when the price of a text model is unknown and
  // the user did not allow that. The quote of a media request is known
  // only right before it goes, so the work checks again there
  // (`InvocationRights.checkMoney`); here a media request counts as free.
  //
  // `is_intermediate` changes nothing of the request or of the results
  // that the model reads: the job only marks its images and clips as
  // hidden (`hidesAssets`), and the editor shows them under the chip of
  // this call. The same holds for `join_clips` and `ffmpeg` of `video`,
  // and for `invoke` of `apps`. The images and the clips of the job keep
  // the invoked model as their model mark (chat/assetModels.ts).
  async model_invoke (args, callSignal, context) {
    const providers = await sbp('dez.provider/infos') as ProviderInfo[]
    const { modelParameters, providerSettings } = sbp('dez.model/settings/snapshot') as SettingsSnapshot
    const invocation = modelInvocation(args, {
      cache: sbp('dez.model/modelCache/snapshot') as ModelCache,
      providers,
      modelParameters,
      providerSettings,
      sections: context.sections(),
    })
    context.checkMoney(invocation.kind === 'chat' ? chatRequestPrice(invocation.model.price) : { kind: 'quote', usd: 0 })
    const rights = { toolsAllowed: false, checkMoney: context.checkMoney } as const
    return startJob(context, callSignal, MODEL_INVOKE_TOOL.name, (signal, report, reportCost, keepAsset) => invokeModel(invocation, context, signal, report, reportCost, keepAsset, rights), {
      timeoutMs: invocation.timeoutMs,
      hidesAssets: isIntermediate(args),
      model: { providerId: invocation.provider.id, modelId: invocation.model.id },
      label: invocationLabel(args),
    }, invocationInputsText(invocation.inputs))
  },
  // The `video` tool (model/tools/videoTool.ts): ffmpeg and ffprobe, the
  // programs that Dez ships, on the clips and the images of the
  // conversation and the files of its `/work` folder (videoTool.ts runs
  // them). The checks of a call that need no file run first
  // (`joinClipsCall`, `ffmpegCall`, `ffprobeCall`), then the check of its
  // paths of `/work` (`checkWorkPaths`): a call that Dez refuses starts no
  // job and no program. `join_clips` and `ffmpeg` run as jobs of the
  // reply, and their results tell the inputs that go, as for
  // `model_invoke`. `ffprobe` is short, so its call waits for it. `cuts`,
  // `sync`, and `title` are aliases (appAliases.ts): each runs a built-in
  // app, and the call waits for it. `cuts` and `sync` measure clips;
  // `title` makes a clip, which goes into the reply.
  video: subcommandRunner(VIDEO_TOOL, {
    async join_clips (args, callSignal, context) {
      const call = joinClipsCall(args, context.sections())
      return startJob(context, callSignal, VIDEO_TOOL.name, (signal, report) => runJoinJob(call, signal, report), { timeoutMs: call.timeoutMs, hidesAssets: isIntermediate(args), label: videoCallLabel('join_clips', args) }, videoInputsText(call))
    },
    async ffmpeg (args, callSignal, context) {
      const call = ffmpegCall(args, { sections: context.sections(), conversationId: context.conversationId })
      await checkWorkPaths(call, 'ffmpeg')
      return startJob(context, callSignal, VIDEO_TOOL.name, (signal, report) => runFfmpegJob(call, signal, report), { timeoutMs: call.timeoutMs, hidesAssets: isIntermediate(args), label: videoCallLabel('ffmpeg', args) }, videoInputsText(call))
    },
    async ffprobe (args, signal, context) {
      return runFfprobe(ffprobeCall(args, { sections: context.sections(), conversationId: context.conversationId }), signal)
    },
    ...aliasRunners(VIDEO_ALIASES),
  }),
  // The facts of the images and the clips that the call names, with who
  // made each one and whether the editor hides it, and the checks of each
  // clip (controller/assetInfo.ts). The call waits for them and starts no
  // job: an image needs one decode in the webview, and a clip one short
  // ffprobe run, and with checks, one ffmpeg run of at most the time limit
  // of a view, as asset_view has.
  async asset_info (args, signal, context) {
    return assetInfoResult(args, context.sections(), signal)
  },
  // The facts and the pictures of the images and the clips that the call
  // names (controller/assetView.ts). The call waits for them and starts no
  // job: the pictures must be there for the next request of the reply,
  // and a frame sheet or a wave is one short ffmpeg run.
  async asset_view (args, signal, context) {
    return assetViewResult(args, context.sections(), signal, context)
  },
  // The numbers of the conversation of the call, for the model of the
  // reply (model/tools/conversationInfo.ts): the ones that the bottom bar
  // shows the user, and the picture budget. The request of the round that
  // made the call is in the cost and in the context size already
  // (`runChatRounds`, stream.ts). The window and the compaction numbers
  // give the size at which the compaction check of the reply compacts
  // (`compactIfDue`).
  async conversation_info (_args, _signal, context) {
    const { providerId, modelId } = context.model
    const contextSize = sbp('dez.model/tabs/contextSize', context.tabId, context.model) as ContextSize | undefined
    if (!contextSize) {
      throw new ToolError('The tab of this conversation is closed, so Dez has no numbers of it. This is not a fault of the call, and a new call gives the same answer.')
    }
    const model = sbp('dez.model/modelCache/model', providerId, modelId) as ModelInfo | null
    return conversationInfoText({
      contextSize,
      contextWindow: contextWindowOf(model ?? { id: modelId }),
      compactions: sbp('dez.model/tabs/compactions', context.tabId) as Compactions | undefined,
      cost: sbp('dez.model/tabs/cost', context.tabId) as ConversationCost | undefined,
      jobs: context.jobs.list(),
      // A model that reads no images gets no pictures, as in asset_view.
      pictureBudget: model?.imageInput === false ? null : await context.pictureBudget(),
      money: context.money(),
    })
  },
  // One run of code that the model wrote, in Deno, the JavaScript runtime
  // that Dez ships (jsEval.ts): a script run, as the run of a script app
  // (controller/appInvoke.ts), with copies of its inputs, the output
  // folder, the work folder of the conversation, the fonts, and
  // skia-canvas, and no network. The code calls the other Dez tools
  // through Dez, with the context of this call (toolBridge.ts). The run is
  // a job that the call waits for: the model needs the value for its next
  // step. A stop of the reply stops the code.
  async js_eval (args, signal, context) {
    return runJsEval(codeRunCall(args, context.sections()), signal, context)
  },
  // The apps, the small programs that a model writes for the user
  // (appsTool.ts). Each file subcommand works on the apps (`/apps`), the
  // libraries that Dez ships (`/libs`, only to read), and the work folder
  // of the conversation (`/work`), and is done when the call returns: it
  // starts no job. A stop of the reply stops `rm`, `mv`, and `wc` between
  // two paths, and `grep` between two reads or in its matching; any other
  // call is short and runs to its end. `grep` matches in a Web Worker,
  // which Dez ends at a time limit (appsGrep.ts).
  //
  // `invoke` runs the code of an app (appInvoke.ts), as a job of the
  // reply: code that a model wrote can run for long. The kind of the app
  // picks the work: a script app runs in Deno, and the page of a UI app
  // in a frame that the user does not see. The checks of the call and of
  // the files of the app run first (`invokeCall`, `checkedAppRun`): a call
  // that Dez refuses starts no job, no program, and no frame. The result
  // tells the inputs that go, as for `model_invoke`.
  //
  // `show` puts a UI app into the reply (appShow.ts): it runs no code.
  apps: subcommandRunner(APPS_TOOL, {
    init: initApp,
    read: (args, _signal, { conversationId }) => readAppFile(args, conversationId),
    write: (args, _signal, { conversationId }) => writeAppFile(args, conversationId),
    edit: (args, _signal, { conversationId }) => editAppFile(args, conversationId),
    rm: (args, signal, { conversationId }) => removeAppPaths(args, signal, conversationId),
    list_apps: listApps,
    ls: (args, _signal, { conversationId }) => listAppFolder(args, conversationId),
    find: (args, _signal, { conversationId }) => findAppFiles(args, conversationId),
    grep: (args, signal, { conversationId }) => grepAppFiles(args, signal, conversationId),
    wc: (args, signal, { conversationId }) => wcAppFiles(args, signal, conversationId),
    mkdir: (args, _signal, { conversationId }) => makeAppFolder(args, conversationId),
    mv: (args, signal, { conversationId }) => moveAppPaths(args, signal, conversationId),
    show: (args, _signal, context) => showApp(args, context),
    async invoke (args, callSignal, context) {
      const call = await checkedAppRun(invokeCall(args, context.sections()))
      // The code of a script app calls the Dez tools with the context of
      // this call, and the jobs that its calls start are jobs of its job.
      return startJob(context, callSignal, APPS_TOOL.name, (signal, report, _reportCost, keepAsset, jobs) => (call.kind === 'ui'
        ? runAppFrameJob(call, signal, report, keepAsset)
        : runScriptJob({ kind: 'app', call }, { toolName: APPS_TOOL.name, texts: INVOKE_RUN_TEXTS }, context.conversationId, signal, report, keepAsset, { context, jobs })), {
        timeoutMs: call.timeoutMs,
        hidesAssets: isIntermediate(args),
        label: invokeLabel(args),
      }, invokeInputsText(call.inputs, call.kind))
    },
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
      const result = runnerResult(await runner(call.arguments, signal, context))
      // An error result that a runner gave is logged as one that it threw.
      if (result.isError && !signal.aborted) console.error(`The tool ${call.name} failed:`, result.content)
      return result
    } catch (error) {
      // A run that the user stopped did not fail; the reply drops its result.
      if (!signal.aborted) console.error(`The tool ${call.name} failed:`, error)
      return { content: error instanceof ToolError ? error.message : unexpectedToolErrorText(call.name), isError: true }
    }
  },
})
