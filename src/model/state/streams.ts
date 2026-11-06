import sbp from '@sbp/sbp'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useTabStore } from './tabs'
import type { EndedStreamSession, StreamSessionState, StreamStartInput, StreamStatus, StreamTerminalInput } from '../streams/types'

function cloneStreamSession<Session extends StreamSessionState>(session: Session): Session {
  return {
    ...session,
    model: { ...session.model },
  }
}

function cloneNullableStreamSession<Session extends StreamSessionState>(session: Session | null): Session | null {
  return session ? cloneStreamSession(session) : null
}

export const useStreamStore = defineStore('streams', () => {
  const sessionsByTab = ref<Record<string, StreamSessionState>>({})

  const activeSessions = computed(() => {
    return Object.values(sessionsByTab.value).filter((session) => session.status === 'streaming')
  })

  const isActiveTabStreaming = computed(() => {
    const tabStore = useTabStore()
    return isStreaming(tabStore.activeTabId)
  })

  function session(tabId: string): StreamSessionState | null {
    return sessionsByTab.value[tabId] ?? null
  }

  function status(tabId: string): StreamStatus {
    return session(tabId)?.status ?? 'idle'
  }

  function isStreaming(tabId: string): boolean {
    return status(tabId) === 'streaming'
  }

  function startSession(input: StreamStartInput): StreamSessionState {
    const now = Date.now()
    const nextSession: StreamSessionState = {
      tabId: input.tabId,
      sectionId: input.sectionId,
      status: 'streaming',
      model: input.model,
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      tokenCount: 0,
    }
    sessionsByTab.value[input.tabId] = nextSession
    return nextSession
  }

  function receiveToken(tabId: string, token: string): StreamSessionState | null {
    const currentSession = session(tabId)
    if (!currentSession || currentSession.status !== 'streaming') return currentSession
    currentSession.tokenCount += token.length
    currentSession.updatedAt = Date.now()
    return currentSession
  }

  function setTerminal(input: StreamTerminalInput): EndedStreamSession | null {
    const currentSession = session(input.tabId)
    if (!currentSession) return null
    const now = Date.now()
    return Object.assign(currentSession, { status: input.status, updatedAt: now, finishedAt: now })
  }

  function finish(tabId: string): EndedStreamSession | null {
    return setTerminal({ tabId, status: 'finished' })
  }

  function error(tabId: string): EndedStreamSession | null {
    return setTerminal({ tabId, status: 'error' })
  }

  function cancelled(tabId: string): EndedStreamSession | null {
    return setTerminal({ tabId, status: 'cancelled' })
  }

  function removeSession(tabId: string): void {
    delete sessionsByTab.value[tabId]
  }

  return {
    sessionsByTab,
    activeSessions,
    isActiveTabStreaming,
    session,
    status,
    isStreaming,
    startSession,
    receiveToken,
    finish,
    error,
    cancelled,
    removeSession,
  }
})

export function streamIsStreaming(tabId: string): boolean {
  return useStreamStore().isStreaming(tabId)
}

export function streamSession(tabId: string): StreamSessionState | null {
  return cloneNullableStreamSession(useStreamStore().session(tabId))
}

export function startStreamSession(input: StreamStartInput): StreamSessionState {
  return cloneStreamSession(useStreamStore().startSession({
    ...input,
    model: { ...input.model },
  }))
}

export function receiveStreamToken(tabId: string, token: string): StreamSessionState | null {
  return cloneNullableStreamSession(useStreamStore().receiveToken(tabId, token))
}

export function finishStreamSession(tabId: string): EndedStreamSession | null {
  return cloneNullableStreamSession(useStreamStore().finish(tabId))
}

export function errorStreamSession(tabId: string): EndedStreamSession | null {
  return cloneNullableStreamSession(useStreamStore().error(tabId))
}

export function cancelStreamSession(tabId: string): EndedStreamSession | null {
  return cloneNullableStreamSession(useStreamStore().cancelled(tabId))
}

export default sbp('sbp/selectors/register', {
  'dez.model/streams/isStreaming' (tabId: string): boolean {
    return streamIsStreaming(tabId)
  },

  // Id of the section that the tab's stream writes into, while it streams.
  'dez.model/streams/streamingSectionId' (tabId: string): string | null {
    const session = useStreamStore().session(tabId)
    return session?.status === 'streaming' ? session.sectionId : null
  },
})
