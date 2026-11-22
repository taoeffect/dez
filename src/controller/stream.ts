import sbp from '@sbp/sbp'
import type { ActiveModel, MessagePart, ModelRef, Section, SectionThinking, Tab } from '../model/chat/types'
import { clipModelMark, imageModelMark } from '../model/chat/assetModels'
import { appTagText } from '../model/chat/appTags'
import { sectionsBeforeReply, sectionTextParts, type Compactions } from '../model/chat/compaction'
import { sectionPlainText } from '../model/chat/content'
import { compactionDueSize, type ContextSize } from '../model/chat/contextSize'
import type { ConversationCost } from '../model/chat/conversationCost'
import { IMAGE_HIDDEN_KEY, IMAGE_MADE_BY_KEY, IMAGE_TOOL_KEY, imageMarkdown } from '../model/chat/images'
import { requestParts } from '../model/chat/incognito'
import { modelRefKey, sameModelRef } from '../model/chat/modelRef'
import { newMediaIds } from '../model/chat/mediaIds'
import { MEDIA_HIDDEN_ATTRIBUTE, MEDIA_JOB_ATTRIBUTE, MEDIA_MADE_BY_ATTRIBUTE, MEDIA_TOOL_ATTRIBUTE, mediaTagText } from '../model/chat/mediaTags'
import { findToolBlocks, ModelTextEscaper } from '../model/chat/toolBlocks'
import { effectiveOutputs } from '../model/modelOutputs'
import { failedChatRequestCost, type ChatUsage } from '../model/providers/chatUsage'
import { imagesText, TooManyImagesError, tooManyImagesMessage } from '../model/providers/clipImages'
import { isProviderRefusal } from '../model/providers/errors'
import { contextWindowOf, imageLimitOf, messageImageLimitOf, modelFamily } from '../model/providers/modelFamilies'
import { effectiveRequest } from '../model/providers/types'
import { ExplainedError, errorText, explainedError } from '../utils/errorText'
import type { ClipInputRules, GeneratedClip, GeneratedMedia, MediaKind, MediaProgress, ModelInfo, ModelRequest, ProviderGenerateMediaResult, ProviderStreamChatResult } from '../model/providers'
import { getProvider, requireProvider } from '../model/providers/registry'
import { compactionLeftFiles } from '../model/streams/compactionFiles'
import { compactionReason, newestReplyModel, repliedSinceCompaction } from '../model/streams/compactionRequest'
import { agentSectionMessages, imageOptionsOf, mediaRequestInput, newRequestImages, sectionsToStreamMessages, type RequestImages } from '../model/streams/messages'
import {
  attachmentParts,
  compactedPictureLimits,
  contextImageCost,
  NO_CALL_PICTURE_BUDGET,
  NO_PICTURE_BUDGET,
  pictureBudgetLeft,
  pictureLimits,
  requestImageCount,
  shownPictureCost,
  totalCost,
  type CallPictureBudget,
  type PictureBudget,
} from '../model/streams/pictureBudget'
import {
  checkToolCalls,
  stoppedToolResult,
  toolCallBlock,
  toolGroupAppendText,
  toolGroupText,
  type CheckedToolCall,
} from '../model/streams/toolRound'
import type { EndedStreamSession, RequestMessages, StreamMessage } from '../model/streams/types'
import {
  appendThinkingToTabSection,
  appendTokenToTabSection,
  finalizeStreamSectionForTab,
  replaceStreamTailInTabSection,
  setThinkingReplayForTabSection,
  type SettingsSnapshot,
} from '../model/state'
import { buildSystemPrompt, systemPromptTemplate } from '../model/systemPrompt'
import { withEditHintRefusals } from '../model/tools/editHint'
import { TOOL_DEFINITIONS } from '../model/tools/registry'
import type { ToolDefinition, ToolRunResult } from '../model/tools/types'
import {
  cancelStreamSession,
  errorStreamSession,
  finishStreamSession,
  setStreamCompacting,
  startStreamSession,
  streamIsStreaming,
  streamSession,
} from '../model/state/streams'
import { compactConversation, type Compaction } from './compaction'
import { logRequest } from './diagnostics/requestLog'
import { discardMadeAssets, generatedClipAsset, TabJobs, writeJobAssets, type EndedJob, type MadeAsset } from './jobs'
import { discardShownPictures } from './shownPictures'
import type { ToolRunCall, ToolRunContext } from './tools'

// One reply of a tab, in order: `dez.controller/submitTab` (thread.ts)
// checks the request, builds its messages, and adds the reply's agent
// section. That one section takes every round, tool block, image, and
// clip of the reply. `dez.stream/start` then runs the chat rounds
// (`runChatRounds`: a compaction check before each request, then the
// tool calls of the round) or the one media round (`runMediaRound`).
// An incognito tab sends only the parts of `requestParts`: no system
// prompt of Dez, no tools, and no compaction.
// Each request that went counts in the cost of the tab
// (`countRequestCost`). The end (`endReply`) waits for the open jobs of
// the reply, then ends its stream session (`finalizeStream`).

interface StreamStartArgs {
  tabId: string
  conversationId: string
  sectionId: string
  model: ActiveModel
  // How the reply's requests go (ModelInfo.request): chat rounds, or one
  // media request. `dez.controller/submitTab` refuses a `none` model.
  request: Exclude<ModelRequest, 'none'>
  // The request messages of the sections before `sectionId`, built by
  // `dez.model/streamMessagesForTab` at the submit: each round sends them,
  // then the rounds of the reply so far. After a compaction in the reply,
  // its rounds send the messages of the compacted sections in their place.
  messages: StreamMessage[]
  // The images of those messages that went as text only for the image
  // limit of a request (`RequestMessages.imagesOverLimit`). The first chat
  // request of the reply tells the user (`warnImagesOverLimit`).
  imagesOverLimit: number
  // The newest user message as a message of its own
  // (`RequestMessages.newestUserMessage`): a media request takes its
  // prompt and input images from it (`mediaRequestInput`).
  newestUserMessage: string | MessagePart[]
  // Offer the Dez tools (RequestMessages.sendTools).
  sendTools: boolean
  // The tab is incognito (`Tab.incognito`): the chat rounds send the parts
  // of `requestParts`. It cannot change while the reply runs, as a tab that
  // sent a request cannot turn it on (`canTurnOnIncognito`).
  incognito: boolean
  // The model's known outputs hold `image`: its chat requests ask for
  // image output (ChatRequestContext.imageOutput).
  imageOutput: boolean
  // The model's known outputs hold `audio`: its chat requests ask for
  // audio output (ChatRequestContext.audioOutput).
  audioOutput: boolean
  // What the model takes as the input of a media request, for the
  // parameter values of the request (`mediaInputRules`): a model with
  // lyrics gets them from the message, and a video model gets the
  // message's images as frames or references and the clips that it holds
  // or names (`mediaRequestInput`). It is the submit's read of the model,
  // so the request sends the input that the submit checked.
  inputRules?: ClipInputRules
}

// The calls of one tool round while they run. Their blocks stay in the
// section as `runningText` until the round, or a stop, replaces them with
// the final blocks.
interface ToolRun {
  calls: CheckedToolCall[]
  // The result of each call that ended, by call index.
  results: (ToolRunResult | undefined)[]
  runningText: string
  abort: AbortController
}

// The jobs of the tab that a chat reply took, with the lease of the take
// (`TabJobs.take`): it aborts when the reply hands them on.
interface TakenJobs {
  tabJobs: TabJobs
  lease: AbortSignal
}

// One reply: one stream session, and one request round per group of tool
// calls, each with its own native HTTP request.
interface ReplyRuntime {
  sectionId: string
  // The request of the current round; a stop cancels it.
  requestId: string
  // Aborts when a stop or a new submit cancels the reply. A clip request
  // (`runMediaRound`) can be a job of many requests with waits between
  // them, which a cancel of `requestId` alone does not end.
  abort: AbortController
  cancelling: boolean
  // A submit ended the reply's output (`dez.stream/endOutput`): the later
  // tokens and thinking of its request are dropped, as the new request
  // already holds the section. A stop keeps them, so this is not
  // `cancelling`.
  outputEnded: boolean
  toolRun: ToolRun | null
  // Model text never forms a block (toolBlocks.ts). A tag can be split
  // across tokens, so the escaper holds such an end back until the next
  // token, the round end, or the reply end.
  escaper: ModelTextEscaper
  // The last write of the reply was an image reference or a clip tag
  // (`writeAsset`): the answer text that comes next starts a new paragraph
  // (`writeModelText`).
  afterAsset: boolean
  // The jobs of the tab (jobs.ts) that a chat reply took at its start
  // (`takeJobs`): the jobs that its tools start, and the jobs of the
  // replies before it that the user cut. They outlive their tool round. A
  // cut (a stop, a new submit, a delete of the running blocks) hands them
  // on (`handOverJobs`), and the end of a reply that ended on its own ends
  // them (`stopAll`). Null for a media reply: it runs no tool, so it leaves
  // the jobs with the tab.
  jobs: TakenJobs | null
  // How many bytes a request sends for each image of the messages before
  // the reply, by path: the bytes that they take of the picture budget
  // (`imageFileSizes`). Read at the first compaction check or `asset_view`
  // call of the reply; null before it. A compaction in the reply reads the
  // sizes again, for its new messages.
  imageBytes: Promise<ReadonlyMap<string, number>> | null
}

