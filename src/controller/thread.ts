import sbp from '@sbp/sbp'
import { effectiveOutputs } from '../model/modelOutputs'
import { missingImageProblem } from '../model/providers/clipImages'
import { clipTextProblem } from '../model/providers/clipText'
import { effectiveRequest, type ModelInfo } from '../model/providers/types'
import { unusableModelMessage } from '../model/providers/unusableModel'
import { mediaRequestInput } from '../model/streams/messages'
import type { RequestMessages } from '../model/streams/types'

// Tells the user that the request goes with `count` fewer images than the
// message has, because the model `reason` (e.g. "does not read images").
function warnImagesLeftOut(modelName: string, reason: string, count: number): void {
  sbp('dez.ui/toast', 'app-global', {
    variant: 'warning',
    title: count === 1 ? 'Image not sent' : 'Images not sent',
    message: `${modelName} ${reason}, so ${count === 1 ? '1 image was' : `${count} images were`} left out of the request.`,
    duration: 8000,
  })
}

export default sbp('sbp/selectors/register', {
  async 'dez.controller/submitTab' (tabId: string): Promise<void> {
    const tab = sbp('dez.model/tab', tabId)
    if (!tab) return

    const model = sbp('dez.model/activeModelForTab', tabId)
    if (!model) {
      console.error('Cannot send: no model selected')
      sbp('dez.ui/toast', 'app-global', { variant: 'error', title: 'Cannot send', message: 'No model is selected. Choose a model in the bottom bar, and send again.' })
      return
    }

    // The messages, the stamp and the request use the same model read.
    let request = sbp('dez.model/streamMessagesForTab', tabId, model) as RequestMessages
    if (request.messages.length === 0) return

    // A model that the cache does not have has no request kind, so it gets
    // a chat request, as before models had one. A refusal changes nothing,
    // so it comes before the end of a running reply's output.
    const cachedModel: Pick<ModelInfo, 'outputs' | 'request' | 'clipInput' | 'text' | 'images'> = sbp('dez.model/modelCache/model', model.providerId, model.modelId) ?? {}
    const kind = effectiveRequest(cachedModel)
    let message: string | null = null
    // How many images of the message a media request takes and leaves out.
    let mediaImages = { sent: 0, leftOut: 0 }
    if (kind === 'none') {
      message = unusableModelMessage(model.modelName, cachedModel)
    } else if (kind !== 'chat') {
      // An input that the model is known not to take (no image for a model
      // that edits one, makes one larger, or makes its video from one; no
      // lyrics for a model that needs them; a prompt that is too short or
      // too long) gets no request: the check costs nothing, and it tells
      // the user what to change. The end of a running reply's output
      // changes no user message and adds no image, so the input that this
      // checks is the input of the request. Only a clip model has text
      // rules.
      const input = mediaRequestInput(kind, request.messages, tab.sections, cachedModel)
      message = missingImageProblem(model.modelName, kind, input.images.length) ?? clipTextProblem(model.modelName, cachedModel.text, input)
      mediaImages = { sent: input.images.length, leftOut: input.imagesLeftOut }
    }
    if (message !== null) {
      console.error(`Cannot send: ${message}`)
      sbp('dez.ui/toast', 'app-global', { variant: 'error', title: 'Cannot send', message })
      return
    }

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

    // The request still goes. At most one of the two shows: a message whose
    // images do not go as image parts has none for a media request to take.
    if (imagesLeftOut > 0) {
      // With only the text of each image reference.
      warnImagesLeftOut(model.modelName, 'does not read images', imagesLeftOut)
    } else if (mediaImages.leftOut > 0) {
      const takes = mediaImages.sent === 0 ? 'takes no image' : `takes only ${mediaImages.sent === 1 ? '1 image' : `${mediaImages.sent} images`}`
      warnImagesLeftOut(model.modelName, takes, mediaImages.leftOut)
    }

    await sbp('dez.stream/start', {
      tabId,
      conversationId: tab.conversationId,
      sectionId: agentSection.id,
      model,
      request: kind,
      messages,
      sendTools,
      imageOutput: effectiveOutputs(cachedModel).includes('image'),
      inputRules: cachedModel,
    })
  },

})
