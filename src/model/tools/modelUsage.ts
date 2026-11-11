import { effectiveOutputs } from '../modelOutputs'
import { imagesText, maxInputImages, minInputImages, needsInputImage } from '../providers/clipImages'
import { lyricsHowTo } from '../providers/clipText'
import { toolsApply } from '../providers/modelToggles'
import { TOOLS_SETTING_KEY } from '../providers/toolsSetting'
import { CLIP_KINDS, effectiveRequest, isClipKind, type MediaKind, type ModelInfo, type ProviderInputImageRules } from '../providers/types'

// The `usage` of a `model_info` result: how a request to a model is formed,
// what it needs, and what comes back. Each text tells what the code that
// builds the request does (`dez.model/streamMessagesForTab`,
// `mediaRequestInput`, `clipText`, `dez.provider/generateMedia`), and
// modelUsage.test.ts runs that code to check each choice of a text. The
// texts are about the model: they name no image and no file of the
// conversation.

const SETTINGS_POPUP = 'the provider settings popup (the gear button next to the model picker)'

export const USAGE_TEXTS = {
  // MODEL_INVOKE: change this text when a model can send a request to
  // another model.
  userSends: 'You cannot send this model a request. The user can: they choose it in the model picker of the bottom bar, write a message, and send it.',
  cannotUse: 'Dez sends this model no request; `dez.cannotUse` tells why.',
  chatRequest: 'A request holds the whole conversation of the tab, with Dez\'s system prompt.',
  tools: 'It gets the Dez tools (the ones that you have).',
  toolsOff: 'It gets no Dez tools: the Tools toggle of its provider is off.',
  noTools: 'It gets no Dez tools: it does not call tools.',
  chatImages: 'The images of the newest user message (pasted, or named with @id) go to it as images; older images go only as text with their ids, such as `![image](id=a)`.',
  chatNoImages: 'It does not read images: each image goes only as text with its id, such as `![image](id=a)`.',
  textReply: 'It answers with text.',
  imageReply: 'It answers with text, and it can make images; each image gets a new id (@id).',
  toggles: `Each request sends the toggles of \`dez.toggles\`; the user sets them in ${SETTINGS_POPUP}.`,
  mediaRequest: 'A request holds only the newest user message, not the rest of the conversation.',
  promptImages: 'An image in the text goes into the prompt as its id text, such as `![image](id=a)`.',
  noText: 'The text of the message does not go.',
  textLengths: 'Dez refuses a message whose text breaks the lengths of `dez.text` (in UTF-16 units).',
  noImages: 'It takes no input image: the images of the message do not go.',
  noImagesRead: 'It does not read images, so the images of the message do not go.',
  newestImage: 'With no image in the message, the newest image of the conversation goes.',
  newestImageOnly: 'It does not read images, so only the newest image of the conversation goes.',
  fitted: 'Dez sends a fitted copy (cropped or scaled) of an image that breaks `dez.images.size`.',
  limits: 'Dez refuses an image that breaks `dez.images.limits`.',
  videoReferences: 'They are references for the video, not frames of it.',
  parameters: `Each request sends the \`value\` of each of \`dez.parameters\`; the user sets them under "Model Parameters" in ${SETTINGS_POPUP}.`,
  imageResult: 'It answers with an image, which goes into the reply with a new id (@id).',
  audioResult: 'It answers with an audio clip, which the reply shows as a player with a new id. Dez cannot send a clip to a model.',
  videoResult: 'It answers with a video clip, which the reply shows as a player with a new id. Dez cannot send a clip to a model.',
} as const

// The prompt of a model that names its reference images (`promptName`,
// `mediaRequestInput`): the names of the first two images show the form.
export function referenceNamesUsage(promptName: string): string {
  const name = (n: number) => `\`${promptName.replaceAll('{n}', String(n))}\``
  return `Each image that goes is named in the prompt as the model names it, ${name(1)} for the first, ${name(2)} for the second, and so on, in place of its id text (such as \`![image](id=a)\`) and its @id mentions; any other image goes into the prompt as its id text.`
}

// What the text of the message is to a model of each media kind (none:
// the text does not go), and what its input images are (none: no model of
// the kind takes images, as far as the media formats tell).
const MEDIA_USAGE: Readonly<Record<MediaKind, { prompt?: string, images?: string }>> = {
  image: { prompt: 'The text of the message is the prompt.', images: 'They are references for the new image.' },
  imageEdit: { prompt: 'The text of the message tells what to change.', images: 'The first one is the image to edit, and the others are references.' },
  upscale: { images: 'It makes that image larger.' },
  tts: { prompt: 'The text of the message is the text that it speaks.' },
  music: { prompt: 'The text of the message is the prompt (for a song: its style).' },
  video: { prompt: 'The text of the message is the prompt.', images: 'The first one is the first frame of the video, and the second one is the last frame.' },
  imageToVideo: { prompt: 'The text of the message is the prompt.', images: 'The first one is the first frame of the video, and the second one is the last frame.' },
}