// The reply of each tab, so tabs stream at the same time and a new start or
// a stop ends only its own tab's reply. A reply is current while it is its
// tab's entry; a round's request id changes, so checks compare the reply.
// http_bridge.rs keeps the global map of request ids that does the native
// cancel.
const repliesByTab = new Map<string, ReplyRuntime>()

// The jobs of each tab that no reply holds now: the user cut the reply
// that held them (`handOverJobs`), and the next chat reply of the tab
// takes them (`takeJobs`). So the model of that reply can wait for the
// jobs that a cut reply started. A close of the tab ends them
// (`dez.stream/stop` with `endJobs`).
const heldJobsByTab = new Map<string, TabJobs>()

// A chat reply takes the jobs of its tab: the ones that a cut reply left,
// else new ones. Returns them.
function takeJobs(tabId: string, reply: ReplyRuntime): TabJobs {
  const tabJobs = heldJobsByTab.get(tabId) ?? new TabJobs((usd) => countRequestCost(tabId, usd))
  heldJobsByTab.delete(tabId)
  reply.jobs = { tabJobs, lease: tabJobs.take(reply.sectionId) }
  return tabJobs
}

// A stop or a new submit cut `reply`, or the user deleted its running tool
// blocks (it ends as a stop does): its jobs go on, and the tab holds them
// for its next chat reply. Nothing for a reply that holds no jobs (a media
// reply), or that handed them on before.
function handOverJobs(tabId: string, reply: ReplyRuntime): void {
  if (!reply.jobs || reply.jobs.lease.aborted) return
  reply.jobs.tabJobs.release()
  heldJobsByTab.set(tabId, reply.jobs.tabJobs)
}

function finalizeStream(tabId: string, session: EndedStreamSession | null): void {
  if (!session) return
  finalizeStreamSectionForTab(session)
  // A stop is the user's own act, so it marks nothing and gives no alert.
  if (session.status !== 'cancelled') {
    sbp('dez.model/tabs/markReplyDone', tabId)
    // Not awaited; it catches its own failures.
    sbp('dez.controller/alertReplyEnded', tabId, session.status)
  }
  sbp('dez.editor/reconcileAfterStreamFinish', tabId)
  sbp('dez.model/tabs/save', tabId).catch(() => {})
  sbp('dez.model/appState/save')
}

// Adds one request of a reply to the cost of its tab (`withRequestCost`),
// also of a tab that is not active. A price can come after the end of the
// reply (the answer of a stopped round), when the end has saved the
// conversation: then it is saved again. Every request of a reply that
// went counts here: each chat round, each compaction request, the media
// round, and the paid request of each job (`TabJobs`), also of a job that
// ends while no reply of the tab runs.
function countRequestCost(tabId: string, usd: number | null): void {
  sbp('dez.model/tabs/countRequestCost', tabId, usd)
  if (!streamIsStreaming(tabId)) sbp('dez.model/tabs/save', tabId).catch(() => {})
}

// The toast group (`ToastData.group`) of the reply errors of a tab.
function replyErrorGroup(tabId: string): string {
  return `reply-error:${tabId}`
}

// The error shows only in this toast, never as thread text. Sticky (no
// duration): the user closes it, or the next reply of the tab does
// (`dez.stream/start`), as the toast then tells of a reply that the user
// went on from. For a tab in the background the title names the tab, else
// the user cannot tell where the error came from. Call it after the stream
// end, which sets the title of a new tab.
function showReplyError(tabId: string, title: string, message: string): void {
  const tab = sbp('dez.model/tab', tabId) as Tab | null
  const inBackground = !!tab && tab.id !== sbp('dez.model/tabs/activeId')
  sbp('dez.ui/toast', 'app-global', {
    variant: 'error',
    title: inBackground ? `${title} in "${tab.title}"` : title,
    message,
    group: replyErrorGroup(tabId),
  })
}

// The model cache's entry of `model`. A model that the cache does not have
// gets only its id, so the readers of its limits (`contextWindowOf`,
// `imageLimitOf`, ...) take the numbers of its family.
function modelInfoOf(model: ModelRef): Partial<ModelInfo> & Pick<ModelInfo, 'id'> {
  return (sbp('dez.model/modelCache/model', model.providerId, model.modelId) as ModelInfo | null) ?? { id: model.modelId }
}

// Tells the user that `count` images of the conversation did not go with
// the request; `message` tells why.
export function warnImagesNotSent(count: number, message: string): void {
  sbp('dez.ui/toast', 'app-global', {
    variant: 'warning',
    title: count === 1 ? 'Image not sent' : 'Images not sent',
    message,
    duration: 8000,
  })
}

// Tells the user that the chat requests of a reply to `model` go with
// `count` fewer images than the conversation has, because of the image
// limits of the model (`RequestOptions.imageLimit` and
// `messageImageLimit`). The parts are counted in the order of the
// messages, so with only the limit of a request, the newest images are
// the ones with no part; with a lower limit of one message, they are also
// the last images of a message that holds more.
function warnImagesOverLimit(model: ActiveModel, count: number): void {
  const info = modelInfoOf(model)
  const limit = imageLimitOf(info)
  const messageLimit = messageImageLimitOf(info)
  const were = count === 1 ? 'was' : 'were'
  const message = messageLimit < limit
    ? `${model.modelName} takes at most ${imagesText(messageLimit)} in one message${Number.isFinite(limit) ? `, and ${imagesText(limit)} in one request` : ''}, `
      + `so ${imagesText(count)} of the conversation ${were} left out. `
      + 'Put fewer images into one message, or delete the images that the model does not need from earlier messages.'
    : `${model.modelName} takes at most ${imagesText(limit)} in one request, so the newest ${count === 1 ? 'image' : imagesText(count)} of the conversation ${were} left out. `
      + 'Delete the images that the model does not need from earlier messages, or start a new conversation.'
  warnImagesNotSent(count, message)
}

// The error of a failed request to `model`, as the user reads it. A text
// that Dez wrote for the user (`ExplainedError`) is as it is; a refused
// image count tells the image limit of `model`; any other error is one
// that Dez did not expect, and its raw text goes into the details.
function replyError(error: unknown, model: ActiveModel): ExplainedError {
  return error instanceof TooManyImagesError ? new ExplainedError(tooManyImagesMessage(model.modelName, error)) : explainedError(error)
}

// The text of the error toast of a reply that ended with `jobs` that
// failed or timed out, and whose results no `jobs_wait` gave to the model.
// The reply says nothing of them, so only this toast tells the user. The
// result text of a job is for the model (what a new call can change), so
// the toast names each job only by its tool, its id (the result of its
// call in the reply holds it), and its status; `endReply` logs the texts.
function unreadJobsMessage(jobs: readonly EndedJob[]): string {
  const explanation = jobs.length === 1
    ? 'A job that the model started failed, and the reply ended before the model got the result of the job. '
      + 'So the reply does not tell of this failure, and it does not hold what the job should make. Help › Developer Console shows why the job failed.'
    : `${jobs.length} jobs that the model started failed, and the reply ended before the model got their results. `
      + 'So the reply does not tell of these failures, and it does not hold what the jobs should make. Help › Developer Console shows why the jobs failed.'
  return errorText(
    `${explanation} To try again, ask the model for it in a new message.`,
    jobs.map((job) => `The ${job.tool} job ${job.id} ${job.status}.`).join('\n'),
  )
}

// The tab's stream session still writes into `sectionId`.
function streamWritesSection(tabId: string, sectionId: string): boolean {
  const session = streamSession(tabId)
  return !!session && session.sectionId === sectionId && session.status === 'streaming'
}

// The reply's section in the tab, with the text of the reply. In the
// compaction section, the reply that ran at the compaction goes on after
// the block, so its text is the text after the block (`sectionTextParts`).
interface StreamingReply {
  section: Section
  text: string
}

function streamingReply(tabId: string, sectionId: string): StreamingReply | null {
  const sections = (sbp('dez.model/tab', tabId) as Tab | null)?.sections ?? []
  const index = sections.findIndex((section) => section.id === sectionId)
  return index < 0 ? null : { section: sections[index], text: sectionTextParts(sections[index], index).text }
}

