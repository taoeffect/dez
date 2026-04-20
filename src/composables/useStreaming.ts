import { ref } from 'vue'
import { invoke, Channel } from '@tauri-apps/api/core'
import type { EditorView } from '@codemirror/view'
import { useThreadStore } from '../stores/threadStore'
import { useTabStore } from '../stores/tabStore'
import type { StreamEvent } from '../types/chat'
import { appendStreamingText, emptyContent, sectionIsEmpty, setSectionPlainText } from '../types/content'

const isStreaming = ref(false)
const streamingTabId = ref<string | null>(null)
const streamingError = ref<string | null>(null)

// Step-2 bridge: ThreadEditor registers its mounted CM view here so streamed
// tokens can be reflected into the editor. Cleared on unmount and on tab
// switch. Replaced in step 8 by a direct-dispatch pathway.
let streamingCmView: EditorView | null = null
export function setStreamingCmView(view: EditorView | null) {
  streamingCmView = view
}

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
    if (lastSection.role !== 'agent' || !sectionIsEmpty(lastSection)) {
      threadStore.addSection('agent')
    }

    const agentSection = threadStore.sections[threadStore.sections.length - 1]
    agentSection.content = emptyContent()

    isStreaming.value = true
    streamingTabId.value = tabId
    streamingError.value = null

    const channel = new Channel<StreamEvent>()

    channel.onmessage = (event: StreamEvent) => {
      if (streamingTabId.value !== tabId) return

      switch (event.kind) {
        case 'Token':
          appendStreamingText(agentSection, event.data.content)
          if (streamingCmView && streamingTabId.value === tabStore.activeTabId) {
            const view = streamingCmView
            view.dispatch({
              changes: { from: view.state.doc.length, insert: event.data.content },
              scrollIntoView: true,
            })
          }
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
        if (sectionIsEmpty(lastSection)) {
          setSectionPlainText(
            lastSection,
            streamingError.value ? `Error: ${streamingError.value}` : '',
          )
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
