import sbp from '@sbp/sbp'
import { drawnMediaType, type DrawnImage, type ImageSize } from '../chat/imageDrawing'
import { IMAGE_FOLDERS, imageMediaType, storedImageFile, type ImageMediaType } from '../chat/images'
import type { MessagePart } from '../chat/types'
import { modelRefKey } from '../chat/modelRef'
import type { ModelCache } from '../persistence/types'
import { bytesToBase64 } from '../../utils/base64'
import { fileNameOf } from '../../utils/fileName'
import { secret, type Secret } from '../../utils/secret'
import { nativeResponseJson, nativeResponseText, readNativeChunkBytes, type NativeHttpRequest, type NativeHttpResponse, type NativeHttpStreamResult } from '../../utils/protocol/nativeHttp'
import { CLIP_JOB_TIMEOUT_MS, clipPollDelay, sendClipRequest, type ClipRun } from './clipRequests'
import { assertProviderResponseOk } from './errors'
import { generatedImageFromUrl } from './generatedImages'
import { imageFit, type ImageSizeRules } from './imageSize'
import type { MediaWireRequest } from './mediaFormats'
import { effectiveParameterValues, type ParameterValues } from './modelParameters'
import { modelToggles, type ToggleModel } from './modelToggles'
import type { Provider, ProviderChatRequest } from './provider'
import { getProvider, listProviders, requireProvider } from './registry'
import { assertStreamResponseOk, streamProviderTokens } from './streaming'
import type { ProviderChatInputMessage, ProviderGenerateMediaInput, ProviderGenerateMediaResult, ProviderMediaQuoteInput, ProviderStreamChatInput, ProviderStreamChatResult } from './streamTypes'
import { CLIP_KINDS, ProviderNotConfiguredError, isClipKind, type ChatImagePart, type ChatMessage, type ChatPart, type ModelDisplayNames, type ModelInfo, type ProviderId, type ProviderInfo, type ProviderModelsResult, type ProviderSettingsDescriptor } from './types'

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
  let value: Secret<string> | null
  try {
    value = refreshCopilot ? await refreshCopilotSecret() : await providerSecret(provider.id)
  } catch (error) {
    if (provider.requiresKey) throw error
    console.error(`Failed to read the API key of provider ${provider.id}:`, error)
    value = null
  }

  if (!value && provider.requiresKey) {
    throw new ProviderNotConfiguredError(provider.id, provider.name, provider.config.auth === 'githubCopilot')
  }

  return value
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
    throw new Error(`Image not found: ${fileNameOf(path)}. Paste the image again, or remove its reference.`)
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
// it is: the provider's answer then tells the user what is wrong.
async function fittedImage(image: StoredImage, rules: ImageSizeRules | undefined): Promise<StoredImage> {
  if (!rules) return image
  const mediaType = drawnMediaType(image.mediaType)
  try {
    const file = new Blob([image.bytes], { type: image.mediaType })
    const drawn = await sbp('dez.controller/images/redraw', file, (size: ImageSize) => imageFit(size, rules), mediaType) as DrawnImage | null
    return drawn ? { bytes: drawn.bytes, mediaType } : image
  } catch (error) {
    console.error('Failed to fit an image to the size rules of the request:', error)
    return image
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
// list, a price). Throws for any other status.
async function jsonResponse(provider: Provider, request: NativeHttpRequest): Promise<unknown> {
  const response = await sbp('dez.native/httpRequest', request) as NativeHttpResponse
  assertProviderResponseOk(response, provider, nativeResponseText(response))
  return nativeResponseJson<unknown>(response)
}

// The value that a clip request sends for each parameter of a model: the
// model's parameters are in the model cache (`ModelInfo.parameters`), and
// `chosen` holds the values that the caller wants (`effectiveParameterValues`).
function clipParameterValues(providerId: ProviderId, modelId: string, chosen: Readonly<ParameterValues> | undefined): ParameterValues {
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
  // The model list and the list of the media API (`mediaModelListRequest`)
  // load at the same time. A failed list of the media API does not fail the
  // check, as the provider's other models work without it: the result says
  // so (`mediaListFailed`), and the model cache then keeps what it knew of
  // each model from that list (`withKeptClipData`). A model that the cache
  // did not know has no parameters then, and one that needs them gets no
  // request until a later check (`ClipFormat.request`).
  async 'dez.provider/listModelsResult' (providerId: ProviderId): Promise<ProviderModelsResult> {
    const provider = requireProvider(providerId)

    try {
      const secretValue = await requestSecret(provider)
      const listRequest = provider.modelListRequest(secretValue)
      const mediaListRequest = provider.mediaModelListRequest(secretValue)
      const [data, mediaData] = await Promise.all([
        listRequest ? jsonResponse(provider, listRequest) : undefined,
        mediaListRequest
          ? jsonResponse(provider, mediaListRequest).catch((error: unknown) => {
            console.error(`Failed to list the media models of provider ${providerId}:`, error)
            return undefined
          })
          : undefined,
      ])
      // `undefined` is no JSON value: with a request, it tells that the
      // request failed.
      const mediaListFailed = mediaListRequest !== null && mediaData === undefined
      // With no model list, these are the config models.
      const merged = provider.mergeModels(provider.parseModels(data))
      const entries = provider.modelEntries(merged, data)
      const mediaEntries = mediaData === undefined ? undefined : provider.mediaModelEntries(mediaData)
      const models = provider.withClipData(merged, entries, mediaEntries ?? new Map())
      return { ok: true, models, entries, ...(mediaEntries && { mediaEntries }), ...(mediaListFailed && { mediaListFailed }) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`Failed to list models for provider ${providerId}:`, error)
      return { ok: false, models: [], error: message }
    }
  },

  async 'dez.provider/streamChat' (input: ProviderStreamChatInput): Promise<ProviderStreamChatResult> {
    const provider = requireProvider(input.providerId)
    const requestId = input.requestId ?? crypto.randomUUID()
    const messages = await readMessageImages(input.messages)
    let stream = await nativeChatStream(provider, input, messages, requestId)

    // A 401 can mean the cached Copilot chat token expired early; get a fresh
    // one and retry once. The refused response is never parsed, so its
    // thinking cannot mix with the retry's.
    if (provider.config.auth === 'githubCopilot' && stream.result.response.status === 401) {
      await sbp('dez.http/cancelStream', stream.result.requestId)
      stream = await nativeChatStream(provider, input, messages, requestId, true)
    }

    return {
      requestId: stream.result.requestId,
      ...await streamProviderTokens(provider, input, stream.result, stream.thinking,
        (url) => generatedImageFromUrl(url, (imageUrl) => fetchReplyImage(provider, imageUrl))),
    }
  },

  // Makes media with a model of the provider's media API (`mediaApi`). It
  // needs no tab or editor, so a tool can call it too. dez.http/cancelStream
  // with `requestId` cancels the request that runs, and `signal` does the
  // same and also ends the wait of a clip job. An input image that breaks
  // a size rule of the request goes as a drawing that passes it
  // (`fittedImage`).
  //
  // - An image, or an edit of stored images: one request through
  //   dez.http/stream. A cancel before the response headers rejects; a
  //   cancel after them ends the body early, so a caller that cancelled
  //   must drop the result.
  // - A clip (speech, music, video): the answer to the first request is the
  //   clip, or a job. For a job, the provider is asked for its state each
  //   `CLIP_POLL_INTERVAL_MS` until the clip is there: in the answer to
  //   that request, at a URL that plays, at a URL to copy, or behind one
  //   more request. A clip that came as bytes is a temp copy in the cache
  //   root (`sendClipRequest`), which the caller must delete when it does
  //   not keep the clip. A stop rejects. The request sets the model's
  //   parameters (the length, the voice): `input.parameters` where the
  //   model takes the value, else the parameter's default. A video request
  //   sends the stored images of `input.images` as frames of the video. A
  //   refusal that tells that the model takes fewer images rejects with a
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
      if (kind === 'imageEdit' && paths.length === 0) throw new Error('No image to edit')
      if (kind === 'imageToVideo' && paths.length === 0) throw new Error('No image to make a video from')
      const appDir = paths.length > 0 ? await sbp('dez.native/getAppDir') as string : ''
      const sizeRules = provider.inputImageSize(kind, sbp('dez.model/modelCache/model', provider.id, modelId) as ModelInfo | null)
      const images = await Promise.all(paths.map(async (path): Promise<ChatImagePart> => {
        const { bytes, mediaType } = await fittedImage(await readStoredImage(path, appDir), sizeRules)
        return { type: 'image', mediaType, data: bytesToBase64(bytes) }
      }))

      if (!isClipKind(kind)) {
        const request = provider.mediaRequest(kind, modelId, { prompt: input.prompt, images }, await requestSecret(provider))
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
      const values = clipParameterValues(provider.id, modelId, input.parameters)
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
        if (!('clip' in download)) throw new Error('The provider sent no clip.')
        return { media: [], clips: [download.clip] }
      }
    } catch (error) {
      if (jobId === null) throw error
      const stopped = signal?.aborted === true
      console.error(`The clip job ${jobId} of ${provider.name} (model ${modelId}) ${stopped ? 'was stopped' : 'failed'}:`, error)
      if (stopped) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${message}${/[.!?]$/.test(message) ? '' : '.'} To ask ${provider.name} about this clip, give its job id: ${jobId}.`, { cause: error })
    } finally {
      signal?.removeEventListener('abort', cancelRequest)
    }
  },

  // The provider's price in USD of the clip that dez.provider/generateMedia
  // with the same `parameters` asks for. Null when the provider tells no
  // price before a request: its model entries hold the prices then. The
  // request costs nothing. Rejects when it fails.
  async 'dez.provider/mediaQuote' (input: ProviderMediaQuoteInput): Promise<number | null> {
    const provider = requireProvider(input.providerId)
    const { kind, modelId } = input
    if (!isClipKind(kind)) return null

    const values = clipParameterValues(provider.id, modelId, input.parameters)
    const entry = sbp('dez.model/modelCache/rawModel', provider.id, modelId) as unknown
    const quote = provider.clipQuote(kind, modelId, values, entry, await requestSecret(provider))
    return quote ? quote.usd(await jsonResponse(provider, quote.request)) : null
  },
})