// Appends text to the streaming section in the store, and in the editor when
// the tab is visible.
function writeStreamText(tabId: string, sectionId: string, text: string): void {
  appendTokenToTabSection(tabId, sectionId, text)
  sbp('dez.editor/appendTokenIfVisible', tabId, sectionId, text)
}

function receiveToken(tabId: string, sectionId: string, token: string): void {
  if (!streamWritesSection(tabId, sectionId)) return
  writeStreamText(tabId, sectionId, token)
}

// Writes escaped answer text of the model. Right after an image reference
// or a clip tag of the reply, the text starts a new paragraph: one blank
// line takes the place of the line breaks that the text starts with, and a
// text of only line breaks is dropped, so a reply never ends with an empty
// paragraph. A clip's tag needs it: a tag counts only as a whole line
// (mediaTags.ts). True when it wrote text.
function writeModelText(tabId: string, reply: ReplyRuntime, text: string): boolean {
  let written = text
  if (reply.afterAsset) {
    const rest = text.replace(/^\n+/, '')
    written = rest === '' ? '' : `\n\n${rest}`
  }
  if (written === '' || !streamWritesSection(tabId, reply.sectionId)) return false
  reply.afterAsset = false
  receiveToken(tabId, reply.sectionId, written)
  return true
}

// Writes the answer text that the reply's escaper still holds back. Call it
// at a round end and before the reply ends, while the stream session still
// writes the section. True when it wrote text.
function flushModelText(tabId: string, reply: ReplyRuntime): boolean {
  return writeModelText(tabId, reply, reply.escaper.flush())
}

// `change` updates the thinking of the streaming section in the store; the
// editor then gets the new thinking in the same tick, so the editor's
// section watcher finds both copies equal. The store changes for a tab in
// the background too; its editor reads the store when it is shown.
function updateStreamThinking(tabId: string, sectionId: string, change: () => SectionThinking | null): void {
  if (!streamWritesSection(tabId, sectionId)) return
  const thinking = change()
  if (thinking) sbp('dez.editor/setSectionThinkingIfVisible', tabId, sectionId, thinking)
}

// Replaces the running blocks of `run` with `text`, in the store and in the
// visible editor. False when the section no longer holds them.
function replaceToolRun(tabId: string, sectionId: string, run: ToolRun, text: string): boolean {
  if (!replaceStreamTailInTabSection(tabId, sectionId, run.runningText, text)) return false
  sbp('dez.editor/replaceStreamTailIfVisible', tabId, sectionId, run.runningText, text)
  return true
}

// Deletes the picture copies of the results of `run` (shownPictures.ts)
// when no block of the section takes them: no text could name them then.
function discardRunPictures(run: ToolRun): void {
  void discardShownPictures(run.results.flatMap((result) => result?.pictures ?? []))
}

// Ends the tool run of a reply that the user stopped, or whose output a
// submit ended (`dez.stream/endOutput`): aborts the running tool, and
// writes the final blocks at once, while the stream session still writes
// the section. Calls that ended keep their results; the others get their
// stopped result (`stoppedToolResult`). The round loop finds the run gone
// and writes nothing more. True when it wrote the blocks.
function stopToolRun(tabId: string, reply: ReplyRuntime): boolean {
  const run = reply.toolRun
  if (!run) return false
  reply.toolRun = null
  run.abort.abort()
  const blocks = run.calls.map((call, index) => toolCallBlock(call, run.results[index] ?? stoppedToolResult(call.name)))
  if (streamWritesSection(tabId, reply.sectionId) && replaceToolRun(tabId, reply.sectionId, run, toolGroupText(blocks))) return true
  discardRunPictures(run)
  return false
}

// The writers of a tool's image and clip into the reply
// (`ToolRunContext`): each puts its asset at the section end, with the
// name of the tool that made it (`IMAGE_TOOL_KEY`, `MEDIA_TOOL_ATTRIBUTE`).
// That is `tool`, or the tool that a write names (`jobs_wait` writes what
// the job of another tool made). An asset that a model made for the tool
// (`model_invoke`) keeps that model (`imageModelMark`, `clipModelMark`). A
// clip that a provider made as a job keeps the provider's job id too
// (`MEDIA_JOB_ATTRIBUTE`), as the clip of a media reply does. An asset of
// a Dez job keeps the id of that job (`IMAGE_MADE_BY_KEY`,
// `MEDIA_MADE_BY_ATTRIBUTE`), and an asset that its call made as a part of
// its work keeps the id again last (`IMAGE_HIDDEN_KEY`,
// `MEDIA_HIDDEN_ATTRIBUTE`). A write while `takesAssets` gives false
// writes nothing and gives null.
function toolAssetWriters(tabId: string, reply: ReplyRuntime, tool: string, takesAssets: () => boolean): Pick<ToolRunContext, 'writeImage' | 'writeClip'> {
  return {
    writeImage: (path, options) => (takesAssets()
      ? writeAsset(tabId, reply, (id) => imageMarkdown(path, [
        { key: 'id', value: id },
        { key: IMAGE_TOOL_KEY, value: options?.tool ?? tool },
        ...imageModelMark(options?.model),
        ...(options?.madeBy === undefined ? [] : [{ key: IMAGE_MADE_BY_KEY, value: options.madeBy }]),
        ...(options?.hidden === undefined ? [] : [{ key: IMAGE_HIDDEN_KEY, value: options.hidden }]),
      ]))
      : null),
    writeClip: (clip, options) => (takesAssets()
      ? writeAsset(tabId, reply, (id) => mediaTagText({
        ...clip,
        id,
        other: [
          { name: MEDIA_TOOL_ATTRIBUTE, value: options?.tool ?? tool },
          ...clipModelMark(options?.model),
          ...(options?.jobId === undefined ? [] : [{ name: MEDIA_JOB_ATTRIBUTE, value: options.jobId }]),
          ...(options?.madeBy === undefined ? [] : [{ name: MEDIA_MADE_BY_ATTRIBUTE, value: options.madeBy }]),
          ...(options?.hidden === undefined ? [] : [{ name: MEDIA_HIDDEN_ATTRIBUTE, value: options.hidden }]),
        ],
      }))
      : null),
  }
}

// How many bytes a request sends for each image part of `messages` (the
// file, or its smaller copy), by path, for the picture budget
// (`contextImageCost`). An image that Dez cannot send has no entry and
// counts no bytes: the request that holds it fails with its own text.
async function imageFileSizes(messages: readonly StreamMessage[]): Promise<ReadonlyMap<string, number>> {
  const paths = new Set<string>()
  for (const part of attachmentParts(messages)) if (part.type === 'image') paths.add(part.path)
  return paths.size === 0 ? new Map() : await sbp('dez.provider/chatImageSizes', [...paths]) as Map<string, number>
}

// What the pictures of the next call of `run` can cost
// (`ToolRunContext.pictureBudget`): the limits of a request to `model`,
// less the images and the pictures of `messages` (the request that gave
// the calls of the round, so the context as it is now), and less the
// pictures of the calls of the round that ended, which the next request
// adds. Those pictures go in one message, so the round can show only as
// many more as a message of the model still takes. The model cache gives
// the context window and the image limits of the model; a model that it
// does not have counts by its family.
async function pictureBudgetOf(reply: ReplyRuntime, model: ModelRef, messages: readonly StreamMessage[], run: ToolRun): Promise<CallPictureBudget> {
  // The images before the reply are the same in each of its requests.
  reply.imageBytes ??= imageFileSizes(messages)
  const imageBytes = await reply.imageBytes
  const rule = modelFamily(model.modelId).imageTokens
  const info = modelInfoOf(model)
  const shown = run.results.flatMap((result) => result?.pictures ?? [])
  return {
    left: pictureBudgetLeft(
      pictureLimits(info),
      totalCost([contextImageCost(messages, rule, imageBytes), ...shown.map((picture) => shownPictureCost(rule, picture))]),
    ),
    roundPictures: Math.max(0, messageImageLimitOf(info) - shown.length),
  }
}

// The picture parts that the rounds of the reply to `model` can get in a
// request that starts with the messages `base`: what `base` leaves of the
// image limits of the model. `sectionsToStreamMessages` counts the parts
// of the whole conversation the same way, so each later request gives the
// rounds the same parts. Null for a model that reads no images, which
// gets no picture.
function replyPictureParts(base: readonly StreamMessage[], model: ModelRef): RequestImages | null {
  const { sendImages, imageLimit = Infinity, messageImageLimit } = imageOptionsOf(modelInfoOf(model))
  return sendImages ? newRequestImages(imageLimit - requestImageCount(base), messageImageLimit) : null
}

