import sbp from '@sbp/sbp'
import { drawnMediaType, type DrawnImage, type ImageSize } from '../chat/imageDrawing'
import { IMAGE_FOLDERS, imageMediaType, storedImageFile, type ImageMediaType } from '../chat/images'
import type { MessagePart } from '../chat/types'
import { modelRefKey } from '../chat/modelRef'
import type { ModelCache } from '../persistence/types'
import { bytesToBase64 } from '../../utils/base64'
import { ExplainedError, explainedError, rawErrorText, REPORT_ADVICE } from '../../utils/errorText'
import { fileNameOf } from '../../utils/fileName'
import { secret, type Secret } from '../../utils/secret'
import { sanitizeErrorText } from '../../utils/protocol/errors'
import { nativeResponseJson, nativeResponseText, readNativeChunkBytes, type NativeHttpRequest, type NativeHttpResponse, type NativeHttpStreamResult } from '../../utils/protocol/nativeHttp'
import { missingImageProblem } from './clipImages'
import { CLIP_JOB_TIMEOUT_MS, clipPollDelay, sendClipRequest, type ClipRun } from './clipRequests'
import { assertProviderResponseOk, explainedProviderError, providerConnectionError, UnusableAnswerError } from './errors'
import { generatedImageFromUrl } from './generatedImages'
import { imageFit, type ImageSizeRules } from './imageSize'
import type { MediaWireRequest } from './mediaFormats'
import { effectiveParameterValues, type ParameterValues } from './modelParameters'
import { modelToggles, type ToggleModel } from './modelToggles'
import type { Provider, ProviderChatRequest } from './provider'
import { getProvider, listProviders, requireProvider } from './registry'
import { assertStreamResponseOk, streamProviderTokens } from './streaming'
import type { ProviderChatInputMessage, ProviderGenerateMediaInput, ProviderGenerateMediaResult, ProviderMediaQuote, ProviderMediaQuoteInput, ProviderStreamChatInput, ProviderStreamChatResult } from './streamTypes'
import { CLIP_KINDS, ProviderNotConfiguredError, effectiveRequest, isClipKind, type ChatImagePart, type ChatMessage, type ChatPart, type ModelDisplayNames, type ModelInfo, type ProviderId, type ProviderInfo, type ProviderInputImageRules, type ProviderModelsResult, type ProviderSettingsDescriptor } from './types'
import { unstoredOutputMessage } from './unusableModel'

// The file of a stored image.
interface StoredImage {
  bytes: Uint8Array
  mediaType: ImageMediaType
}

// The stored key, or null when there is none. Throws for GitHub Copilot when
// the user is not signed in.
export async function providerSecret(providerId: ProviderId): Promise<Secret<string> | null> {
  const value = await sbp('dez.native/getProviderSecret', providerId) as string | null
  return value ? secret(value) : null
}

async function refreshCopilotSecret(): Promise<Secret<string>> {
  const value = await sbp('dez.native/getCopilotChatToken') as { token: string }
  return secret(value.token)
}

// Providers that do not require a key send requests without auth headers
// when no key is stored, or when the key store cannot be read (like
// dez.provider/infos, which then treats them as configured).
async function requestSecret(provider: Provider, refreshCopilot = false): Promise<Secret<string> | null> {
  const copilot = provider.config.auth === 'githubCopilot'
  let value: Secret<string> | null
  try {
    value = refreshCopilot ? await refreshCopilotSecret() : await providerSecret(provider.id)
  } catch (error) {
    console.error(`Failed to read the API key of provider ${provider.id}:`, error)
    if (provider.requiresKey) throw secretReadError(provider, copilot, error)
    value = null
  }

  if (!value && provider.requiresKey) {
    throw new ProviderNotConfiguredError(provider.id, provider.name, copilot)
  }

  return value
}

// The native text does not tell the cause of a failed Copilot token
// request (no sign-in, an expired one, or no connection), so the text names
// each with its fix.
function secretReadError(provider: Provider, copilot: boolean, error: unknown): ExplainedError {
  const name = provider.name
  const explanation = copilot
    ? `Dez could not get a sign-in token from ${name}. If you did not sign in to ${name}, or the sign-in has expired, sign in to ${name} in Settings › Providers. Else check the internet connection, then try again.`
    : `Dez could not read the API key of ${name}. Enter the API key of ${name} again in Settings › Providers. If Dez cannot save it either, its key file is damaged or locked: the details below tell what failed.`
  return new ExplainedError(explanation, sanitizeErrorText(rawErrorText(error)), { cause: error })
}

