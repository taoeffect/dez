import sbp from '@sbp/sbp'
import type { MediaTagKind } from '../model/chat/mediaTags'
import { modelRefKey } from '../model/chat/modelRef'
import { effectiveOutputs } from '../model/modelOutputs'
import { clipsText } from '../model/providers/clipInputs'
import { imagesText } from '../model/providers/clipImages'
import { effectiveRequest, type ClipInputRules, type ModelInfo } from '../model/providers/types'
import { unstoredOutputMessage, unusableModelMessage } from '../model/providers/unusableModel'
import type { SettingsSnapshot } from '../model/state'
import { mediaInputRules, mediaRequestProblem } from '../model/streams/mediaRequest'
import { mediaRequestInput } from '../model/streams/messages'
import type { RequestMessages } from '../model/streams/types'
import { systemPromptErrorText, systemPromptProblem, systemPromptTemplate } from '../model/systemPrompt'

// Tells the user that the request goes with `count` fewer images than the
// message has, because the model `reason` (e.g. "does not read images").
function warnImagesLeftOut(modelName: string, reason: string, count: number): void {
  sbp('dez.ui/toast', 'app-global', {
    variant: 'warning',
    title: count === 1 ? 'Image not sent' : 'Images not sent',
    message: `${modelName} ${reason}, so ${imagesText(count)} ${count === 1 ? 'was' : 'were'} left out of the request.`,
    duration: 8000,
  })
}

// Tells the user that the request goes without the clips of `leftOut`, the
// count of each kind that the message holds or names and the model
// `modelName` does not take; `sent` is the count of each kind that goes. A
// model with no clip rules takes no clip at all.
function warnClipsLeftOut(modelName: string, takesClips: boolean, sent: Record<MediaTagKind, number>, leftOut: Record<MediaTagKind, number>): void {
  const count = leftOut.audio + leftOut.video
  if (count === 0) return
  const kinds = (['audio', 'video'] as const).filter((kind) => leftOut[kind] > 0)
  const takes = takesClips
    ? kinds.map((kind) => (sent[kind] === 0 ? `takes no ${kind} clip` : `takes only ${clipsText(sent[kind], kind)}`)).join(' and ')
    : 'takes no clip'
  sbp('dez.ui/toast', 'app-global', {
    variant: 'warning',
    title: count === 1 ? 'Clip not sent' : 'Clips not sent',
    message: `${modelName} ${takes}, so ${count === 1 ? '1 clip was' : `${count} clips were`} left out of the request.`,
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
    const cachedModel: Pick<ModelInfo, 'outputs' | 'request' | 'text' | 'images' | 'clips' | 'parameters' | 'unstoredOutput' | 'learnedImageLimit'> = sbp('dez.model/modelCache/model', model.providerId, model.modelId) ?? {}
    const kind = effectiveRequest(cachedModel)
    let message: string | null = null
    // How many images and clips of the message a media request takes and
    // leaves out.
    let mediaImages = { sent: 0, leftOut: 0 }
    let mediaClips = { sent: { audio: 0, video: 0 }, leftOut: { audio: 0, video: 0 } }
    // The text, image, and clip rules of a media request, for the user's
    // parameter values, which the request reads at its start too
    // (`generateMedia`).
    let inputRules: ClipInputRules = {}
    if (kind === 'none') {
      message = unusableModelMessage(model.modelName, cachedModel)
    } else if (cachedModel.unstoredOutput !== undefined) {
      // The provider would bill an image that Dez then cannot store.
      message = unstoredOutputMessage(model.modelName, cachedModel.unstoredOutput)
    } else if (kind !== 'chat') {
      const chosen = (sbp('dez.model/settings/snapshot') as SettingsSnapshot).modelParameters[modelRefKey(model)]
      inputRules = mediaInputRules(cachedModel, chosen)
      // An input that the model is known not to take gets no request
      // (`mediaRequestProblem`, the checks that the `model_invoke` tool
      // shares): each check costs nothing, and it tells the user what to
      // change. The end of a running reply's output changes no user
      // message and adds no image or clip, so the input that this checks is
      // the input of the request.
      const input = mediaRequestInput(kind, request.messages, tab.sections, inputRules)
      message = mediaRequestProblem(model.modelName, kind, cachedModel, inputRules.images, input)
      mediaImages = { sent: input.images.length, leftOut: input.imagesLeftOut }
      const sentClips = { audio: 0, video: 0 }
      for (const clip of input.clips) sentClips[clip.kind]++
      mediaClips = { sent: sentClips, leftOut: input.clipsLeftOut }
    } else {
      // A chat request sends the system prompt (`dez.stream/start`), whose
      // template the user can edit. A template with a problem would fail
      // the request after the new agent section exists.
      const { systemPrompt } = sbp('dez.model/settings/snapshot') as SettingsSnapshot
      const problem = systemPromptProblem(systemPromptTemplate(systemPrompt))
      if (problem !== null) message = systemPromptErrorText(problem)
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

    // The request still goes. A message whose images do not go as image
    // parts has none for a media request to take, so at most one of these
    // shows. A media model that needs one image still gets the newest image
    // reference of the tab (`mediaRequestInput`), which can be an image of
    // this message.
    if (imagesLeftOut > 0 && mediaImages.sent > 0) {
      sbp('dez.ui/toast', 'app-global', {
        variant: 'warning',
        title: 'Only the newest image sent',
        message: `${model.modelName} does not read images, so only the newest image of the conversation went with the request.`,
        duration: 8000,
      })
    } else if (imagesLeftOut > 0) {
      // With only the text of each image reference.
      warnImagesLeftOut(model.modelName, 'does not read images', imagesLeftOut)
    } else if (mediaImages.leftOut > 0) {
      const takes = mediaImages.sent === 0 ? 'takes no image' : `takes only ${imagesText(mediaImages.sent)}`
      warnImagesLeftOut(model.modelName, takes, mediaImages.leftOut)
    }
    warnClipsLeftOut(model.modelName, cachedModel.clips !== undefined, mediaClips.sent, mediaClips.leftOut)

    await sbp('dez.stream/start', {
      tabId,
      conversationId: tab.conversationId,
      sectionId: agentSection.id,
      model,
      request: kind,
      messages,
      sendTools,
      imageOutput: effectiveOutputs(cachedModel).includes('image'),
      inputRules,
    })
  },

})
