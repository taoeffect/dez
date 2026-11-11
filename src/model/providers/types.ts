import type { ImageMediaType } from '../chat/images'
import type { MediaTagKind } from '../chat/mediaTags'
import type { RequestMessage, ThinkingReplay } from '../chat/types'
import { normalizeOutputs, type ModelOutput } from '../modelOutputs'
import type { StreamedToolCall, ToolDefinition } from '../tools/types'
import { cloneInputImageRules, type InputImageRules } from './clipImages'
import { cloneClipTextRules, type ClipTextRules } from './clipText'
import type { ImageSizeRules, InputImageLimits } from './imageSize'
import type { ApiFormatId, ProviderAuth } from './config'
import { cloneModelParameter, type ModelParameter } from './modelParameters'
import type { ModelToggles } from './modelToggles'

// Any id that passes `isValidProviderId()` in `config.ts`: built-in ids plus
// user-defined custom provider ids.
export type ProviderId = string

// The request kinds that go to the provider's media API (`mediaApi` in
// config.ts, mediaFormats.ts) instead of its chat API.
// `image`, `imageEdit`: the media API makes or edits an image.
// `upscale`: the media API makes one image larger. The request takes that
// image and no text, so the text of the message does not go.
// `tts`, `music`, `video`, `imageToVideo`: the media API makes a clip:
// speech that reads the user's text, music or a sound, or a video. A
// `video` model makes its video from the text, and some also take an image
// as a frame of it (`ModelInfo.images`). An `imageToVideo` model makes no
// video without an image.
export const MEDIA_KINDS = ['image', 'imageEdit', 'upscale', 'tts', 'music', 'video', 'imageToVideo'] as const

export type MediaKind = (typeof MEDIA_KINDS)[number]

// How Dez sends a request to a model. `chat`: the API format's chat request.
// `none`: Dez has no request for the model yet, so a submit is refused
// (unusableModel.ts has the texts).
export const MODEL_REQUESTS = ['chat', ...MEDIA_KINDS, 'none'] as const

export type ModelRequest = (typeof MODEL_REQUESTS)[number]

// The media kinds that make a clip, each with the kind of its clip (the
// name of the clip's tag, src/model/chat/mediaTags.ts).
export const CLIP_KINDS = {
  tts: 'audio',
  music: 'audio',
  video: 'video',
  imageToVideo: 'video',
} as const satisfies Partial<Record<MediaKind, MediaTagKind>>

export type ClipKind = keyof typeof CLIP_KINDS

// The media kinds that make image files.
export type ImageKind = Exclude<MediaKind, ClipKind>

export function isClipKind(kind: ModelRequest): kind is ClipKind {
  return Object.hasOwn(CLIP_KINDS, kind)
}

// One image file that a media model made.
export interface GeneratedMedia {
  bytes: Uint8Array
  mediaType: ImageMediaType
}

// One clip (audio or video) that a media model made. Its bytes never come
// through the webview, as a video is too large for the HTTP bridge: the
// clip is at the provider's URL, or in a temp copy that Rust wrote.
export interface GeneratedClip {
  kind: MediaTagKind
  // The media type, such as `video/mp4`.
  mediaType: string
  // The source that plays: `url` when the provider gave one, else the
  // absolute path of the temp copy (`isTempMediaPath` in mediaTags.ts).
  src: string
  // The provider's URL of the clip. It is a signed URL, which is a secret.
  url: string | null
  // The ISO time after which `src` stops working.
  expires: string
  // The provider's id of the job that made the clip, when it had one. The
  // provider can give the clip again for it while it keeps the clip.
  jobId: string | null
}

