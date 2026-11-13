import type { MediaTagKind } from '../chat/mediaTags'
import { effectiveOutputs } from '../modelOutputs'
import { imagesText, maxInputImages, minInputImages } from '../providers/clipImages'
import { clipsText, maxInputClips, neededClipKind, type ClipUse, type InputClipRules } from '../providers/clipInputs'
import { lyricsHowTo } from '../providers/clipText'
import { toolsApply } from '../providers/modelToggles'
import { TOOLS_SETTING_KEY } from '../providers/toolsSetting'
import { CLIP_KINDS, effectiveRequest, isClipKind, isTextKind, type MediaKind, type ModelInfo, type NoPromptKind, type ProviderInputImageRules } from '../providers/types'

// The `usage` of a `model_info` result: how a request to a model is formed,
// what it needs, and what comes back. Each text tells what the code that
// builds the request does (`dez.model/streamMessagesForTab`,
// `mediaRequestInput`, `clipText`, `dez.provider/generateMedia`), and
// modelUsage.test.ts runs that code to check each choice of a text. The
// texts are about the model: they name no image and no file of the
// conversation.

const SETTINGS_POPUP = 'the provider settings popup (the gear button next to the model picker)'

// The start of the first text of a model that takes a request of
// `model_invoke`: the texts after it tell of a message of the user.
const INVOKE_LEAD = 'You can send this model a request with `model_invoke`. The user can too: they choose it in the model picker of the bottom bar, write a message, and send it. '
  + 'The sentences after these tell of such a message. '

export const USAGE_TEXTS = {
  // A `model_invoke` call to a text model sends another request than a
  // message of the user (`chatContent`, modelInvoke.ts; `invokeTextModel`,
  // controller/modelInvoke.ts), and this text tells each difference. It
  // names no "other" model: a call can name the model that reads it.
  invokeSendsChat: INVOKE_LEAD
    + 'A `model_invoke` call sends another request: it holds only `prompt`, with no conversation and no system prompt, and the model gets no Dez tools. '
    + 'An image goes only when `prompt` names it with @id. '
    + 'Dez refuses a call whose `prompt` names a clip, and a call that names an image for a model that does not read images. '
    + 'The text of the answer comes only as the result of the job, not into the reply.',
  // A `model_invoke` call to a media model sends the same request as a
  // message of the user, but for the differences that
  // streams/mediaRequest.ts and controller/modelInvoke.ts have, which
  // this text tells.
  invokeSends: INVOKE_LEAD
    + 'For a `model_invoke` call, read `prompt` for the message, with these differences. '
    + 'An image or a clip goes only when `prompt` names it with @id, and the newest image of the conversation never goes by itself. '
    + 'Dez refuses a call with more images or clips than the model takes. '
    + 'A value in `parameters` of the call goes in place of the `value` of that parameter in `dez.parameters`. '
    + 'Text that the model makes comes only as the result of the job, not into the reply.',
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
  newestImageOrVideo: 'With no image and no video clip in the message, the newest image of the conversation goes.',
  newestImageOnly: 'It does not read images, so only the newest image of the conversation goes.',
  fitted: 'Dez sends a fitted copy (cropped or scaled) of an image that breaks `dez.images.size`.',
  limits: 'Dez refuses an image that breaks `dez.images.limits`.',
  frames: 'The first one is the first frame of the video, and the second one is the last frame.',
  firstFrame: 'It is the first frame of the video.',
  // No request field sets this: a model that starts from a frame keeps the
  // shape of that frame (the square clips of a square first image), and
  // nothing else tells the calling model so.
  frameShape: 'The video usually gets the shape (the aspect ratio) of its first frame, so give an image that has the shape that the video must have; the image tool can crop one.',
  videoReferences: 'They are references for the video, not frames of it.',
  clipsMakeReferences: 'With a clip in the message (pasted, or named with @id), the images go as references for the video, not as its frames.',
  parameters: `Each request sends the \`value\` of each of \`dez.parameters\`; the user sets them under "Model Parameters" in ${SETTINGS_POPUP}.`,
  imageResult: 'It answers with an image, which goes into the reply with a new id (@id).',
  audioResult: 'It answers with an audio clip, which the reply shows as a player with a new id.',
  videoResult: 'It answers with a video clip, which the reply shows as a player with a new id.',
  transcriptResult: 'It answers with the words of the speech, which go into the reply as text.',
  noClips: 'It takes no input clip: the clips of the message (pasted, or named with @id) do not go.',
  // `clipTagProblem`, `clipFileProblem` (clipInputs.ts). The refusal of a
  // clip names the same tools (`fixText` there): keep the two the same.
  clipRules: 'Dez refuses a clip that breaks the rules of its kind in `dez.clips` (media types, seconds, bytes). Dez cuts and converts no clip by itself. '
    + 'A Dez tool can make a new clip that fits: the audio tool cuts an audio clip, and the video tool (its ffmpeg subcommand) cuts and converts audio and video clips.',
  wavCopy: 'An audio clip of a type that it does not take goes as a WAV copy.',
  audioNeedsVisual: 'An audio clip goes only together with an image or a video clip.',
} as const

