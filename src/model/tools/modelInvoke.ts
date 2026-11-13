import { sectionPlainText } from '../chat/content'
import { newMediaIds } from '../chat/mediaIds'
import { modelRefKey } from '../chat/modelRef'
import type { Section } from '../chat/types'
import type { ModelCache } from '../persistence/types'
import { inputImageRulesFor } from '../providers/clipImages'
import { effectiveParameterValues, type ParameterValues } from '../providers/modelParameters'
import type { MediaProgress } from '../providers/streamTypes'
import { effectiveRequest, sendsPrompt, type MediaKind, type ModelInfo, type ProviderInfo } from '../providers/types'
import { unstoredOutputMessage, unusableModelMessage } from '../providers/unusableModel'
import { conversationAssets, preparedMediaRequest, promptRequestProblem, promptRequestSource, type ConversationAssets, type MediaRequestInput, type PromptInput } from '../streams/mediaRequest'
import { ASSET_NAMES } from './jobs'
import { withoutLocalPaths } from './localPaths'
import { FIND_MODELS, namedModelTarget, parameterValuesArgument } from './modelArguments'
import { ToolError, type ToolArguments, type ToolDefinition } from './types'

// The `model_invoke` tool: a model sends one request to another model that
// the user can use. This module has the pure parts: the definition, the
// checks of a call (`modelInvocation`), and every text that the calling
// model reads. controller/modelInvoke.ts sends the request, as a job of the
// reply (controller/jobs.ts).
//
// For now the tool takes only the models of a media request kind (image,
// audio, video, transcription). The request is the one that a user message
// to such a model sends (streams/mediaRequest.ts has the shared
// preparation and the differences), with `prompt` in place of the message.
//
// Every text here is a tool result or the result of a job: it goes to the
// chat provider. So it names an image or a clip by its id only, and it
// holds no local path.

/** The time limit of a call with no `timeout_seconds`: 30 minutes, which
 *  the definition states in words. */
export const DEFAULT_INVOKE_TIMEOUT_SECONDS = 1800

// A shorter limit ends a request before a provider can answer. The longest
// one is also far below the most that a timer takes.
const MIN_INVOKE_TIMEOUT_SECONDS = 10
const MAX_INVOKE_TIMEOUT_SECONDS = 3600

// Static text only (no count that changes, no date): the tools array and
// the system prompt, which lists the tools, are in the provider's prompt
// cache.
export const MODEL_INVOKE_TOOL: ToolDefinition = {
  name: 'model_invoke',
  description: 'Send one request to another model that the user can use, and get what it makes. '
    + 'For now it takes only the models whose request is not `chat` (`dez.request` of `model_info`): '
    + 'the models that make images, audio clips, or video clips, and the models that write down speech. '
    + 'A request costs the user money, as a request that the user sends does. '
    + 'Call `model_info` for the model first: `usage` tells what the model needs, `dez.parameters` what a request can set, and `dez.cost` the price. '
    + '`model_list` finds models. '
    + 'The model gets only `prompt` and the inputs that `prompt` names with @id, not the conversation. '
    + 'The call starts a job and returns its job id at once; `jobs_wait` gives the result. '
    + 'Jobs run at the same time: start every call that does not need the result of another call, then wait. '
    + 'An image or a clip that the model made goes into your reply at `jobs_wait`, with a new id that a later call can name with @id. '
    + 'Text that the model made is only in the result of the job: the user sees it only when you write it in your reply. '
    + 'A request that failed gives the cause as the result of its job.',
  parameters: [
    {
      name: 'model',
      type: 'string',
      description: 'The full id of the model (`provider/model`), as `model_list` gives it.',
      required: true,
    },
    {
      name: 'prompt',
      type: 'string',
      description: 'The text of the request: what the model must make or change. '
        + 'Write @id in it for each image or clip of the conversation that the model must get, as in "make @a move as in @c": '
        + 'each one goes as an input, in text order. Only an @id sends an image or a clip. '
        + 'A model that takes no text (the `usage` of `model_info` tells it) needs only the @id of its input. '
        + '`usage` also tells how to write lyrics.',
      required: true,
    },
    {
      name: 'parameters',
      type: 'string',
      description: 'Values for parameters of the model (`dez.parameters` of `model_info`), as the text of a JSON object from parameter name to value '
        + '(for example `{"duration": "5s"}`). A parameter with no value here gets the value that the user chose, else its default.',
      required: false,
    },
    {
      name: 'is_intermediate',
      type: 'boolean',
      description: 'Set it to `true` when the call makes only a part that you use to assemble the result that the user asked for, '
        + 'and not a result that the user asked to see. The default is `false`.',
      required: false,
    },
    {
      name: 'timeout_seconds',
      type: 'integer',
      description: `The most seconds that the job runs, from ${MIN_INVOKE_TIMEOUT_SECONDS} to ${MAX_INVOKE_TIMEOUT_SECONDS}. A job that runs longer stops with no result. `
        + `The default is ${DEFAULT_INVOKE_TIMEOUT_SECONDS} (30 minutes).`,
      required: false,
    },
  ],
}

