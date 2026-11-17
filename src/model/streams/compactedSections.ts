import { assetTextPieces } from '../chat/assetMentions'
import { compactionBlockText, partsImageReferences, sectionCompactionBlock, sectionLinkedRuleParts } from '../chat/compaction'
import { compactionNotesText, notesLeftOutMessages, type NotesAsset } from '../chat/compactionNotes'
import { sectionPlainText, textNode } from '../chat/content'
import type { ConversationCost } from '../chat/conversationCost'
import { findImageReferences, imageReferenceTextWithKeptMark, isKeptImage, linkedPathCounts, type ImageReference, type LinkedPathRule } from '../chat/images'
import { compareMediaIds, highestConversationMediaId } from '../chat/mediaIds'
import { findMediaTags, isLinkedMediaPath, mediaTagTextWithKeptMark } from '../chat/mediaTags'
import { cloneModelRef, modelRefField } from '../chat/modelRef'
import type { ShownPicture } from '../chat/shownPictures'
import type { ModelRef, Section } from '../chat/types'
import type { ImageTokenRule } from '../providers/modelFamilies'
import type { JobInfo } from '../tools/jobs'
import { compactionScope, keptMiddleMessages, type AssetChoice, type CompactionAsset, type KeptMessage } from './compactionAssets'
import type { CompactionAnswer } from './compactionRequest'
import { foundAssetFrom } from './mediaRequest'
import { sectionsToStreamMessages } from './messages'
import { budgetAfter, contextImageCost, type PictureBudget } from './pictureBudget'

// The sections of a conversation after a compaction, in place of the
// sections up to the reply that runs: one agent section, the section of
// that reply (the compaction section). It holds the compaction block,
// which holds the notes (chat/compaction.ts, chat/compactionNotes.ts),
// then a line break, and the reply goes on after it. It keeps the id and
// the model of the reply, so the reply keeps one AGENT pill; its thinking
// starts new, as the text of the reply does. The end of the reply sets
// its time (`endStreamSection`): the time of the whole reply. With no
// section of the reply, it gets a new id and the model of the compaction. A
// request sends the block as one message of the user, the compaction
// message (messages.ts), which stays the same bytes until the next
// compaction.
//
// The notes hold the messages of the user that the work needs word for
// word, each in a message part: the first one, the middle ones that the
// model kept (`keptMiddleMessages`), and the final one, the one that the
// reply answers. So the sections of the user leave the conversation. A
// later compaction copies these messages from the notes before, and the
// model can drop a middle one then. Every other image and clip that stays
// has its reference or tag in the notes, with its line: also one of a
// middle message that the model dropped. The user gave the linked files
// of these texts, so the tag lists them (`linked`), and they still count
// in the block. No text of a model makes Dez read a file of the computer:
// a path that the old texts did not count, the new block does not count.
//
// What a model sees of an asset follows its decision (`assetDecisions`):
// a `show` asset goes as pixels (an image as it is, a clip as the picture
// of the tag), and a `keep` asset as text only, which its kept mark tells
// (`IMAGE_KEPT_KEY`, `MEDIA_KEPT_ATTRIBUTE`). The images of the kept
// messages are a part of the user's words, so they go as pixels by
// themselves, within the limits of step 1 below, and a decision changes
// nothing for them.
//
// Pictures are costly, so they have a budget. This module builds the
// sections, asks the request builder for the compaction message, and
// counts its image and picture parts (`contextImageCost`): an `@id`
// mention of the user adds an image part only when no reference sent that
// image, so the cost of a message is not the sum of its assets.
// 1. The message must be in the limits of a compacted conversation
//    (`compactedPictureLimits`, pictureBudget.ts): a share of the limits
//    of one request, so that the reply can still view pictures and the
//    next compaction is due only after new ones came, and at most the
//    images of one message. While it is not, one more image of the kept
//    messages goes as text (the kept mark; the user still sees it in the
//    summary chip), from the oldest message to the final one: the first
//    message, then the middle ones from the oldest, then the final one,
//    each from its last image back. An image that Dez cannot read goes as
//    text at once: a request with it would fail each time.
// 2. The `show` assets get what the images of step 1 leave of those
//    limits, in the order of the answer's lines. One that does not fit is
//    kept as text, and a smaller one after it can still fit.

