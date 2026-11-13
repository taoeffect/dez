import type { MessagePart, Section } from '../chat/types'
import type { AssetKind } from '../chat/assetMentions'
import { sectionPlainText } from '../chat/content'
import { findAssetMentions } from '../chat/imageMentions'
import { findImageReferences, requestImageReferenceStart } from '../chat/images'
import { findMediaTags, sectionClipSource, type MediaTagKind } from '../chat/mediaTags'
import { withoutStoredFilePaths } from '../chat/storedFilePaths'
import { takesInputImages } from '../modelInputs'
import { clipTagProblem, maxInputClips, missingClipProblem, type ClipAttachment } from '../providers/clipInputs'
import { maxInputImages, missingImageProblem, unusedImagesProblem, type InputImageRules } from '../providers/clipImages'
import { clipText, clipTextProblem, type ClipText } from '../providers/clipText'
import { learnedImagesProblem } from '../providers/learnedImageLimit'
import type { RequestReader } from '../providers/requestReader'
import type { ClipInputRules, MediaKind, ModelInfo } from '../providers/types'

// The preparation of a media request (a `ModelInfo.request` that is not
// `chat`), which two callers share: the submit of a user message
// (`mediaRequestInput`, messages.ts) and the `model_invoke` tool, whose
// `prompt` argument takes the place of the message. Each caller reads its
// own source (`MediaRequestSource`); the cut to what the model takes, the
// names in the prompt, the lyrics, and the checks are the same code, so the
// two cannot drift apart. The differences are only these:
// - A message holds images and clips, and names others with `@id`. A tool
//   prompt is plain text: only its `@id` mentions are inputs.
// - A message with no image gets the newest image of the conversation for
//   a model that needs one (`mediaRequestInput`). A tool prompt does not.
// - A message with more inputs than the model takes is cut, and a toast
//   tells the user. A tool prompt with more is refused
//   (`promptRequestProblem`), because no one would see what went.

/** What a media request is made from, before the cut to what the model
 *  takes. */
export interface MediaRequestSource {
  /** The text, with an image part right after the text that names the
   *  image (the shape of the newest user message of a chat request). An
   *  image has one part, at its first place. */
  parts: MessagePart[]
  /** The clips, in text order and each one once. */
  clips: ClipAttachment[]
  /** The path of each image id that a mention of the text can name. */
  pathsById: ReadonlyMap<string, string>
}

/** What a media request sends to `dez.provider/generateMedia`, and the
 *  count of the source's images and clips that it leaves out. */
export interface MediaRequestInput extends ClipText {
  images: string[]
  imagesLeftOut: number
  clips: ClipAttachment[]
  clipsLeftOut: Record<MediaTagKind, number>
}

/** The images and the clips that an `@id` mention can name. */
export interface ConversationAssets {
  /** The path of each image id. */
  images: ReadonlyMap<string, string>
  /** The clip of each clip id that no image has. */
  clips: ReadonlyMap<string, ClipAttachment>
}

/** The images and the clips of `sections` by their ids: the image
 *  references and the media tags of each section, user and agent, with the
 *  rules of its role (a linked file counts only in a user section). Of two
 *  images or two clips with one id (a hand edit), the last one counts, and
 *  an id that an image and a clip both have names the image. */
export function conversationAssets(sections: readonly Section[]): ConversationAssets {
  const images = new Map<string, string>()
  const clips = new Map<string, ClipAttachment>()
  for (const section of sections) {
    const text = sectionPlainText(section)
    for (const { id, path } of findImageReferences(text, section.role)) {
      if (id !== null) images.set(id, path)
    }
    for (const { kind, id, type, src, url, expires } of findMediaTags(text)) {
      clips.set(id, { kind, id, type, src: sectionClipSource(src, section.role), url, expires })
    }
  }
  for (const id of images.keys()) clips.delete(id)
  return { images, clips }
}

/** An image or a clip that a tool prompt names. */
export interface PromptInput {
  id: string
  kind: AssetKind
}

/** The source of a request whose text is a tool's `prompt` argument. */
export interface PromptRequestSource extends MediaRequestSource {
  /** The images and the clips that the prompt names, in text order and
   *  each one once. */
  inputs: PromptInput[]
  /** The ids of the `@id` words of the prompt that name no image and no
   *  clip, in text order and each one once. */
  unknownIds: string[]
}

/** The source of a media request that a tool sends for a model: `prompt`
 *  is the text that the model wrote, and `assets` are the images and the
 *  clips of its conversation (`conversationAssets`).
 *
 *  Only an `@id` mention (imageMentions.ts) is an input: the image or the
 *  clip with that id, at the place of its first mention. The text keeps
 *  each mention as it is. An image reference or a media tag in the prompt
 *  is plain text and reads no file: a model could write the path of any
 *  file of the computer into one. So the prompt goes through the path
 *  scrub first, as every request text does. */
