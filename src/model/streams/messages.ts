import type { MessagePart, ModelRef, Section, SectionThinking, ThinkingReplay } from '../chat/types'
import { appTagsForRequest, appTagText, findAppTags } from '../chat/appTags'
import { assetTextPieces } from '../chat/assetMentions'
import { blockLinkedRule, COMPACTION_MESSAGE_INTRO, COMPACTION_USER_MESSAGE_LABEL, compactionMessageEnd, isCarriedUserAssets, partsImageReferences, sectionCompactionBlock, sectionLinkedRuleParts, sectionTextParts, type CompactionBlock, type LinkedRulePart } from '../chat/compaction'
import { messageFence, notesMessages } from '../chat/compactionNotes'
import { sectionIsEmpty, sectionPlainText } from '../chat/content'
import { findAssetMentions, type AssetMention } from '../chat/imageMentions'
import { findImageReferences, IMAGE_TOOL_KEY, type ImageReference, type LinkedPathRule } from '../chat/images'
import { findMediaTags, MEDIA_TOOL_ATTRIBUTE, mediaTagRequestText, mediaTagsForRequest, type MediaTag } from '../chat/mediaTags'
import { sameModelRef } from '../chat/modelRef'
import { SHOWN_PICTURE_OVER_LIMIT_NOTE } from '../chat/shownPictures'
import { holdsStoredFilePath, withoutStoredFilePaths } from '../chat/storedFilePaths'
import { thinkingField } from '../chat/thinking'
import { EMPTY_TOOL_RESULT, INTERRUPTED_TOOL_RESULT, agentTextForRequest, unescapedModelText, splitToolBlocks, type ToolBlock } from '../chat/toolBlocks'
import type { ClipAttachment } from '../providers/clipInputs'
import { minInputImages } from '../providers/clipImages'
import { imageLimitOf, messageImageLimitOf } from '../providers/modelFamilies'
import type { ClipInputRules, MediaKind, ModelInfo } from '../providers/types'
import { shownAppNames } from '../tools/appShow'
import { madeAssetIds } from '../tools/jobs'
import type { ToolCall, ToolResult } from '../tools/types'
import { conversationAssets, preparedMediaRequest, type MediaRequestInput } from './mediaRequest'
import type { RequestMessages, StreamMessage } from './types'

export interface RequestOptions {
  // False when the request model does not read images: the images of the
  // user messages (their references and the images that they mention)
  // then go as text only, and no picture goes.
  sendImages: boolean
  // False when the request offers no tools: an agent section's tool calls
  // then go as text (agentSectionMessages).
  sendTools: boolean
  // The most image and picture parts that the messages of the request
  // have together (`imageLimitOf`, providers/modelFamilies.ts). A part
  // over it does not go (`takesPart`), and
  // `RequestMessages.imagesOverLimit` counts it. Absent: no limit.
  imageLimit?: number
  // The most image and picture parts of one message: a user message, the
  // compaction message, or the picture message of a round
  // (`messageImageLimitOf`). A part over it does not go either. Absent:
  // no limit.
  messageImageLimit?: number
}

/** The image rules of a request to `model` (its entry of the model cache,
 *  or only its id): whether its images go, and its two image limits. A
 *  model that the cache does not know not to read images gets them. */
export function imageOptionsOf(model: Pick<ModelInfo, 'id' | 'imageInput' | 'imageLimit' | 'messageImageLimit' | 'learnedImageLimit'>): Pick<RequestOptions, 'sendImages' | 'imageLimit' | 'messageImageLimit'> {
  return { sendImages: model.imageInput !== false, imageLimit: imageLimitOf(model), messageImageLimit: messageImageLimitOf(model) }
}

