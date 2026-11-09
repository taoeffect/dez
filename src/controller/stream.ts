import sbp from '@sbp/sbp'
import type { ActiveModel, Section, SectionThinking, Tab } from '../model/chat/types'
import { sectionPlainText } from '../model/chat/content'
import { findToolBlocks, ModelTextEscaper } from '../model/chat/toolBlocks'
import type { ProviderStreamChatResult } from '../model/providers'
import { agentSectionMessages } from '../model/streams/messages'
import {
  checkToolCalls,
  MAX_TOOL_ROUNDS,
  ROUND_LIMIT_TOOL_RESULT,
  STOPPED_TOOL_RESULT,
  toolCallBlock,
  toolGroupStart,
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
import type { ToolRunCall } from './tools'

interface StreamStartArgs {
  tabId: string
  conversationId: string
  sectionId: string
  model: ActiveModel
  // The request messages of the sections before `sectionId`, built by
  // `dez.model/streamMessagesForTab` at the submit: each round sends them,
  // then the rounds of the reply so far.
  messages: StreamMessage[]
  // Offer the Dez tools (RequestMessages.sendTools).
  sendTools: boolean
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
  cancelling: boolean
  toolRun: ToolRun | null
  // Model text never forms a block (toolBlocks.ts). A tag can be split
  // across tokens, so the escaper holds such an end back until the next
  // token, the round end, or the reply end.
  escaper: ModelTextEscaper
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

// Writes the answer text that the reply's escaper still holds back. Call it
// at a round end and before the reply ends, while the stream session still
// writes the section. True when it wrote text.
function flushModelText(tabId: string, reply: ReplyRuntime): boolean {
  const held = reply.escaper.flush()
  if (!held || !streamWritesSection(tabId, reply.sectionId)) return false
  receiveToken(tabId, reply.sectionId, held)
  return true
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
// the section meanwhile. Returns the section after the round, or null when
// the run did not end here: the user stopped the reply, or a submit ended
// its output (stopToolRun wrote the blocks), or the user deleted the
// running blocks.
async function runToolRound(tabId: string, reply: ReplyRuntime, calls: CheckedToolCall[], sectionText: string): Promise<Section | null> {
  const run: ToolRun = {
    calls,
    results: [],
    runningText: toolGroupText(calls.map((call) => toolCallBlock(call))),
    abort: new AbortController(),
  }
  writeStreamText(tabId, reply.sectionId, toolGroupStart(sectionText) + run.runningText)
  reply.toolRun = run

  for (const [index, call] of calls.entries()) {
    if (call.refusal !== undefined) continue
    const toolCall: ToolRunCall = { name: call.name, arguments: call.arguments }
    const result = await sbp('dez.controller/tools/run', toolCall, run.abort.signal) as ToolRunResult
    if (reply.toolRun !== run) return null
    run.results[index] = result
  }

  reply.toolRun = null
  const blocks = calls.map((call, index) => toolCallBlock(call, run.results[index]))
  if (!replaceToolRun(tabId, reply.sectionId, run, toolGroupText(blocks))) return null
  return streamingSection(tabId, reply.sectionId)
}

export default sbp('sbp/selectors/register', {
  // One reply: request rounds until a round ends with no tool calls. Each
  // round streams its answer text and thinking into the agent section; a
  // round that ends with tool calls adds their blocks, runs them, and sends
  // the next round with the reply so far. The stream session, the busy
  // state, the start time, and the scroll follow span the whole reply, and
  // only the reply's end finalizes it (duration, alerts, trailing user
  // section, save).
  async 'dez.stream/start' (args: StreamStartArgs): Promise<void> {
    const previousReply = repliesByTab.get(args.tabId)
    if (previousReply) {
      // The submit ended its output (`dez.stream/endOutput`) before it built
      // `args.messages`; the new reply ends its request.
      previousReply.cancelling = true
      await sbp('dez.http/cancelStream', previousReply.requestId).catch(() => {})
      if (repliesByTab.get(args.tabId) === previousReply) repliesByTab.delete(args.tabId)
    }

    const reply: ReplyRuntime = { sectionId: args.sectionId, requestId: '', cancelling: false, toolRun: null, escaper: new ModelTextEscaper() }
    repliesByTab.set(args.tabId, reply)
    const replyIsCurrent = () => repliesByTab.get(args.tabId) === reply && !reply.cancelling

    startStreamSession({
      tabId: args.tabId,
      sectionId: args.sectionId,
      model: args.model,
      messages: args.messages,
    })
    sbp('dez.editor/startStreamingFollowIfVisible', args.tabId)

    // Read the provider's stored setting overrides at stream start (rather
    // than threading them from submitTab) so every caller — including future
    // retries — picks up the user's current settings consistently.
    const providerSettings = (sbp('dez.model/settings/snapshot') as SettingsSnapshot)
      .providerSettings[args.model.providerId]
    // The prompt lists exactly the tools that the request offers.
    const tools = args.sendTools ? TOOL_DEFINITIONS : []

    try {
      // Inside the try: a template error must end the stream session.
      const system = buildSystemPrompt(args.model, tools)
      let messages = args.messages
      // The first call id of the group that ended the round before: it names
      // the thinking round of every later round (SectionThinking.rounds).
      let afterToolCall: string | undefined

      for (let toolRounds = 0; ; toolRounds++) {
        const requestId = crypto.randomUUID()
        reply.requestId = requestId
        const roundIsCurrent = () => repliesByTab.get(args.tabId) === reply && reply.requestId === requestId
        const roundAfterToolCall = afterToolCall
        const result = await sbp('dez.provider/streamChat', {
          providerId: args.model.providerId,
          conversationId: args.conversationId,
          system,
          tools,
          modelId: args.model.modelId,
          messages,
          requestId,
          providerSettings,
          onToken: (token: string) => {
            if (!roundIsCurrent()) return
            const text = reply.escaper.push(token)
            if (text) receiveToken(args.tabId, args.sectionId, text)
          },
          onThinking: (token: string) => {
            if (!roundIsCurrent()) return
            updateStreamThinking(args.tabId, args.sectionId, () => appendThinkingToTabSection(args.tabId, args.sectionId, token, roundAfterToolCall))
          },
        }) as ProviderStreamChatResult
        if (!replyIsCurrent()) return

        // Before the blocks and the finish, which saves the conversation.
        flushModelText(args.tabId, reply)
        const replay = result.thinkingReplay
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
          writeStreamText(args.tabId, args.sectionId, toolGroupStart(sectionText) + toolGroupText(blocks))
          console.error(`The reply reached the limit of ${MAX_TOOL_ROUNDS} tool rounds`)
          finalizeStream(args.tabId, errorStreamSession(args.tabId))
          showReplyError(args.tabId, 'Tool limit reached', `The reply reached the limit of ${MAX_TOOL_ROUNDS} tool rounds, so Dez did not run its last tool calls.`)
          return
        }

        const roundsSoFar = await runToolRound(args.tabId, reply, calls, sectionText)
        if (!roundsSoFar) {
          // Still current only when the user deleted the running blocks:
          // with no calls to send back, the reply cannot go on, so it ends
          // as a stop does.
          if (replyIsCurrent()) finalizeStream(args.tabId, cancelStreamSession(args.tabId))
          return
        }
        afterToolCall = calls[0].id
        messages = [...args.messages, ...agentSectionMessages(roundsSoFar, args.model, true)]
      }
    } catch (error) {
      if (replyIsCurrent()) {
        console.error('Chat request failed:', error)
        flushModelText(args.tabId, reply)
        finalizeStream(args.tabId, errorStreamSession(args.tabId))
        // The toast refuses an empty message.
        showReplyError(args.tabId, 'Request failed', (error instanceof Error ? error.message : String(error)) || 'Unknown error')
      }
    } finally {
      if (repliesByTab.get(args.tabId) === reply) repliesByTab.delete(args.tabId)
    }
  },

  // A submit during a reply in the tab calls this before it builds its
  // request messages and adds the new agent section; the new start then
  // cancels the reply's request. A running tool stops with its final blocks,
  // and the answer text that the escaper holds is written. These writes
  // must come before the new section is in the store: the editor gets it
  // only in Vue's next watcher flush, and a doc change before then writes
  // the editor's sections back to the store, with no new section. True
  // when it wrote text, which the messages must then hold.
  'dez.stream/endOutput' (tabId: string): boolean {
    const reply = repliesByTab.get(tabId)
    if (!reply) return false
    reply.cancelling = true
    const wroteBlocks = stopToolRun(tabId, reply)
    const wroteText = flushModelText(tabId, reply)
    return wroteBlocks || wroteText
  },

  async 'dez.stream/stop' (tabId: string): Promise<void> {
    if (!streamIsStreaming(tabId)) return
    const reply = repliesByTab.get(tabId)
    if (reply) {
      reply.cancelling = true
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