/** What a `model_invoke` call sends, after every check that needs no
 *  request. */
export interface ModelInvocation {
  provider: ProviderInfo
  model: ModelInfo
  kind: MediaKind
  /** What the request sends of the prompt (`preparedMediaRequest`). */
  request: MediaRequestInput
  /** The parameter values that the caller wants: the values of the call
   *  over the values that the user chose. `dez.provider/generateMedia`
   *  takes the ones that the model takes, and the defaults of the others. */
  parameters: ParameterValues
  /** The images and the clips that go, in text order. */
  inputs: PromptInput[]
  /** The id of each input image by its path, for the text of an image that
   *  Dez then cannot read. */
  imageIds: ReadonlyMap<string, string>
  /** The time limit of the job. */
  timeoutMs: number
}

/** What Dez knows when a `model_invoke` call comes. */
export interface InvocationFacts {
  cache: ModelCache
  providers: readonly ProviderInfo[]
  /** The parameter values that the user chose, by `modelRefKey`
   *  (`SettingsSnapshot.modelParameters`). */
  modelParameters: Readonly<Record<string, ParameterValues>>
  /** The sections of the tab of the call. */
  sections: readonly Section[]
}

// The time limit that a call names, in milliseconds.
function timeoutArgument(args: ToolArguments): number {
  const seconds = args.timeout_seconds
  if (seconds === undefined) return DEFAULT_INVOKE_TIMEOUT_SECONDS * 1000
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < MIN_INVOKE_TIMEOUT_SECONDS || seconds > MAX_INVOKE_TIMEOUT_SECONDS) {
    throw new ToolError(`\`timeout_seconds\` must be a whole number from ${MIN_INVOKE_TIMEOUT_SECONDS} to ${MAX_INVOKE_TIMEOUT_SECONDS}. `
      + 'Leave it out for the default of 30 minutes.')
  }
  return seconds * 1000
}

// The request kind of a model that `model_invoke` takes. Dez sends no
// request to a model with the request `none` or with an output that it
// cannot store, as for the user; a chat model is not a part of the tool
// yet.
function invokedKind(model: ModelInfo): MediaKind {
  const kind = effectiveRequest(model)
  if (kind === 'none') throw new ToolError(`${unusableModelMessage(model.name, model)} ${FIND_MODELS}`)
  if (model.unstoredOutput !== undefined) throw new ToolError(`${unstoredOutputMessage(model.name, model.unstoredOutput)} ${FIND_MODELS}`)
  if (kind === 'chat') {
    throw new ToolError(`${model.name} is a chat model (its request is \`chat\`), and model_invoke takes no chat model yet. `
      + 'It takes the models that make images, audio clips, or video clips, and the models that write down speech. '
      + 'Use model_list with `type` to find one.')
  }
  return kind
}

function assetText({ id, kind }: PromptInput): string {
  return `the ${ASSET_NAMES[kind]} @${id}`
}

// Why a prompt with the `@id` words `unknownIds`, which name no image and
// no clip, gets no request; null when it can go. A model that names an
// input that is not there (a wrong id, an image that the user deleted)
// would pay for a result without it. Most `@` words are no ids (a user
// name, an address), so only a word that is as short as an id of this
// conversation counts: a word longer than the next free id cannot be one.
function unknownInputsProblem(unknownIds: readonly string[], assets: ConversationAssets, nextId: string): string | null {
  const unknown = unknownIds.filter((id) => id.length <= nextId.length).map((id) => `@${id}`)
  if (unknown.length === 0) return null
  const lead = `${unknown.join(', ')} ${unknown.length === 1 ? 'names' : 'name'} no image and no clip of this conversation`
  const known = [
    ...Array.from(assets.images.keys(), (id) => assetText({ id, kind: 'image' })),
    ...Array.from(assets.clips.values(), assetText),
  ]
  const notAnInput = 'Write a word that is no input without the @.'
  return known.length === 0
    ? `${lead}: it has none, so \`prompt\` can name no input. Dez sent no request. ${notAnInput}`
    : `${lead}. Dez sent no request. The conversation has ${known.join(', ')}: call again with these ids. ${notAnInput}`
}

/** The request of a `model_invoke` call with `args`: the model that it
 *  names, the inputs that its prompt names, and the values of its
 *  parameters. Every check that needs no request runs here, before the job
 *  starts, so that a call that cannot work costs nothing and gets its
 *  answer at once.
 *
 *  Throws a `ToolError` that tells the model how to fix the call:
 *  - a model that the user cannot use (`namedModelTarget`), that Dez sends
 *    no request, or that is a chat model;
 *  - a bad `timeout_seconds` or `parameters` (`parameterValuesArgument`);
 *  - an `@id` that names nothing (`unknownInputsProblem`);
 *  - an input that the model does not take, more inputs than it takes, or
 *    a text that it does not take (`promptRequestProblem`);
 *  - no text for a model that needs one. */