// The request messages: every section that has text, in order. No path of a
// file that Dez stores or links ever goes to a provider: every text (user
// and agent text, prompt bodies, tool arguments and results) goes through
// `withoutStoredFilePaths`, so an image reference goes as `![id=a](image)`,
// with the ids and other metadata that later requests can name. A clip goes
// as its tag with only the id and the type (`mediaTagRequestText`), in a
// user section (a clip file that the user pasted or dropped) and in an
// agent section: no path and no signed URL. Each message
// is built from its own section and, for the images that it mentions, the
// sections before it.
//
// Every user message carries its images (image parts), unless `sendImages`
// is false: its image references, and the images that it names with an
// `@id` mention, however far back they are (`userMessageContent`). An
// image goes one time in a request, in the first message that holds or
// names it: a later message sends that image as its `![id=a](image)` text,
// or as the mention, only. An agent section's images go as text only: both
// formats take images only from the user. So to show a model an image that
// a model made, the user mentions it in a message, or the model calls
// `asset_view`, whose pictures go as `user` messages after the tool
// results of their round, from their saved copies
// (`agentSectionMessages`). They go in every later request of the
// conversation too, until a compaction takes their round out. A clip adds
// no part, neither its tag nor a mention of it (`@b`): only a media
// request sends clips (`messageClips`, `mediaRequestInput`), so the bytes
// of a chat request do not depend on them.
//
// A request has two limits of its image and picture parts: the count of
// all its messages (`RequestOptions.imageLimit`), and the count of one
// message (`messageImageLimit`). The parts are counted in the order of
// the messages, so when a conversation holds more of them than a limit,
// the newest ones of the request, or the last ones of a message, do not
// go, and the messages before them keep their bytes.
//
// A compacted conversation (chat/compaction.ts) starts with its compaction
// section, an agent section, and both wire formats need a `user` message
// first. So the compaction block goes as a `user` message, the compaction
// message (`addCompactionNotes`), and the text after the block goes as the
// agent messages of the reply that ran the compaction, with its thinking.
// The notes hold the messages of the user that the work needs in message
// parts (chat/compactionNotes.ts): each part goes as a text of the user
// (`addUserText`), with the images of its references, in a code fence. In
// a conversation that an older Dez compacted, the user sections right
// after the compaction section, up to the first later agent section, held
// these messages: they go in the same message, each one after its label.
// The message carries the pictures of the tag too. The compaction took
// every other image out of the conversation, so these are the ones that
// the model must still see. An image reference with the kept mark of a
// compaction (`IMAGE_KEPT_KEY`, chat/images.ts) is the exception: in this
// message it goes as its text only, so the model gets the id and no
// pixels. A mention of the user (`@a`) still sends such an image.
//
// An image or a clip that a Dez tool made is not text of the model, but
// its reference or tag is in the reply, at the start of the text of the
// round after the tool's group. An agent message leaves it out when a
// result of that group names the asset (`roundRequestText`): the result
// already tells the model the id. The tag of an app that `apps show`
// shows is in the same place, and goes by the same rule
// (chat/appTags.ts).
//
// Prompt cache: a message of the sections is the same bytes in every later
// request: it is built from its own section and the sections before it,
// and it keeps its image parts, and a round its picture message, when a
// newer message comes (the bytes of an image part and of a picture copy
// are the same at each read; `chatImage` and `shownPicturePart`,
// providers/selectors.ts). So the signed thinking replays go back too
// (their prefix is the same; `wireChat`, apiFormats.ts). The compaction
// message never changes by itself: it is the block alone when the reply
// that ran the compaction wrote text after it. Else (an old layout, or a
// reply with no text) its sections end at the first later agent section
// that is not empty, so a newer user message is no part of it
// (`compactionMessageEnd`).
export function sectionsToStreamMessages(sections: Section[], requestModel: ModelRef, options: RequestOptions): Omit<RequestMessages, 'sendTools'> {
  let imagesLeftOut = 0
  let newestUserMessage: string | MessagePart[] = ''
  // The images that a mention in the section at hand can name: the path of
  // each image id in the references of that section and of the sections
  // before it, user and agent. When two images have one id (a hand edit),
  // the last one wins. Later text is never read: not the sections after
  // the message, and for the messages of the notes, not the reply after
  // the compaction block. A message must keep its parts while the
  // conversation after it grows.
  const imagesById = new Map<string, string>()
  const addImageIds = (parts: readonly LinkedRulePart[]) => {
    for (const { id, path } of partsImageReferences(parts)) {
      if (id !== null) imagesById.set(id, path)
    }
  }
  // A model that reads no images gets no part, so no limit counts.
  const images = options.sendImages ? newRequestImages(options.imageLimit, options.messageImageLimit) : newRequestImages()
  const newestUser = sections.findLastIndex((section) => section.role === 'user' && !sectionIsEmpty(section))
  // The compaction message, and the index after its last section. The
  // compaction reads the same rule, so it and the request agree on which
  // sections the compaction message holds.
  const block = sections.length > 0 ? sectionCompactionBlock(sections[0]) : null
  const compaction = block === null ? null : newPartList()
  const compactionEnd = compactionMessageEnd(sections)
  const messages: StreamMessage[] = []
  // The message of the user as a message of its own, for a media request:
  // with every image that it holds or names, also one that an earlier
  // message of the chat request carries, and with no limit.
  const takeNewest = (messageText: string, rule: LinkedPathRule) => {
    const parts = userMessageContent(messageText, imagesById, newRequestImages(), rule)
    // The count is of the image parts that the message has for a model
    // that reads images, so the toast and the request always agree.
    if (parts !== null && !options.sendImages) imagesLeftOut = parts.filter((part) => part.type === 'image').length
    newestUserMessage = parts !== null && options.sendImages ? parts : withoutStoredFilePaths(userTextForRequest(messageText))
  }
  sections.forEach((section, index) => {
    if (sectionIsEmpty(section)) return
    const text = sectionPlainText(section)
    const ruleParts = sectionLinkedRuleParts(section, index)
    if (compaction !== null && block !== null && index === 0) {
      // The first part is the block; the reply after it is newer than the
      // messages of the notes, so its images get their ids only after them.
      addImageIds(ruleParts.slice(0, 1))
      addCompactionNotes(compaction, block, imagesById, images, options.sendImages)
      // With no user section, the newest message of the user is the last
      // message part of the notes.
      const newestPart = newestUser < 0 ? notesMessages(block.notes).at(-1) : undefined
      if (newestPart !== undefined) takeNewest(newestPart.text, blockLinkedRule(block))
      addImageIds(ruleParts.slice(1))
      messages.push(...agentSectionMessages(section, requestModel, options.sendTools, options.sendImages ? images : null, sectionTextParts(section, index).text))
      return
    }
    addImageIds(ruleParts)
    if (section.role === 'agent') {
      messages.push(...agentSectionMessages(section, requestModel, options.sendTools, options.sendImages ? images : null))
      return
    }
    if (compaction !== null && index < compactionEnd) {
      // The section of the carried assets of the user (an old layout) is
      // no message of the user, and its first line tells what it is.
      compaction.pendingText += isCarriedUserAssets(text) ? '\n\n' : `\n\n${COMPACTION_USER_MESSAGE_LABEL}\n`
      addUserText(compaction, text, imagesById, images, true)
    } else {
      startMessage(images)
      messages.push({ role: 'user', content: (options.sendImages ? userMessageContent(text, imagesById, images) : null) ?? withoutStoredFilePaths(userTextForRequest(text)) })
    }
    if (index === newestUser) takeNewest(text, 'user')
  })
  // Every section of the compaction message is before every other message.
  if (compaction !== null) {
    messages.unshift({ role: 'user', content: (options.sendImages ? messageParts(compaction) : null) ?? partListText(compaction) })
  }

  return { messages, imagesLeftOut, imagesOverLimit: images.overLimit.size, newestUserMessage }
}

