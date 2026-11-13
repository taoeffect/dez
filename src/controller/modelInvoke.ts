import sbp from '@sbp/sbp'
import { TooManyImagesError, tooManyImagesMessage } from '../model/providers/clipImages'
import { InputImageError } from '../model/providers/errors'
import type { MediaProgress, ProviderGenerateMediaResult } from '../model/providers/streamTypes'
import { unreadableImageText } from '../model/tools/imageTool'
import {
  IMAGE_NOT_SAVED_TEXT,
  INVOCATION_READS_INPUTS,
  invocationFailedText,
  invocationStateText,
  invocationTextResult,
  undrawnImageText,
  type ModelInvocation,
} from '../model/tools/modelInvoke'
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

/** The work of the job of a `model_invoke` call (`JobWork`): sends the one
 *  media request of `invocation`, and gives what the model made.
 *
 *  - An image is saved in the generated image folder, and a clip stays at
 *    the provider's URL or in a temp copy, as in a reply of a media model.
 *    The reader of the job's result writes them into the reply
 *    (`writeJobAssets`), with a new id each.
 *  - A text (a transcription) is the result text of the job. It is never
 *    written into the reply: the calling model decides what the user sees.
 *  - `report` gets each step of the request, with the provider's own job id
 *    as soon as there is one.
 *
 *  Rejects with a `ToolError` for a failure that Dez knows
 *  (`invocationError`); `ReplyJobs` logs it with its cause. When `signal`
 *  aborts (the job timed out, or its reply ended), `ReplyJobs` takes no
 *  result and no error any more, and deletes the files of a result that
 *  still comes. */
export async function invokeModel(invocation: ModelInvocation, signal: AbortSignal, report: (state: string) => void): Promise<JobOutcome> {
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
