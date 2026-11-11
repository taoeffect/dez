import sbp from '@sbp/sbp'
import type { ActiveModel, Section, SectionThinking, Tab } from '../model/chat/types'
import { sectionPlainText } from '../model/chat/content'
import { IMAGE_TOOL_KEY, imageMarkdown, type ImageMetadataItem } from '../model/chat/images'
import { modelRefKey } from '../model/chat/modelRef'
import { tempMediaFile } from '../model/chat/mediaFiles'
import { newMediaIds } from '../model/chat/mediaIds'
import { mediaTagText } from '../model/chat/mediaTags'
import { findToolBlocks, ModelTextEscaper } from '../model/chat/toolBlocks'
import type { ClipInputRules, GeneratedClip, GeneratedMedia, MediaKind, ModelRequest, ProviderGenerateMediaResult, ProviderStreamChatResult } from '../model/providers'
import { requireProvider } from '../model/providers/registry'
import { agentSectionMessages, mediaRequestInput } from '../model/streams/messages'
import {
  checkToolCalls,
  MAX_TOOL_ROUNDS,
  ROUND_LIMIT_TOOL_RESULT,
  STOPPED_TOOL_RESULT,
  toolCallBlock,
  toolGroupAppendText,
  toolGroupText,
  type CheckedToolCall,
} from '../model/streams/toolRound'
import type { EndedStreamSession, StreamMessage } from '../model/streams/types'
import {
  appendThinkingToTabSection,
  appendTokenToTabSection,
  finalizeStreamSectionForTab,
  replaceStreamTailInTabSection,
  setThinkingReplayForTabSection,
  type SettingsSnapshot,
} from '../model/state'
import { buildSystemPrompt } from '../model/systemPrompt'
import { TOOL_DEFINITIONS } from '../model/tools/registry'
import type { ToolRunResult } from '../model/tools/types'
import {
  cancelStreamSession,
  errorStreamSession,
  finishStreamSession,
  receiveStreamToken,
  startStreamSession,
  streamIsStreaming,
  streamSession,
} from '../model/state/streams'
import type { ToolRunCall, ToolRunContext } from './tools'

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
  // then the rounds of the reply so far. A media request takes its prompt
  // and input images from them (`mediaRequestInput`).
  messages: StreamMessage[]
  // Offer the Dez tools (RequestMessages.sendTools).
  sendTools: boolean
  // The model's known outputs hold `image`: its chat requests ask for
  // image output (ChatRequestContext.imageOutput).
  imageOutput: boolean
  // What the model takes as the input of a media request (its
  // ModelInfo.text and ModelInfo.images): a model with lyrics gets them
  // from the message, and a video model gets the message's images as
  // frames (`mediaRequestInput`). It is the submit's read of the model, so
  // the request sends the input that the submit checked.
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
  // The last write of the reply was an image reference (`writeReplyImage`):
  // the answer text that comes next starts a new paragraph
  // (`writeModelText`).
  afterImage: boolean
}

// The reply of each tab, so tabs stream at the same time and a new start or
// a stop ends only its own tab's reply. A reply is current while it is its
// tab's entry; a round's request id changes, so checks compare the reply.
// http_bridge.rs keeps the global map of request ids that does the native
// cancel.
const repliesByTab = new Map<string, ReplyRuntime>()

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

// The error shows only in this toast, never as thread text. Sticky (no
// duration): the user closes it. For a tab in the background the title names
// the tab, else the user cannot tell where the error came from. Call it after
// the stream end, which sets the title of a new tab.
function showReplyError(tabId: string, title: string, message: string): void {
  const tab = sbp('dez.model/tab', tabId) as Tab | null
  const inBackground = !!tab && tab.id !== sbp('dez.model/tabs/activeId')
  sbp('dez.ui/toast', 'app-global', {
    variant: 'error',
    title: inBackground ? `${title} in "${tab.title}"` : title,
    message,
  })
}

// The tab's stream session still writes into `sectionId`.
function streamWritesSection(tabId: string, sectionId: string): boolean {
  const session = streamSession(tabId)
  return !!session && session.sectionId === sectionId && session.status === 'streaming'
}