// The text of a message of the user as a request sends it with no image
// part, before the path scrub: each media tag and each app tag in its
// request form, as `messageTextPieces` gives them to a message with image
// parts.
function userTextForRequest(text: string): string {
  return appTagsForRequest(mediaTagsForRequest(text))
}

/** The image and picture parts of the messages of one request while they
 *  are built: which images have a part, and how many more parts the
 *  request and the message at hand take. */
export interface RequestImages {
  // The images that a message has a part for. An image goes one time in a
  // request, so a later message sends it as text only.
  sent: Set<string>
  // How many image and picture parts the messages can still get
  // (`RequestOptions.imageLimit`).
  left: number
  // The most parts of one message (`RequestOptions.messageImageLimit`),
  // and how many the message at hand has.
  messageLimit: number
  inMessage: number
  // The images (their paths) and the pictures (the names of their copies)
  // that got no part, because the request or their message was full.
  overLimit: Set<string>
}

/** The parts of a request that takes at most `limit` of them, and at most
 *  `messageLimit` in one message, before its first message. */
export function newRequestImages(limit = Infinity, messageLimit = Infinity): RequestImages {
  return { sent: new Set(), left: limit, messageLimit, inMessage: 0, overLimit: new Set() }
}

// Starts the count of the parts of a new message. The compaction message
// is one message of several sections, so its sections share one count.
function startMessage(images: RequestImages): void {
  images.inMessage = 0
}

// Whether the message at hand still takes a part for the image or the
// picture `key` (a path, or the name of a picture copy). A part that it
// takes counts against both limits. An image that got no part in a full
// message can get one in a later message that names it; it is then no
// longer left out.
function takesPart(images: RequestImages, key: string): boolean {
  if (images.left <= 0 || images.inMessage >= images.messageLimit) {
    images.overLimit.add(key)
    return false
  }
  images.left -= 1
  images.inMessage += 1
  images.overLimit.delete(key)
  return true
}

// The parts of one message while it is built.
interface PartList {
  parts: MessagePart[]
  // The text since the last image or picture part.
  pendingText: string
}

function newPartList(): PartList {
  return { parts: [], pendingText: '' }
}

// Adds an image or a picture part after the text since the part before it.
// A whitespace-only text is left out: Anthropic refuses a text block with
// no visible text.
function addAttachment(list: PartList, part: Exclude<MessagePart, { type: 'text' }>): void {
  if (list.pendingText.trim() !== '') list.parts.push({ type: 'text', text: list.pendingText })
  list.pendingText = ''
  list.parts.push(part)
}

// The parts of a built message, with the text after its last image or
// picture (left out when it is whitespace only, as in `addAttachment`).
// Null for a message with no image and no picture.
function messageParts(list: PartList): MessagePart[] | null {
  if (list.parts.length === 0) return null
  return list.pendingText.trim() !== '' ? [...list.parts, { type: 'text', text: list.pendingText }] : list.parts
}

// The text of a built message, with no image and no picture.
function partListText(list: PartList): string {
  return list.parts.map((part) => (part.type === 'text' ? part.text : '')).join('') + list.pendingText
}