// The messages with the bytes of each image part, read once for the request
// and its Copilot retry. The app folder is read only when a message has an
// image.
async function readMessageImages(messages: ProviderChatInputMessage[]): Promise<ChatMessage[]> {
  let appDir: Promise<string> | undefined
  const readPart = async (part: MessagePart): Promise<ChatPart> => {
    if (part.type === 'text') return part
    appDir ??= sbp('dez.native/getAppDir') as Promise<string>
    const { bytes, mediaType } = await readStoredImage(part.path, await appDir)
    return { type: 'image', mediaType, data: bytesToBase64(bytes) }
  }

  return Promise.all(messages.map(async (message): Promise<ChatMessage> => {
    if (message.role !== 'user') return message
    const { content } = message
    return { role: 'user', content: typeof content === 'string' ? content : await Promise.all(content.map(readPart)) }
  }))
}

// Only a stored image of this Dez folder is read (`storedImageFile`): the
// folders that dez.controller/images/save writes and the asset protocol
// serves. So a reference copied from another home or machine fails like a
// missing file, as it shows in the editor. The error names only the file,
// like the editor's broken-image box; the log has the cause.
async function readStoredImage(path: string, appDir: string): Promise<StoredImage> {
  try {
    const file = storedImageFile(path, appDir)
    const mediaType = imageMediaType(path)
    if (!file || !mediaType) {
      throw new Error(`The image is not in an image folder of ${appDir} (${Object.values(IMAGE_FOLDERS).join(', ')})`)
    }
    return { bytes: await sbp('dez.native/loadAppFileBytes', file) as Uint8Array, mediaType }
  } catch (error) {
    console.error(`Failed to read the image ${path}:`, error)
    throw new ExplainedError(`The image file ${fileNameOf(path)} is missing, or Dez cannot read it. Paste the image again, or remove its reference from the message.`)
  }
}

// The image that a media request sends for a stored image. A provider
// refuses an image that breaks a size rule that it tells (`rules`,
// imageSize.ts), so such an image goes as a new drawing that passes the
// rules: a part of it, at another size (`imageFit`). Only the request gets
// the drawing; the stored file and the doc keep the image. An image that
// passes the rules goes as it is, byte for byte, and so does every image
// of a request with no rules, which is not even decoded. An image that
// cannot be drawn (a file that the webview does not decode) also goes as
// it is: the provider's answer then tells the user what is wrong. `size`
// is the size of the image that goes; null when it was not decoded.
async function fittedImage(image: StoredImage, rules: ImageSizeRules | undefined): Promise<StoredImage & { size: ImageSize | null }> {
  if (!rules) return { ...image, size: null }
  const mediaType = drawnMediaType(image.mediaType)
  let decoded: ImageSize | null = null
  try {
    const file = new Blob([image.bytes], { type: image.mediaType })
    const plan = (size: ImageSize) => {
      decoded = { width: size.width, height: size.height }
      return imageFit(size, rules)
    }
    const drawn = await sbp('dez.controller/images/redraw', file, plan, mediaType) as DrawnImage | null
    return drawn ? { bytes: drawn.bytes, mediaType, size: { width: drawn.width, height: drawn.height } } : { ...image, size: decoded }
  } catch (error) {
    console.error('Failed to fit an image to the size rules of the request:', error)
    return { ...image, size: null }
  }
}

// The model as the model cache knows it, for the rule of its toggles
// (modelToggles.ts). A model that the cache does not have is only its id,
// so every toggle of the provider applies to it.
function toggleModel(providerId: ProviderId, modelId: string): ToggleModel {
  return (sbp('dez.model/modelCache/model', providerId, modelId) as ModelInfo | null) ?? { id: modelId }
}

async function nativeChatStream(
  provider: Provider,
  input: ProviderStreamChatInput,
  messages: ChatMessage[],
  requestId: string,
  refreshCopilot = false,
): Promise<{ result: NativeHttpStreamResult, thinking: ProviderChatRequest['thinking'] }> {
  const secretValue = await requestSecret(provider, refreshCopilot)
  const { request, thinking } = provider.chatRequest(messages, toggleModel(provider.id, input.modelId), secretValue, input.providerSettings, input)
  return { result: await sbp('dez.http/stream', request, requestId) as NativeHttpStreamResult, thinking }
}