// Runs the calls of one round, in order: appends their running blocks (a
// refused call gets its error block at once), runs each call, then replaces
// the running blocks with the final ones. Nothing else of the reply writes
// the section meanwhile, but a tool can put an image, a clip, or an app
// after the blocks (`toolAssetWriters`, `showApp`). `model` is the reply's
// model, for a tool that reads it, and `messages` the request that gave
// the calls, for the picture budget. Returns the reply after the round,
// or null when the run did not end here: the user stopped the reply, or a
// submit ended its output (stopToolRun wrote the blocks), or the user
// deleted the running blocks.
//
// The reference of a tool's image or the tag of its clip goes after the
// group, so it is the start of the text of the next round, and has the
// name of its tool (`IMAGE_TOOL_KEY`, `MEDIA_TOOL_ATTRIBUTE`). A request
// does not send that text: the result of the call names the asset
// (`roundRequestText`, streams/messages.ts). The round that made the call
// keeps its text, and both rounds keep their thinking: a request sends no
// thinking for a round whose text holds an image of the model
// (`roundThinking`, streams/messages.ts), and the request after a round of
// calls needs that round's thinking. The tag of an app that `apps show`
// shows goes the same way (chat/appTags.ts), with no mark of a tool: only
// Dez writes that tag.
async function runToolRound(tabId: string, conversationId: string, reply: ReplyRuntime, jobs: TabJobs, model: ModelRef, calls: CheckedToolCall[], replyText: string, messages: readonly StreamMessage[]): Promise<StreamingReply | null> {
  const runningBlocks = calls.map((call) => toolCallBlock(call))
  const run: ToolRun = {
    calls,
    results: [],
    runningText: toolGroupText(runningBlocks),
    abort: new AbortController(),
  }
  writeStreamText(tabId, reply.sectionId, toolGroupAppendText(replyText, runningBlocks))
  // The next round's text comes after the blocks, not after an asset.
  reply.afterAsset = false
  reply.toolRun = run

  for (const [index, call] of calls.entries()) {
    if (call.refusal !== undefined) continue
    const toolCall: ToolRunCall = { name: call.name, arguments: call.arguments }
    // Not after a stop (`stopToolRun`), as for an image of the model.
    const takesAssets = () => reply.toolRun === run
    const context: ToolRunContext = {
      tabId,
      conversationId,
      model,
      jobs,
      ...toolAssetWriters(tabId, reply, call.name, takesAssets),
      showApp: (name) => takesAssets() && writeOwnParagraph(tabId, reply, () => appTagText(name)),
      // The read of the file sizes takes a moment, so a stop can come
      // during it.
      pictureBudget: async () => {
        const budget = takesAssets() ? await pictureBudgetOf(reply, model, messages, run) : NO_CALL_PICTURE_BUDGET
        return takesAssets() ? budget : NO_CALL_PICTURE_BUDGET
      },
      roundResults: run.results.flatMap((result) => (result ? [result.content] : [])),
      isBridged: false,
    }
    const result = await sbp('dez.controller/tools/run', toolCall, run.abort.signal, context) as ToolRunResult
    if (reply.toolRun !== run) {
      // `stopToolRun` wrote the block of this call as stopped.
      void discardShownPictures(result.pictures ?? [])
      return null
    }
    run.results[index] = result
  }

  reply.toolRun = null
  const blocks = calls.map((call, index) => toolCallBlock(call, run.results[index]))
  if (!replaceToolRun(tabId, reply.sectionId, run, toolGroupText(blocks))) {
    discardRunPictures(run)
    return null
  }
  return streamingReply(tabId, reply.sectionId)
}

// The reply is still its tab's reply, and no stop or submit ended it. A
// cancelled request can still give its response, so each write of a
// reply's image or clip checks this first.
function replyIsCurrent(tabId: string, reply: ReplyRuntime): boolean {
  return repliesByTab.get(tabId) === reply && !reply.cancelling
}

// The line breaks that put a line of Dez in the reply (an image, a clip,
// an app) in a paragraph of its own after `replyText`. A tag needs it: a
// tag counts only as a whole line (mediaTags.ts, appTags.ts).
function paragraphGap(replyText: string): string {
  return replyText === '' || replyText.endsWith('\n\n') ? '' : replyText.endsWith('\n') ? '\n' : '\n\n'
}

// Writes a line of Dez (an image reference, a clip tag, an app tag) at the
// end of the reply's section, as a paragraph of its own; `lineText` gives
// its text from the sections of the tab as they are now, in the tick of
// the write. Returns false, and writes nothing, when the section takes no
// text: the user merged it into the one before, or the stream ended. The
// model text that comes next starts a new paragraph (`writeModelText`).
// Right after a compaction, the reply text is empty, so the line starts on
// the line after the end line of the block.
function writeOwnParagraph(tabId: string, reply: ReplyRuntime, lineText: (sections: readonly Section[]) => string): boolean {
  const sections = (sbp('dez.model/tab', tabId) as Tab | null)?.sections ?? []
  const index = sections.findIndex((section) => section.id === reply.sectionId)
  if (index < 0 || !streamWritesSection(tabId, reply.sectionId)) return false
  receiveToken(tabId, reply.sectionId, paragraphGap(sectionTextParts(sections[index], index).text) + lineText(sections))
  reply.afterAsset = true
  return true
}

// Writes an image reference or a clip tag into the reply
// (`writeOwnParagraph`); `assetText` gives its text with a new media id.
// Returns the id, or null when the section takes no text. The id and the
// write are in one tick, so that no paste takes the id (the editor gives
// ids only to pasted and dropped references).
function writeAsset(tabId: string, reply: ReplyRuntime, assetText: (id: string) => string): string | null {
  let id = ''
  const written = writeOwnParagraph(tabId, reply, (sections) => {
    [id] = newMediaIds(sections.map(sectionPlainText), 1)
    return assetText(id)
  })
  return written ? id : null
}

// Puts an image of a chat reply at the end of its section: saves the file
// in the generated image folder, then writes its reference, with the model
// of the reply as its model mark. No answer text comes meanwhile:
// dez.provider/streamChat waits for this. A failed save leaves the image
// out, and the reply goes on.
async function writeReplyImage(tabId: string, reply: ReplyRuntime, image: GeneratedMedia, model: ModelRef): Promise<void> {
  let path: string
  try {
    path = await sbp('dez.controller/images/save', image.bytes, image.mediaType, { folder: 'generated' }) as string
  } catch {
    // images/save logged the failure and showed its error toast.
    return
  }

  // While the file was saved, the reply could end, or the user could merge
  // its section into the one before. A file that no reference names is
  // deleted; images/delete logs and shows its own failures.
  const current = replyIsCurrent(tabId, reply)
  // Text that the escaper holds is answer text from before the image. The
  // reference itself is not model text, so it gets no escape.
  if (current) flushModelText(tabId, reply)
  if (!current || writeAsset(tabId, reply, (id) => imageMarkdown(path, [{ key: 'id', value: id }, ...imageModelMark(model)])) === null) {
    await sbp('dez.controller/images/delete', path).catch(() => {})
  }
}

// Puts the audio of a chat reply (a temp copy) at the end of its section,
// after the answer text, as a media reply's clip is, with the model of the
// reply as its model mark. A temp copy that no tag names is deleted: the
// reply ended, or the section takes no text.
async function writeReplyClip(tabId: string, reply: ReplyRuntime, clip: GeneratedClip, model: ModelRef): Promise<void> {
  const current = replyIsCurrent(tabId, reply)
  if (current) flushModelText(tabId, reply)
  const written = current && writeAsset(tabId, reply, (id) => mediaTagText({
    kind: clip.kind,
    id,
    type: clip.mediaType,
    src: clip.src,
    url: clip.url,
    expires: clip.expires,
    other: clipModelMark(model),
  })) !== null
  if (!written) await discardMadeAssets([generatedClipAsset(clip)])
}

// For a reply that ends while some of its jobs still run, or have results
// that no `jobs_wait` gave to the model: the model ended its reply before
// it got them, or the reply failed. Waits until no job runs, as a job can
// be a request that the user pays for, and puts the images and the clips
// of those jobs at the section end, under the names of their tools, as
// `jobs_wait` does. The reply stays busy meanwhile. A stop or a new submit
// ends the wait, but not the jobs: the reply hands them on, with their
// results, to the next reply (`handOverJobs`). The result text of such a
// job has no reader: the text of a job that finished is dropped, and
// `endReply` logs the others. Returns the jobs that failed or timed out,
// for the error toast (`unreadJobsMessage`); null when the reply ended
// meanwhile.
async function settleJobs(tabId: string, reply: ReplyRuntime, { tabJobs, lease }: TakenJobs): Promise<EndedJob[] | null> {
  // A section that is gone (the user merged it into the one before) takes
  // no asset, so nothing is worth the wait.
  if (!streamingReply(tabId, reply.sectionId)) tabJobs.stopAll()
  const ended = await tabJobs.settle(lease)
  if (ended === null) return null
  // When the reply ended in another way meanwhile, the writers give null,
  // which deletes the files.
  for (const job of ended) {
    await writeJobAssets(job, toolAssetWriters(tabId, reply, job.tool, () => replyIsCurrent(tabId, reply)))
  }
  return replyIsCurrent(tabId, reply) ? ended.filter((job) => job.status !== 'finished') : null
}