// What follows each text about the names that a model gives its inputs:
// a model that reads only the name writes it next to the `@id`, and Dez
// then sends the name twice.
const NAMES_ARE_PUT_IN = 'Dez puts these names in: write only the @id in the prompt, never such a name.'

// The prompt of a model that names its reference images (`promptName`,
// `mediaRequestInput`): the names of the first two images show the form.
export function referenceNamesUsage(promptName: string): string {
  const name = (n: number) => `\`${promptName.replaceAll('{n}', String(n))}\``
  return `Each image that goes is named in the prompt as the model names it, ${name(1)} for the first, ${name(2)} for the second, and so on, in place of its id text (such as \`![image](id=a)\`) and its @id mentions; any other image goes into the prompt as its id text. ${NAMES_ARE_PUT_IN}`
}

// What a model does with the clips of a kind (`ClipKindRules.use`).
const CLIP_USE_USAGE: Readonly<Record<ClipUse, string>> = {
  reference: 'They are references for the video (a look, a motion, a voice, a sound).',
  background: 'It is the sound of the video, as it is.',
  voice: 'Each one is the voice of one reference, in order: the first audio clip is the voice of the first image, with the images first and then the video clips.',
  source: 'It is the clip that the model changes or writes down.',
}

// A model that makes nothing without a clip of `kind` (`neededClipKind`,
// `missingClipProblem`).
export function neededClipUsage(kind: MediaTagKind): string {
  return `Dez refuses a message with no ${kind} clip.`
}

/** How many clips of `kind` of the message (pasted, or named with @id) a
 *  request takes, with at most `max` (`maxInputClips`, more than 0). */
export function takenClipsUsage(kind: MediaTagKind, max: number): string {
  const taken = max === Infinity ? `every ${kind} clip` : max === 1 ? clipsText(1, kind) : `up to ${clipsText(max, kind)}`
  return `It takes ${taken} of the message (pasted, or named with @id)${max === 1 ? '' : ', in text order'}.`
}

// The prompt of a model that names its clips of `kind` (`promptName`,
// `mediaRequestInput`): the names of the first two clips show the form.
export function clipNamesUsage(kind: MediaTagKind, promptName: string): string {
  const name = (n: number) => `\`${promptName.replaceAll('{n}', String(n))}\``
  return `Each ${kind} clip that goes is named in the prompt as the model names it, ${name(1)} for the first, ${name(2)} for the second, and so on, in place of its tag and its @id mentions. ${NAMES_ARE_PUT_IN}`
}

// A model that takes the clips of `kind` only by their web address
// (`ClipKindRules.urlOnly`, `clipTagProblem`). A clip that the `audio` or
// the `video` tool made has no web address: Dez stores its file at once.
export function urlOnlyClipsUsage(kind: MediaTagKind): string {
  const clip = kind === 'audio' ? 'an audio clip' : 'a video clip'
  const lead = kind === 'audio' ? 'An audio clip' : 'A video clip'
  return `${lead} goes only by its web address, which the provider downloads: only a clip that a model made goes, while its address works (the tag's \`expires\`). Dez refuses ${clip} that is only a file (pasted, dropped, or made by the audio tool or the video tool).`
}

// What the input clips of a request are (`mediaRequestInput`), and what
// generateMedia checks and converts. Of the kinds that take clips, only a
// video model can have no clip rules (`MediaFormat.clipRules`), so only a
// video model gets told that it takes none. A model that needs a clip
// (`neededClipKind`) gets told so with or without rules, as the submit
// refuses a message with no such clip either way.
function inputClipsUsage(kind: MediaKind, clips: InputClipRules | undefined): string[] {
  const needed = neededClipKind(kind)
  const neededText = needed ? [neededClipUsage(needed)] : []
  if (!clips) return [...(isClipKind(kind) && CLIP_KINDS[kind] === 'video' ? [USAGE_TEXTS.noClips] : []), ...neededText]
  const kinds = (['audio', 'video'] as const).flatMap((clipKind) => {
    const rules = clips[clipKind]
    if (!rules) return []
    return [
      takenClipsUsage(clipKind, maxInputClips(clips, clipKind)),
      CLIP_USE_USAGE[rules.use],
      ...(rules.promptName === undefined ? [] : [clipNamesUsage(clipKind, rules.promptName)]),
      ...(rules.urlOnly ? [urlOnlyClipsUsage(clipKind)] : []),
    ]
  })
  return [
    ...kinds,
    ...neededText,
    ...(clips.audioNeedsVisual ? [USAGE_TEXTS.audioNeedsVisual] : []),
    USAGE_TEXTS.clipRules,
    ...(clips.audio?.types?.includes('audio/wav') ? [USAGE_TEXTS.wavCopy] : []),
  ]
}