// Adds the start of the compaction message: the intro, the notes of
// `block` with no tag line and no end line, and, with `sendPictures`, the
// pictures of the tag, each one after its label. The text after the block
// is no part of it: it is the text of the reply that ran the compaction
// (`sectionsToStreamMessages`).
//
// The notes go as an agent message sends them: a clip as the request form
// of its tag, the model's text with its escape removed, and every text
// after the path scrub. But each image reference also gets its image
// part, right after its `![id=a](image)` text, unless it has the kept
// mark. The references are read with the rule of the block
// (`blockLinkedRule`), so a linked file counts only when the tag lists
// it: a model's text never makes Dez read another file of the computer.
// An `@id` mention adds no part here. A tool block (only a paste can put
// one into the notes) goes as its text.
//
// A message part of the notes (`notesMessages`) goes as a text of the
// user (`addUserText`), with the same rule: its text with no escape, its
// images, and the images of its mentions (`imagesById`). In place of its
// start line and its end line go the lines of a code fence
// (`messageFence`), so the model sees where the words of the user start
// and end; the image parts go at their places, inside the fence. Its
// heading goes as it is.
//
// A reference that is over the limit of `images` goes as its text only,
// and a picture that is over it does not go, with its label.
function addCompactionNotes(list: PartList, block: CompactionBlock, imagesById: ReadonlyMap<string, string>, images: RequestImages, sendPictures: boolean): void {
  const rule = blockLinkedRule(block)
  const notes = block.notes.trim()
  list.pendingText += notes === '' ? COMPACTION_MESSAGE_INTRO : `${COMPACTION_MESSAGE_INTRO}\n\n`
  let end = 0
  for (const message of notesMessages(notes)) {
    addNotesText(list, notes.slice(end, message.partFrom), rule, images)
    const fence = messageFence(message.text)
    list.pendingText += `${fence}\n`
    addUserText(list, message.text, imagesById, images, true, rule)
    list.pendingText += `\n${fence}`
    end = message.partTo
  }
  addNotesText(list, notes.slice(end), rule, images)
  if (!sendPictures) return
  // A label is text of the tag, which the user can edit, so it gets the
  // path scrub as every request text does.
  for (const picture of block.pictures) {
    if (!takesPart(images, picture.file)) continue
    list.pendingText += `\n\n${withoutStoredFilePaths(picture.label)}`
    addAttachment(list, { type: 'picture', picture })
  }
}

// Adds `notes`, a text of the notes out of the message parts, with the
// linked paths that count by `rule` (see `addCompactionNotes`). Code is
// model text as a gap is, with no image. An app tag is a line of Dez, in
// the text of its writer.
function addNotesText(list: PartList, notes: string, rule: LinkedPathRule, images: RequestImages): void {
  for (const piece of assetTextPieces(notes, rule)) {
    if (piece.kind === 'media' || piece.kind === 'codeTag') {
      list.pendingText += withoutStoredFilePaths(mediaTagRequestText(piece.tag))
      continue
    }
    if (piece.kind === 'app') {
      list.pendingText += appTagText(piece.tag.name)
      continue
    }
    const pieceText = notes.slice(piece.from, piece.to)
    if (piece.kind === 'gap' || piece.kind === 'code') {
      list.pendingText += withoutStoredFilePaths(unescapedModelText(pieceText))
      continue
    }
    list.pendingText += withoutStoredFilePaths(pieceText)
    if (piece.kept || !takesPart(images, piece.path)) continue
    images.sent.add(piece.path)
    addAttachment(list, { type: 'image', path: piece.path })
  }
}

/** What a media reply (a ModelInfo.request that is not `chat`) sends to
 *  dez.provider/generateMedia. `rules` is what the cache knows of the
 *  model's input, for the request's parameter values (`mediaInputRules`).
 *
 *  The source of the request is the newest user message as a message of
 *  its own (`RequestMessages.newestUserMessage`): its text, with no path,
 *  and with each image reference as its `![id=a](image)` text; the images
 *  that it holds and the ones that it names with an `@id` mention, in text
 *  order and each one once; and its clips (`messageClips`). Its tag lines
 *  are read by the rule of its text (`newestUserText`), so the names in
 *  the prompt and the clips agree. A chat request sends no clip: only a
 *  media request reads them. `preparedMediaRequest` (the code that the
 *  `model_invoke` tool shares) makes the request of that source: the cut
 *  to what the model takes, the names in the prompt, and the lyrics.
 *  `imagesLeftOut` and `clipsLeftOut` count the message's images and clips
 *  that the request does not take, so that the submit can tell the user.
 *
 *  When the message has no image, a request whose lowest image count is one
 *  (`minInputImages`) takes the newest image reference of `sections` (the
 *  tab's sections, in which the reply's own section is still empty; the
 *  references of each part of a section by its rule,
 *  `sectionLinkedRuleParts`), so that "Make it blue" or "Make it move"
 *  uses the image of the reply before. With no image there either, it gets
 *  no paths: the submit refuses the request (`missingImageProblem`), and
 *  generateMedia refuses it too. A model that needs more images takes no
 *  such image: one image can never meet its count, and the refusal tells
 *  the count of the message. A request with a video clip takes no such
 *  image: the video is the reference then, and neither refuses it. */
export function mediaRequestInput(
  kind: MediaKind,
  newestUserMessage: string | MessagePart[],
  sections: Section[],
  rules: ClipInputRules = {},
): MediaRequestInput {
  const parts: MessagePart[] = typeof newestUserMessage === 'string' ? [{ type: 'text', text: newestUserMessage }] : newestUserMessage
  const rule = newestUserText(sections)?.rule ?? 'user'
  const input = preparedMediaRequest(kind, { parts, clips: messageClips(sections), pathsById: conversationAssets(sections).images, rule }, rules)
  if (input.images.length + input.imagesLeftOut > 0 || input.clips.some((clip) => clip.kind === 'video') || minInputImages(kind, rules.images) !== 1) return input
  const newest = sections.map((section, index) => partsImageReferences(sectionLinkedRuleParts(section, index)).at(-1)).findLast((reference) => reference !== undefined)
  return { ...input, images: newest ? [newest.path] : [] }
}

