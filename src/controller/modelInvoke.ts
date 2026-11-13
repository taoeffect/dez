import sbp from '@sbp/sbp'
import { TooManyImagesError, tooManyImagesMessage } from '../model/providers/clipImages'
import { InputImageError } from '../model/providers/errors'
import type { MediaProgress, ProviderGenerateMediaResult } from '../model/providers/streamTypes'
import type { GeneratedMedia } from '../model/providers/types'
import { unreadableImageText } from '../model/tools/imageTool'
import {
  answerIsCut,
  IMAGE_NOT_SAVED_TEXT,
  INVOCATION_READS_INPUTS,
  invocationAnswerStateText,
  invocationAnswerText,
  invocationFailedText,
  invocationStateText,
  invocationTextResult,
  undrawnImageText,
  type ChatInvocation,
  type MediaInvocation,
  type ModelInvocation,
} from '../model/tools/modelInvoke'
import { TOOL_DEFINITIONS } from '../model/tools/registry'
import { ToolError } from '../model/tools/types'
import { ExplainedError } from '../utils/errorText'
import { discardJobAssets, type JobAsset, type JobOutcome } from './jobs'

// The request of a `model_invoke` call (model/tools/modelInvoke.ts), as the
// work of a job of the reply (jobs.ts). This module registers no selector:
// the `model_invoke` runner (tools.ts) starts the work, after the checks
// of the call (`modelInvocation`).

// The failure of a request as the error of its job: a `ToolError` whose
// text the calling model reads, for a failure that Dez knows. Any other
// error stays as it is, and the job then tells only that Dez did not
// expect it (its text can hold a local path).
function invocationError({ model, imageIds }: ModelInvocation, error: unknown): unknown {
  if (error instanceof InputImageError) {
    // Never the error's own text: it names the file, and the name of a
    // linked file is private.
    const id = imageIds.get(error.path)
    if (id === undefined) return error
    return new ToolError(error.problem === 'notDrawn' ? undrawnImageText(id) : unreadableImageText(id), '', { cause: error })
  }
  if (error instanceof TooManyImagesError) return new ToolError(tooManyImagesMessage(model.name, error, 'model'), '', { cause: error })
  if (error instanceof ExplainedError) return new ToolError(invocationFailedText(model.name, error.message), '', { cause: error })
  return error
}

/** What the caller of `invokeModel` lets the invoked model do. */
export interface InvocationRights {
  /** Whether an invoked text model gets the Dez tools: the internal
   *  `tools_allowed` rule. It is no argument of the tool, so no model can
   *  set it. The `model_invoke` runner passes `false`, because its caller
   *  is a text model: the request then holds no tools array (and never a
   *  system prompt or a conversation), so the invoked model cannot call a
   *  tool or invoke a model in its turn. One call is one request.
   *
   *  The type holds only `false`, because `true` needs more than the tools
   *  array: a tool loop for the invoked model (its request rounds, a
   *  `ToolRunContext` of its own, a limit on the depth of the calls), which
   *  Dez does not have. Widen the type together with that loop. */
  toolsAllowed: false
}

// The one media request of `invocation`, as the work of its job.
// - An image is saved in the generated image folder, and a clip stays at
//   the provider's URL or in a temp copy, as in a reply of a media model.
// - A text (a transcription) is the result text of the job.
// - `report` gets each step of the request, with the provider's own job id
//   as soon as there is one.
async function invokeMediaModel(invocation: MediaInvocation, signal: AbortSignal, report: (state: string) => void): Promise<JobOutcome> {
  const { provider, model, kind, request, parameters, timeoutMs } = invocation
  report(INVOCATION_READS_INPUTS)
  let result: ProviderGenerateMediaResult
  try {
    result = await sbp('dez.provider/generateMedia', {
      providerId: provider.id,
      modelId: model.id,
      kind,
      prompt: request.prompt,
      ...(request.lyrics !== undefined && { lyrics: request.lyrics }),
      images: request.images,
      clips: request.clips,
      parameters,
      signal,
      timeoutMs,
      onProgress: (progress: MediaProgress) => report(invocationStateText(provider.name, progress)),
      reader: 'model',
    }) as ProviderGenerateMediaResult
  } catch (error) {
    throw invocationError(invocation, error)
  }

  const assets: JobAsset[] = result.clips.map((clip) => ({
    kind: 'clip',
    clip: { kind: clip.kind, type: clip.mediaType, src: clip.src, url: clip.url, expires: clip.expires },
    ...(clip.jobId !== null && { jobId: clip.jobId }),
  }))
  // An abort cancelled the request, which can end the body of an image
  // early: a cut image is never saved. A clip that still came is whole,
  // and `ReplyJobs` deletes its temp copy.
  if (signal.aborted) return { text: '', isError: false, assets }

  try {
    for (const image of result.media) {
      assets.push({ kind: 'image', path: await sbp('dez.controller/images/save', image.bytes, image.mediaType, { folder: 'generated' }) as string })
    }
  } catch (error) {
    // images/save logged the failure and showed its error toast.
    await discardJobAssets(assets)
    throw new ToolError(IMAGE_NOT_SAVED_TEXT, '', { cause: error })
  }
  return { text: result.text === undefined ? '' : invocationTextResult(result.text), isError: false, assets }
}

