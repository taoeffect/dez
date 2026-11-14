import { sectionPlainText } from '../chat/content'
import { newMediaIds } from '../chat/mediaIds'
import { modelRefKey } from '../chat/modelRef'
import type { MessagePart, Section } from '../chat/types'
import { effectiveOutputs } from '../modelOutputs'
import type { ModelCache } from '../persistence/types'
import { unusedImagesProblem } from '../providers/clipImages'
import { clipTagProblem } from '../providers/clipInputs'
import type { ParameterValues } from '../providers/modelParameters'
import type { MediaProgress } from '../providers/streamTypes'
import { effectiveRequest, sendsPrompt, type MediaKind, type ModelInfo, type ProviderInfo } from '../providers/types'
import { unstoredOutputMessage, unusableModelMessage } from '../providers/unusableModel'
import { conversationAssets, mediaInputRules, preparedMediaRequest, promptRequestProblem, promptRequestSource, type MediaRequestInput, type PromptInput, type PromptRequestSource } from '../streams/mediaRequest'
import { jobTimeoutMs, jobTimeoutParameter } from './jobs'
import { withoutLocalPaths } from './localPaths'
import { FIND_MODELS, namedModelTarget, parameterValuesArgument } from './modelArguments'
import { MODEL_INFO_SIZE_CAP } from './modelInfo'
import { assetText, unknownInputsProblem, type InputWording } from './toolInputs'
import { ToolError, type ToolArguments, type ToolDefinition } from './types'

// The `model_invoke` tool: a model sends one request to a model that the
// user can use. This module has the pure parts: the definition, the
// checks of a call (`modelInvocation`), and every text that the calling
// model reads. controller/modelInvoke.ts sends the request, as a job of the
// reply (controller/jobs.ts).
//
// The tool takes two groups of models:
// - A model of a media request kind (image, audio, video, transcription).
//   The request is the one that a user message to such a model sends
//   (streams/mediaRequest.ts has the shared preparation and the
//   differences), with `prompt` in place of the message.
// - A text model (the request kind `chat`). The request is one chat
//   request with one user message: `prompt`, and the images that it names.
//   It holds no conversation, no system prompt, and no tools, so the
//   invoked model cannot call a tool or invoke a model in its turn (the
//   `toolsAllowed` rule, controller/modelInvoke.ts).
//
// Every text here is a tool result or the result of a job: it goes to the
// chat provider. So it names an image or a clip by its id only, and it
// holds no local path.

/** The time limit of a call with no `timeout_seconds`: 30 minutes, which
 *  the definition states in words. */
export const DEFAULT_INVOKE_TIMEOUT_SECONDS = 1800

/** The most characters of a text model's answer that the result of a job
 *  holds: the size limit of a `model_info` result, as both results go into
 *  the next request of the calling model and stay in the conversation, so
 *  a model that writes without end must not fill them. */
export const INVOCATION_TEXT_CAP = MODEL_INFO_SIZE_CAP

// Static text only (no count that changes, no date): the tools array and
// the system prompt, which lists the tools, are in the provider's prompt
// cache.
export const MODEL_INVOKE_TOOL: ToolDefinition = {
  name: 'model_invoke',
  description: 'Send one request to a model that the user can use, and get what it makes: '
    + 'a model that makes images, audio clips, or video clips, a model that writes down speech, or a text model. '
    + 'A request costs the user money, as a request that the user sends does. '
    + 'Call `model_info` for the model first: `usage` tells what the model needs, `dez.parameters` what a request can set, and `dez.cost` the price. '
    + '`model_list` finds models. '
    + 'The model gets only `prompt` and the inputs that `prompt` names with @id, not the conversation. '
    + 'A text model gets no tools and no system prompt: it can only answer `prompt`, and of the inputs it takes only images. '
    + 'To learn what an image shows, ask a text model that reads images about it; that model can be your own model. '
    + 'The call starts a job and returns its job id at once; `jobs_wait` gives the result. '
    + 'Jobs run at the same time: start every call that does not need the result of another call, then wait. '
    + 'An image or a clip that the model made goes into your reply at `jobs_wait`, with a new id that a later call can name with @id. '
    + 'The new ids follow the order in which the jobs end, not the order of your calls: each result of `jobs_wait` names its call. '
    + 'The user sees each image and each clip of your reply: set `is_intermediate` for a call that makes only a part of the result. '
    + 'Text that the model made is only in the result of the job: the user sees it only when you write it in your reply. '
    + `The result of a text model holds at most the first ${INVOCATION_TEXT_CAP} characters of its answer. `
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
      description: 'The text of the request: what the model must make, change, or answer. '
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
        + 'and not a result that the user asked to see: a frame, one scene of a video, a sound track. '
        + 'The image or the clip is then hidden in your reply: the user sees only the chip of this call, and can open the chip to see it. '
        + 'It gets an id as any other one, which a later call can name with @id. '
        + 'The default is `false`: the image or the clip shows in your reply.',
      required: false,
    },
    jobTimeoutParameter(DEFAULT_INVOKE_TIMEOUT_SECONDS),
  ],
}

