import sbp from '@sbp/sbp'
import { drawnMediaType, UnwritableImageTypeError, type DrawnImage, type ImageSize } from '../model/chat/imageDrawing'
import type { MediaTagData } from '../model/chat/mediaTags'
import { modelRefKey } from '../model/chat/modelRef'
import type { ModelRef, Section, Tab } from '../model/chat/types'
import type { ModelCache } from '../model/persistence/types'
import type { KnownLimit } from '../model/providers/knownLimits'
import { effectiveParameterValues } from '../model/providers/modelParameters'
import { toggleRows, toggleValue } from '../model/providers/modelToggles'
import type { ProviderMediaQuote } from '../model/providers/streamTypes'
import { effectiveRequest, type ProviderInfo, type ProviderInputImageRules, type ProviderSettingsDescriptor } from '../model/providers/types'
import type { SettingsSnapshot } from '../model/state'
import { AUDIO_TOOL, audioClipId, audioClipOf, audioCutPart, audioCutRequest, audioCutResultText, audioLengthText } from '../model/tools/audioTool'
import { brightnessPlan, contrastPlan, convertPlan, cropPlan, flipPlan, IMAGE_TOOL, imageIdArgument, imageOf, imageResultText, invertPlan, rotatePlan, saturationPlan, scalePlan, unreadableImageText, unwritableFormatError, type ImagePlan } from '../model/tools/imageTool'
import { jobCallLabel, jobInspectText, jobResultText, jobsListText, jobStartedText, jobsWaitText, unknownJobText, type JobResult } from '../model/tools/jobs'
import { parameterValuesArgument, type ModelTarget } from '../model/tools/modelArguments'
import { modelInfoPart, modelInfoText, modelInfoTarget, type ModelInfoFacts } from '../model/tools/modelInfo'
import { invocationInputsText, MODEL_INVOKE_TOOL, modelInvocation } from '../model/tools/modelInvoke'
import { modelListText } from '../model/tools/modelList'
import { unexpectedToolErrorText, unknownToolText } from '../model/tools/registry'
import { parseSubcommandCall, type SubcommandTool } from '../model/tools/subcommands'
import { ToolError, type ToolArguments, type ToolRunResult } from '../model/tools/types'
import { ffmpegCall, ffprobeCall, joinClipsCall, VIDEO_TOOL, videoInputsText } from '../model/tools/videoTool'
import { rawErrorText } from '../utils/errorText'
import { audioClipSeconds, cutAudioClip } from './audioTool'
import { discardJobAssets, writeJobAssets, type JobWork, type ReplyJobs } from './jobs'
import { invokeModel } from './modelInvoke'
import { runFfmpegJob, runFfprobe, runJoinJob } from './videoTool'

/** A call that Dez runs: a Dez tool and the arguments that its definition
 *  accepted (`checkToolCalls`). */
export interface ToolRunCall {
  name: string
  arguments: ToolArguments
}

/** What a runner gets of the reply that made its call. */
export interface ToolRunContext {
  tabId: string
  /** The model of the reply: the one that the user chose for it and that
   *  makes the call. Not the tab's active model, which the user can change
   *  while the reply runs. */
  model: ModelRef
  /** The jobs of the reply (jobs.ts). A tool whose work can take long
   *  starts it as a job and returns `jobStartedText` with the job's id. */
  jobs: ReplyJobs
  /** Writes the reference of a stored image that the tool made into the
   *  reply, with a new image id, and returns that id. The reference names
   *  the tool of the call, or `tool` (the `jobs_wait` runner writes what
   *  the job of another tool made). `hidden` is the id of the Dez job that
   *  made the image as a part of its work: the reference keeps it
   *  (`IMAGE_HIDDEN_KEY`), and the editor shows the image under the chip
   *  of that job's call. Null when the reply takes no image any more (a
   *  stop ended the tool round): the runner then deletes the file.
   *
   *  The result of the call must name the new id with `madeAssetText`
   *  (tools/jobs.ts): a request sends that result and not the reference,
   *  so only the result tells the model of the image. */
  writeImage(path: string, options?: { tool?: string, hidden?: string }): string | null
  /** Writes the tag of a clip that the tool made into the reply, with a new
   *  media id and the tool's name (`tool`, as for `writeImage`), and
   *  returns that id. `jobId` is the provider's id of the job that made
   *  the clip, which the tag keeps (`MEDIA_JOB_ATTRIBUTE`); `hidden` is as
   *  for `writeImage` (`MEDIA_HIDDEN_ATTRIBUTE`). Null when the reply takes
   *  no clip any more (a stop ended the tool round): the runner then
   *  deletes the file. The result of the call must name the new id, as for
   *  `writeImage`. */
  writeClip(clip: Omit<MediaTagData, 'id' | 'other'>, options?: { tool?: string, jobId?: string, hidden?: string }): string | null
}