function streamingSection(tabId: string, sectionId: string): Section | null {
  const tab = sbp('dez.model/tab', tabId) as Tab | null
  return tab?.sections.find((section) => section.id === sectionId) ?? null
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
  receiveStreamToken(tabId, token)
}

// Writes escaped answer text of the model. Right after an image reference
// of the reply, the text starts a new paragraph: one blank line takes the
// place of the line breaks that the text starts with, and a text of only
// line breaks is dropped, so a reply never ends with an empty paragraph.
// True when it wrote text.
function writeModelText(tabId: string, reply: ReplyRuntime, text: string): boolean {
  let written = text
  if (reply.afterImage) {
    const rest = text.replace(/^\n+/, '')
    written = rest === '' ? '' : `\n\n${rest}`
  }
  if (written === '' || !streamWritesSection(tabId, reply.sectionId)) return false
  reply.afterImage = false
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
// section watcher finds both copies equal. Thinking is not answer text, so
// it does not count in the session's token count. The store changes for a
// tab in the background too; its editor reads the store when it is shown.
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

// Ends the tool run of a reply that the user stopped, or whose output a
// submit ended (`dez.stream/endOutput`): aborts the running tool, and
// writes the final blocks at once, while the stream session still writes
// the section. Calls that ended keep their results; the others get
// "Stopped.". The round loop finds the run gone and writes nothing more.
// True when it wrote the blocks.
function stopToolRun(tabId: string, reply: ReplyRuntime): boolean {
  const run = reply.toolRun
  if (!run) return false
  reply.toolRun = null
  run.abort.abort()
  if (!streamWritesSection(tabId, reply.sectionId)) return false
  const blocks = run.calls.map((call, index) => toolCallBlock(call, run.results[index] ?? STOPPED_TOOL_RESULT))
  return replaceToolRun(tabId, reply.sectionId, run, toolGroupText(blocks))
}

// Runs the calls of one round, in order: appends their running blocks (a
// refused call gets its error block at once), runs each call, then replaces
// the running blocks with the final ones. Nothing else of the reply writes
// the section meanwhile, but a tool can put an image after the blocks
// (`ToolRunContext.writeImage`). Returns the section after the round, or
// null when the run did not end here: the user stopped the reply, or a
// submit ended its output (stopToolRun wrote the blocks), or the user
// deleted the running blocks.
//
// The reference of a tool's image goes after the group, so it is the start
// of the text of the next round, and has the name of its tool
// (`IMAGE_TOOL_KEY`). The round that made the call keeps its text, and both
// rounds keep their thinking: a request sends no thinking for a round whose
// text holds an image of the model (`roundThinking`, streams/messages.ts),
// and the request after a round of calls needs that round's thinking.
async function runToolRound(tabId: string, reply: ReplyRuntime, calls: CheckedToolCall[], sectionText: string): Promise<Section | null> {
  const runningBlocks = calls.map((call) => toolCallBlock(call))
  const run: ToolRun = {
    calls,
    results: [],
    runningText: toolGroupText(runningBlocks),
    abort: new AbortController(),
  }
  writeStreamText(tabId, reply.sectionId, toolGroupAppendText(sectionText, runningBlocks))
  // The next round's text comes after the blocks, not after an image.
  reply.afterImage = false
  reply.toolRun = run

  for (const [index, call] of calls.entries()) {
    if (call.refusal !== undefined) continue
    const toolCall: ToolRunCall = { name: call.name, arguments: call.arguments }
    const context: ToolRunContext = {
      tabId,
      // Not after a stop (`stopToolRun`), as for an image of the model.
      writeImage: (path) => (reply.toolRun === run ? writeImageReference(tabId, reply, path, [{ key: IMAGE_TOOL_KEY, value: call.name }]) : null),
    }
    const result = await sbp('dez.controller/tools/run', toolCall, run.abort.signal, context) as ToolRunResult
    if (reply.toolRun !== run) return null
    run.results[index] = result
  }

  reply.toolRun = null
  const blocks = calls.map((call, index) => toolCallBlock(call, run.results[index]))
  if (!replaceToolRun(tabId, reply.sectionId, run, toolGroupText(blocks))) return null
  return streamingSection(tabId, reply.sectionId)
}

// The reply is still its tab's reply, and no stop or submit ended it.
function replyIsCurrent(tabId: string, reply: ReplyRuntime): boolean {
  return repliesByTab.get(tabId) === reply && !reply.cancelling
}

// The line breaks that put a reference of the reply (an image, a clip) in
// a paragraph of its own after `sectionText`. A clip's tag needs it: a tag
// counts only as a whole line (mediaTags.ts).
function paragraphGap(sectionText: string): string {
  return sectionText === '' || sectionText.endsWith('\n\n') ? '' : sectionText.endsWith('\n') ? '\n' : '\n\n'
}

// Deletes the temp copies of clips that no tag will name. A failure is only
// logged: the cleanup of the temp copies (controller/media.ts) deletes a
// copy that stays.
async function deleteTempCopies(clips: readonly GeneratedClip[]): Promise<void> {
  if (clips.length === 0) return
  try {
    const cacheDir = await sbp('dez.native/getAppDir', 'cache') as string
    for (const clip of clips) {
      const file = tempMediaFile(clip.src, cacheDir)
      if (file !== null) await sbp('dez.native/deleteAppFile', file, 'cache')
    }
  } catch (error) {
    console.error('Failed to delete the temp copy of a clip:', error)
  }
}

// Writes the reference of a stored image at the end of the reply's section,
// as a paragraph of its own, with a new image id; `metadata` goes after the
// id. Returns the id, or null when the section takes no text: the user
// merged it into the one before, or the stream ended. The id and the write
// are in one tick, so that no paste takes the id (the editor gives ids only
// to pasted and dropped references). The model text that comes next starts
// a new paragraph (`writeModelText`).
function writeImageReference(tabId: string, reply: ReplyRuntime, path: string, metadata: readonly ImageMetadataItem[] = []): string | null {
  const sections = (sbp('dez.model/tab', tabId) as Tab | null)?.sections ?? []
  const texts = sections.map(sectionPlainText)
  const sectionText = texts[sections.findIndex((section) => section.id === reply.sectionId)]
  if (sectionText === undefined || !streamWritesSection(tabId, reply.sectionId)) return null
  const [id] = newMediaIds(texts, 1)
  receiveToken(tabId, reply.sectionId, paragraphGap(sectionText) + imageMarkdown(path, [{ key: 'id', value: id }, ...metadata]))
  reply.afterImage = true
  return id
}

// Puts an image of a chat reply at the end of its section: saves the file
// in the generated image folder, then writes its reference. No answer text
// comes meanwhile: dez.provider/streamChat waits for this. A failed save
// leaves the image out, and the reply goes on.
async function writeReplyImage(tabId: string, reply: ReplyRuntime, image: GeneratedMedia): Promise<void> {
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
  if (!current || writeImageReference(tabId, reply, path) === null) {
    await sbp('dez.controller/images/delete', path).catch(() => {})
  }
}

// The chat rounds of a reply: request rounds until a round ends with no
// tool calls. Each round streams its answer text and thinking into the
// agent section; a round that ends with tool calls adds their blocks, runs
// them, and sends the next round with the reply so far. Ends the reply,
// except when it throws.
async function runChatRounds(args: StreamStartArgs, reply: ReplyRuntime): Promise<void> {
  // Read the provider's stored setting overrides at stream start (rather
  // than threading them from submitTab) so every caller — including future
  // retries — picks up the user's current settings consistently.
  const providerSettings = (sbp('dez.model/settings/snapshot') as SettingsSnapshot)
    .providerSettings[args.model.providerId]
  // The prompt lists exactly the tools that the request offers.
  const tools = args.sendTools ? TOOL_DEFINITIONS : []
  // A template error or a deleted provider throws, which ends the stream
  // session. Built once per reply, so a provider rename during the reply
  // does not change the prompt of its later rounds.
  const system = buildSystemPrompt(args.model, requireProvider(args.model.providerId).name, tools)
  let messages = args.messages
  // The first call id of the group that ended the round before: it names
  // the thinking round of every later round (SectionThinking.rounds).
  let afterToolCall: string | undefined

  for (let toolRounds = 0; ; toolRounds++) {
    const requestId = crypto.randomUUID()
    reply.requestId = requestId
    const roundIsCurrent = () => repliesByTab.get(args.tabId) === reply && reply.requestId === requestId && !reply.outputEnded
    const roundAfterToolCall = afterToolCall
    // The round's reply held an image, saved or not.
    let madeImage = false
    const result = await sbp('dez.provider/streamChat', {
      providerId: args.model.providerId,
      conversationId: args.conversationId,
      system,
      tools,
      imageOutput: args.imageOutput,
      modelId: args.model.modelId,
      messages,
      requestId,
      providerSettings,
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
        if (replyIsCurrent(args.tabId, reply)) await writeReplyImage(args.tabId, reply, image)
      },
    }) as ProviderStreamChatResult
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
    const section = streamingSection(args.tabId, args.sectionId)
    if (streamedCalls.length === 0 || !section) {
      finalizeStream(args.tabId, finishStreamSession(args.tabId))
      return
    }

    const sectionText = sectionPlainText(section)
    const calls = checkToolCalls(streamedCalls, findToolBlocks(sectionText).map((block) => block.id))
    if (toolRounds >= MAX_TOOL_ROUNDS) {
      const blocks = calls.map((call) => toolCallBlock(call, ROUND_LIMIT_TOOL_RESULT))
      writeStreamText(args.tabId, args.sectionId, toolGroupAppendText(sectionText, blocks))
      console.error(`The reply reached the limit of ${MAX_TOOL_ROUNDS} tool rounds`)
      finalizeStream(args.tabId, errorStreamSession(args.tabId))
      showReplyError(args.tabId, 'Tool limit reached', `The reply reached the limit of ${MAX_TOOL_ROUNDS} tool rounds, so Dez did not run its last tool calls.`)
      return
    }

    const replySoFar = await runToolRound(args.tabId, reply, calls, sectionText)
    if (!replySoFar) {
      // Still current only when the user deleted the running blocks:
      // with no calls to send back, the reply cannot go on, so it ends
      // as a stop does.
      if (replyIsCurrent(args.tabId, reply)) finalizeStream(args.tabId, cancelStreamSession(args.tabId))
      return
    }
    afterToolCall = calls[0].id
    // Only up to the results of the newest group. The text after that group
    // (an image that a tool of the round made, or text that the user typed
    // while the tools ran) is the start of the next round's message. A
    // request that ends with an agent message asks the model to go on from
    // that text, and many providers refuse it. Every later request sends
    // that text at the start of the message of the next round, after these
    // same bytes.
    const soFar = agentSectionMessages(replySoFar, args.model, true)
    messages = [...args.messages, ...soFar.slice(0, soFar.findLastIndex((message) => message.role === 'tool') + 1)]
  }
}