// The newest message of the user in `sections`, as `sectionsToStreamMessages`
// takes it for `RequestMessages.newestUserMessage`: the text of the newest
// user section that is not empty, or with no such section, the last message
// part of the notes of a compaction. `rule` is the rule of the text
// (`messageTextPieces`), and `section` the index of the section that holds
// it. Null when there is no message.
function newestUserText(sections: readonly Section[]): { text: string, rule: LinkedPathRule, section: number } | null {
  const index = sections.findLastIndex((section) => section.role === 'user' && !sectionIsEmpty(section))
  if (index >= 0) return { text: sectionPlainText(sections[index]), rule: 'user', section: index }
  const block = sections.length > 0 ? sectionCompactionBlock(sections[0]) : null
  const part = block === null ? undefined : notesMessages(block.notes).at(-1)
  return block === null || part === undefined ? null : { text: part.text, rule: blockLinkedRule(block), section: 0 }
}

/** The clips of the newest user message of `sections` (`newestUserText`),
 *  in text order and each one once: its media tags (clip files that the
 *  user pasted or dropped) and the clips that it names with an `@id`
 *  mention (imageMentions.ts). A mention names the last media tag with
 *  that id in the message or in a section before it, user or agent. The
 *  message is read as `userMessageContent` reads it (`messageTextPieces`).
 *  An id that an image of the message or of an earlier section has is an
 *  image: its tag and its mentions add no clip. A mention of no image and
 *  no clip is plain text. The text keeps each mention as the user typed
 *  it. */
export function messageClips(sections: readonly Section[]): ClipAttachment[] {
  const message = newestUserText(sections)
  if (message === null) return []
  const clipsById = conversationAssets(sections.slice(0, message.section + 1)).clips

  const clips = new Map<string, ClipAttachment>()
  const add = (id: string) => {
    const clip = clipsById.get(id)
    if (clip && !clips.has(id)) clips.set(id, clip)
  }
  for (const piece of messageTextPieces(message.text, message.rule)) {
    if (piece.kind === 'media') add(piece.tag.id)
    else if (piece.kind === 'gap') for (const { id } of piece.mentions) add(id)
  }
  return [...clips.values()]
}

/** The ids that the `@id` mentions of `text`, the text of a user message,
 *  name, as a request reads them (`messageTextPieces`): no `@` in an image
 *  reference, a media tag, Markdown code, or a stored file path. */
export function messageMentionIds(text: string): Set<string> {
  return new Set(messageTextPieces(text).flatMap((piece) => (piece.kind === 'gap' ? piece.mentions.map(({ id }) => id) : [])))
}

/** The request messages of one agent section. A reply that called tools
 *  made one request round per group of calls, and the section holds them
 *  all: each round's text, then its `<dez:tool>` blocks. Each round becomes
 *  an agent message with the round's text (`roundRequestText`) and calls,
 *  then a tool message with their results; the text after the last group
 *  becomes the last agent message, left out when it is blank. A section
 *  with no blocks gives one agent message, the same bytes as before tools
 *  existed (saved prefix hashes depend on it). The stream controller builds
 *  the rounds of a running reply with this too, so the loop and every later
 *  request send the same bytes.
 *
 *  With `sendTools` false, a section with blocks is one agent message, with
 *  each block as text, and sends no thinking: a request with no tool
 *  definitions cannot hold tool calls.
 *
 *  With `images`, a round whose `asset_view` blocks name the saved copies
 *  of their pictures (`ToolBlock.pictures`) gets one `user` message right
 *  after its tool message: each picture after its label. The Anthropic
 *  format joins that message to the tool results before it
 *  (`withResultsJoined`, providers/apiFormats.ts). `dez.provider/streamChat`
 *  reads the copies, so each request that holds the round sends the same
 *  bytes: the prompt cache needs them, and so do the thinking replays, as
 *  a replay goes back only while the request before it hashes to its
 *  `prefixHash` (`wireChat`). `images` counts the picture parts against
 *  the image limits of the request (`takesPart`), and a picture over one
 *  goes as its label and a note. A picture is made only within what the
 *  context has left (streams/pictureBudget.ts), so that happens only for
 *  a model with lower limits than the one of the reply. A request with no
 *  tools sends no pictures: a call that is text has no round to put them
 *  after. With no `images` (a model that reads no images), no picture
 *  goes.
 *
 *  `text` is the text of the reply in the section: the whole text, or the
 *  text after the block of a compaction section (`sectionTextParts`). */
export function agentSectionMessages(section: Section, requestModel: ModelRef, sendTools: boolean, images: RequestImages | null = null, text = sectionPlainText(section)): StreamMessage[] {
  const rounds = agentRounds(text)
  // The first group's blocks are always in the first round; a section that
  // ends at its first group has only that round.
  if (!sendTools && rounds[0].blocks.length > 0) return [{ role: 'agent', content: textWithToolCalls(rounds) }]

  return rounds.flatMap((round, index): StreamMessage[] => {
    const content = withoutStoredFilePaths(roundRequestText(rounds, index))
    const thinking = roundThinking(section, requestModel, rounds, index)
    if (round.blocks.length === 0) return content.trim() === '' ? [] : [{ role: 'agent', content, ...thinking }]
    const messages: StreamMessage[] = [
      { role: 'agent', content, ...thinking, toolCalls: round.blocks.map(toolCall) },
      { role: 'tool', results: round.blocks.map(toolResult) },
    ]
    if (images === null) return messages
    startMessage(images)
    const pictures = round.blocks.flatMap((block) => pictureParts(block, images))
    if (pictures.length > 0) messages.push({ role: 'user', content: pictures })
    return messages
  })
}