/** What `compactedSections` needs. */
export interface CompactedSectionsInput {
  /** The sections of the tab. */
  sections: readonly Section[]
  /** The id of the section of the reply that runs: at a submit, the empty
   *  section of the new reply. */
  replySectionId: string
  /** The model that wrote the answer. */
  model: ModelRef
  /** What the compaction does with each asset (`assetDecisions`). */
  choices: readonly AssetChoice[]
  answer: CompactionAnswer
  /** The jobs of the reply that runs (`CompactionInput.jobs`). */
  jobs: readonly JobInfo[]
  /** The inputs of the open jobs of `jobs` (`openJobInputs`): the notes
   *  tell them to the model, as their start blocks leave. */
  jobInputs: ReadonlyMap<string, readonly string[]>
  /** The cost of the conversation with the compaction request. */
  cost: ConversationCost | undefined
  /** The saved picture of each clip that the model wants to see, by the
   *  id of the clip. A clip with none is kept as text. */
  clipPictures: ReadonlyMap<string, ShownPicture>
  /** The model reads images. Else no asset is shown. */
  sendImages: boolean
  /** The most that the images and the pictures of the compaction message
   *  can cost (`compactedPictureLimits`). */
  limits: PictureBudget
  /** How the model counts the tokens of an image. */
  rule: ImageTokenRule
  /** How many bytes a request sends for each image of the sections that
   *  Dez can read, by its path. An image with no entry goes as text. */
  imageBytes: ReadonlyMap<string, number>
  /** A new section id. */
  newId: () => string
}

/** The result of a compaction. */
export interface CompactedSections {
  sections: Section[]
  /** The assets that left the conversation. */
  dropped: CompactionAsset[]
  /** The pictures that the tag of the compaction section names: the ones
   *  of `clipPictures` that fit. */
  pictures: ShownPicture[]
}

// What goes as pixels: the ids of the `show` assets that do, and the keys
// (`imageKey`) of the images of the kept messages that do not.
interface Plan {
  shown: ReadonlySet<string>
  asText: ReadonlySet<string>
}

// The key of the image reference at `from` in the text of a kept message:
// `message` is the place of the message in the kept messages, from 0 for
// the first message.
function imageKey(message: number, from: number): string {
  return `${message}:${from}`
}

// The image references of `text`, a kept message whose linked paths count
// by `rule`, as a request reads them (`assetTextPieces`: a reference in a
// media tag is none), with offsets in `text`.
function messageReferences(text: string, rule: LinkedPathRule): ImageReference[] {
  return assetTextPieces(text, rule).flatMap((piece) => (piece.kind === 'reference'
    ? findImageReferences(text.slice(piece.from, piece.to), rule).map((reference) => ({ ...reference, from: piece.from, to: piece.to }))
    : []))
}

// The text of `message` (its place, as for `imageKey`) with the kept mark
// on the images of `asText` and on no other image. The marks of a message
// are set new at each compaction.
function withKeptMarks({ text, rule }: KeptMessage, message: number, asText: ReadonlySet<string>): string {
  let marked = ''
  let end = 0
  for (const reference of messageReferences(text, rule)) {
    const kept = asText.has(imageKey(message, reference.from))
    if (kept === isKeptImage(reference)) continue
    marked += text.slice(end, reference.from) + imageReferenceTextWithKeptMark(reference, kept)
    end = reference.to
  }
  return marked + text.slice(end)
}

// The linked paths that count in `text`, whose linked paths count by
// `rule`: the ones of its image references and of its media tags.
function linkedPathsOf(text: string, rule: LinkedPathRule): string[] {
  return [
    ...findImageReferences(text, rule).filter((reference) => reference.linked).map((reference) => reference.path),
    ...findMediaTags(text).flatMap(({ src }) => (src !== null && isLinkedMediaPath(src) && linkedPathCounts(src, rule) ? [src] : [])),
  ]
}

