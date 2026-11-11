import sbp from '@sbp/sbp'
import { effectiveOutputs, MODEL_OUTPUTS, type ModelOutput } from '../model/modelOutputs'
import { clipTextProblem } from '../model/providers/clipText'
import { effectiveRequest, isClipKind, type ModelInfo } from '../model/providers/types'
import { mediaRequestInput } from '../model/streams/messages'
import type { RequestMessages } from '../model/streams/types'

// The text of the refusal of a model that Dez has no request for
// (ModelInfo.request `none`), e.g. "Dez cannot use Upscaler yet. It makes
// image output through an API that Dez does not support."
function unusableModelMessage(modelName: string, outputs: readonly ModelOutput[]): string {
  const labels = MODEL_OUTPUTS.filter((output) => outputs.includes(output.id)).map((output) => output.label.toLowerCase())
  const cannotUse = `Dez cannot use ${modelName} yet.`
  if (labels.length === 0) return cannotUse
  return `${cannotUse} It makes ${new Intl.ListFormat('en', { type: 'conjunction' }).format(labels)} output through an API that Dez does not support.`
}

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

    // A model that the cache does not have has no request kind, so it gets
    // a chat request, as before models had one. A refusal changes nothing,
    // so it comes before the end of a running reply's output.
    const cachedModel: Pick<ModelInfo, 'outputs' | 'request' | 'text'> = sbp('dez.model/modelCache/model', model.providerId, model.modelId) ?? {}
    const kind = effectiveRequest(cachedModel)
    let message: string | null = null
    if (kind === 'none') {
      message = unusableModelMessage(model.modelName, effectiveOutputs(cachedModel))
    } else if (isClipKind(kind)) {
      // A text that the model is known not to take (no lyrics for a model
      // that needs them, a prompt that is too short or too long) gets no
      // request: the check costs nothing, and it tells the user what to
      // change. The end of a running reply's output changes no user
      // message, so the text that this checks is the text of the request.
      message = clipTextProblem(model.modelName, cachedModel.text, mediaRequestInput(kind, request.messages, tab.sections, cachedModel.text))
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
      request: kind,
      messages,
      sendTools,
      imageOutput: effectiveOutputs(cachedModel).includes('image'),
      ...(cachedModel.text && { textRules: cachedModel.text }),
    })
  },

})