// Ends a reply that is still its tab's reply, as finished or as failed:
// first its open jobs (`settleJobs`), then the stream session. With no
// open job there is no wait, so the end is in the tick of the reply's
// last write. True when it ended the reply; false when a stop or a new
// submit ended it during the wait for the jobs. A caller shows its own
// toast only after a true: the end sets the title of a new tab.
async function endReply(tabId: string, reply: ReplyRuntime, status: 'finished' | 'error'): Promise<boolean> {
  const jobs = reply.jobs
  const unread = jobs?.tabJobs.hasOpen ? await settleJobs(tabId, reply, jobs) : []
  if (unread === null) return false
  finalizeStream(tabId, status === 'finished' ? finishStreamSession(tabId) : errorStreamSession(tabId))
  if (unread.length > 0) {
    for (const job of unread) console.error(`The ${job.tool} job ${job.id} ${job.status}, and the model did not get its result:`, job.text)
    showReplyError(tabId, unread.length === 1 ? 'Job failed' : `${unread.length} jobs failed`, unreadJobsMessage(unread))
  }
  return true
}

// The parts of a chat request that are the same in every request of a
// reply to one model (`runChatRounds`). A compaction request sends them as
// they are, so it reads the prompt cache of the reply.
interface RequestFrame {
  system: string | undefined
  tools: readonly ToolDefinition[]
  imageOutput: boolean
  audioOutput: boolean
  providerSettings: Record<string, boolean> | undefined
}

// Who writes the notes of a compaction: a model, and the chat request to
// that model that holds the conversation. The compaction request is that
// request with one more user message (controller/compaction.ts).
interface NotesWriter {
  model: ActiveModel
  messages: readonly StreamMessage[]
  frame: RequestFrame
}

// What the compaction check before a chat request of a reply did
// (`compactIfDue`).
type CompactionStep =
  // No compaction: the request goes as it is.
  | { kind: 'none' }
  // The tab is compacted. `messages` are the request messages before the
  // reply: the compaction message of the block of the reply's section.
  // `imagesOverLimit` counts their images that went as text only
  // (`RequestMessages.imagesOverLimit`), and `kept` is what their images
  // and pictures cost.
  | { kind: 'compacted', messages: StreamMessage[], imagesOverLimit: number, kept: PictureBudget }
  // The reply ended in the check, or a stop or a submit ended it meanwhile.
  | { kind: 'ended' }

const NO_COMPACTION: CompactionStep = { kind: 'none' }
const REPLY_ENDED: CompactionStep = { kind: 'ended' }

// The request messages, for `model`, of the sections of `sections` before
// the reply's section `sectionId`, with the count of their images that
// went as text only for the image limits; null when no section has that
// id. Not the messages of all the sections: an empty section of a reply is
// left out of a request, so a user section after it would join the
// message before it. For a reply in the compaction section, that is the
// compaction message of its block (`sectionsBeforeReply`).
function messagesBefore(sections: Section[], sectionId: string, model: ModelRef, sendTools: boolean): Pick<RequestMessages, 'messages' | 'imagesOverLimit'> | null {
  const index = sections.findIndex((section) => section.id === sectionId)
  if (index < 0) return null
  const { messages, imagesOverLimit } = sectionsToStreamMessages(sectionsBeforeReply(sections, index), model, {
    ...imageOptionsOf(modelInfoOf(model)),
    sendTools,
  })
  return { messages, imagesOverLimit }
}

// The writer of the notes of a conversation that is larger than the whole
// context window of the model of the new reply, `replyModel` (the user
// chose a smaller model): the model of the newest reply before it, which
// read the whole conversation in its last request. It gets a chat request
// of its own: the sections before `replySectionId` as it reads them, with
// its system prompt, its tools, and its settings. Only a normal tab compacts
// (`requestParts`), so it is the request of a normal tab.
//
// Null when the model of the new reply must write the notes itself: no
// earlier reply tells its model, or that model is `replyModel`. The window
// that Dez knows of a model can be too small (a model of no family gets a
// default), so Dez sends the request, and the provider refuses it if the
// conversation is in fact too large.
//
// Throws an `ExplainedError` when Dez cannot send a chat request to the
// model of the newest reply: its provider is gone, or it is a media model.
function earlierReplyWriter(sections: Section[], replySectionId: string, replyModel: ActiveModel): NotesWriter | null {
  const ref = newestReplyModel(sections, replySectionId)
  if (ref === null || sameModelRef(ref, replyModel)) return null
  const provider = getProvider(ref.providerId)
  const info = modelInfoOf(ref)
  const model: ActiveModel = { ...ref, modelName: info.name ?? ref.modelId }
  const sendTools = sbp('dez.model/requestSendsTools', ref) as boolean
  const messages = messagesBefore(sections, replySectionId, ref, sendTools)?.messages ?? null
  if (!provider || effectiveRequest(info) !== 'chat' || messages === null) {
    throw new ExplainedError(
      `This conversation is too large for ${replyModel.modelName}. To go on with that model, Dez must first ask the model of the newest reply, ${model.modelName}, `
      + `for notes that take the place of the conversation, and Dez cannot send a chat request to ${model.modelName}. `
      + 'Choose a model that can read more text, and send the message again.',
    )
  }
  const settings = sbp('dez.model/settings/snapshot') as SettingsSnapshot
  const tools = sendTools ? TOOL_DEFINITIONS : []
  const outputs = effectiveOutputs(info)
  return {
    model,
    messages,
    frame: {
      system: buildSystemPrompt(systemPromptTemplate(settings.systemPrompt), ref, provider.name, tools),
      tools,
      imageOutput: outputs.includes('image'),
      audioOutput: outputs.includes('audio'),
      providerSettings: settings.providerSettings[ref.providerId],
    },
  }
}

// Asks `writer` for the notes that take the place of the conversation
// `sections` (`compactConversation`, which changes no tab), with one more
// try after a failure. Each try is a request of the reply
// (`reply.requestId`), so a stop cancels it, and the stream session tells
// the bottom bar that the reply waits for a compaction. Null when a stop
// or a new submit ended the reply meanwhile: that is no failure. Throws
// the failure of the second try.
async function requestCompaction(args: StreamStartArgs, reply: ReplyRuntime, jobs: TabJobs, sections: Section[], writer: NotesWriter): Promise<Compaction | null> {
  const { tabId } = args
  setStreamCompacting(tabId, true)
  try {
    for (let tries = 1; ; tries++) {
      const requestId = crypto.randomUUID()
      reply.requestId = requestId
      try {
        return await compactConversation({
          tabId,
          conversationId: args.conversationId,
          sections,
          replySectionId: args.sectionId,
          model: writer.model,
          readerModel: args.model,
          messages: writer.messages,
          ...writer.frame,
          requestId,
          signal: reply.abort.signal,
          jobs: jobs.list(),
          replySections: jobs.replySections,
          cost: () => sbp('dez.model/tabs/cost', tabId) as ConversationCost | undefined,
          countCost: (usd) => countRequestCost(tabId, usd),
        })
      } catch (error) {
        if (reply.abort.signal.aborted || !replyIsCurrent(tabId, reply)) return null
        if (tries === 2) throw error
        console.error('The compaction request failed, and Dez sends it one more time:', error)
      }
    }
  } finally {
    // The session of a newer reply of the tab has its own flag.
    if (replyIsCurrent(tabId, reply)) setStreamCompacting(tabId, false)
  }
}

// The text of the error toast of a compaction whose request failed two
// times: what Dez tried and that the conversation is as it was, then the
// fault and the fix of `error`. `writer` is the model that Dez asked for
// the notes.
function compactionFailedMessage(error: unknown, writer: ActiveModel): string {
  const cause = replyError(error, writer)
  return errorText(
    `This conversation is near the limit of what one request can hold. So Dez asked ${writer.modelName} for notes that take the place of the conversation, and that request failed two times. `
    + `The conversation stays as it is. ${cause.explanation}`,
    cause.details,
  )
}

// Ends `reply` with the error toast `message`, because Dez could not
// compact the conversation (`error`), and the request that was due cannot
// go without that. The tab keeps its conversation.
async function endUncompactedReply(tabId: string, reply: ReplyRuntime, error: unknown, message: string): Promise<CompactionStep> {
  console.error('The compaction of the conversation failed:', error)
  flushModelText(tabId, reply)
  if (await endReply(tabId, reply, 'error')) showReplyError(tabId, 'Compaction failed', message)
  return REPLY_ENDED
}