/** The sections of a tab after a compaction; see the top of this file. */
export function compactedSections(input: CompactedSectionsInput): CompactedSections {
  const { sections, model, choices, answer, clipPictures, imageBytes } = input
  const scope = compactionScope(sections, input.replySectionId)
  const keptMiddle = keptMiddleMessages(scope, answer)
  // The messages that the notes quote, in their order.
  const messages = [scope.first, ...keptMiddle, scope.last].filter((message) => message !== null)
  const noteId = input.newId()
  const oldBlock = sections.length > 0 ? sectionCompactionBlock(sections[0]) : null
  // The count of the middle messages that the notes leave out: the ones
  // that the notes before left out, and the ones that this answer drops.
  const leftOutMessages = (oldBlock === null ? 0 : notesLeftOutMessages(oldBlock.notes)) + scope.middle.length - keptMiddle.length
  const lastId = highestConversationMediaId(sections.map(sectionPlainText))
  const staying = choices.filter((choice) => choice.decision !== 'drop').sort((a, b) => compareMediaIds(a.asset.asset.id, b.asset.asset.id))
  const dropped = choices.filter((choice) => choice.decision === 'drop').map((choice) => choice.asset)
  // Whether the text at `from` of the plain text of the section `section`
  // is in one of the kept messages.
  const inMessage = (section: number, from: number) => messages.some((message) => message.section === section && from >= message.from && from < message.to)
  // An image of the kept messages: the message sends it, so a `show` adds
  // nothing for it. A clip of these messages still needs its picture.
  const isMessageImage = ({ asset }: AssetChoice) => asset.asset.kind === 'image' && inMessage(asset.asset.section, foundAssetFrom(asset.asset))
  // The references of the images with no id (an image of an old Dez) out
  // of the kept messages, in section and text order: the notes keep them
  // as text. The compaction section holds the ones of the compaction
  // before.
  const unnamed = sections.slice(0, scope.end).flatMap((section, index) => partsImageReferences(sectionLinkedRuleParts(section, index))
    .filter((reference) => reference.id === null && !inMessage(index, reference.from)))
  // The linked paths that the new block holds and that count where they
  // are now: in the kept messages, in the text of a kept asset, and in an
  // image with no id.
  const linked = new Set<string>()
  for (const message of messages) {
    linkedPathsOf(message.text, message.rule).forEach((path) => linked.add(path))
  }
  for (const { asset: { asset } } of staying) {
    if (asset.kind === 'image' && asset.reference.linked) linked.add(asset.reference.path)
    // `conversationAssets` gives a clip no `src` for a linked one that does
    // not count.
    if (asset.kind === 'clip' && asset.clip.src !== null && isLinkedMediaPath(asset.clip.src)) linked.add(asset.clip.src)
  }
  for (const reference of unnamed) {
    if (reference.linked) linked.add(reference.path)
  }

  // The block for `plan`.
  const head = ({ shown, asText }: Plan): { text: string, pictures: ShownPicture[] } => {
    const assets = staying.map(({ asset, sentence }): NotesAsset => {
      const found = asset.asset
      const keptMark = !shown.has(found.id)
      const text = inMessage(found.section, foundAssetFrom(found))
        ? null
        : found.kind === 'image' ? imageReferenceTextWithKeptMark(found.reference, keptMark) : mediaTagTextWithKeptMark(found.tag, keptMark)
      return { id: found.id, kind: asset.kind, facts: asset.facts, origin: asset.origin, sentence, byReply: asset.byReply, text }
    })
    const pictures = staying.flatMap(({ asset }) => {
      const picture = shown.has(asset.asset.id) ? clipPictures.get(asset.asset.id) : undefined
      return picture === undefined ? [] : [picture]
    })
    // The messages by their place: the final message is the last one, and
    // with no final message, the first message is the only one.
    const quoted = messages.map((message, index) => withKeptMarks(message, index, asText))
    const notes = compactionNotesText({
      firstMessage: quoted[0] ?? null,
      middleMessages: quoted.slice(1, scope.last === null ? quoted.length : -1),
      leftOutMessages,
      finalMessage: scope.last === null ? null : quoted[quoted.length - 1],
      requirements: answer.requirements,
      assets,
      unnamed: unnamed.map((reference) => imageReferenceTextWithKeptMark(reference, true)),
      jobs: input.jobs,
      jobInputs: input.jobInputs,
      cost: input.cost,
    })
    const tag = { count: (oldBlock?.count ?? 0) + 1, lastId, dropped: dropped.length, pictures, linked: [...linked] }
    return { text: compactionBlockText(tag, notes), pictures }
  }
  // Whether the images and the pictures of the head of `plan` fit in the
  // limits.
  const fits = (plan: Plan): boolean => budgetAfter(input.limits, contextImageCost(
    sectionsToStreamMessages([{ id: noteId, role: 'agent', content: [textNode(head(plan).text)] }], model, { sendImages: true, sendTools: false }).messages,
    input.rule,
    imageBytes,
  )) !== null

  // 1. The images of the kept messages: the final message first, so that
  // `pop` takes the last image of the first message first.
  const images = messages.flatMap((message, index) => messageReferences(message.text, message.rule)
    .map((reference) => ({ message: index, key: imageKey(index, reference.from), path: reference.path })))
    .sort((a, b) => b.message - a.message)
  const asText = new Set(images.filter(({ path }) => !imageBytes.has(path)).map(({ key }) => key))
  const asPixels = images.filter(({ key }) => !asText.has(key))
  const noShown: ReadonlySet<string> = new Set()
  while (!fits({ shown: noShown, asText }) && asPixels.length > 0) {
    asText.add((asPixels.pop() as { key: string }).key)
  }

  // 2. The `show` assets.
  const shown = new Set<string>()
  if (input.sendImages) {
    const wanted = choices.filter((choice) => choice.decision === 'show' && !isMessageImage(choice)).sort((a, b) => a.rank - b.rank)
    for (const { asset } of wanted) {
      const found = asset.asset
      if (found.kind === 'image' ? !imageBytes.has(found.reference.path) : !clipPictures.has(found.id)) continue
      if (fits({ shown: new Set([...shown, found.id]), asText })) shown.add(found.id)
    }
  }

  const built = head({ shown, asText })
  const reply = scope.reply === null ? null : sections[scope.reply]
  // The line break after the block keeps its end line whole, so the first
  // token of the reply starts on a line of its own.
  const first: Section = {
    id: reply?.id ?? noteId,
    role: 'agent',
    content: [textNode(`${built.text}\n`)],
    ...(reply === null ? { model: cloneModelRef(model) } : modelRefField(reply.model)),
  }
  return {
    sections: [first, ...sections.slice(scope.end)],
    dropped,
    pictures: built.pictures,
  }
}
