import { ref } from 'vue'
import { invoke, Channel } from '@tauri-apps/api/core'
import { useThreadStore } from '../stores/threadStore'
import { useTabStore } from '../stores/tabStore'
import type { StreamEvent } from '../types/chat'

const isStreaming = ref(false)
const streamingTabId = ref<string | null>(null)
const streamingError = ref<string | null>(null)

export function useStreaming() {
  const threadStore = useThreadStore()
  const tabStore = useTabStore()

  async function startStreaming() {
    const model = threadStore.activeModel
    if (!model) {
      streamingError.value = 'No model selected'
      return
    }

    const messages = threadStore.getThreadForSubmission()
    if (messages.length === 0) return

    const tabId = tabStore.activeTabId

    const lastSection = threadStore.sections[threadStore.sections.length - 1]
    if (lastSection.role !== 'agent' || lastSection.content.trim() !== '') {
      threadStore.addSection('agent')
    }

    const agentSection = threadStore.sections[threadStore.sections.length - 1]
    agentSection.content = ''

    isStreaming.value = true
    streamingTabId.value = tabId
    streamingError.value = null

    const channel = new Channel<StreamEvent>()

    channel.onmessage = (event: StreamEvent) => {
      if (streamingTabId.value !== tabId) return

      switch (event.kind) {
        case 'Token':
          agentSection.content += event.data.content
          break
        case 'Done':
          finishStreaming()
          break
        case 'Error':
          streamingError.value = event.data.message
          finishStreaming()
          break
      }
    }

    try {
      await invoke('send_message', {
        tabId,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        providerId: model.providerId,
        modelId: model.modelId,
        onEvent: channel,
      })
    } catch (e) {
      streamingError.value = e instanceof Error ? e.message : String(e)
      finishStreaming()
    }
  }

  function finishStreaming() {
    const wasStreamingTab = streamingTabId.value
    isStreaming.value = false
    streamingTabId.value = null

    if (wasStreamingTab === tabStore.activeTabId) {
      const lastSection = threadStore.sections[threadStore.sections.length - 1]
      if (lastSection.role === 'agent') {
        if (lastSection.content.trim() === '') {
          lastSection.content = streamingError.value
            ? `Error: ${streamingError.value}`
            : ''
        }
        threadStore.addSection('user')
      }
      tabStore.autoTitle(tabStore.activeTabId)
      if (wasStreamingTab) tabStore.saveTab(wasStreamingTab).catch(() => {})
      tabStore.saveAppState()
    }
  }

  async function stopStreaming() {
    if (!streamingTabId.value) return
    try {
      await invoke('cancel_generation', { tabId: streamingTabId.value })
    } catch {
      // ignore
    }
    finishStreaming()
  }

  return {
    isStreaming,
    streamingTabId,
    streamingError,
    startStreaming,
    stopStreaming,
  }
}