// The compaction check of a reply, right before a chat request: when the
// request is due for a compaction (`compactionReason`), one request asks
// for the notes of the conversation, and the notes take the place of the
// tab's sections up to the reply's section and of the text of the reply.
// After it, the reply's section is the compaction section: the block, and
// no reply text yet (`compactedSections`). The reply stays the same
// reply: its runtime, its jobs, and its stream session go on, so its busy
// state, Stop, and its error toast cover the compaction, and it writes on
// after the block. The first request of a reply and a request between two
// tool rounds use this one path: at a submit, the reply's section is the
// empty section of the new reply.
//
// `messages` and `frame` are the request that is about to go. `kept` is
// what the images and the pictures cost right after the newest compaction
// of the reply (`compactionReason`), and `firstCheck` tells that the reply
// sent no request yet. Call it only when a chat request went since the
// newest compaction of the conversation.
//
// A compaction that Dez cannot ask for, or whose request fails two times,
// ends the reply with an error toast, and the tab stays as it is.
async function compactIfDue(args: StreamStartArgs, reply: ReplyRuntime, jobs: TabJobs, frame: RequestFrame, { messages, kept, firstCheck }: {
  messages: StreamMessage[]
  kept: PictureBudget
  firstCheck: boolean
}): Promise<CompactionStep> {
  const { tabId, sectionId, model } = args
  const info = modelInfoOf(model)
  const contextWindow = contextWindowOf(info)
  const rule = modelFamily(model.modelId).imageTokens
  const contextTokens = (sbp('dez.model/tabs/contextSize', tabId, model) as ContextSize | undefined)?.tokens ?? 0
  // The images before the reply are the same in each of its requests.
  reply.imageBytes ??= imageFileSizes(messages)
  const spent = contextImageCost(messages, rule, await reply.imageBytes)
  if (!replyIsCurrent(tabId, reply)) return REPLY_ENDED
  const reason = compactionReason({
    contextTokens,
    dueSize: compactionDueSize(contextWindow, sbp('dez.model/tabs/compactions', tabId) as Compactions | undefined),
    limits: pictureLimits(info),
    leaves: compactedPictureLimits(info),
    spent,
    kept,
  })
  // The sections that the compaction reads, and that tell which files it
  // leaves with no text. A reply's section that is gone (the user merged it
  // into the one before) takes no compaction: the rounds end such a reply.
  const sections = (sbp('dez.model/tab', tabId) as Tab | null)?.sections ?? []
  if (reason === null || !sections.some((section) => section.id === sectionId)) return NO_COMPACTION

  let writer: NotesWriter = { model, messages, frame }
  let result: Compaction | null
  try {
    // Only a new reply can have a model that never read the conversation.
    if (firstCheck && contextTokens > contextWindow) writer = earlierReplyWriter(sections, sectionId, model) ?? writer
  } catch (error) {
    // No request went, so the text of the refusal is the whole message.
    return endUncompactedReply(tabId, reply, error, explainedError(error).message)
  }
  try {
    result = await requestCompaction(args, reply, jobs, sections, writer)
  } catch (error) {
    return endUncompactedReply(tabId, reply, error, compactionFailedMessage(error, writer.model))
  }
  if (result === null) return REPLY_ENDED
  // A submit can end the output of the reply with no stop of its request
  // (`dez.stream/endOutput`), so the answer can still come whole. Its
  // picture copies then have no text that names them.
  if (!replyIsCurrent(tabId, reply)) {
    void discardShownPictures(result.pictures)
    return REPLY_ENDED
  }

  const swapped = sbp('dez.model/tabs/compact', tabId, { sections: result.sections, replySectionId: sectionId, tokens: result.usage?.inputTokens ?? contextTokens, model }) as boolean
  const tab = swapped ? sbp('dez.model/tab', tabId) as Tab | null : null
  const base = tab && messagesBefore(tab.sections, sectionId, model, args.sendTools)
  if (!base) {
    // The user merged the reply's section into the one before while the
    // request ran, so the tab stays as it is. With no section, the reply
    // cannot go on: it ends as a stop does.
    void discardShownPictures(result.pictures)
    finalizeStream(tabId, cancelStreamSession(tabId))
    return REPLY_ENDED
  }
  // In the tick of the swap: an editor that still holds the old doc writes
  // the old text back into the tab at its next doc change.
  sbp('dez.editor/rebuildIfVisible', tabId)
  // The reply text is empty again, so its text state starts new.
  reply.escaper = new ModelTextEscaper()
  reply.afterAsset = false
  // Before the delete, which keeps each file that a conversation file
  // names: the old file of this conversation names the files that left.
  await sbp('dez.model/tabs/save', tabId)
  // Not awaited: it waits for the scan of a cleanup that runs, and it
  // logs its own failures.
  void sbp('dez.controller/unusedFiles/deleteUnnamed', compactionLeftFiles({ sections, replySectionId: sectionId, dropped: result.dropped, keptPictures: result.pictures }))
  reply.imageBytes = imageFileSizes(base.messages)
  const keptNow = contextImageCost(base.messages, rule, await reply.imageBytes)
  return replyIsCurrent(tabId, reply) ? { kind: 'compacted', ...base, kept: keptNow } : REPLY_ENDED
}