/** What `model_info` knows besides the cached model, for `modelUsage`. */
export interface UsageFacts {
  /** The toggles that apply to the model, with their values. */
  toggles: readonly { key: string, on: boolean }[]
  inputImages: ProviderInputImageRules
}

// How many images of the message a request takes: from the fewest that it
// needs to the most that it takes. Only a model with no image rules takes
// every image (`maxInputImages`), and it needs 1 or none.
function takenImages(min: number, max: number): string {
  if (max === Infinity) return 'every image'
  if (min === max) return imagesText(max)
  return min > 0 ? `${min} to ${imagesText(max)}` : `up to ${imagesText(max)}`
}

function chatUsage(model: ModelInfo, facts: UsageFacts): string[] {
  const tools = facts.toggles.find((toggle) => toggle.key === TOOLS_SETTING_KEY)
  return [
    USAGE_TEXTS.chatRequest,
    !toolsApply(model) ? USAGE_TEXTS.noTools : tools?.on === false ? USAGE_TEXTS.toolsOff : USAGE_TEXTS.tools,
    model.imageInput === false ? USAGE_TEXTS.chatNoImages : USAGE_TEXTS.chatImages,
    effectiveOutputs(model).includes('image') ? USAGE_TEXTS.imageReply : USAGE_TEXTS.textReply,
    ...(facts.toggles.length > 0 ? [USAGE_TEXTS.toggles] : []),
  ]
}

function inputImagesUsage(kind: MediaKind, model: ModelInfo): string[] {
  const max = maxInputImages(kind, model.images)
  const needed = needsInputImage(kind, model.images)
  if (max === 0) return [USAGE_TEXTS.noImages]
  // A message to a model that is known not to read images carries no
  // image (`dez.model/streamMessagesForTab`), so only the fallback of
  // `mediaRequestInput` gives one.
  if (model.imageInput === false) return [needed ? USAGE_TEXTS.newestImageOnly : USAGE_TEXTS.noImagesRead]
  const role = model.images?.references ? USAGE_TEXTS.videoReferences : MEDIA_USAGE[kind].images
  return [
    `It takes ${takenImages(minInputImages(kind, model.images), max)} of the message (pasted, or named with @id)${max === 1 ? '' : ', in text order'}.`,
    ...(role === undefined ? [] : [role]),
    ...(needed ? [USAGE_TEXTS.newestImage] : []),
  ]
}

function mediaUsage(kind: MediaKind, model: ModelInfo, facts: UsageFacts): string[] {
  const { prompt } = MEDIA_USAGE[kind]
  const lyrics = model.text?.lyrics
  const lengths = model.text && (model.text.minPromptLength !== undefined || model.text.maxPromptLength !== undefined || lyrics?.maxLength !== undefined)
  const takesImages = maxInputImages(kind, model.images) > 0
  // A message to a model that does not read images carries no image part
  // (`inputImagesUsage`), so no image gets a name.
  const promptName = takesImages && model.imageInput !== false ? model.images?.references?.promptName : undefined
  return [
    USAGE_TEXTS.mediaRequest,
    ...(prompt === undefined ? [USAGE_TEXTS.noText] : [prompt, promptName === undefined ? USAGE_TEXTS.promptImages : referenceNamesUsage(promptName)]),
    ...(lyrics ? [lyricsHowTo(lyrics)] : []),
    ...(lengths ? [USAGE_TEXTS.textLengths] : []),
    ...inputImagesUsage(kind, model),
    ...(takesImages && facts.inputImages.size ? [USAGE_TEXTS.fitted] : []),
    ...(takesImages && facts.inputImages.limits ? [USAGE_TEXTS.limits] : []),
    ...(model.parameters ? [USAGE_TEXTS.parameters] : []),
    !isClipKind(kind) ? USAGE_TEXTS.imageResult : CLIP_KINDS[kind] === 'audio' ? USAGE_TEXTS.audioResult : USAGE_TEXTS.videoResult,
  ]
}

/** How to use `model`, as short sentences for a chat model: who sends a
 *  request, what goes in it, what the model needs, and what comes back. A
 *  model that Dez sends no request (the request `none`, or an output that
 *  Dez does not store) gets only a pointer to the reason. */
export function modelUsage(model: ModelInfo, facts: UsageFacts): string[] {
  const kind = effectiveRequest(model)
  if (kind === 'none' || model.unstoredOutput !== undefined) return [USAGE_TEXTS.cannotUse]
  return [USAGE_TEXTS.userSends, ...(kind === 'chat' ? chatUsage(model, facts) : mediaUsage(kind, model, facts))]
}