// The parts of the pictures that the call of `block` showed its model:
// the label of each picture, then the picture by its saved copy, or a
// note when the request takes no more parts (`images`). A label is text
// of the block, which the user can edit, so it gets the path scrub as
// every request text does, and a label that the user made blank is left
// out, as in `addAttachment`.
function pictureParts(block: ToolBlock, images: RequestImages): MessagePart[] {
  return (block.pictures ?? []).flatMap((picture): MessagePart[] => {
    const label = withoutStoredFilePaths(picture.label)
    return [
      ...(label.trim() === '' ? [] : [{ type: 'text' as const, text: label }]),
      takesPart(images, picture.file) ? { type: 'picture', picture } : { type: 'text', text: SHOWN_PICTURE_OVER_LIMIT_NOTE },
    ]
  })
}

// The text of the round `index` as a request sends it, before the path
// scrub: the text that the model wrote (`agentTextForRequest`), without
// the references and the tags of the images and the clips that the tools
// of the group before the round made and named in their results
// (`madeAssetIds`, tools/jobs.ts), and without the tags of the apps that
// those results tell that Dez shows (`shownAppNames`, tools/appShow.ts).
//
// Dez writes such an asset after the group, so its text is the start of
// the model's own message of the next round. A model that reads two of
// its messages that start with a clip's tag ends its answer with a tag
// that it wrote itself, which the user sees as text (`ModelTextEscaper`);
// a sentence in the system prompt did not stop that. The result tells the
// model the id and the kind of each asset, so the request loses nothing.
//
// An asset that no result of that group names keeps its text: the model's
// own image, and the asset of a job whose result the model did not take
// (`settleJobs`, controller/stream.ts), which nothing else tells it of.
// So does the tag of an app that no result of that group names (a tag
// that the user moved there). The stored text never changes, and the
// stored result of a block never changes, so a round is the same bytes in
// every request.
function roundRequestText(rounds: readonly AgentRound[], index: number): string {
  const results = rounds[index - 1]?.blocks.map((block) => block.result) ?? []
  const made = new Set(results.flatMap(madeAssetIds))
  const shown = new Set(results.flatMap(shownAppNames))
  return agentTextForRequest(made.size === 0 && shown.size === 0 ? rounds[index].text : withoutToolAssets(rounds[index].text, made, shown))
}

// `text` without the image references and the media tags of the assets
// `ids` that have the mark of a Dez tool, and without the tags of the
// apps `apps`, which only Dez writes. Each one goes with the line breaks
// around it, which Dez wrote (`writeOwnParagraph` and `writeModelText`,
// controller/stream.ts); one blank line stays where text is on both sides.
// So a round that wrote only calls gives a blank text, and a round's
// answer starts with the model's own words.
function withoutToolAssets(text: string, ids: ReadonlySet<string>, apps: ReadonlySet<string>): string {
  const assets: { from: number, to: number }[] = [
    ...findImageReferences(text, 'agent').filter(({ id, metadata }) => id !== null && ids.has(id) && metadata.some((item) => item.key === IMAGE_TOOL_KEY)),
    ...findMediaTags(text, 'agent').filter(({ id, other }) => ids.has(id) && other.some((attribute) => attribute.name === MEDIA_TOOL_ATTRIBUTE)),
    ...findAppTags(text, 'agent').filter(({ name }) => apps.has(name)),
  ]
  let rest = text
  // From the last one, so that the offsets of the earlier ones still hold.
  for (const { from, to } of assets.sort((a, b) => b.from - a.from)) {
    const before = rest.slice(0, from).replace(/\n+$/, '')
    const after = rest.slice(to).replace(/^\n+/, '')
    rest = before !== '' && after !== '' ? `${before}\n\n${after}` : before + after
  }
  return rest
}

// One request round of an agent section: the text that the round wrote, and
// the group of calls that ended it. The last round has no calls. `before`
// and `after` are the `\n` that joins the text to the group before it and
// to its own group (blank on a side with no block): Dez wrote them, so they
// are no part of `text`.
interface AgentRound {
  text: string
  blocks: ToolBlock[]
  before: string
  after: string
}

// The stream controller writes one `\n` before each group of calls (none
// when the section is empty) and one `\n` after each block. After a round
// that wrote no text, that gives a blank line before the next group. So
// blocks with exactly one `\n` between them are one group, and any other
// text between two blocks is the text of the round between them. The `\n`
// that joins a text to a block is not model text: one is dropped on each
// side that touches a block, and the model's own line breaks stay. A block
// starts at the text start or after a `\n`, and ends at the text end or
// before a `\n`, so the text next to a block always has that `\n`.
function agentRounds(text: string): AgentRound[] {
  const pieces = splitToolBlocks(text)
  const rounds: AgentRound[] = [{ text: '', blocks: [], before: '', after: '' }]
  // splitToolBlocks never gives two text pieces in a row.
  pieces.forEach((piece, index) => {
    if (piece.kind === 'tool') {
      rounds[rounds.length - 1].blocks.push(piece.block)
      return
    }
    const afterBlock = index > 0
    const beforeBlock = index < pieces.length - 1
    if (afterBlock && beforeBlock && piece.text === '\n') return
    const from = afterBlock ? 1 : 0
    const to = piece.text.length - (beforeBlock ? 1 : 0)
    const round: AgentRound = { text: piece.text.slice(from, to), blocks: [], before: piece.text.slice(0, from), after: piece.text.slice(to) }
    if (afterBlock) rounds.push(round)
    else rounds[0] = round
  })
  return rounds
}

