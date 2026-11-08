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
    const { messages, imagesLeftOut } = sbp('dez.model/streamMessagesForTab', tabId, model) as RequestMessages
    if (messages.length === 0) return

    const agentSection = sbp('dez.model/ensureTrailingAgentSectionForTab', tabId, model)
    if (!agentSection) return

    // The request still goes, with the text `[image]` in place of each image.
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
      sectionId: agentSection.id,
      model,
      messages,
    })
  },

})
