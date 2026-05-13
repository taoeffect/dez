import sbp from '@sbp/sbp'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useTabStore } from './tabs'
import type { StreamSessionState, StreamStartInput, StreamStatus, StreamTerminalInput } from '../streams/types'

function terminalStatusTime(status: StreamStatus): number | null {
  return status === 'streaming' || status === 'idle' ? null : Date.now()
}

function cloneStreamSession(session: StreamSessionState): StreamSessionState {
  return {
    ...session,
    model: { ...session.model },
  }
}

export const useStreamStore = defineStore('streams', () => {
  const sessionsByTab = ref<Record<string, StreamSessionState>>({})
  const errorsByTab = ref<Record<string, string | null>>({})

  const activeSessions = computed(() => {
    return Object.values(sessionsByTab.value).filter((session) => session.status === 'streaming')
  })

  const activeTabSession = computed(() => {
    const tabStore = useTabStore()
    return session(tabStore.activeTabId)
  })

  const isActiveTabStreaming = computed(() => {
    const tabStore = useTabStore()
    return isStreaming(tabStore.activeTabId)
  })

  const activeTabError = computed(() => {
    const tabStore = useTabStore()
    return activeTabSession.value?.error ?? errorsByTab.value[tabStore.activeTabId] ?? null
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
      error: null,
    }
    sessionsByTab.value[input.tabId] = nextSession
    errorsByTab.value[input.tabId] = null
    return nextSession
  }

  function receiveToken(tabId: string, token: string): StreamSessionState | null {
    const currentSession = session(tabId)
    if (!currentSession || currentSession.status !== 'streaming') return currentSession
    currentSession.tokenCount += token.length
    currentSession.updatedAt = Date.now()
    return currentSession
  }

  function setTerminal(input: StreamTerminalInput): StreamSessionState | null {
    const currentSession = session(input.tabId)
    if (!currentSession) return null
    const error = input.error ?? null
    currentSession.status = input.status
    currentSession.error = error
    errorsByTab.value[input.tabId] = error
    currentSession.updatedAt = Date.now()
    currentSession.finishedAt = terminalStatusTime(input.status)
    return currentSession
  }

  function finish(tabId: string): StreamSessionState | null {
    return setTerminal({ tabId, status: 'finished' })
  }

  function error(tabId: string, message: string): StreamSessionState | null {
    return setTerminal({ tabId, status: 'error', error: message })
  }

  function cancelled(tabId: string): StreamSessionState | null {
    return setTerminal({ tabId, status: 'cancelled' })
  }

  function setError(tabId: string, message: string): void {
    errorsByTab.value[tabId] = message
  }

  function clearError(tabId: string): void {
    errorsByTab.value[tabId] = null
  }

  function removeSession(tabId: string): void {
    delete sessionsByTab.value[tabId]
    delete errorsByTab.value[tabId]
  }

  return {
    sessionsByTab,
    errorsByTab,
    activeSessions,
    activeTabSession,
    isActiveTabStreaming,
    activeTabError,
    session,
    status,
    isStreaming,
    startSession,
    receiveToken,
    finish,
    error,
    cancelled,
    setError,
    clearError,
    removeSession,
  }
})

export default sbp('sbp/selectors/register', {
  'dez.model/streams/isStreaming' (tabId: string): boolean {
    return useStreamStore().isStreaming(tabId)
  },

  'dez.model/streams/session' (tabId: string): StreamSessionState | null {
    const session = useStreamStore().session(tabId)
    return session ? cloneStreamSession(session) : null
  },

  'dez.model/streams/activeTabError' (): string | null {
    const streamStore = useStreamStore()
    const activeTabId = useTabStore().activeTabId
    return streamStore.session(activeTabId)?.error ?? streamStore.errorsByTab[activeTabId] ?? null
  },

  'dez.model/streams/startSession' (input: StreamStartInput): StreamSessionState {
    return cloneStreamSession(useStreamStore().startSession({
      ...input,
      model: { ...input.model },
    }))
  },

  'dez.model/streams/receiveToken' (tabId: string, token: string): StreamSessionState | null {
    const session = useStreamStore().receiveToken(tabId, token)
    return session ? cloneStreamSession(session) : null
  },

  'dez.model/streams/finish' (tabId: string): StreamSessionState | null {
    const session = useStreamStore().finish(tabId)
    return session ? cloneStreamSession(session) : null
  },

  'dez.model/streams/error' (tabId: string, message: string): StreamSessionState | null {
    const session = useStreamStore().error(tabId, message)
    return session ? cloneStreamSession(session) : null
  },

  'dez.model/streams/cancelled' (tabId: string): StreamSessionState | null {
    const session = useStreamStore().cancelled(tabId)
    return session ? cloneStreamSession(session) : null
  },

  'dez.model/streams/setError' (tabId: string, message: string): void {
    useStreamStore().setError(tabId, message)
  },

  'dez.model/streams/clearError' (tabId: string): void {
    useStreamStore().clearError(tabId)
  },

})
