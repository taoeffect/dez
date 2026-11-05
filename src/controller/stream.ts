import sbp from '@sbp/sbp'
import type { ActiveModel, SectionThinking } from '../model/chat/types'
import type { ProviderStreamChatResult } from '../model/providers'
import type { StreamMessage, StreamSessionState } from '../model/streams/types'
import {
  appendThinkingToTabSection,
  appendTokenToTabSection,
  finalizeStreamSectionForTab,
  setThinkingReplayForTabSection,
  type SettingsSnapshot,
} from '../model/state'
import {
  cancelStreamSession,
  errorStreamSession,
  finishStreamSession,
  receiveStreamToken,
  startStreamSession,
  streamIsStreaming,
  streamSession,
} from '../model/state/streams'

interface StreamStartArgs {
  tabId: string
  sectionId: string
  model: ActiveModel
  messages: StreamMessage[]
}

interface NativeStreamRuntime {
  requestId: string
  cancelling: boolean
}

const nativeStreamsByTab = new Map<string, NativeStreamRuntime>()

function finalizeStream(tabId: string, session: StreamSessionState | null, error: string | null): void {
  if (!session) return
  finalizeStreamSectionForTab(tabId, session.sectionId, error)
  sbp('dez.editor/reconcileAfterStreamFinish', tabId)
  sbp('dez.model/tabs/save', tabId).catch(() => {})
  sbp('dez.model/appState/save')
}

// The tab's stream session still writes into `sectionId`.
function streamWritesSection(tabId: string, sectionId: string): boolean {
  const session = streamSession(tabId)
  return !!session && session.sectionId === sectionId && session.status === 'streaming'
}

function receiveToken(tabId: string, sectionId: string, token: string): void {
  if (!streamWritesSection(tabId, sectionId)) return
  appendTokenToTabSection(tabId, sectionId, token)
  sbp('dez.editor/appendTokenIfVisible', tabId, sectionId, token)
  receiveStreamToken(tabId, token)
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

function finishStream(tabId: string): StreamSessionState | null {
  const session = streamSession(tabId)
  const result = finishStreamSession(tabId)
  finalizeStream(tabId, session, null)
  return result
}

function errorStream(tabId: string, message: string): StreamSessionState | null {
  const session = streamSession(tabId)
  const result = errorStreamSession(tabId, message)
  finalizeStream(tabId, session, message)
  return result
}

function cancelStream(tabId: string): StreamSessionState | null {
  const session = streamSession(tabId)
  const result = cancelStreamSession(tabId)
  finalizeStream(tabId, session, null)
  return result
}

export default sbp('sbp/selectors/register', {
  async 'dez.stream/start' (args: StreamStartArgs): Promise<void> {
    const previousStream = nativeStreamsByTab.get(args.tabId)
    if (previousStream) {
      previousStream.cancelling = true
      await sbp('dez.http/cancelStream', previousStream.requestId).catch(() => {})
      if (nativeStreamsByTab.get(args.tabId)?.requestId === previousStream.requestId) {
        nativeStreamsByTab.delete(args.tabId)
      }
    }

    const requestId = crypto.randomUUID()
    nativeStreamsByTab.set(args.tabId, { requestId, cancelling: false })
    const isCurrentRequest = () => nativeStreamsByTab.get(args.tabId)?.requestId === requestId

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

    try {
      const result = await sbp('dez.provider/streamChat', {
        providerId: args.model.providerId,
        modelId: args.model.modelId,
        messages: args.messages.map((message) => ({
          role: message.role,
          content: message.content,
          ...(message.thinking && { thinking: message.thinking }),
        })),
        requestId,
        providerSettings,
        onToken: (token: string) => {
          if (!isCurrentRequest()) return
          receiveToken(args.tabId, args.sectionId, token)
        },
        onThinking: (token: string) => {
          if (!isCurrentRequest()) return
          updateStreamThinking(args.tabId, args.sectionId, () => appendThinkingToTabSection(args.tabId, args.sectionId, token))
        },
      }) as ProviderStreamChatResult

      const currentStream = nativeStreamsByTab.get(args.tabId)
      if (currentStream?.requestId === requestId && !currentStream.cancelling) {
        // Before the finish, which saves the conversation.
        const replay = result.thinkingReplay
        if (replay) {
          updateStreamThinking(args.tabId, args.sectionId, () => setThinkingReplayForTabSection(args.tabId, args.sectionId, replay))
        }
        finishStream(args.tabId)
      }
    } catch (error) {
      const currentStream = nativeStreamsByTab.get(args.tabId)
      if (currentStream?.requestId === requestId && !currentStream.cancelling) {
        errorStream(args.tabId, error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (isCurrentRequest()) {
        nativeStreamsByTab.delete(args.tabId)
      }
    }
  },

  async 'dez.stream/stop' (tabId: string): Promise<void> {
    if (!streamIsStreaming(tabId)) return
    const currentStream = nativeStreamsByTab.get(tabId)
    if (currentStream) {
      currentStream.cancelling = true
    }

    try {
      if (currentStream) {
        await sbp('dez.http/cancelStream', currentStream.requestId)
      }
    } finally {
      if (nativeStreamsByTab.get(tabId)?.requestId === currentStream?.requestId) {
        nativeStreamsByTab.delete(tabId)
      }
      cancelStream(tabId)
    }
  },
})