// What the text of the message is to a model of each media kind (none:
// the text does not go, `NO_PROMPT_KINDS`; the type keeps the two tables
// the same), and what its input images are (none: no model of the kind
// takes images, as far as the media formats tell).
type MediaUsage = { [Kind in MediaKind]: { images?: string } & (Kind extends NoPromptKind ? { prompt?: never } : { prompt: string }) }

const MEDIA_USAGE: Readonly<MediaUsage> = {
  image: { prompt: 'The text of the message is the prompt.', images: 'They are references for the new image.' },
  imageEdit: { prompt: 'The text of the message tells what to change.', images: 'The first one is the image to edit, and the others are references.' },
  upscale: { images: 'It makes that image larger.' },
  tts: { prompt: 'The text of the message is the text that it speaks.' },
  music: { prompt: 'The text of the message is the prompt (for a song: its style).' },
  video: { prompt: 'The text of the message is the prompt.', images: USAGE_TEXTS.frames },
  imageToVideo: { prompt: 'The text of the message is the prompt.', images: USAGE_TEXTS.frames },
  // A video upscale model takes no prompt (mediaFormats.ts).
  videoToVideo: { prompt: 'The text of the message tells what to change; a video upscale model gets no text.', images: 'It is a reference for the new video, such as the person that a motion control model moves.' },
  voiceChange: {},
  transcription: {},
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
  const min = minInputImages(kind, model.images)
  // With no image in the message, only a model that needs exactly one image
  // gets the newest image of the conversation (`mediaRequestInput`).
  const takesNewest = min === 1
  if (max === 0) return [USAGE_TEXTS.noImages]
  // A message to a model that is known not to read images carries no
  // image (`dez.model/streamMessagesForTab`), so only the fallback of
  // `mediaRequestInput` gives one.
  if (model.imageInput === false) return [takesNewest ? USAGE_TEXTS.newestImageOnly : USAGE_TEXTS.noImagesRead]
  const frames = !model.images?.references && MEDIA_USAGE[kind].images === USAGE_TEXTS.frames
  const role = model.images?.references ? USAGE_TEXTS.videoReferences : frames && max === 1 ? USAGE_TEXTS.firstFrame : MEDIA_USAGE[kind].images
  // A video request with a reference clip sends its images as references
  // too, whatever the image rules (OpenRouter: frames would drop the clips;
  // mediaFormats.ts). A background clip keeps the frames (Venice).
  const clipsMakeReferences = frames && (model.clips?.audio?.use === 'reference' || model.clips?.video?.use === 'reference')
  // A video clip takes the place of the newest image (`mediaRequestInput`).
  const newest = model.clips?.video ? USAGE_TEXTS.newestImageOrVideo : USAGE_TEXTS.newestImage
  return [
    `It takes ${takenImages(min, max)} of the message (pasted, or named with @id)${max === 1 ? '' : ', in text order'}.`,
    ...(role === undefined ? [] : [role]),
    ...(frames ? [USAGE_TEXTS.frameShape] : []),
    ...(clipsMakeReferences ? [USAGE_TEXTS.clipsMakeReferences] : []),
    ...(takesNewest ? [newest] : []),
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
    ...inputClipsUsage(kind, model.clips),
    ...(model.parameters ? [USAGE_TEXTS.parameters] : []),
    isTextKind(kind) ? USAGE_TEXTS.transcriptResult : !isClipKind(kind) ? USAGE_TEXTS.imageResult : CLIP_KINDS[kind] === 'audio' ? USAGE_TEXTS.audioResult : USAGE_TEXTS.videoResult,
  ]
}

/** How to use `model`, as short sentences for a chat model: who sends a
 *  request, what goes in it, what the model needs, and what comes back. A
 *  model that Dez sends no request (the request `none`, or an output that
 *  Dez does not store) gets only a pointer to the reason. The first
 *  sentence tells that `model_invoke` takes the model (`modelInvocation`,
 *  modelInvoke.ts), and how a call differs from a message of the user. */
export function modelUsage(model: ModelInfo, facts: UsageFacts): string[] {
  const kind = effectiveRequest(model)
  if (kind === 'none' || model.unstoredOutput !== undefined) return [USAGE_TEXTS.cannotUse]
  return kind === 'chat'
    ? [USAGE_TEXTS.invokeSendsChat, ...chatUsage(model, facts)]
    : [USAGE_TEXTS.invokeSends, ...mediaUsage(kind, model, facts)]
}
