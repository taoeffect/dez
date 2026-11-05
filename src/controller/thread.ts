import sbp from '@sbp/sbp'

export default sbp('sbp/selectors/register', {
  async 'dez.controller/submitTab' (tabId: string): Promise<void> {
    const tab = sbp('dez.model/tab', tabId)
    if (!tab) return

    const model = sbp('dez.model/activeModelForTab', tabId)
    if (!model) {
      console.error('Cannot send: no model selected')
      sbp('dez.ui/toast', 'app-global', { variant: 'error', title: 'Cannot send', message: 'No model selected' })
      return
    }

    // The messages, the stamp and the request use the same model read.
    const messages = sbp('dez.model/streamMessagesForTab', tabId, model)
    if (messages.length === 0) return

    const agentSection = sbp('dez.model/ensureTrailingAgentSectionForTab', tabId, model)
    if (!agentSection) return

    await sbp('dez.stream/start', {
      tabId,
      sectionId: agentSection.id,
      model,
      messages,
    })
  },

})