// What every `model_invoke` call holds, after every check that needs no
// request.
interface InvocationTarget {
  provider: ProviderInfo
  model: ModelInfo
  /** The images and the clips that go, in text order. */
  inputs: PromptInput[]
  /** The id of each input image by its path, for the text of an image that
   *  Dez then cannot read. */
  imageIds: ReadonlyMap<string, string>
  /** The time limit of the job. */
  timeoutMs: number
}

/** A call to a model of a media request kind: one media request
 *  (`dez.provider/generateMedia`). */
export interface MediaInvocation extends InvocationTarget {
  kind: MediaKind
  /** What the request sends of the prompt (`preparedMediaRequest`). */
  request: MediaRequestInput
  /** The parameter values that the caller wants: the values of the call
   *  over the values that the user chose. `dez.provider/generateMedia`
   *  takes the ones that the model takes, and the defaults of the others. */
  parameters: ParameterValues
}

/** A call to a text model: one chat request (`dez.provider/streamChat`)
 *  whose only message is this user message. */
export interface ChatInvocation extends InvocationTarget {
  kind: 'chat'
  /** The content of the user message: the prompt, or, when it names
   *  images, its text with an image part right after the text that names
   *  each image (the shape of the newest user message of a conversation,
   *  streams/messages.ts). */
  content: string | MessagePart[]
  /** The model makes images too: the request asks for them, as a request
   *  of the user does (`submitTab`). */
  imageOutput: boolean
  /** The user's toggles of the provider, which a request of the user to
   *  the model sends too (Thinking, web search); undefined for none. */
  providerSettings: Record<string, boolean> | undefined
}

/** What a `model_invoke` call sends, after every check that needs no
 *  request. */
export type ModelInvocation = MediaInvocation | ChatInvocation

/** What Dez knows when a `model_invoke` call comes. */
export interface InvocationFacts {
  cache: ModelCache
  providers: readonly ProviderInfo[]
  /** The parameter values that the user chose, by `modelRefKey`
   *  (`SettingsSnapshot.modelParameters`). */
  modelParameters: Readonly<Record<string, ParameterValues>>
  /** The toggles that the user set, by provider id
   *  (`SettingsSnapshot.providerSettings`). */
  providerSettings: Readonly<Record<string, Record<string, boolean>>>
  /** The sections of the tab of the call. */
  sections: readonly Section[]
}

// The request kind of a model that `model_invoke` takes. Dez sends no
// request to a model with the request `none` or with an output that it
// cannot store, as for the user.
function invokedKind(model: ModelInfo): MediaKind | 'chat' {
  const kind = effectiveRequest(model)
  if (kind === 'none') throw new ToolError(`${unusableModelMessage(model.name, model)} ${FIND_MODELS}`)
  if (model.unstoredOutput !== undefined) throw new ToolError(`${unstoredOutputMessage(model.name, model.unstoredOutput)} ${FIND_MODELS}`)
  return kind
}

// A prompt that names an input that is not there gets no request: the
// model would pay for a result without it (`unknownInputsProblem`).
const PROMPT_INPUTS: InputWording = { argument: '`prompt`', notDone: 'Dez sent no request.' }

// The content of the one user message that a call sends to the text model
// `model` (`ChatInvocation.content`), from the source of its prompt.
//
// Throws for an input that the request does not carry: a clip (a chat
// request takes none, whatever the provider says that the model reads,
// `modelInputs`), and an image for a model that is known not to read
// images (a user message sends such a model the reference as text; the
// calling model would get an answer about an image that the model never
// got). Throws for a prompt with no text too.
function chatContent(model: ModelInfo, source: PromptRequestSource): string | MessagePart[] {
  const imageCount = source.inputs.length - source.clips.length
  const problem = clipTagProblem(model.name, undefined, source.clips, imageCount, undefined, 'model')
    ?? unusedImagesProblem(model.name, model.imageInput === false ? 0 : imageCount, imageCount)
  if (problem !== null) throw new ToolError(problem)
  // The text after the last image can be only white space, and the
  // Anthropic format refuses such a text part (as `userMessageContent`,
  // streams/messages.ts).
  const parts = source.parts.filter((part) => part.type === 'image' || part.text.trim() !== '')
  const [first] = parts
  if (first === undefined) {
    throw new ToolError(`\`prompt\` has no text, and ${model.name} answers nothing without one. Write in \`prompt\` what the model must answer or do, and name each image that it must get with @id.`)
  }
  return parts.length === 1 && first.type === 'text' ? first.text : parts
}

/** The request of a `model_invoke` call with `args`: the model that it
 *  names, the inputs that its prompt names, and the values of its
 *  parameters. Every check that needs no request runs here, before the job
 *  starts, so that a call that cannot work costs nothing and gets its
 *  answer at once.
 *
 *  Throws a `ToolError` that tells the model how to fix the call:
 *  - a model that the user cannot use (`namedModelTarget`), or that Dez
 *    sends no request;
 *  - a bad `timeout_seconds` or `parameters` (`parameterValuesArgument`; a
 *    text model has no parameters, so it takes none);
 *  - an `@id` that names nothing (`unknownInputsProblem`);
 *  - for a media model: an input that the model does not take, more
 *    inputs than it takes, or a text that it does not take
 *    (`promptRequestProblem`);
 *  - for a text model: a clip, or an image for a model that reads none
 *    (`chatContent`);
 *  - no text for a model that needs one. */
