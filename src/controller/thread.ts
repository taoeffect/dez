import sbp from '@sbp/sbp'

export default sbp('sbp/selectors/register', {
  async 'dez.controller/submitActiveTab' (): Promise<void> {
    await sbp('dez.controller/submitTab', sbp('dez.model/tabs/activeId'))
  },

  async 'dez.controller/submitTab' (tabId: string): Promise<void> {
    const tab = sbp('dez.model/tab', tabId)
    if (!tab) return

    const model = sbp('dez.model/activeModelForTab', tabId)
    if (!model) {
      sbp('dez.model/streams/setError', tabId, 'No model selected')
      return
    }

    const messages = sbp('dez.model/streamMessagesForTab', tabId)
    if (messages.length === 0) return

    const agentSection = sbp('dez.model/ensureTrailingAgentSectionForTab', tabId)
    if (!agentSection) return

    sbp('dez.model/streams/clearError', tabId)
    await sbp('dez.stream/start', {
      tabId,
      sectionId: agentSection.id,
      model,
      messages,
    })
  },

  async 'dez.controller/stopActiveTab' (): Promise<void> {
    await sbp('dez.controller/stopTab', sbp('dez.model/tabs/activeId'))
  },

  async 'dez.controller/stopTab' (tabId: string): Promise<void> {
    await sbp('dez.stream/stop', tabId)
  },
})
