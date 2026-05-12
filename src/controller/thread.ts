import sbp from '@sbp/sbp'
import { useStreamStore } from '../model/state/streams'
import { useTabStore } from '../model/state/tabs'

export default sbp('sbp/selectors/register', {
  async 'dez.controller/submitActiveTab' (): Promise<void> {
    const tabStore = useTabStore()
    await sbp('dez.controller/submitTab', tabStore.activeTabId)
  },

  async 'dez.controller/submitTab' (tabId: string): Promise<void> {
    const tabStore = useTabStore()
    const streamStore = useStreamStore()
    if (!tabStore.tabById(tabId)) return

    const model = tabStore.activeModelForTab(tabId)
    if (!model) {
      streamStore.setError(tabId, 'No model selected')
      return
    }

    const messages = tabStore.streamMessagesForTab(tabId)
    if (messages.length === 0) return

    const agentSection = tabStore.ensureTrailingAgentSectionForTab(tabId)
    if (!agentSection) return

    streamStore.clearError(tabId)
    await sbp('dez.stream/start', {
      tabId,
      sectionId: agentSection.id,
      model,
      messages,
    })
  },

  async 'dez.controller/stopActiveTab' (): Promise<void> {
    const tabStore = useTabStore()
    await sbp('dez.controller/stopTab', tabStore.activeTabId)
  },

  async 'dez.controller/stopTab' (tabId: string): Promise<void> {
    await sbp('dez.stream/stop', tabId)
  },
})