// The thinking of one round goes back only when `requestModel` wrote the
// section, the round has a replay, and neither holds a stored file path: a
// replay is valid only for the model that made it, a signed replay cannot be
// changed, and thinking with no replay (pasted, cut off, or split from
// inline tags) never goes back. A `field` replay sends the thinking text; the
// other kinds hold the thinking in their own JSON.
//
// The thinking of a round whose text holds an image of the model never goes
// back. A round that made an image has the provider's signature of that
// image as its replay (about 1 MB from a Gemini image model), and the
// request holds the image only as its reference text. The stream controller
// keeps no replay for such a round (`runChatRounds`, controller/stream.ts);
// conversations from before that rule still hold one. An image that a Dez
// tool made (`IMAGE_TOOL_KEY`) does not count: its reference is at the
// start of the text of the round after the tool's group, and the replay of
// that round is of the model's text only. That round can call a tool too,
// and some providers refuse a request that holds the calls of a round with
// no thinking.
//
// The first round has the section's `replay` and the text up to the first
// `rounds` entry. A later round has the entry whose `afterToolCall` is the
// first call of the group before it, and the text up to the next entry. A
// round with no entry had no thinking.
function roundThinking(section: Section, requestModel: ModelRef, rounds: AgentRound[], index: number): { thinking?: SectionThinking } {
  const { thinking } = section
  if (!thinking || !sameModelRef(section.model, requestModel)) return {}
  const madeByModel = ({ metadata }: ImageReference) => metadata.every((item) => item.key !== IMAGE_TOOL_KEY)
  if (findImageReferences(rounds[index].text, 'agent').some(madeByModel)) return {}

  const entries = thinking.rounds ?? []
  const textUpTo = (entry: number) => entries[entry]?.from ?? thinking.text.length
  if (index === 0) return sentThinking(thinking.text.slice(0, textUpTo(0)), thinking.replay)

  const afterToolCall = rounds[index - 1].blocks[0].id
  const entry = entries.findIndex((candidate) => candidate.afterToolCall === afterToolCall)
  if (entry < 0) return {}
  return sentThinking(thinking.text.slice(entries[entry].from, textUpTo(entry + 1)), entries[entry].replay)
}

function sentThinking(text: string, replay: ThinkingReplay | undefined): { thinking?: SectionThinking } {
  if (!replay || holdsStoredFilePath(text) || holdsStoredFilePath(JSON.stringify(replay))) return {}
  return thinkingField({ text, replay })
}

// A block's arguments are in definition order (toolBlocks.ts), so their JSON
// is the same bytes in every request.
function toolCall(block: ToolBlock): ToolCall {
  const args = Object.entries(block.arguments).map(([name, value]) => [name, typeof value === 'string' ? withoutStoredFilePaths(value) : value])
  return { id: block.id, name: block.name, arguments: Object.fromEntries(args) }
}

// Every call gets a result. A `running` block in a request has no tool run
// that will end it: the app stopped while the tool ran, or the user pasted
// the block. A submit during a tool run sends the final blocks that
// `dez.stream/endOutput` wrote.
function toolResult(block: ToolBlock): ToolResult {
  if (block.status === 'running') return { callId: block.id, content: INTERRUPTED_TOOL_RESULT, isError: true }
  const content = withoutStoredFilePaths(block.result)
  return { callId: block.id, content: content.trim() === '' ? EMPTY_TOOL_RESULT : content, isError: block.status === 'error' }
}

// The section as one text, for a request with no tools: the text of each
// round (`roundRequestText`) with its joins, as the section has them, and
// each block in place as plain text. The blocks of a group have one `\n`
// between them (`agentRounds`).
function textWithToolCalls(rounds: readonly AgentRound[]): string {
  const parts = rounds.map((round, index) => {
    const blocks = round.blocks.map((block) => {
      const call = toolCall(block)
      return `[Tool call: ${call.name} ${JSON.stringify(call.arguments)}]\n${toolResult(block).content}\n[End of tool result]`
    })
    return round.before + roundRequestText(rounds, index) + round.after + blocks.join('\n')
  })
  return withoutStoredFilePaths(parts.join(''))
}

// The content of a user message of one text: text and image parts in doc
// order (`addUserText`, which `rule` goes to). `images` are the images of
// the request that the message is a part of.
//
// Null for a text with no image part: the message then goes as its text
// (`sectionsToStreamMessages`). So a text-only request body is the same
// bytes as before images existed (the prefix hashes of saved thinking
// replays depend on it). A whitespace-only text after the last image is
// left out: Anthropic refuses a text block with no visible text.
function userMessageContent(text: string, imagesById: ReadonlyMap<string, string>, images: RequestImages, rule: LinkedPathRule = 'user'): MessagePart[] | null {
  const list = newPartList()
  addUserText(list, text, imagesById, images, false, rule)
  return messageParts(list)
}