export interface ModelInfo {
  id: string
  name: string
  provider: ProviderId
  // true: the model reads images; false: it does not. Missing: unknown, and
  // the request sends the images.
  imageInput?: boolean
  // true: the model calls tools; false: it does not, and the request sends
  // no tools. Missing: unknown, and the request sends the tools.
  toolCalling?: boolean
  // false: the model does not think, so it gets no Thinking toggle and its
  // requests send no thinking fields. Missing: unknown, and the provider's
  // `thinking` config decides, as for a model that thinks.
  thinking?: boolean
  // The keys of the provider's config toggles (`settings` in config.ts) that
  // the model is known not to take: it gets neither their rows nor their
  // request fields. Never empty. Missing: none is known.
  unsupportedSettings?: string[]
  // What the model makes, each type once, in MODEL_OUTPUTS order. Missing:
  // the provider does not tell, and Dez counts it as a text model
  // (`effectiveOutputs` in modelOutputs.ts).
  outputs?: ModelOutput[]
  // How Dez sends the model a request. Missing: `chat` (`effectiveRequest`).
  request?: ModelRequest
  // The kind of clip that the model needs as the input of every request: a
  // recording to write down or to change (speech-to-text, a voice changer),
  // or a video to change. Dez has no request that carries a clip, so only a
  // model with the request `none` has this, and it tells why a submit is
  // refused. Missing: the model needs no clip, or the provider does not
  // tell.
  // MODEL_INVOKE: a `model_invoke` tool that can give a model a clip must
  // read this to know what to send, and such a model then needs a request
  // kind of its own in place of `none`.
  clipInput?: MediaTagKind
  // What a request to the model can set (modelParameters.ts), for a model
  // of a media request kind whose provider tells it. Never empty. Missing:
  // none.
  parameters?: ModelParameter[]
  // What the model takes as the text of a request (clipText.ts): the
  // limits of the prompt's length, and whether it takes lyrics. For a model
  // of a clip request kind whose provider tells it. Missing: unknown, and
  // Dez checks no text.
  text?: ClipTextRules
  // What the model takes as the input images of a request (clipImages.ts):
  // how many, and the size rules of each one. For a model of a media
  // request kind whose provider tells it (an edit, a video, a new image
  // from reference images). Missing: an `imageEdit` model takes every
  // image, an `upscale` or `imageToVideo` model one image, and a `video`
  // or `image` model none (`maxInputImages`).
  images?: InputImageRules
  // The name of the file type of the images that the model makes (such as
  // `SVG`), for a model of an image request kind that makes only types
  // that Dez does not store (`ImageFormat.unstoredOutput`). Dez sends it
  // no request (`unstoredOutputMessage`). Missing: it makes a type that
  // Dez stores, as far as the provider tells.
  unstoredOutput?: string
}

export type ModelCapabilities = Pick<ModelInfo, 'imageInput' | 'toolCalling' | 'thinking' | 'unsupportedSettings' | 'outputs' | 'request' | 'clipInput' | 'parameters' | 'text' | 'images' | 'unstoredOutput'>

// What a clip model takes as the input of a request, besides the values of
// its parameters.
export type ClipInputRules = Pick<ModelInfo, 'text' | 'images'>

// Display names for agent role pills and history rows: provider id ->
// provider name, and `modelRefKey` -> model name. Maps, not plain objects,
// because the ids come from files. A missing entry means the name is
// unknown.
export interface ModelDisplayNames {
  providers: Map<ProviderId, string>
  models: Map<string, string>
}

// What views and controllers know about a provider. Plain data, so it can be
// cloned and shown without the Provider class. Views learn about a provider
// (thinking support too) from this or ProviderSettingsDescriptor, never from
// registry imports.
export interface ProviderInfo {
  id: ProviderId
  name: string
  builtIn: boolean
  auth: ProviderAuth
  apiFormat: ApiFormatId
  baseUrl: string
  // A key is stored (for GitHub Copilot: the user is signed in).
  hasKey: boolean
  // The provider can be used: it has a key or does not need one.
  configured: boolean
  // The config has `thinking`, so the provider gets the Thinking toggle.
  supportsThinking: boolean
}

// What the provider settings popup shows for one model: the provider's name
// and the toggles that apply to the model.
export interface ProviderSettingsDescriptor extends ModelToggles {
  name: string
}

// The rules of each input image of a request to one model that its
// provider tells (dez.provider/inputImageRules). Each one is absent when
// the provider tells none.
export interface ProviderInputImageRules {
  // Dez sends a fitted copy of an image that breaks them.
  size?: ImageSizeRules
  // Dez refuses an image that breaks them.
  limits?: InputImageLimits
}

// Result of a provider model fetch. `ok` is the basis for a provider's
// "working" status: a fetch that fails (expired or invalid key, network)
// yields `ok = false` with no models. A provider that does not fetch models
// yields `ok = true` with its config models.
export interface ProviderModelsResult {
  ok: boolean
  models: ModelInfo[]
  // On success: the raw entry of each model, by model id
  // (`Provider.modelEntries`), for the `model_info` tool. The model cache
  // keeps it in memory only.
  entries?: ReadonlyMap<string, unknown>
  // On success, for a provider whose media API has own model lists
  // (`MediaFormat.modelLists`) of which one or more answered: the raw
  // entry of each model of those lists, by model id. In memory only, like
  // `entries`.
  mediaEntries?: ReadonlyMap<string, unknown>
  // On success: one or more of those lists did not load, so `models` can
  // lack what only they tell (the lengths of the OpenRouter video models).
  // The model cache then keeps what it knew of each model
  // (keptClipData.ts).
  mediaListFailed?: true
  error?: string
}

// One part of a user message, as both wire formats need it: text, or the
// bytes of a stored image in base64 (apiFormats.ts writes the wire block).
export type ChatPart =
  | { type: 'text', text: string }
  | { type: 'image', mediaType: ImageMediaType, data: string }

export type ChatImagePart = Extract<ChatPart, { type: 'image' }>

