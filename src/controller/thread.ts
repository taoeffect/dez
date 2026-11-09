import sbp from '@sbp/sbp'
import type { RequestMessages } from '../model/streams/types'

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
    let request = sbp('dez.model/streamMessagesForTab', tabId, model) as RequestMessages
    if (request.messages.length === 0) return

    // A reply that still streams in the tab ends its output here, before the
    // new agent section exists (`dez.stream/endOutput`). The request must
    // send what the tab then stores, else the next request changes these
    // bytes (prompt cache, replay prefix hashes).
    if (sbp('dez.stream/endOutput', tabId)) {
      request = sbp('dez.model/streamMessagesForTab', tabId, model) as RequestMessages
    }
    const { messages, imagesLeftOut, sendTools } = request

    const agentSection = sbp('dez.model/ensureTrailingAgentSectionForTab', tabId, model)
    if (!agentSection) return

    // The request still goes, with only the text of each image reference.
    if (imagesLeftOut > 0) {
      sbp('dez.ui/toast', 'app-global', {
        variant: 'warning',
        title: imagesLeftOut === 1 ? 'Image not sent' : 'Images not sent',
        message: `${model.modelName} does not read images, so ${imagesLeftOut === 1 ? '1 image was' : `${imagesLeftOut} images were`} left out of the request.`,
        duration: 8000,
      })
    }

    await sbp('dez.stream/start', {
      tabId,
      conversationId: tab.conversationId,
      sectionId: agentSection.id,
      model,
      messages,
      sendTools,
    })
  },

})
