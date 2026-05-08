import sbp from '@sbp/sbp'
import { useStreamStore } from '../stores/streamStore'
import { useTabStore } from '../stores/tabStore'
import type { ActiveModel } from '../types/chat'
import type { StreamMessage, StreamSessionState, StreamStartInput, StreamStatus } from '../core/stream/types'

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

function cloneStreamSession(session: StreamSessionState): StreamSessionState {
  return {
    ...session,
    model: { ...session.model },
  }
}

function cloneStreamSessions(sessions: StreamSessionState[]): StreamSessionState[] {
  return sessions.map(cloneStreamSession)
}

function finishStream(tabId: string, error: string | null): StreamSessionState | null {
  const streamStore = useStreamStore()
  const session = streamStore.session(tabId)
  const result = error ? streamStore.error(tabId, error) : streamStore.finish(tabId)
  if (session) {
    useTabStore().finalizeStreamSectionForTab(tabId, session.sectionId, error)
    sbp('dez.editor/reconcileAfterStreamFinish', tabId)
    useTabStore().saveTab(tabId).catch(() => {})
    useTabStore().saveAppState()
  }
  return result
}

export default sbp('sbp/selectors/register', {
  'dez.stream/status' (tabId: string): StreamStatus {
    return useStreamStore().status(tabId)
  },

  'dez.stream/isStreaming' (tabId: string): boolean {
    return useStreamStore().isStreaming(tabId)
  },

  'dez.stream/session' (tabId: string): StreamSessionState | null {
    const session = useStreamStore().session(tabId)
    return session ? cloneStreamSession(session) : null
  },

  'dez.stream/activeTabStatus' (): StreamStatus {
    const tabStore = useTabStore()
    return useStreamStore().status(tabStore.activeTabId)
  },

  'dez.stream/activeSessions' (): StreamSessionState[] {
    return cloneStreamSessions(useStreamStore().activeSessions)
  },

  'dez.stream/startSession' (input: StreamStartInput): StreamSessionState {
    return cloneStreamSession(useStreamStore().startSession(input))
  },

  'dez.stream/receiveToken' (tabId: string, sectionId: string, token: string): StreamSessionState | null {
    const streamStore = useStreamStore()
    const session = streamStore.session(tabId)
    if (!session || session.sectionId !== sectionId || session.status !== 'streaming') return session ? cloneStreamSession(session) : null
    useTabStore().appendTokenToTabSection(tabId, sectionId, token)
    sbp('dez.editor/appendTokenIfVisible', tabId, sectionId, token)
    const nextSession = streamStore.receiveToken(tabId, token)
    return nextSession ? cloneStreamSession(nextSession) : null
  },

  'dez.stream/finish' (tabId: string): StreamSessionState | null {
    const session = finishStream(tabId, null)
    return session ? cloneStreamSession(session) : null
  },

  'dez.stream/error' (tabId: string, message: string): StreamSessionState | null {
    const session = finishStream(tabId, message)
    return session ? cloneStreamSession(session) : null
  },

  'dez.stream/cancelled' (tabId: string): StreamSessionState | null {
    const streamStore = useStreamStore()
    const session = streamStore.session(tabId)
    const result = streamStore.cancelled(tabId)
    if (session) {
      useTabStore().finalizeStreamSectionForTab(tabId, session.sectionId, null)
      sbp('dez.editor/reconcileAfterStreamFinish', tabId)
      useTabStore().saveTab(tabId).catch(() => {})
      useTabStore().saveAppState()
    }
    return result ? cloneStreamSession(result) : null
  },

  'dez.stream/removeSession' (tabId: string): void {
    useStreamStore().removeSession(tabId)
  },

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

    sbp('dez.stream/startSession', {
      tabId: args.tabId,
      sectionId: args.sectionId,
      model: args.model,
      messages: args.messages,
    })
    sbp('dez.editor/startStreamingFollowIfVisible', args.tabId)

    try {
      await sbp('dez.provider/streamChat', {
        providerId: args.model.providerId,
        modelId: args.model.modelId,
        messages: args.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        requestId,
        onToken: (token: string) => {
          if (nativeStreamsByTab.get(args.tabId)?.requestId !== requestId) return
          sbp('dez.stream/receiveToken', args.tabId, args.sectionId, token)
        },
      })

      const currentStream = nativeStreamsByTab.get(args.tabId)
      if (currentStream?.requestId === requestId && !currentStream.cancelling) {
        sbp('dez.stream/finish', args.tabId)
      }
    } catch (error) {
      const currentStream = nativeStreamsByTab.get(args.tabId)
      if (currentStream?.requestId === requestId && !currentStream.cancelling) {
        sbp('dez.stream/error', args.tabId, error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (nativeStreamsByTab.get(args.tabId)?.requestId === requestId) {
        nativeStreamsByTab.delete(args.tabId)
      }
    }
  },

  async 'dez.stream/stop' (tabId: string): Promise<void> {
    if (!useStreamStore().isStreaming(tabId)) return
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
      sbp('dez.stream/cancelled', tabId)
    }
  },
})