export function promptRequestSource(prompt: string, assets: ConversationAssets): PromptRequestSource {
  const text = withoutStoredFilePaths(prompt)
  const parts: MessagePart[] = []
  const clips = new Map<string, ClipAttachment>()
  const sentImages = new Set<string>()
  const inputs: PromptInput[] = []
  const unknownIds = new Set<string>()
  // The end of the text that the parts hold.
  let start = 0
  for (const mention of findAssetMentions(text)) {
    const path = assets.images.get(mention.id)
    const clip = assets.clips.get(mention.id)
    if (path !== undefined) {
      if (sentImages.has(path)) continue
      sentImages.add(path)
      inputs.push({ id: mention.id, kind: 'image' })
      parts.push({ type: 'text', text: text.slice(start, mention.to) }, { type: 'image', path })
      start = mention.to
    } else if (clip === undefined) {
      unknownIds.add(mention.id)
    } else if (!clips.has(clip.id)) {
      clips.set(clip.id, clip)
      inputs.push({ id: clip.id, kind: clip.kind })
    }
  }
  if (start < text.length) parts.push({ type: 'text', text: text.slice(start) })
  return { parts, clips: [...clips.values()], pathsById: assets.images, inputs, unknownIds: [...unknownIds] }
}

/** What a media request of `kind` sends of `source`, for a model with
 *  `rules`: what the cache knows of the model's input (its ModelInfo), with
 *  the image rules of the request's parameter values
 *  (`inputImageRulesFor`).
 *
 *  The images are the images of the source, in text order and each one
 *  once, as many as the model takes (`rules.images`, `maxInputImages`):
 *  for an edit, the first image is the one to edit; for a video, the first
 *  image is the first frame, and the second one is the last frame, or each
 *  one is a reference (`rules.images.references`); a new image takes them
 *  as references. The clips are the clips of the source, as many of each
 *  kind as the model takes (`rules.clips`, `maxInputClips`).
 *  `imagesLeftOut` and `clipsLeftOut` count what the request does not
 *  take.
 *
 *  The prompt is the text of the source. For a model whose prompt names
 *  its reference images (`rules.images.references.promptName`) or its
 *  clips (`rules.clips.<kind>.promptName`), each image and clip that goes
 *  gets that name instead (`promptWithNames`). For a model that takes
 *  lyrics (`rules.text`), a `Lyrics:` line splits that text into the
 *  prompt and the lyrics (`clipText`). */
export function preparedMediaRequest(kind: MediaKind, source: MediaRequestSource, rules: ClipInputRules = {}): MediaRequestInput {
  const sourceImages = [...new Set(source.parts.flatMap((part) => (part.type === 'image' ? [part.path] : [])))]
  const images = sourceImages.slice(0, maxInputImages(kind, rules.images))
  const imagesLeftOut = sourceImages.length - images.length

  const clipsTaken = { audio: 0, video: 0 }
  const clipsLeftOut = { audio: 0, video: 0 }
  const clips = source.clips.filter((clip) => {
    const taken = clipsTaken[clip.kind] < maxInputClips(rules.clips, clip.kind)
    if (taken) clipsTaken[clip.kind]++
    else clipsLeftOut[clip.kind]++
    return taken
  })

  const imagePromptName = rules.images?.references?.promptName
  const imageNames = new Map(imagePromptName === undefined ? [] : images.map((path, index) => [path, imagePromptName.replaceAll('{n}', String(index + 1))]))
  // Each kind has its own numbers, in request order: `@Audio1`, `@Video1`.
  const clipNames = new Map((['audio', 'video'] as const).flatMap((clipKind) => {
    const clipPromptName = rules.clips?.[clipKind]?.promptName
    if (clipPromptName === undefined) return []
    return clips.filter((clip) => clip.kind === clipKind).map((clip, index) => [clip.id, clipPromptName.replaceAll('{n}', String(index + 1))] as const)
  }))
  const prompt = imageNames.size === 0 && clipNames.size === 0
    ? source.parts.map((part) => (part.type === 'text' ? part.text : '')).join('')
    : promptWithNames(source.parts, imageNames, clipNames, source.pathsById)
  return { ...clipText(rules.text, prompt.trim()), images, imagesLeftOut, clips, clipsLeftOut }
}

