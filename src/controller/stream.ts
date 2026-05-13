import sbp from '@sbp/sbp'
import type { ActiveModel } from '../model/chat/types'
import type { StreamMessage, StreamSessionState } from '../model/streams/types'
import {
  appendTokenToTabSection,
  finalizeStreamSectionForTab,
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

function receiveToken(tabId: string, sectionId: string, token: string): StreamSessionState | null {
  const session = streamSession(tabId)
  if (!session || session.sectionId !== sectionId || session.status !== 'streaming') return session
  appendTokenToTabSection(tabId, sectionId, token)
  sbp('dez.editor/appendTokenIfVisible', tabId, sectionId, token)
  return receiveStreamToken(tabId, token)
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

    startStreamSession({
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
          receiveToken(args.tabId, args.sectionId, token)
        },
      })

      const currentStream = nativeStreamsByTab.get(args.tabId)
      if (currentStream?.requestId === requestId && !currentStream.cancelling) {
        finishStream(args.tabId)
      }
    } catch (error) {
      const currentStream = nativeStreamsByTab.get(args.tabId)
      if (currentStream?.requestId === requestId && !currentStream.cancelling) {
        errorStream(args.tabId, error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (nativeStreamsByTab.get(args.tabId)?.requestId === requestId) {
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
