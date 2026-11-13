import type { MessagePart, RequestMessage, ThinkingReplay } from '../chat/types'
import type { StreamedToolCall } from '../tools/types'
import type { ClipAttachment } from './clipInputs'
import type { ParameterValues } from './modelParameters'
import type { RequestReader } from './requestReader'
import type { ChatRequestContext, GeneratedClip, GeneratedMedia, MediaKind, ProviderId } from './types'

// A message as dez.provider/streamChat takes it: an image part holds the
// path of a stored image, and streamChat reads its bytes before it builds
// the request.
export type ProviderChatInputMessage = RequestMessage<MessagePart>

// `conversationId`, `system`, `tools`, and `imageOutput` go into the request
// body (ChatRequestContext).
export interface ProviderStreamChatInput extends ChatRequestContext {
  providerId: ProviderId
  modelId: string
  messages: ProviderChatInputMessage[]
  // dez.http/cancelStream with this id cancels the request that runs.
  requestId?: string
  // Stops the request: nothing goes to the provider after the abort, and a
  // request that runs is cancelled. For a caller that has no reply of a tab
  // to stop (the job of a `model_invoke` call).
  signal?: AbortSignal
  // Who reads the text of a request that failed (requestReader.ts); the
  // user with none.
  reader?: RequestReader
  // Sparse user overrides for this provider's settings
  // (ProviderConfig.settings) and its Thinking toggle; missing keys fall
  // back to the defaults.
  providerSettings?: Record<string, boolean>
  onToken(token: string): void | Promise<void>
  // Each piece of thinking text, in stream order. Called only when the
  // provider supports thinking and the Thinking toggle is on.
  onThinking(token: string): void | Promise<void>
  // Each image of the reply, as bytes, in stream order with the answer
  // text: the next `onToken` call comes after this one ends. A reply has
  // images only when the request asked for them (`imageOutput`).
  onImage(image: GeneratedMedia): void | Promise<void>
}

export interface ProviderStreamChatResult {
  requestId: string
  // What the next request can send back of this reply's thinking. Absent
  // when there is none, or when the thinking is not complete.
  thinkingReplay?: ThinkingReplay
  // The tool calls of the reply, in stream order (SseStreamEnd.toolCalls).
  // The tool loop runs them whatever the finish reason says: some servers
  // end a reply with tool calls with `stop`.
  toolCalls?: StreamedToolCall[]
}

// How far a request of dez.provider/generateMedia is:
// - `sent`: the inputs are read, and the first request goes now.
// - `queued`: the provider runs the request as a job, and Dez asks for
//   its state.
// - `downloading`: the provider made the clip, and Dez copies it.
// `jobId` is the provider's id of the job, as soon as there is one: the
// provider took the money for that job, and the user can ask it for the
// output with the id.
export interface MediaProgress {
  phase: 'sent' | 'queued' | 'downloading'
  jobId: string | null
}

// The input of dez.provider/generateMedia. `kind` is the model's request
// kind (ModelInfo.request).
export interface ProviderGenerateMediaInput {
  providerId: ProviderId
  modelId: string
  kind: MediaKind
  prompt: string
  // The lyrics of a song, for a music model that takes them
  // (`ModelInfo.text.lyrics`); `prompt` is then the style of the song. A
  // request of another kind does not send them.
  lyrics?: string
  // The absolute paths of stored images (`storedImageFile`). The model's
  // image rules tell how many it takes and as what (`ModelInfo.images`,
  // for the values of `parameters`: `inputImageRulesFor`; the count:
  // `maxInputImages`): for example the image to edit first, the one image
  // of an `upscale`, the frames of a video (the first frame, then the last
  // frame), or references (`InputImageRules.references`). No more of them
  // than those rules take.
  images?: readonly string[]
  // The input clips, in the user's order (`mediaRequestInput`): media tags
  // with their sources, which generateMedia reads. Only clips that the
  // model's clip rules take (`ModelInfo.clips`): for example the clip of a
  // `videoToVideo`, `voiceChange`, or `transcription` request, or the
  // references of a video. generateMedia refuses the others before any
  // request.
  clips?: readonly ClipAttachment[]
  // The values to set for the model's parameters (ModelInfo.parameters),
  // by parameter name. A parameter with no value here, or with one that
  // the model does not take, gets its default.
  parameters?: Readonly<ParameterValues>
  // dez.http/cancelStream with this id cancels the request that runs. A
  // clip can take many requests, one after the other, and a wait between
  // them; `signal` stops all of that.
  requestId?: string
  signal?: AbortSignal
  // The longest time (ms) from the first request of a clip to its last
  // byte; `CLIP_JOB_TIMEOUT_MS` with none. An image and a text have no
  // time limit here: `signal` ends them.
  timeoutMs?: number
  // Called at each step of the request, in order.
  onProgress?: (progress: MediaProgress) => void
  // Who reads the text of an input that the model does not take or that
  // Dez cannot read, and of a request that failed (requestReader.ts); the
  // user with none.
  reader?: RequestReader
}

// An image kind gives `media`, a clip kind (CLIP_KINDS) gives `clips`, and
// a text kind (TEXT_KINDS) gives `text`; the other lists are empty.
export interface ProviderGenerateMediaResult {
  // The image files that the model made, in the provider's order.
  media: GeneratedMedia[]
  clips: GeneratedClip[]
  // The text that the model wrote (a transcription), which can be empty.
  text?: string
}

// The input of dez.provider/mediaQuote: the fields of the
// dez.provider/generateMedia input that set the price.
export type ProviderMediaQuoteInput = Pick<ProviderGenerateMediaInput, 'providerId' | 'modelId' | 'kind' | 'parameters'>

// What dez.provider/mediaQuote tells about the price of one request.
export interface ProviderMediaQuote {
  // The price in USD of one request with the input's parameter values.
  // Absent when the provider's data tells no one price for it.
  usd?: number
  // With `usd`: what else changes the price, or that it is an estimate.
  note?: string
  // Why the model's entries, which hold its prices, tell no one price of
  // the request (`ClipFormat.entryPrice`).
  error?: string
  // The model's price records, as the provider sent them, for a provider
  // whose model lists hold no prices (`ImageQuoteFormat.recordsRequest`).
  records?: unknown
}