// The bytes of an image that a reply names by an http(s) URL. The request
// has no provider headers: the URL can name any host, and the API key must
// not go there.
async function fetchReplyImage(provider: Provider, url: string): Promise<Uint8Array> {
  const { response, chunks } = await sbp('dez.http/stream', { method: 'GET', url }) as NativeHttpStreamResult
  await assertStreamResponseOk(provider, response, chunks, false)
  return readNativeChunkBytes(chunks)
}

// The JSON of the 2xx response to a request that is not a stream (a model
// list, a price). Throws for any other status, for no answer, and for an
// answer that is not JSON (a custom provider's base URL can name a web page
// that answers 2xx with HTML).
async function jsonResponse(provider: Provider, request: NativeHttpRequest): Promise<unknown> {
  let response: NativeHttpResponse
  try {
    response = await sbp('dez.native/httpRequest', request) as NativeHttpResponse
  } catch (error) {
    throw providerConnectionError(provider, error)
  }
  assertProviderResponseOk(response, provider, nativeResponseText(response))
  try {
    return nativeResponseJson<unknown>(response)
  } catch (error) {
    const fix = provider.builtIn
      ? ` Try again later. ${REPORT_ADVICE}`
      : ` Check the base URL of ${provider.name} in Settings › Providers.`
    throw new ExplainedError(`${provider.name} sent an answer that is not JSON, so Dez cannot read it.${fix}`, rawErrorText(error), { cause: error })
  }
}

// The value that a media request sends for each parameter of a model: the
// model's parameters are in the model cache (`ModelInfo.parameters`), and
// `chosen` holds the values that the caller wants (`effectiveParameterValues`).
function parameterValues(providerId: ProviderId, modelId: string, chosen: Readonly<ParameterValues> | undefined): ParameterValues {
  const model = sbp('dez.model/modelCache/model', providerId, modelId) as ModelInfo | null
  return effectiveParameterValues(model?.parameters ?? [], chosen)
}