// The text of `parts` (a request's source) for a model whose prompt names
// its reference images or its clips by their order in the request:
// `imageNames` has the name of each image that goes by its path (`@Image1`
// for the first), and `clipNames` the name of each clip that goes by its id
// (`@Audio1`). The name of an image takes the place of its reference text
// (`![image](id=a)`) and of each @id mention of it, and the name of a clip
// the place of its tag line and of each @id mention of it, as the guides of
// such models tell the user to write; the doc keeps the text as the user
// wrote it. The image part of a reference or of a first mention comes right
// after that text, at the end of the text part before it. An image or a
// clip with no name and a mention of nothing stay as they are. `pathsById`
// gives the image of each id (the ids are unique in a tab).
function promptWithNames(parts: readonly MessagePart[], imageNames: ReadonlyMap<string, string>, clipNames: ReadonlyMap<string, string>, pathsById: ReadonlyMap<string, string>): string {
  // `text` with each mention of an image or a clip that goes as its name.
  // A mention ends with a letter, so it is never part of a reference that
  // ends a text.
  const withNamedMentions = (text: string) => {
    let named = ''
    let start = 0
    for (const mention of findAssetMentions(text)) {
      const path = pathsById.get(mention.id)
      const name = path === undefined ? clipNames.get(mention.id) : imageNames.get(path)
      if (name === undefined) continue
      named += text.slice(start, mention.from) + name
      start = mention.to
    }
    return named + text.slice(start)
  }
  // The whole text, and the places in it that a name can take: the
  // reference text before each image part, and each tag line. Mentions are
  // named only between these places, as `userMessageContent` and
  // `messageClips` read them.
  let text = ''
  const places: { from: number, to: number, name: string | undefined }[] = []
  for (const [index, part] of parts.entries()) {
    if (part.type !== 'text') continue
    const next = parts[index + 1]
    const referenceStart = next?.type === 'image' ? requestImageReferenceStart(part.text) : null
    if (referenceStart !== null && next?.type === 'image') places.push({ from: text.length + referenceStart, to: text.length + part.text.length, name: imageNames.get(next.path) })
    text += part.text
  }
  for (const tag of findMediaTags(text)) places.push({ from: tag.from, to: tag.to, name: clipNames.get(tag.id) })
  places.sort((a, b) => a.from - b.from)

  let prompt = ''
  let start = 0
  for (const { from, to, name } of places) {
    if (from < start) continue
    prompt += withNamedMentions(text.slice(start, from)) + (name ?? text.slice(from, to))
    start = to
  }
  return prompt + withNamedMentions(text.slice(start))
}

/** What the checks of a media request read of its model. */
export type MediaRequestModel = Pick<ModelInfo, 'text' | 'clips' | 'learnedImageLimit'>

/** Why the request `input` of `kind` does not go to the model `modelName`,
 *  as a text for `reader`; null when it can go. `imageRules` are the image
 *  rules of the request's parameter values. Each check costs nothing and
 *  tells what to change: no clip for a model that changes or writes down a
 *  clip; a clip of a type that the model does not take, or an audio clip
 *  with no image or video that it needs; no image for a model that edits
 *  one, makes one larger, makes its video from one, or needs a reference
 *  image; more images than an earlier refusal of the provider told; no
 *  lyrics for a model that needs them; a prompt that is too short or too
 *  long.
 *
 *  A video clip is the reference of a request with no image. The learned
 *  count is checked against all the images of the source, before the cut
 *  to the most that the model's rules take, so that the request is refused
 *  and never cut to fewer images. Only a clip model has text rules. */
export function mediaRequestProblem(
  modelName: string,
  kind: MediaKind,
  model: MediaRequestModel,
  imageRules: InputImageRules | undefined,
  input: MediaRequestInput,
  reader: RequestReader = 'user',
  now = Date.now(),
): string | null {
  const sentVideo = input.clips.some((clip) => clip.kind === 'video')
  return missingClipProblem(modelName, kind, input.clips, reader)
    ?? clipTagProblem(modelName, model.clips, input.clips, input.images.length, now, reader)
    ?? (sentVideo ? null : missingImageProblem(modelName, kind, input.images.length, imageRules, reader))
    ?? learnedImagesProblem(modelName, model.learnedImageLimit, input.images.length + input.imagesLeftOut, reader)
    ?? clipTextProblem(modelName, model.text, input)
}

/** Why the request of a tool prompt does not go to the model `modelName`,
 *  as a text for the model that wrote the prompt; null when it can go.
 *  `input` is what `preparedMediaRequest` made of `source`.
 *
 *  A prompt that names more images or clips than the model takes is
 *  refused, where a user message is cut: the user sees a toast about the
 *  inputs that did not go, and a model would see nothing and get a result
 *  that leaves out an input that it meant. Images count as inputs only for
 *  a model that Dez sends images to (`takesInputImages`). Then come the
 *  checks of every media request (`mediaRequestProblem`). */
export function promptRequestProblem(
  modelName: string,
  kind: MediaKind,
  model: MediaRequestModel & Pick<ModelInfo, 'imageInput'>,
  imageRules: InputImageRules | undefined,
  source: MediaRequestSource,
  input: MediaRequestInput,
  now = Date.now(),
): string | null {
  const maxImages = takesInputImages(kind, model.imageInput, imageRules) ? input.images.length : 0
  const imagesProblem = unusedImagesProblem(modelName, maxImages, input.images.length + input.imagesLeftOut)
  if (imagesProblem !== null) return imagesProblem
  // The count texts of `clipTagProblem` are for clips that no one cut.
  const clipsProblem = input.clipsLeftOut.audio + input.clipsLeftOut.video > 0
    ? clipTagProblem(modelName, model.clips, source.clips, input.images.length, now, 'model')
    : null
  return clipsProblem ?? mediaRequestProblem(modelName, kind, model, imageRules, input, 'model', now)
}