// The one media request of a reply to a media model (a ModelInfo.request
// of MEDIA_KINDS), in place of the chat rounds: no system prompt, tools, or
// thinking. The files of an image model are saved in the generated image
// folder, and the section gets a reference to each. A clip (audio, video)
// is not saved: the section gets a media tag (mediaTags.ts) whose source
// is the provider's URL, or a temp copy until
// the user saves the clip. A clip request sets the model's parameters to
// the values that the user chose in the provider settings popup, and sends
// the lyrics that the message holds to a model that takes lyrics; a video
// request sends the images of the message as frames. Images and clips get
// new ids of the one id sequence. Ends the reply, except when it throws.
async function runMediaRound(args: StreamStartArgs, reply: ReplyRuntime, kind: MediaKind): Promise<void> {
  const tab = sbp('dez.model/tab', args.tabId) as Tab | null
  const { prompt, lyrics, images } = mediaRequestInput(kind, args.messages, tab?.sections ?? [], args.inputRules)
  const parameters = (sbp('dez.model/settings/snapshot') as SettingsSnapshot).modelParameters[modelRefKey(args.model)]
  const requestId = crypto.randomUUID()
  reply.requestId = requestId
  const { media, clips } = await sbp('dez.provider/generateMedia', {
    providerId: args.model.providerId,
    modelId: args.model.modelId,
    kind,
    prompt,
    ...(lyrics !== undefined && { lyrics }),
    images,
    ...(parameters && { parameters }),
    requestId,
    signal: reply.abort.signal,
  }) as ProviderGenerateMediaResult
  // A stop or a new submit cancelled the request, which can end its body
  // early: a cut image is never saved. A clip that still came is whole, but
  // the reply takes no tag any more.
  if (!replyIsCurrent(args.tabId, reply)) {
    await deleteTempCopies(clips)
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
  // no reference names are deleted; images/delete logs and shows its own
  // failures.
  const sections = (sbp('dez.model/tab', args.tabId) as Tab | null)?.sections ?? []
  const texts = sections.map(sectionPlainText)
  const sectionText = texts[sections.findIndex((section) => section.id === args.sectionId)]
  if (!saved || !replyIsCurrent(args.tabId, reply) || sectionText === undefined) {
    await Promise.allSettled([...paths.map((path) => sbp('dez.controller/images/delete', path)), deleteTempCopies(clips)])
    if (replyIsCurrent(args.tabId, reply)) finalizeStream(args.tabId, saved ? finishStreamSession(args.tabId) : errorStreamSession(args.tabId))
    return
  }
  // The ids and the write in one tick, so that no paste takes one of the
  // ids (the editor gives ids only to pasted and dropped references).
  const ids = newMediaIds(texts, paths.length + clips.length)
  const references = [
    ...paths.map((path, index) => imageMarkdown(path, [{ key: 'id', value: ids[index] }])),
    // The job id is tag metadata: the provider took the money for the job,
    // and with the id the user can ask it for the clip again.
    ...clips.map((clip, index) => mediaTagText({
      kind: clip.kind,
      id: ids[paths.length + index],
      type: clip.mediaType,
      src: clip.src,
      url: clip.url,
      expires: clip.expires,
      other: clip.jobId === null ? [] : [{ name: 'job', value: clip.jobId }],
    })),
  ]
  // The user can type in the section while a clip is made.
  receiveToken(args.tabId, args.sectionId, paragraphGap(sectionText) + references.join('\n\n'))
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
      // `args.messages`; the new reply ends its request.
      previousReply.cancelling = true
      previousReply.abort.abort()
      await sbp('dez.http/cancelStream', previousReply.requestId).catch(() => {})
      if (repliesByTab.get(args.tabId) === previousReply) repliesByTab.delete(args.tabId)
    }

    const reply: ReplyRuntime = {
      sectionId: args.sectionId,
      requestId: '',
      abort: new AbortController(),
      cancelling: false,
      outputEnded: false,
      toolRun: null,
      escaper: new ModelTextEscaper(),
      afterImage: false,
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
        finalizeStream(args.tabId, errorStreamSession(args.tabId))
        // The toast refuses an empty message.
        showReplyError(args.tabId, 'Request failed', (error instanceof Error ? error.message : String(error)) || 'Unknown error')
      }
    } finally {
      if (repliesByTab.get(args.tabId) === reply) repliesByTab.delete(args.tabId)
    }
  },

  // A submit during a reply in the tab calls this after it builds its
  // request messages (so a submit with no messages leaves the reply alone)
  // and before it adds the new agent section; the new start then cancels
  // the reply's request. A running tool stops with its final blocks, and
  // the answer text that the escaper holds is written. These writes must
  // come before the new section is in the store: the editor gets it only in
  // Vue's next watcher flush, and a doc change before then writes the
  // editor's sections back to the store, with no new section. Output of the
  // request after this is dropped. True when it wrote text: the caller must
  // then build its messages again.
  'dez.stream/endOutput' (tabId: string): boolean {
    const reply = repliesByTab.get(tabId)
    if (!reply) return false
    reply.cancelling = true
    reply.outputEnded = true
    const wroteBlocks = stopToolRun(tabId, reply)
    const wroteText = flushModelText(tabId, reply)
    return wroteBlocks || wroteText
  },

  async 'dez.stream/stop' (tabId: string): Promise<void> {
    if (!streamIsStreaming(tabId)) return
    const reply = repliesByTab.get(tabId)
    if (reply) {
      reply.cancelling = true
      reply.abort.abort()
      stopToolRun(tabId, reply)
    }

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
})