// A request message as the wire formats take it: an image part holds the
// image bytes.
export type ChatMessage = RequestMessage<ChatPart>

// What a chat request sends besides its messages. Every field is optional:
// a diagnostics probe sends none of them.
export interface ChatRequestContext {
  // The conversation of the request; see ProviderConfig.promptCacheKey.
  conversationId?: string
  // Dez's system prompt (src/model/systemPrompt).
  system?: string
  // The Dez tools that the model may call. None or an empty list sends no
  // `tools` field.
  tools?: readonly ToolDefinition[]
  // The model's known outputs hold `image` (ModelInfo.outputs): the body
  // gets the config's `imageOutputBody`, which asks for image output.
  imageOutput?: boolean
}

// One parsed SSE `data:` payload yields zero or more of these, in either
// API format. `token` is answer text and `thinking` is reasoning text.
// `image` is an image that the model made, at its place in the answer; its
// URL is a `data:` URL or an http(s) URL (`generatedImageFromUrl` in
// generatedImages.ts reads it).
export type SseTokenEvent =
  | { kind: 'token', token: string }
  | { kind: 'thinking', token: string }
  | { kind: 'image', url: string }
  | { kind: 'done' }

// Omit from each member of a union, not from the union as a whole.
type OmitEach<T, Key extends PropertyKey> = T extends unknown ? Omit<T, Key> : never

// A replay as a stream parser builds it. Only the request knows the
// messages before the reply, so the signed kinds get `prefixHash` later.
export type StreamedThinkingReplay = OmitEach<ThinkingReplay, 'prefixHash'>

export interface SseStreamEnd {
  // Text that the parser held back because it could still be part of an
  // inline `<think>` tag.
  events: SseTokenEvent[]
  // Absent when there was no thinking to send back, or when it is not
  // complete (the stream ended early).
  replay?: StreamedThinkingReplay
  // The tool calls of the reply, in stream order. Absent when there are
  // none, or when the stream was cut off or reported a failure: the
  // arguments of a call could then be cut off too.
  toolCalls?: StreamedToolCall[]
}

// Reads the SSE payloads of one response, in order. Parsers keep state
// between payloads (thinking blocks, a partial tag), so every response
// needs a new one.
export interface SseStreamParser {
  parse(data: string): SseTokenEvent[]
  // Call once, after the last payload.
  finish(): SseStreamEnd
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly providerId: ProviderId,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

// `signIn`: the provider takes a sign-in (`auth: 'githubCopilot'`), not an
// API key.
export class ProviderNotConfiguredError extends ProviderError {
  constructor(providerId: ProviderId, providerName: string, signIn: boolean) {
    super(signIn
      ? `You are not signed in to ${providerName}. Sign in with GitHub in Settings › Providers.`
      : `${providerName} has no API key. Add one in Settings › Providers.`, providerId)
    this.name = 'ProviderNotConfiguredError'
  }
}

// Leaves each capability out when it is unknown, so the model cache file and
// whole-object comparisons hold no `undefined` field. `outputs` becomes a new
// array in table order, `unsupportedSettings` a new array, and `parameters`,
// `text`, and `images` deep copies, so two models never share one (a store
// copy and its snapshot, a config model and the cache). `clipInput` stays
// only with the request `none`: a config model can give a fetched model
// another request kind, and its reason for `none` must not stay then.
export function providerModel(provider: ProviderId, id: string, name: string, capabilities: ModelCapabilities = {}): ModelInfo {
  const model: ModelInfo = { id, name, provider }
  if (capabilities.imageInput !== undefined) model.imageInput = capabilities.imageInput
  if (capabilities.toolCalling !== undefined) model.toolCalling = capabilities.toolCalling
  if (capabilities.thinking !== undefined) model.thinking = capabilities.thinking
  if (capabilities.unsupportedSettings?.length) model.unsupportedSettings = [...capabilities.unsupportedSettings]
  if (capabilities.outputs !== undefined) model.outputs = normalizeOutputs(capabilities.outputs)
  if (capabilities.request !== undefined) model.request = capabilities.request
  if (capabilities.clipInput !== undefined && capabilities.request === 'none') model.clipInput = capabilities.clipInput
  if (capabilities.parameters !== undefined) model.parameters = capabilities.parameters.map(cloneModelParameter)
  if (capabilities.text !== undefined) model.text = cloneClipTextRules(capabilities.text)
  if (capabilities.images !== undefined) model.images = cloneInputImageRules(capabilities.images)
  if (capabilities.unstoredOutput !== undefined) model.unstoredOutput = capabilities.unstoredOutput
  return model
}

/** How Dez sends the model a request; a model whose kind is unknown gets
 *  chat requests. */
export function effectiveRequest(model: Pick<ModelInfo, 'request'>): ModelRequest {
  return model.request ?? 'chat'
}