// Adds the text of a message of the user to a message: text and image
// parts in doc order (`messageTextPieces`, with the linked paths that
// count by `rule`). Each image part comes right after its
// reference's text, `![id=a](image)`, at the end of the text part before
// it, so that a model can name the image by its id (and `promptWithNames`,
// mediaRequest.ts, finds that text). A media tag goes in its request form
// and adds no part. Markdown code adds no part: a reference, a tag, or a
// mention in it is text (a tag goes in its request form there too).
//
// An `@id` mention (imageMentions.ts) that names an image of `imagesById`
// counts as that image at that place: its image part comes right after the
// mention, which stays in the text as the user typed it. A mentioned image
// goes once, at its first mention. A mention of an image that the text
// itself holds adds no part: the reference sends that image.
//
// An image that an earlier message of the request has a part for
// (`images.sent`) adds no part here, neither for a reference nor for a
// mention: the model sees it there. But each reference of an image that
// this text sends first gets a part, also a second one of the same image:
// `promptWithNames` names a reference only when its part follows it.
//
// With `keptAsText` (the compaction message), a reference with the kept
// mark adds no part: only its text goes. A mention of that image then
// adds the part, as for an image that the text does not hold.
//
// An image that is over a limit of `images` adds no part (`takesPart`),
// and it is not marked as sent: a later message that names it can still
// give it its part.
function addUserText(list: PartList, text: string, imagesById: ReadonlyMap<string, string>, images: RequestImages, keptAsText = false, rule: LinkedPathRule = 'user'): void {
  const pieces = messageTextPieces(text, rule)
  const sendsImage = (piece: Extract<MessageTextPiece, { kind: 'reference' }>) => !(keptAsText && piece.kept) && !images.sent.has(piece.path)
  // The images that the references of this text send, and the ones of
  // them that got a part. `images.sent` gets the second ones only after
  // the text, so that each of their references sends.
  const own = new Set<string>()
  const taken = new Set<string>()
  for (const piece of pieces) {
    if (piece.kind === 'reference' && sendsImage(piece)) own.add(piece.path)
  }
  for (const piece of pieces) {
    switch (piece.kind) {
      case 'media':
        list.pendingText += withoutStoredFilePaths(mediaTagRequestText(piece.tag))
        break
      case 'text':
        list.pendingText += piece.text
        break
      case 'reference':
        list.pendingText += piece.text
        if (sendsImage(piece) && takesPart(images, piece.path)) {
          taken.add(piece.path)
          addAttachment(list, { type: 'image', path: piece.path })
        }
        break
      case 'gap': {
        // An image part after each mention that adds one.
        let start = 0
        for (const mention of piece.mentions) {
          const path = imagesById.get(mention.id)
          if (path === undefined || own.has(path) || images.sent.has(path) || !takesPart(images, path)) continue
          images.sent.add(path)
          list.pendingText += piece.text.slice(start, mention.to)
          addAttachment(list, { type: 'image', path })
          start = mention.to
        }
        list.pendingText += piece.text.slice(start)
      }
    }
  }
  for (const path of taken) images.sent.add(path)
}

// A run of the text of a user message, as a request reads it: a media tag,
// an image reference (its text after the path scrub, its path, and whether
// it has the kept mark of a compaction), a text between them (after the
// path scrub, with its `@id` mentions), or a text that names nothing: a
// run of Markdown code (after the path scrub, and a media tag in it in its
// request form), or an app tag (in the text of its writer).
type MessageTextPiece =
  | { kind: 'media', tag: MediaTag }
  | { kind: 'reference', text: string, path: string, kept: boolean }
  | { kind: 'gap', text: string, mentions: AssetMention[] }
  | { kind: 'text', text: string }

// The pieces of a user message's text, in order, with no empty gap
// (`assetTextPieces`, which the editor's mention chips read too), with the
// linked paths that count by `rule`: `'user'` for a user section, the rule
// of the block for a message part of the notes of a compaction. Every
// reader of a message's images, clips, and mentions uses it
// (`userMessageContent`, `messageClips`, `messageMentionIds`), so a mention
// names the same thing in a chat request, in a media request, and in the
// asset rules of a compaction. References and mentions are read in the
// text outside media tags and code, and mentions after the path scrub: a
// bare path can hold an `@`, and a cut there would send the start of the
// path.
function messageTextPieces(text: string, rule: LinkedPathRule = 'user'): MessageTextPiece[] {
  return assetTextPieces(text, rule).map((piece): MessageTextPiece => {
    if (piece.kind === 'media') return piece
    if (piece.kind === 'codeTag') return { kind: 'text', text: withoutStoredFilePaths(mediaTagRequestText(piece.tag)) }
    if (piece.kind === 'app') return { kind: 'text', text: appTagText(piece.tag.name) }
    const scrubbed = withoutStoredFilePaths(text.slice(piece.from, piece.to))
    if (piece.kind === 'code') return { kind: 'text', text: scrubbed }
    return piece.kind === 'reference'
      ? { kind: 'reference', text: scrubbed, path: piece.path, kept: piece.kept }
      : { kind: 'gap', text: scrubbed, mentions: findAssetMentions(scrubbed) }
  })
}