// The chat rounds of a reply: request rounds until a round ends with no
// tool calls, with no limit of their count. Each round streams its answer
// text and thinking into the agent section; a round that ends with tool
// calls adds their blocks, runs them, and sends the next round with the
// reply so far. A request that would be too large gets a compaction of
// the conversation first (`compactIfDue`). Ends the reply, except when it
// throws.
async function runChatRounds(args: StreamStartArgs, reply: ReplyRuntime): Promise<void> {
  // Before the first compaction check: the notes of a compaction list the
  // jobs that a cut reply left, as their start blocks leave.
  const jobs = takeJobs(args.tabId, reply)
  // Read the provider's stored setting overrides and the system prompt
  // template at stream start (rather than threading them from submitTab) so
  // every caller — including future retries — picks up the user's current
  // settings consistently.
  const settings = sbp('dez.model/settings/snapshot') as SettingsSnapshot
  const providerSettings = settings.providerSettings[args.model.providerId]
  const parts = requestParts(args)
  // The prompt lists exactly the tools that the request offers.
  const tools = args.sendTools ? TOOL_DEFINITIONS : []
  // A template error or a deleted provider throws, which ends the stream
  // session. Built once per reply, so a provider rename or a template edit
  // during the reply does not change the prompt of its later rounds. A
  // blank template gives no system prompt, and so does an incognito tab.
  const system = parts.dezSystemPrompt
    ? buildSystemPrompt(systemPromptTemplate(settings.systemPrompt), args.model, requireProvider(args.model.providerId).name, tools)
    : undefined
  const frame: RequestFrame = { system, tools, imageOutput: args.imageOutput, audioOutput: args.audioOutput, providerSettings }
  // The messages of the sections before the reply's section: each request
  // sends them, then the rounds of the reply so far. A compaction in the
  // reply replaces them with the compaction message of its block.
  let base = args.messages
  let messages = base
  // The images that the next request leaves out for the image limit, and
  // that the user does not know of yet: the ones of the messages before
  // the reply, then the ones of the messages of a compaction.
  let untoldImagesOverLimit = args.imagesOverLimit
  // A chat request went since the newest compaction of the conversation.
  // At the start of the reply, the text tells it.
  let requestSinceCompaction = repliedSinceCompaction((sbp('dez.model/tab', args.tabId) as Tab | null)?.sections ?? [], args.sectionId)
  // What the images and the pictures cost right after the newest
  // compaction of the reply.
  let kept = NO_PICTURE_BUDGET
  let firstCheck = true
  // The first call id of the group that ended the round before: it names
  // the thinking round of every later round (SectionThinking.rounds).
  let afterToolCall: string | undefined

  for (;;) {
    // No check, and so no wait, for a request that needs none: a first
    // message, and the request right after a compaction. A compaction that
    // made no room would come again and again. An incognito tab never
    // compacts: a conversation that grows too large for the model gets the
    // provider's error.
    if (parts.compaction && requestSinceCompaction) {
      const step = await compactIfDue(args, reply, jobs, frame, { messages, kept, firstCheck })
      if (step.kind === 'ended') return
      if (step.kind === 'compacted') {
        base = messages = step.messages
        untoldImagesOverLimit = step.imagesOverLimit
        kept = step.kept
        requestSinceCompaction = false
        // The reply text is empty again: it has no round before.
        afterToolCall = undefined
      }
    }
    firstCheck = false
    if (untoldImagesOverLimit > 0) {
      warnImagesOverLimit(args.model, untoldImagesOverLimit)
      untoldImagesOverLimit = 0
    }
    const requestId = crypto.randomUUID()
    reply.requestId = requestId
    const roundIsCurrent = () => repliesByTab.get(args.tabId) === reply && reply.requestId === requestId && !reply.outputEnded
    const roundAfterToolCall = afterToolCall
    // The round's reply held an image, saved or not.
    let madeImage = false
    let result: ProviderStreamChatResult
    // A request that failed before it went costs nothing, and does not
    // count.
    let sent = false
    const startedAt = Date.now()
    const imageCount = requestImageCount(messages)
    // The end of the round's request, with the price that the tab counts
    // and the tokens that the provider told: for the cost of the tab, and
    // for the developer's request log.
    const countRound = (cost: number | null, usage?: ChatUsage) => {
      countRequestCost(args.tabId, cost)
      logRequest({ tabId: args.tabId, kind: 'chat', model: args.model, startedAt, usage, cost, imageCount })
    }
    try {
      result = await sbp('dez.provider/streamChat', {
        providerId: args.model.providerId,
        conversationId: args.conversationId,
        system: frame.system,
        tools: frame.tools,
        imageOutput: frame.imageOutput,
        audioOutput: frame.audioOutput,
        modelId: args.model.modelId,
        messages,
        requestId,
        providerSettings: frame.providerSettings,
        providerSystemPrompt: parts.providerSystemPrompt,
        onSent: () => { sent = true },
        onToken: (token: string) => {
          if (!roundIsCurrent()) return
          writeModelText(args.tabId, reply, reply.escaper.push(token))
        },
        onThinking: (token: string) => {
          if (!roundIsCurrent()) return
          updateStreamThinking(args.tabId, args.sectionId, () => appendThinkingToTabSection(args.tabId, args.sectionId, token, roundAfterToolCall))
        },
        // Not after a stop, unlike the text: the save is not instant, and a
        // stopped reply must not grow later.
        onImage: async (image: GeneratedMedia) => {
          madeImage = true
          if (replyIsCurrent(args.tabId, reply)) await writeReplyImage(args.tabId, reply, image, args.model)
        },
        onClip: (clip: GeneratedClip) => writeReplyClip(args.tabId, reply, clip, args.model),
      }) as ProviderStreamChatResult
    } catch (error) {
      if (sent) countRound(failedChatRequestCost(error))
      throw error
    }
    // Also when a stop cut the answer off: it gives no price.
    countRound(result.cost ?? null, result.usage)
    requestSinceCompaction = true
    if (!replyIsCurrent(args.tabId, reply)) return

    // Before the blocks and the finish, which saves the conversation.
    flushModelText(args.tabId, reply)
    // A round that made an image keeps no replay. Its replay is the
    // provider's signature of the image (about 1 MB from a Gemini image
    // model): it would go into the conversation file and into each later
    // request, and a request holds the image only as its reference text,
    // so no thinking of such a round goes back (`roundThinking`,
    // streams/messages.ts). The thinking text of the round stays.
    const replay = madeImage ? undefined : result.thinkingReplay
    if (replay) {
      updateStreamThinking(args.tabId, args.sectionId, () => setThinkingReplayForTabSection(args.tabId, args.sectionId, replay, roundAfterToolCall))
    }

    // A request that offers no tools gets no calls. Calls that a server
    // sends anyway are left out: the next request could not send them
    // back with no tool definitions. A section that is gone (the user
    // merged it into the one before) takes no blocks.
    const streamedCalls = tools.length > 0 ? result.toolCalls ?? [] : []
    const replied = streamingReply(args.tabId, args.sectionId)
    // The tokens of this request are the size of the conversation with
    // its answer. The tab holds the answer's text now, but not yet the
    // blocks of its calls, so the calls go with the count. A provider that
    // told no tokens leaves the count of an earlier request.
    const { inputTokens, outputTokens } = result.usage ?? {}
    if (inputTokens !== undefined && outputTokens !== undefined) {
      sbp('dez.model/tabs/countRequestContext', args.tabId, args.model, inputTokens + outputTokens, replied ? streamedCalls : [])
    }
    if (streamedCalls.length === 0 || !replied) {
      await endReply(args.tabId, reply, 'finished')
      return
    }

    // Only the tool blocks of the reply text: the notes of a block hold
    // none. The refusal of an `apps edit` call can get the hint of `edit`,
    // by the sections of the tab before the round (editHint.ts).
    const checkedCalls = checkToolCalls(streamedCalls, findToolBlocks(replied.text).map((block) => block.id))
    const calls = withEditHintRefusals(checkedCalls, streamedCalls, (sbp('dez.model/tab', args.tabId) as Tab | null)?.sections ?? [])
    const replySoFar = await runToolRound(args.tabId, args.conversationId, reply, jobs, args.model, calls, replied.text, messages)
    if (!replySoFar) {
      // Still current only when the user deleted the running blocks:
      // with no calls to send back, the reply cannot go on, so it ends
      // as a stop does, and its jobs go on for the next reply.
      if (replyIsCurrent(args.tabId, reply)) {
        handOverJobs(args.tabId, reply)
        finalizeStream(args.tabId, cancelStreamSession(args.tabId))
      }
      return
    }
    afterToolCall = calls[0].id
    // Only up to the results of the newest group, and the pictures that
    // its calls showed (`agentSectionMessages` puts their `user` message
    // right after the results; `replyPictureParts` counts them as every
    // later request does). The text after that group (text that the user
    // typed while the tools ran, or an asset that no result names) is the
    // start of the next round's message. A request that ends with an
    // agent message asks the model to go on from that text, and many
    // providers refuse it. Every later request sends that text at the start
    // of the message of the next round, after these same bytes.
    const soFar = agentSectionMessages(replySoFar.section, args.model, true, replyPictureParts(base, args.model), replySoFar.text)
    const lastTool = soFar.findLastIndex((message) => message.role === 'tool')
    const end = soFar[lastTool + 1]?.role === 'user' ? lastTool + 2 : lastTool + 1
    messages = [...base, ...soFar.slice(0, end)]
  }
}

// The one media request of a reply to a media model (a ModelInfo.request
// of MEDIA_KINDS), in place of the chat rounds: no system prompt, tools, or
// thinking. The files of an image model (an image, an edit, an upscale)
// are saved in the generated image folder, and the section gets a
// reference to each. A clip (audio, video) is not saved: the section gets
// a media tag (mediaTags.ts) whose source is the provider's URL, or a temp
// copy until the user saves the clip. A transcription model's text goes
// into the section as the text of a chat reply. The request sets the
// model's parameters to the values that the user chose in the provider
// settings popup, and sends the lyrics that the message holds to a model
// that takes lyrics; an edit, an upscale, and a video request send the
// images of the message, and a request of a model that takes clips the
// clips that it holds or names (`mediaRequestInput`). Images and clips get
// new ids of the one id sequence. Ends the reply, except when it throws.
async function runMediaRound(args: StreamStartArgs, reply: ReplyRuntime, kind: MediaKind): Promise<void> {
  const tab = sbp('dez.model/tab', args.tabId) as Tab | null
  const input = mediaRequestInput(kind, args.newestUserMessage, tab?.sections ?? [], args.inputRules)
  const parameters = (sbp('dez.model/settings/snapshot') as SettingsSnapshot).modelParameters[modelRefKey(args.model)]
  const requestId = crypto.randomUUID()
  reply.requestId = requestId
  // From the moment that the request went: its quote, or null when no
  // quote is known. Undefined while it did not go.
  let sentCost: number | null | undefined
  // The provider runs the request as a job of its own, which it bills.
  let queued = false
  let result: ProviderGenerateMediaResult
  try {
    result = await sbp('dez.provider/generateMedia', {
      providerId: args.model.providerId,
      modelId: args.model.modelId,
      kind,
      prompt: input.prompt,
      ...(input.lyrics !== undefined && { lyrics: input.lyrics }),
      images: input.images,
      ...(input.clips.length > 0 && { clips: input.clips }),
      ...(parameters && { parameters }),
      requestId,
      signal: reply.abort.signal,
      onProgress: (progress: MediaProgress) => {
        if (progress.phase === 'sent') sentCost = progress.quote ?? null
        if (progress.phase === 'queued') queued = true
      },
    }) as ProviderGenerateMediaResult
  } catch (error) {
    // A request that went counts 0 only when the provider refused it, as a
    // refused request costs nothing (the rule of `model_invoke`). Any other
    // failure, a stop, and a failure after the provider started its job
    // (a poll, the download, an answer that Dez cannot use, the time limit)
    // keep the quote: the provider can have taken the money.
    if (sentCost !== undefined) countRequestCost(args.tabId, !queued && isProviderRefusal(error) ? 0 : sentCost)
    throw error
  }
  countRequestCost(args.tabId, result.cost ?? null)
  const { media, clips, text = '' } = result
  // A stop or a new submit cancelled the request, which can end its body
  // early: a cut image is never saved. A clip that still came is whole, but
  // the reply takes no tag any more.
  if (!replyIsCurrent(args.tabId, reply)) {
    await discardMadeAssets(clips.map(generatedClipAsset))
    return
  }

  const paths: string[] = []
  let saved = true
  try {
    for (const file of media) {
      paths.push(await sbp('dez.controller/images/save', file.bytes, file.mediaType, { folder: 'generated' }) as string)
    }
  } catch {
    // images/save logged the failure and showed its error toast.
    saved = false
  }

  // While the files were saved, the reply could end, or the user could
  // merge its section into the one before (as in a chat round). Files that
  // no reference names are deleted; images/delete shows its own failures.
  const sections = (sbp('dez.model/tab', args.tabId) as Tab | null)?.sections ?? []
  const texts = sections.map(sectionPlainText)
  const sectionText = texts[sections.findIndex((section) => section.id === args.sectionId)]
  if (!saved || !replyIsCurrent(args.tabId, reply) || sectionText === undefined) {
    await discardMadeAssets([...paths.map((path): MadeAsset => ({ kind: 'image', path })), ...clips.map(generatedClipAsset)])
    if (replyIsCurrent(args.tabId, reply)) finalizeStream(args.tabId, saved ? finishStreamSession(args.tabId) : errorStreamSession(args.tabId))
    return
  }
  // The ids and the write in one tick, so that no paste takes one of the
  // ids (the editor gives ids only to pasted and dropped references).
  const ids = newMediaIds(texts, paths.length + clips.length)
  // Each asset keeps the model of the reply as its model mark.
  const references = [
    ...paths.map((path, index) => imageMarkdown(path, [{ key: 'id', value: ids[index] }, ...imageModelMark(args.model)])),
    // The job id is tag metadata (`MEDIA_JOB_ATTRIBUTE`).
    ...clips.map((clip, index) => mediaTagText({
      kind: clip.kind,
      id: ids[paths.length + index],
      type: clip.mediaType,
      src: clip.src,
      url: clip.url,
      expires: clip.expires,
      other: [...clipModelMark(args.model), ...(clip.jobId === null ? [] : [{ name: MEDIA_JOB_ATTRIBUTE, value: clip.jobId }])],
    })),
  ]
  // A transcription is escaped as the text of a chat reply
  // (`ModelTextEscaper`), so that speech that spells a tag forms no tool
  // block and no media tag. An empty one writes nothing.
  const written = [...references, reply.escaper.push(text.trim()) + reply.escaper.flush()].filter((part) => part !== '')
  // The user can type in the section while a clip is made.
  if (written.length > 0) receiveToken(args.tabId, args.sectionId, paragraphGap(sectionText) + written.join('\n\n'))
  finalizeStream(args.tabId, finishStreamSession(args.tabId))
}

