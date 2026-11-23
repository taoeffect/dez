import sbp from '@sbp/sbp'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useTabStore } from './tabs'
import type { CallTime, EndedStreamSession, LiveTimes, StreamSessionState, StreamStartInput, StreamStatus, StreamTerminalInput } from '../streams/types'

function cloneCallTimes(callTimes: Record<string, CallTime>): Record<string, CallTime> {
  return Object.fromEntries(Object.entries(callTimes).map(([id, time]) => [id, { ...time }]))
}

function cloneStreamSession<Session extends StreamSessionState>(session: Session): Session {
  return {
    ...session,
    model: { ...session.model },
    callTimes: cloneCallTimes(session.callTimes),
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
      finishedAt: null,
      compacting: false,
      callTimes: {},
    }
    sessionsByTab.value[input.tabId] = nextSession
    return nextSession
  }

  function setCompacting(tabId: string, compacting: boolean): void {
    const currentSession = session(tabId)
    if (currentSession) currentSession.compacting = compacting
  }

  // The session that streams into `sectionId`, or null: a call of a reply
  // that ended must not write into the session of a newer reply.
  function streamingSessionOf(tabId: string, sectionId: string): StreamSessionState | null {
    const currentSession = session(tabId)
    return currentSession?.status === 'streaming' && currentSession.sectionId === sectionId ? currentSession : null
  }

  // A call id comes from the provider: a computed key and `Object.hasOwn`
  // keep an id such as `__proto__` or `constructor` an own entry, never a
  // read or a write of the prototype.
  function startCall(tabId: string, sectionId: string, callId: string, startedAt: number): void {
    const currentSession = streamingSessionOf(tabId, sectionId)
    if (currentSession) currentSession.callTimes = { ...currentSession.callTimes, [callId]: { startedAt, endedAt: null } }
  }

  function endCall(tabId: string, sectionId: string, callId: string, endedAt: number): void {
    const callTimes = streamingSessionOf(tabId, sectionId)?.callTimes
    if (callTimes && Object.hasOwn(callTimes, callId)) callTimes[callId].endedAt = endedAt
  }

  function setTerminal(input: StreamTerminalInput): EndedStreamSession | null {
    const currentSession = session(input.tabId)
    if (!currentSession) return null
    return Object.assign(currentSession, { status: input.status, finishedAt: Date.now() })
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
    setCompacting,
    startCall,
    endCall,
    isStreaming,
    startSession,
    finish,
    error,
    cancelled,
    removeSession,
  }
})

export function streamIsStreaming(tabId: string): boolean {
  return useStreamStore().isStreaming(tabId)
}

/** The section that the tab's stream writes into, while it streams. */
export function streamingSectionId(tabId: string): string | null {
  const session = useStreamStore().session(tabId)
  return session?.status === 'streaming' ? session.sectionId : null
}

export function startStreamSession(input: StreamStartInput): StreamSessionState {
  return cloneStreamSession(useStreamStore().startSession({
    ...input,
    model: { ...input.model },
  }))
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

/** Tells that the reply of the tab waits for a compaction request, or
 *  that it waits no more. */
export function setStreamCompacting(tabId: string, compacting: boolean): void {
  useStreamStore().setCompacting(tabId, compacting)
}

/** Stamps the start of a tool call of the reply that streams into
 *  `sectionId`, for the live time of its chip, and gives the stamp. */
export function startStreamCall(tabId: string, sectionId: string, callId: string): number {
  const startedAt = Date.now()
  useStreamStore().startCall(tabId, sectionId, callId, startedAt)
  return startedAt
}

/** Stamps the end of a tool call that `startStreamCall` stamped, and gives
 *  the stamp. */
export function endStreamCall(tabId: string, sectionId: string, callId: string): number {
  const endedAt = Date.now()
  useStreamStore().endCall(tabId, sectionId, callId, endedAt)
  return endedAt
}

export default sbp('sbp/selectors/register', {
  'dez.model/streams/isStreaming' (tabId: string): boolean {
    return streamIsStreaming(tabId)
  },

  // Id of the section that the tab's stream writes into, while it streams.
  'dez.model/streams/streamingSectionId' (tabId: string): string | null {
    return streamingSectionId(tabId)
  },

  // Whether the reply that runs in the tab waits for a compaction request
  // now, for the "Compacting…" text of the bottom bar.
  'dez.model/streams/isCompacting' (tabId: string): boolean {
    const session = useStreamStore().session(tabId)
    return session?.status === 'streaming' && session.compacting
  },

  // The times of the reply that runs in the tab, for the live times of its
  // pill and of its tool call chips; null when no reply runs. A copy: the
  // view reads it on each tick of its clock, not through Vue.
  'dez.model/streams/liveTimes' (tabId: string): LiveTimes | null {
    const session = useStreamStore().session(tabId)
    if (session?.status !== 'streaming') return null
    return { sectionId: session.sectionId, startedAt: session.startedAt, calls: cloneCallTimes(session.callTimes) }
  },
})
