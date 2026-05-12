import sbp from '@sbp/sbp'
import type { ActiveModel } from '../model/chat/types'
import type { StreamMessage, StreamSessionState } from '../model/streams/types'

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
  sbp('dez.model/finalizeStreamSectionForTab', tabId, session.sectionId, error)
  sbp('dez.editor/reconcileAfterStreamFinish', tabId)
  sbp('dez.model/tabs/save', tabId).catch(() => {})
  sbp('dez.model/appState/save')
}

export default sbp('sbp/selectors/register', {
  'dez.stream/receiveToken' (tabId: string, sectionId: string, token: string): StreamSessionState | null {
    const session = sbp('dez.model/streams/session', tabId) as StreamSessionState | null
    if (!session || session.sectionId !== sectionId || session.status !== 'streaming') return session
    sbp('dez.model/appendTokenToTabSection', tabId, sectionId, token)
    sbp('dez.editor/appendTokenIfVisible', tabId, sectionId, token)
    return sbp('dez.model/streams/receiveToken', tabId, token) as StreamSessionState | null
  },

  'dez.stream/finish' (tabId: string): StreamSessionState | null {
    const session = sbp('dez.model/streams/session', tabId) as StreamSessionState | null
    const result = sbp('dez.model/streams/finish', tabId) as StreamSessionState | null
    finalizeStream(tabId, session, null)
    return result
  },

  'dez.stream/error' (tabId: string, message: string): StreamSessionState | null {
    const session = sbp('dez.model/streams/session', tabId) as StreamSessionState | null
    const result = sbp('dez.model/streams/error', tabId, message) as StreamSessionState | null
    finalizeStream(tabId, session, message)
    return result
  },

  'dez.stream/cancelled' (tabId: string): StreamSessionState | null {
    const session = sbp('dez.model/streams/session', tabId) as StreamSessionState | null
    const result = sbp('dez.model/streams/cancelled', tabId) as StreamSessionState | null
    finalizeStream(tabId, session, null)
    return result
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

    sbp('dez.model/streams/startSession', {
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
    if (!sbp('dez.model/streams/isStreaming', tabId)) return
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