export default sbp('sbp/selectors/register', {
  async 'dez.provider/infos' (): Promise<ProviderInfo[]> {
    let keyIds: string[] = []
    try {
      keyIds = await sbp('dez.native/getConfiguredProviderIds') as string[]
    } catch (error) {
      // Still list every provider, as if no key were stored, so providers
      // that need no key stay usable.
      console.error('Failed to read configured provider ids:', error)
    }

    const keys = new Set(keyIds)
    return listProviders().map((provider) => provider.info(keys))
  },

  // Synchronous and reactive read for the provider settings popup: the
  // provider's display name and the toggles that apply to this model
  // (`modelToggles`, the rule that the chat request follows too), instead of
  // the whole Provider. Takes a plain string, so views need no id check;
  // null for unknown ids.
  'dez.provider/settingsDescriptor' (providerId: string, modelId: string): ProviderSettingsDescriptor | null {
    const provider = getProvider(providerId)
    return provider
      ? { name: provider.name, ...modelToggles(provider.config, toggleModel(provider.id, modelId)) }
      : null
  },

  // Synchronous: the rules of each input image of a request to the model
  // that the provider tells, as dez.provider/generateMedia applies them
  // (`Provider.inputImageSize`, `Provider.inputImageLimits`). Empty for a
  // model that takes no media request, and for an unknown provider.
  'dez.provider/inputImageRules' (providerId: string, modelId: string): ProviderInputImageRules {
    const provider = getProvider(providerId)
    const model = sbp('dez.model/modelCache/model', providerId, modelId) as ModelInfo | null
    const kind = effectiveRequest(model ?? {})
    if (!provider || kind === 'chat' || kind === 'none') return {}
    const size = provider.inputImageSize(kind, model)
    const limits = provider.inputImageLimits(kind)
    return { ...(size && { size }), ...(limits && { limits }) }
  },

  // Synchronous and reactive: it reads the custom providers and the model
  // cache through model selectors, so a view computed over it updates when
  // either changes. A name set in a provider config beats the cached name,
  // because the cache keeps the name from the last fetch and a config edit
  // does not refetch.
  'dez.provider/modelDisplayNames' (): ModelDisplayNames {
    const providers = new Map<ProviderId, string>()
    const models = new Map<string, string>()

    const cache = sbp('dez.model/modelCache/snapshot') as ModelCache
    for (const [providerId, entry] of Object.entries(cache.providers)) {
      for (const model of entry?.models ?? []) {
        models.set(modelRefKey({ providerId, modelId: model.id }), model.name)
      }
    }

    for (const provider of listProviders()) {
      providers.set(provider.id, provider.name)
      for (const model of provider.config.models) {
        if (model.name) models.set(modelRefKey({ providerId: provider.id, modelId: model.id }), model.name)
      }
    }

    return { providers, models }
  },

  // Never throws for a known provider: every failure becomes `ok: false`, the
  // basis for the provider's "working" status in the model cache.
  //
  // The model list and the lists of the media API (`mediaModelListRequests`)
  // load at the same time. A failed list of the media API does not fail the
  // check, as the provider's other models work without it: the result says
  // so (`mediaListFailed`), and the model cache then keeps what it knew of
  // each model from the media lists (`withKeptClipData`). A model that the
  // cache did not know has no parameters then, and one that needs them gets
  // no request until a later check (`ClipFormat.request`).
  async 'dez.provider/listModelsResult' (providerId: ProviderId): Promise<ProviderModelsResult> {
    const provider = requireProvider(providerId)

    try {
      const secretValue = await requestSecret(provider)
      const listRequest = provider.modelListRequest(secretValue)
      const mediaListRequests = provider.mediaModelListRequests(secretValue)
      const [data, ...mediaData] = await Promise.all([
        listRequest ? jsonResponse(provider, listRequest) : undefined,
        ...mediaListRequests.map((request) => jsonResponse(provider, request).catch((error: unknown) => {
          console.error(`Failed to list the media models of provider ${providerId}:`, error)
          return undefined
        })),
      ])
      // `undefined` is no JSON value: it tells that the request failed.
      const loadedMediaData = mediaData.filter((list) => list !== undefined)
      const mediaListFailed = loadedMediaData.length < mediaListRequests.length
      // With no model list, these are the config models.
      const merged = provider.mergeModels(provider.parseModels(data))
      const entries = provider.modelEntries(merged, data)
      const mediaEntries = loadedMediaData.length > 0 ? provider.mediaModelEntries(loadedMediaData) : undefined
      const models = provider.withClipData(merged, entries, mediaEntries ?? new Map())
      return { ok: true, models, entries, ...(mediaEntries && { mediaEntries }), ...(mediaListFailed && { mediaListFailed }) }
    } catch (error) {
      console.error(`Failed to list models for provider ${providerId}:`, error)
      return { ok: false, models: [], error: explainedError(error).message }
    }
  },

  // A failed request rejects with a text for the user
  // (`explainedProviderError`).
  async 'dez.provider/streamChat' (input: ProviderStreamChatInput): Promise<ProviderStreamChatResult> {
    const provider = requireProvider(input.providerId)
    const requestId = input.requestId ?? crypto.randomUUID()
    const messages = await readMessageImages(input.messages)
    try {
      let stream = await nativeChatStream(provider, input, messages, requestId)

      // A 401 can mean the cached Copilot chat token expired early; get a
      // fresh one and retry once. The refused response is never parsed, so
      // its thinking cannot mix with the retry's.
      if (provider.config.auth === 'githubCopilot' && stream.result.response.status === 401) {
        await sbp('dez.http/cancelStream', stream.result.requestId)
        stream = await nativeChatStream(provider, input, messages, requestId, true)
      }

      return {
        requestId: stream.result.requestId,
        ...await streamProviderTokens(provider, input, stream.result, stream.thinking,
          (url) => generatedImageFromUrl(url, (imageUrl) => fetchReplyImage(provider, imageUrl))),
      }
    } catch (error) {
      throw explainedProviderError(provider, error)
    }
  },

  // Makes media with a model of the provider's media API (`mediaApi`). It
  // needs no tab or editor, so a tool can call it too. dez.http/cancelStream
  // with `requestId` cancels the request that runs, and `signal` does the
  // same and also ends the wait of a clip job. An input image that breaks
  // a size rule of the request goes as a drawing that passes it
  // (`fittedImage`); one that breaks a limit that no drawing meets rejects
  // before any request (`Provider.inputImageProblem`). The request sets the
  // model's parameters (a scale, the length of a clip, a voice):
  // `input.parameters` where the model takes the value, else the
  // parameter's default.
  //
  // - An image, or an edit or an upscale of stored images: one request
  //   through dez.http/stream. A cancel before the response headers
  //   rejects; a cancel after them ends the body early, so a caller that
  //   cancelled must drop the result.
  // - A clip (speech, music, video): the answer to the first request is the
  //   clip, or a job. For a job, the provider is asked for its state each
  //   `CLIP_POLL_INTERVAL_MS` until the clip is there: in the answer to
  //   that request, at a URL that plays, at a URL to copy, or behind one
  //   more request. A clip that came as bytes is a temp copy in the cache
  //   root (`sendClipRequest`), which the caller must delete when it does
  //   not keep the clip. A stop rejects. A video request sends the stored
  //   images of `input.images` as frames of the video. A refusal that
  //   tells that the model takes fewer images rejects with a
  //   TooManyImagesError (`Provider.imageCountRefusal`).
  //
  // A provider takes the money for a job when it starts. So after that
  // point, a failure and a stop log the job id, and the message of a
  // failure names it: with the id, the user can ask the provider for the
  // clip.
  async 'dez.provider/generateMedia' (input: ProviderGenerateMediaInput): Promise<ProviderGenerateMediaResult> {
    const provider = requireProvider(input.providerId)
    const { kind, modelId, signal } = input
    const requestId = input.requestId ?? crypto.randomUUID()
    // The native cancel also ends a clip request (`downloadAppFile`).
    const cancelRequest = () => {
      sbp('dez.http/cancelStream', requestId).catch((error: unknown) => console.error('Failed to cancel a media request:', error))
    }
    signal?.addEventListener('abort', cancelRequest)
    let jobId: string | null = null
    try {
      const paths = input.images ?? []
      const cachedModel = sbp('dez.model/modelCache/model', provider.id, modelId) as ModelInfo | null
      // The submit refuses such requests with the model's name
      // (`unstoredOutputMessage`, `missingImageProblem`); this is for a
      // caller that did not check.
      if (cachedModel?.unstoredOutput !== undefined) throw new ExplainedError(unstoredOutputMessage(cachedModel.name, cachedModel.unstoredOutput))
      const missingImages = missingImageProblem(cachedModel?.name ?? modelId, kind, paths.length, cachedModel?.images)
      if (missingImages !== null) throw new ExplainedError(missingImages)
      const appDir = paths.length > 0 ? await sbp('dez.native/getAppDir') as string : ''
      const sizeRules = provider.inputImageSize(kind, cachedModel)
      const images = await Promise.all(paths.map(async (path): Promise<ChatImagePart> => {
        const { bytes, mediaType, size } = await fittedImage(await readStoredImage(path, appDir), sizeRules)
        const problem = provider.inputImageProblem(kind, size, bytes.length)
        if (problem !== undefined) throw new ExplainedError(problem)
        return { type: 'image', mediaType, data: bytesToBase64(bytes) }
      }))
      const values = parameterValues(provider.id, modelId, input.parameters)

      if (!isClipKind(kind)) {
        const request = provider.mediaRequest(kind, modelId, { prompt: input.prompt, images, values }, await requestSecret(provider))
        signal?.throwIfAborted()
        const { response, chunks } = await sbp('dez.http/stream', request, requestId) as NativeHttpStreamResult
        await assertStreamResponseOk(provider, response, chunks)
        return { media: provider.mediaResult(kind, response, await readNativeChunkBytes(chunks)), clips: [] }
      }

      const startedAt = Date.now()
      const run: ClipRun = { provider, kind, requestId, deadline: startedAt + CLIP_JOB_TIMEOUT_MS, signal }
      const secret = await requestSecret(provider)
      // A request of the media API, which gets the API key.
      const apiRequest = (wire: MediaWireRequest) => provider.mediaApiRequest(wire, secret)
      const cacheDir = await sbp('dez.native/getAppDir', 'cache') as string
      const clipInput = { prompt: input.prompt, images, values, ...(input.lyrics !== undefined && { lyrics: input.lyrics }) }
      // A refusal that tells that the model takes fewer images: the user
      // gets Dez's text, with the count, and the console the provider's. A
      // refusal that tells a field value that the model needs: the request
      // goes once more with it (`Provider.clipRequestAfterRefusal`).
      const firstRequest = provider.clipRequest(kind, modelId, clipInput)
      const first = await sendClipRequest(run, apiRequest(firstRequest), null, cacheDir).catch(async (error: unknown) => {
        const refusal = provider.imageCountRefusal(kind, error, images.length)
        if (refusal) {
          console.error(`${provider.name} refused the images of a request to ${modelId}:`, error)
          throw refusal
        }
        const fixed = provider.clipRequestAfterRefusal(kind, firstRequest, error)
        if (!fixed) throw error
        console.error(`${provider.name} refused a request to ${modelId}, which goes once more with the fields that the refusal names:`, error)
        return sendClipRequest(run, apiRequest(fixed), null, cacheDir)
      })
      if ('clip' in first) return { media: [], clips: [first.clip] }

      const job = provider.clipJob(kind, modelId, first.data)
      jobId = job.id
      for (;;) {
        await clipPollDelay(signal)
        const poll = await sendClipRequest(run, apiRequest(job.poll), jobId, cacheDir)
        if ('clip' in poll) return { media: [], clips: [poll.clip] }

        const state = job.state(poll.data)
        if (state === 'running') continue
        if ('url' in state) {
          const clip = { kind: CLIP_KINDS[kind], mediaType: state.mediaType, src: state.url, url: state.url, expires: new Date(state.expires).toISOString(), jobId }
          return { media: [], clips: [clip] }
        }
        // A file URL comes from a response and can name any host, so its
        // request has no header: the API key goes only to the URLs that
        // Dez builds.
        const keyed = 'download' in state
        const request: NativeHttpRequest = keyed ? apiRequest(state.download) : { method: 'GET', url: state.fileUrl }
        const download = await sendClipRequest(run, request, jobId, cacheDir, keyed)
        if (!('clip' in download)) throw new UnusableAnswerError('The answer to the clip download holds no clip.')
        return { media: [], clips: [download.clip] }
      }
    } catch (error) {
      const explained = explainedProviderError(provider, error)
      if (jobId === null) throw explained
      const stopped = signal?.aborted === true
      console.error(`The clip job ${jobId} of ${provider.name} (model ${modelId}) ${stopped ? 'was stopped' : 'failed'}:`, error)
      if (stopped) throw error
      // A provider takes the money for a job when it starts, so the text
      // gives the job id, before the details.
      const { explanation, details } = explainedError(explained)
      throw new ExplainedError(`${explanation} To ask ${provider.name} about this clip, give its job id: ${jobId}.`, details, { cause: error })
    } finally {
      signal?.removeEventListener('abort', cancelRequest)
    }
  },

  // The provider's price in USD of the image or the clip that
  // dez.provider/generateMedia with the same `parameters` asks for, as far
  // as its data tells one, and the model's price records for a provider
  // whose model lists hold no prices. Null when the provider tells neither:
  // its model entries hold the prices then. The requests cost nothing.
  // Rejects when one fails.
  async 'dez.provider/mediaQuote' (input: ProviderMediaQuoteInput): Promise<ProviderMediaQuote | null> {
    const provider = requireProvider(input.providerId)
    const { kind, modelId } = input
    const values = parameterValues(provider.id, modelId, input.parameters)
    const entry = sbp('dez.model/modelCache/rawModel', provider.id, modelId) as unknown
    if (isClipKind(kind)) {
      const quote = provider.clipQuote(kind, modelId, values, entry, await requestSecret(provider))
      return quote ? { usd: quote.usd(await jsonResponse(provider, quote.request)) } : null
    }

    const quote = provider.imageQuote(kind, modelId, await requestSecret(provider))
    if (!quote) return null
    const records = quote.request ? await jsonResponse(provider, quote.request) : undefined
    const mediaEntry = sbp('dez.model/modelCache/rawModel', provider.id, modelId, 'media') as unknown
    const usd = quote.usd(kind, values, { entry, mediaEntry, records })
    if (usd === undefined && records === undefined) return null
    return { ...(usd !== undefined && { usd }), ...(records !== undefined && { records }) }
  },
})