// The code of each Dez tool (TOOL_DEFINITIONS), by tool name. A runner gives
// the result text, or throws a `ToolError` for an error result. `signal`
// aborts when the user stops the reply; a runner that waits on something
// must stop then.
type ToolRunner = (args: ToolArguments, signal: AbortSignal, context: ToolRunContext) => Promise<string>

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

// The sections of the tab of a call, where a tool finds the images and
// the clips that the call names; none for a tab that is gone.
function callSections(context: ToolRunContext): Section[] {
  return (sbp('dez.model/tab', context.tabId) as Tab | null)?.sections ?? []
}

// The model of a `model_info` call (the one that it names, else the reply's
// model `replyModel`), and its raw model-list entry in memory (undefined
// when there is none). Throws for a model that the user cannot use
// (`modelInfoTarget`).
async function modelInfoLookup(args: ToolArguments, replyModel: ModelRef): Promise<ModelTarget & { entry: unknown }> {
  const providers = await sbp('dez.provider/infos') as ProviderInfo[]
  const target = modelInfoTarget(sbp('dez.model/modelCache/snapshot') as ModelCache, providers, args, replyModel)
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

// Starts `work` as a job of the reply for a call of `tool` (`options` as
// for `ReplyJobs.start`), and gives the result of the call: the id and the
// number of the job, then `inputsText`, which tells the inputs that go.
function startJob(context: ToolRunContext, tool: string, work: JobWork, options: Parameters<ReplyJobs['start']>[2], inputsText: string): string {
  const job = context.jobs.start(tool, work, options)
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
    const source = imageOf(callSections(context), id)

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
  // The models as the model picker shows them, from the model cache as it
  // is (refreshed at startup and when the picker opens): no network request.
  async model_list (args) {
    const providers = await sbp('dez.provider/infos') as ProviderInfo[]
    const cache = sbp('dez.model/modelCache/snapshot') as ModelCache
    return modelListText(cache, providers, args)
  },
  // All that Dez knows about one model: the one that the call names, else
  // the reply's model. The raw entries of the provider's model list are in
  // memory only, so after a start they are missing until the provider's
  // next model check; then this one runs a check of that provider now, and
  // looks again (the model may be gone).
  //
  // The result also tells the value that a request sends for each
  // parameter now (the call's own value, else the user's from the provider
  // settings popup, else the default), the toggles that apply with their
  // values, the rules of an input image, and the limits that Dez knows from
  // other places than the provider's data. For a media model it asks the
  // provider for the price of one request with those values, or for the
  // model's price records; that costs nothing. A failed price request does
  // not fail the call.
  async model_info (args, signal, context) {
    const part = modelInfoPart(args)
    let found = await modelInfoLookup(args, context.model)
    if (found.entry === undefined) {
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
  // the conversation into a new stored WAV clip in the reply; ffmpeg does
  // the work (controller/audioTool.ts), and the call waits for it. A call
  // with values that are a part of no clip is refused before Dez reads the
  // clip. The result and the error texts name a clip by its id only: they
  // go to the chat provider, which gets no path of a stored file and no
  // signed URL. The causes are in the log.
  audio: subcommandRunner(AUDIO_TOOL, {
    async clip (args, signal, context) {
      const id = audioClipId(args)
      const source = audioClipOf(callSections(context), id)
      const request = audioCutRequest(args)
      if (!request) return audioLengthText(id, await audioClipSeconds(source, signal))

      const cut = await cutAudioClip(source, request, signal)
      const newId = context.writeClip(cut.clip)
      if (newId === null) {
        // A file that no tag names.
        await discardJobAssets([{ kind: 'clip', clip: cut.clip }])
        throw new ToolError('The reply stopped before Dez could add the new audio clip to it, so there is no new clip. This is not a fault of the call. '
          + 'Call the audio tool again only when the user asks for the clip again.')
      }
      return audioCutResultText(id, newId, audioCutPart(request, cut.seconds), cut.seconds)
    },
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
  // The job tools (model/tools/jobs.ts) read the jobs of the reply
  // (`ReplyJobs`, jobs.ts). `jobs_wait` gives the results of the jobs that
  // ended since the last one, and waits for the next end when there is
  // none (with `all`: until no job runs); a stop ends the wait, and the
  // jobs with it (`dez.stream/stop`).
  // It also puts the images and the clips of those jobs into the reply,
  // under the names of the tools that started them: a job writes nothing
  // itself, so its asset comes with the result that names it, after the
  // blocks of this call's group. Its result is never an error result: each
  // part tells in words whether its job failed.
  async jobs_wait (args, signal, context) {
    const results: JobResult[] = []
    for (const job of await context.jobs.wait(signal, args.all === true)) {
      results.push({ id: job.id, tool: job.tool, status: job.status, text: jobResultText(job.text, await writeJobAssets(job, context)), call: job.call })
    }
    return jobsWaitText(results, context.jobs.running)
  },
  async jobs_list (_args, _signal, context) {
    return jobsListText(context.jobs.list())
  },
  async job_inspect (args, _signal, context) {
    const id = String(args.job_id).trim()
    const jobs = context.jobs.list()
    const job = jobs.find((candidate) => candidate.id === id)
    if (!job) throw new ToolError(unknownJobText(id, jobs.map((known) => known.id)))
    return jobInspectText(job)
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
  // `is_intermediate` changes nothing of the request or of the results
  // that the model reads: the job only marks its images and clips as
  // hidden (`hidesAssets`), and the editor shows them under the chip of
  // this call.
  async model_invoke (args, _signal, context) {
    const providers = await sbp('dez.provider/infos') as ProviderInfo[]
    const { modelParameters, providerSettings } = sbp('dez.model/settings/snapshot') as SettingsSnapshot
    const invocation = modelInvocation(args, {
      cache: sbp('dez.model/modelCache/snapshot') as ModelCache,
      providers,
      modelParameters,
      providerSettings,
      sections: callSections(context),
    })
    return startJob(context, MODEL_INVOKE_TOOL.name, (signal, report) => invokeModel(invocation, signal, report, { toolsAllowed: false }), {
      timeoutMs: invocation.timeoutMs,
      hidesAssets: args.is_intermediate === true,
      label: jobCallLabel(String(args.prompt ?? '')),
    }, invocationInputsText(invocation.inputs))
  },
  // The `video` tool (model/tools/videoTool.ts): ffmpeg and ffprobe, the
  // programs that Dez ships, on the clips and the images of the
  // conversation (videoTool.ts runs them). The checks of a call that need
  // no file run first (`joinClipsCall`, `ffmpegCall`, `ffprobeCall`): a
  // call that Dez refuses starts no job and no program. `join_clips` and
  // `ffmpeg` run as jobs of the reply, and their results tell the inputs
  // that go, as for `model_invoke`. `ffprobe` is short, so its call waits
  // for it.
  video: subcommandRunner(VIDEO_TOOL, {
    async join_clips (args, _signal, context) {
      const call = joinClipsCall(args, callSections(context))
      const label = jobCallLabel(`join_clips ${String(args.clips ?? '')}`)
      return startJob(context, VIDEO_TOOL.name, (signal, report) => runJoinJob(call, signal, report), { timeoutMs: call.timeoutMs, label }, videoInputsText(call.inputs))
    },
    async ffmpeg (args, _signal, context) {
      const call = ffmpegCall(args, callSections(context))
      const label = jobCallLabel(`ffmpeg ${String(args.arguments ?? '')}`)
      return startJob(context, VIDEO_TOOL.name, (signal, report) => runFfmpegJob(call, signal, report), { timeoutMs: call.timeoutMs, label }, videoInputsText(call.inputs))
    },
    async ffprobe (args, signal, context) {
      return runFfprobe(ffprobeCall(args, callSections(context)), signal)
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
      return { content: await runner(call.arguments, signal, context), isError: false }
    } catch (error) {
      // A run that the user stopped did not fail; the reply drops its result.
      if (!signal.aborted) console.error(`The tool ${call.name} failed:`, error)
      return { content: error instanceof ToolError ? error.message : unexpectedToolErrorText(call.name), isError: true }
    }
  },
})