export function modelInvocation(args: ToolArguments, { cache, providers, modelParameters, providerSettings, sections }: InvocationFacts): ModelInvocation {
  const { provider, model } = namedModelTarget(cache, providers, typeof args.model === 'string' ? args.model : '')
  const kind = invokedKind(model)
  const timeoutMs = jobTimeoutMs(args, DEFAULT_INVOKE_TIMEOUT_SECONDS)
  const chosen = modelParameters[modelRefKey({ providerId: provider.id, modelId: model.id })]
  const parameters = { ...chosen, ...parameterValuesArgument(model, args) }

  const assets = conversationAssets(sections)
  const source = promptRequestSource(typeof args.prompt === 'string' ? args.prompt : '', assets)
  const [nextId] = newMediaIds(sections.map(sectionPlainText), 1)
  const unknown = unknownInputsProblem(source.unknownIds, assets, nextId, PROMPT_INPUTS)
  if (unknown !== null) throw new ToolError(unknown)
  const target = { provider, model, timeoutMs }

  if (kind === 'chat') {
    const content = chatContent(model, source)
    // Every input goes, and each one is an image: `chatContent` refused
    // the clips.
    const imageIds = new Map(source.inputs.flatMap(({ id }) => {
      const path = assets.images.get(id)
      return path === undefined ? [] : [[path, id] as const]
    }))
    return {
      ...target,
      kind,
      content,
      imageOutput: effectiveOutputs(model).includes('image'),
      providerSettings: providerSettings[provider.id],
      inputs: source.inputs,
      imageIds,
    }
  }

  // The image rules can depend on the parameter values that the request
  // sends, as for a user message (`submitTab`).
  const rules = mediaInputRules(model, parameters)
  const request = preparedMediaRequest(kind, source, rules)
  const problem = promptRequestProblem(model.name, kind, model, rules.images, source, request)
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
  return { ...target, kind, request, parameters, inputs, imageIds }
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

// The lead of a text that a model wrote, in the result of a job.
const GIVEN_TEXT = 'the model gave (the user sees it only when you write it in your reply)'

/** The result text of a job whose model wrote `text` (a transcription). It
 *  goes as the model gave it: it is the answer of the model, not data
 *  about the computer. */
export function invocationTextResult(text: string): string {
  const words = text.trim()
  return words === ''
    ? 'The model gave no text: it found no words in the input.'
    : `The text that ${GIVEN_TEXT}:\n${words}`
}

/** The state of a job whose text model gave `characters` characters of
 *  answer text so far. A model that thinks first gives none for a time. */
export function invocationAnswerStateText(characters: number): string {
  return characters === 0 ? 'The model has given no text yet.' : `The model has given ${characters} characters of text so far.`
}

/** Whether `answer`, the answer text of a text model so far, is more than
 *  the result of its job holds: the job needs no more of it. */
export function answerIsCut(answer: string): boolean {
  return answer.length > INVOCATION_TEXT_CAP
}

/** The result text of a job whose text model answered with `answer`. The
 *  text goes as the model gave it, as a transcription does
 *  (`invocationTextResult`). An answer over INVOCATION_TEXT_CAP characters
 *  (`answerIsCut`) is cut to that length, and the text says so first: the
 *  job can have stopped the request there, so the rest is not known. The
 *  images of the answer are assets of the job, which `jobResultText`
 *  names. */
export function invocationAnswerText(answer: string): string {
  if (answerIsCut(answer)) {
    // A cut between the two halves of a character pair (an emoji) would
    // leave a half that is no text: a provider can refuse a request that
    // holds it.
    const start = answer.slice(0, INVOCATION_TEXT_CAP).replace(/[\uD800-\uDBFF]$/, '')
    return `The start of the text that ${GIVEN_TEXT}. `
      + `The answer had more than ${INVOCATION_TEXT_CAP} characters, and the result of a job holds no more, so the rest is lost. `
      + `When you need the rest, call again and ask for a shorter answer, or for the answer in parts:\n${start.trim()}`
  }
  const words = answer.trim()
  return words === '' ? 'The model gave no text.' : `The text that ${GIVEN_TEXT}:\n${words}`
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

/** The error result of a job whose request failed with `message`: the
 *  text of the failure for a model that called (`RequestReader`: whose
 *  fault it is and what a new call can change, the provider's own job id
 *  when it took one, and the provider's text as the details). The last
 *  sentence is for a failure whose text names no fix. A local server can
 *  name a file in its error text, so the local paths go. */
export function invocationFailedText(modelName: string, message: string): string {
  return `The request to ${modelName} failed, and it made nothing. ${withoutLocalPaths(message)}\n\n`
    + 'When the cause is in `prompt`, the inputs, or `parameters`, change the call and call again. Else tell the user what failed.'
}