export function modelInvocation(args: ToolArguments, { cache, providers, modelParameters, sections }: InvocationFacts): ModelInvocation {
  const { provider, model } = namedModelTarget(cache, providers, typeof args.model === 'string' ? args.model : '')
  const kind = invokedKind(model)
  const timeoutMs = timeoutArgument(args)
  const chosen = modelParameters[modelRefKey({ providerId: provider.id, modelId: model.id })]
  const parameters = { ...chosen, ...parameterValuesArgument(model, args) }

  const assets = conversationAssets(sections)
  const source = promptRequestSource(typeof args.prompt === 'string' ? args.prompt : '', assets)
  const [nextId] = newMediaIds(sections.map(sectionPlainText), 1)
  const unknown = unknownInputsProblem(source.unknownIds, assets, nextId)
  if (unknown !== null) throw new ToolError(unknown)

  // The image rules can depend on the parameter values that the request
  // sends, as for a user message (`submitTab`).
  const images = inputImageRulesFor(model.images, effectiveParameterValues(model.parameters ?? [], parameters))
  const rules = { ...(model.text && { text: model.text }), ...(images && { images }), ...(model.clips && { clips: model.clips }) }
  const request = preparedMediaRequest(kind, source, rules)
  const problem = promptRequestProblem(model.name, kind, model, images, source, request)
  if (problem !== null) throw new ToolError(problem)
  if (sendsPrompt(kind) && request.prompt === '' && request.lyrics === undefined) {
    throw new ToolError(`\`prompt\` has no text, and ${model.name} makes nothing without one. Write in \`prompt\` what the model must make, and name each input with @id.`)
  }

  const sentClips = new Set(request.clips.map((clip) => clip.id))
  const imageIds = new Map<string, string>()
  const inputs = source.inputs.filter(({ id, kind: inputKind }) => {
    if (inputKind !== 'image') return sentClips.has(id)
    const path = assets.images.get(id)
    if (path === undefined || !request.images.includes(path)) return false
    imageIds.set(path, id)
    return true
  })
  return { provider, model, kind, request, parameters, inputs, imageIds, timeoutMs }
}

/** What the result of a call that started a job adds after
 *  `jobStartedText`: the images and the clips that go with the request, so
 *  that the model sees at once what the other model gets. */
export function invocationInputsText(inputs: readonly PromptInput[]): string {
  return inputs.length === 0
    ? 'The request has no input image and no input clip.'
    : `The inputs of the request: ${inputs.map(assetText).join(', ')}.`
}

/** The state of a job before its request goes. */
export const INVOCATION_READS_INPUTS = 'Dez reads the inputs of the request.'

/** The state of a job at a step of its request (`MediaProgress`). It names
 *  the provider's own job id as soon as there is one: the provider took the
 *  money for that job, and the result of a job that timed out ends with
 *  its last state. */
export function invocationStateText(providerName: string, { phase, jobId }: MediaProgress): string {
  const withId = jobId === null ? '' : ` With the id ${jobId}, the user can ask ${providerName} about the output.`
  switch (phase) {
    case 'sent':
      return `${providerName} has the request, and has not answered yet.`
    case 'queued':
      return `${providerName} runs the request as a job of its own.${withId}`
    case 'downloading':
      return `${providerName} made the clip, and Dez downloads it.${withId}`
  }
}

/** The result text of a job whose model wrote `text` (a transcription). It
 *  goes as the model gave it: it is the answer of the model, not data
 *  about the computer. */
export function invocationTextResult(text: string): string {
  const words = text.trim()
  return words === ''
    ? 'The model gave no text: it found no words in the input.'
    : `The text that the model gave (the user sees it only when you write it in your reply):\n${words}`
}

/** The error result of a job whose input image `id` Dez could not draw as
 *  the PNG copy that goes in place of an SVG. */
export function undrawnImageText(id: string): string {
  return `Dez could not draw the image @${id} (an SVG) as the PNG copy that a request sends, so it sent no request. `
    + `This is not a fault of the call. Tell the user, and call again only with another image in place of @${id}.`
}

/** The error result of a job whose image Dez could not save. */
export const IMAGE_NOT_SAVED_TEXT = 'The model made an image, but Dez could not save it, so there is no new image. '
  + 'This is not a fault of the call, and Dez showed the user the cause. '
  + 'Tell the user that the image was not made, and call model_invoke again for it only when the user asks for it.'

/** The error result of a job whose request failed with `message`: the text
 *  that a user would get (the fault and the fix, the provider's own job id
 *  when it took one, and the provider's text as the details). The cause
 *  can be the call (a provider can refuse a prompt), so the text does not
 *  say whose fault it is. A local server can name a file in its error
 *  text, so the local paths go. */
export function invocationFailedText(modelName: string, message: string): string {
  return `The request to ${modelName} failed, and it made nothing. ${withoutLocalPaths(message)}\n\n`
    + 'When the cause is in `prompt`, the inputs, or `parameters`, change the call and call again. Else tell the user what failed.'
}