export default sbp('sbp/selectors/register', {
  // One reply: chat rounds (`runChatRounds`), or one media round
  // (`runMediaRound`) for a model that makes images or clips. The stream
  // session, the busy state, the start time, the scroll follow, Stop, and
  // the error toast span the whole reply, and only the reply's end
  // finalizes it (duration, alerts, trailing user section, save).
  async 'dez.stream/start' (args: StreamStartArgs): Promise<void> {
    const previousReply = repliesByTab.get(args.tabId)
    if (previousReply) {
      // The submit ended its output (`dez.stream/endOutput`) before it built
      // `args.messages`; the new reply ends its request. The jobs of that
      // reply go on, and the new reply takes them, if it is a chat reply.
      previousReply.cancelling = true
      previousReply.abort.abort()
      handOverJobs(args.tabId, previousReply)
      await sbp('dez.http/cancelStream', previousReply.requestId).catch(() => {})
      if (repliesByTab.get(args.tabId) === previousReply) repliesByTab.delete(args.tabId)
    }
    // The error toasts of the tab's earlier replies are out of date now.
    sbp('dez.ui/closeToasts', 'app-global', replyErrorGroup(args.tabId))

    const reply: ReplyRuntime = {
      sectionId: args.sectionId,
      requestId: '',
      abort: new AbortController(),
      cancelling: false,
      outputEnded: false,
      toolRun: null,
      escaper: new ModelTextEscaper(),
      afterAsset: false,
      // `runChatRounds` takes the jobs of the tab.
      jobs: null,
      imageBytes: null,
    }
    repliesByTab.set(args.tabId, reply)

    startStreamSession({
      tabId: args.tabId,
      sectionId: args.sectionId,
      model: args.model,
      messages: args.messages,
    })
    sbp('dez.editor/startStreamingFollowIfVisible', args.tabId)

    try {
      if (args.request === 'chat') await runChatRounds(args, reply)
      else await runMediaRound(args, reply, args.request)
    } catch (error) {
      if (replyIsCurrent(args.tabId, reply)) {
        console.error(args.request === 'chat' ? 'Chat request failed:' : 'Media request failed:', error)
        flushModelText(args.tabId, reply)
        if (await endReply(args.tabId, reply, 'error')) showReplyError(args.tabId, 'Request failed', replyError(error, args.model).message)
      }
    } finally {
      // A reply that ended on its own ends its jobs: nothing could take
      // their results. A reply that the user cut (a stop, a new submit, a
      // delete of its running blocks) handed them on (its lease aborted).
      if (reply.jobs && !reply.jobs.lease.aborted) reply.jobs.tabJobs.stopAll()
      if (repliesByTab.get(args.tabId) === reply) repliesByTab.delete(args.tabId)
    }
  },

  // A submit during a reply in the tab calls this after it builds its
  // request messages (so a submit with no messages leaves the reply alone)
  // and before it adds the new agent section; the new start then cancels
  // the reply's request. A running tool stops with its final blocks, the
  // jobs of the reply go on for the new reply (`handOverJobs`), and the
  // answer text that the escaper holds is written. These writes must come
  // before the new section is in the store: the editor gets it only in
  // Vue's next watcher flush, and a doc change before then writes the
  // editor's sections back to the store, with no new section. Output of
  // the request after this is dropped. True when it wrote text: the caller
  // must then build its messages again.
  'dez.stream/endOutput' (tabId: string): boolean {
    const reply = repliesByTab.get(tabId)
    if (!reply) return false
    reply.cancelling = true
    reply.outputEnded = true
    const wroteBlocks = stopToolRun(tabId, reply)
    handOverJobs(tabId, reply)
    const wroteText = flushModelText(tabId, reply)
    return wroteBlocks || wroteText
  },

  // Stops the reply of the tab, if one runs. Its jobs go on: the next chat
  // reply of the tab takes them (`handOverJobs`). With `endJobs` (the tab
  // goes), it ends them, and the jobs that the tab holds, also when no
  // reply runs.
  async 'dez.stream/stop' (tabId: string, { endJobs = false }: { endJobs?: boolean } = {}): Promise<void> {
    const streaming = streamIsStreaming(tabId)
    const reply = streaming ? repliesByTab.get(tabId) : undefined
    if (reply) {
      reply.cancelling = true
      reply.abort.abort()
      stopToolRun(tabId, reply)
      // The blocks of the calls that started the jobs stay in the section.
      handOverJobs(tabId, reply)
    }
    if (endJobs) {
      heldJobsByTab.get(tabId)?.stopAll()
      heldJobsByTab.delete(tabId)
    }
    if (!streaming) return

    try {
      if (reply) {
        await sbp('dez.http/cancelStream', reply.requestId)
      }
    } finally {
      if (repliesByTab.get(tabId) === reply) {
        repliesByTab.delete(tabId)
      }
      // After the cancel: a token can still come while it runs.
      if (reply) flushModelText(tabId, reply)
      finalizeStream(tabId, cancelStreamSession(tabId))
    }
  },

  // The files that the work of every reply that runs, and every job of a
  // tab, made, and that no text may name yet: the sources of the files
  // that a job keeps while it runs, and of the assets of its result
  // (`TabJobs.madeAssetSources`; the jobs that a tab holds too); and the
  // names of the picture copies of the calls of a tool round that runs
  // (shownPictures.ts), which a round can hold for longer than the age
  // rule of the cleanup. Delete Unreferenced Files keeps those files, as it
  // keeps the files that a text names.
  'dez.stream/unnamedMadeFiles' (): string[] {
    const replies = [...repliesByTab.values()]
    // A cut reply and the tab (or the next reply) can share one object.
    const tabJobs = new Set([...heldJobsByTab.values(), ...replies.flatMap((reply) => reply.jobs?.tabJobs ?? [])])
    return [
      ...[...tabJobs].flatMap((jobs) => jobs.madeAssetSources()),
      ...replies.flatMap((reply) => (reply.toolRun?.results ?? []).flatMap((result) => result?.pictures?.map(({ file }) => file) ?? [])),
    ]
  },
})