// The one chat request of `invocation`, as the work of its job: the one
// user message, with the toggles that the user set for the provider, and
// nothing of the conversation (no earlier message, no system prompt, no
// conversation id for the provider's prompt cache).
// - The answer text is the result text of the job, up to its size limit
//   (`answerIsCut`). The thinking of the model is dropped.
// - An image of the answer is saved in the generated image folder, as in a
//   reply of a chat model that makes images.
// - `report` gets the count of the characters of the answer so far.
async function invokeTextModel(
  invocation: ChatInvocation,
  signal: AbortSignal,
  report: (state: string) => void,
  { toolsAllowed }: InvocationRights,
): Promise<JobOutcome> {
  const { provider, model, content, imageOutput, providerSettings } = invocation
  const requestId = crypto.randomUUID()
  const cancelRequest = () => {
    sbp('dez.http/cancelStream', requestId).catch((error: unknown) => console.error('Failed to cancel the request of an invoked model:', error))
  }
  const assets: JobAsset[] = []
  let answer = ''
  let imageNotSaved = false
  report(invocationAnswerStateText(0))
  try {
    await sbp('dez.provider/streamChat', {
      providerId: provider.id,
      modelId: model.id,
      messages: [{ role: 'user', content }],
      tools: toolsAllowed ? TOOL_DEFINITIONS : [],
      imageOutput,
      providerSettings,
      requestId,
      // A stop of the reply and the time limit of the job end the request.
      signal,
      // The calling model reads the text of a request that failed.
      reader: 'model',
      onThinking: () => {},
      onToken: (token: string) => {
        if (answerIsCut(answer)) return
        answer += token
        report(invocationAnswerStateText(answer.length))
        // The result holds no more text, so the user must not pay for
        // more. A model that makes images can still give one after its
        // text, so only a request for text ends here. The cancel ends the
        // answer with no error (`dez.provider/streamChat`).
        if (answerIsCut(answer) && !imageOutput) cancelRequest()
      },
      onImage: async (image: GeneratedMedia) => {
        // The job ended: `ReplyJobs` takes no result any more.
        if (signal.aborted) return
        try {
          assets.push({ kind: 'image', path: await sbp('dez.controller/images/save', image.bytes, image.mediaType, { folder: 'generated' }) as string })
        } catch (error) {
          // images/save logged the failure and showed its error toast.
          imageNotSaved = true
          throw error
        }
      },
    })
  } catch (error) {
    // An error of `onImage` does not end the request by itself. And
    // `ReplyJobs` reads no assets of a failed job, so the images that this
    // job saved go here.
    cancelRequest()
    await discardJobAssets(assets)
    throw imageNotSaved ? new ToolError(IMAGE_NOT_SAVED_TEXT, '', { cause: error }) : invocationError(invocation, error)
  }
  // An abort after the first bytes of the answer ends it early with no
  // error: the text is not whole. `ReplyJobs` deletes the saved images.
  if (signal.aborted) return { text: '', isError: false, assets }
  return { text: invocationAnswerText(answer), isError: false, assets }
}

/** The work of the job of a `model_invoke` call (`JobWork`): sends the one
 *  request of `invocation` (a media request, or a chat request to a text
 *  model), and gives what the model made. `rights` is what the caller lets
 *  an invoked text model do.
 *
 *  - An image and a clip are the assets of the job. The reader of the
 *    job's result writes them into the reply (`writeJobAssets`), with a
 *    new id each.
 *  - A text (a transcription, the answer of a text model) is the result
 *    text of the job. It is never written into the reply: the calling
 *    model decides what the user sees.
 *  - `report` gets how far the request is.
 *
 *  Rejects with a `ToolError` for a failure that Dez knows
 *  (`invocationError`); `ReplyJobs` logs it with its cause. When `signal`
 *  aborts (the job timed out, or its reply ended), the request ends,
 *  `ReplyJobs` takes no result and no error any more, and it deletes the
 *  files of a result that still comes. */
export function invokeModel(invocation: ModelInvocation, signal: AbortSignal, report: (state: string) => void, rights: InvocationRights): Promise<JobOutcome> {
  return invocation.kind === 'chat'
    ? invokeTextModel(invocation, signal, report, rights)
    : invokeMediaModel(invocation, signal, report)
}
