import { assetTextPieces } from '../chat/assetMentions'
import { CARRIED_USER_ASSETS_LABEL, compactionTagText, sectionCompactionTag } from '../chat/compaction'
import { compactionNotesText, type NotesAsset } from '../chat/compactionNotes'
import { sectionPlainText, textNode } from '../chat/content'
import type { ConversationCost } from '../chat/conversationCost'
import { findImageReferences, imageReferenceText, isKeptImage, type ImageReference } from '../chat/images'
import { compareMediaIds, highestConversationMediaId } from '../chat/mediaIds'
import { findMediaTags, mediaTagTextWithKeptMark } from '../chat/mediaTags'
import { cloneModelRef, modelRefField } from '../chat/modelRef'
import type { ShownPicture } from '../chat/shownPictures'
import type { ContentNode, ModelRef, Section } from '../chat/types'
import type { ImageTokenRule } from '../providers/modelFamilies'
import type { JobInfo } from '../tools/jobs'
import { compactionScope, type AssetChoice, type CompactionAsset } from './compactionAssets'
import type { CompactionAnswer } from './compactionRequest'
import { sectionsToStreamMessages } from './messages'
import { contextImageCost, type PictureBudget } from './pictureBudget'

// The sections of a conversation after a compaction, in place of the
// sections up to the reply that runs:
//
//   A   agent  the compaction section: the tag, then the notes
//              (chat/compaction.ts, chat/compactionNotes.ts)
//   U0  user   the first message of the user, as it is
//   U+  user   the images and the clips of the other messages of the user
//              (`CARRIED_USER_ASSETS_LABEL`)
//   U1  user   the newest message of the user, as it is
//   B   agent  the reply, which goes on: empty, with its id and its model
//
// `U+` is there only with an asset, `U1` only when it is not `U0`, and `B`
// only for a compaction in a reply. A request sends `A`, `U0`, `U+`, and
// `U1` as one message, the compaction message (messages.ts), which stays
// the same bytes until the next compaction.
//
// The assets of the user stay in user sections, so a linked file still
// counts, and no text of a model makes Dez read a file of the computer.
//
// What a model sees of an asset follows its decision (`assetDecisions`):
// a `show` asset goes as pixels (an image as it is, a clip as the picture
// of the tag), and a `keep` asset as text only, which its kept mark tells
// (`IMAGE_KEPT_KEY`, `MEDIA_KEPT_ATTRIBUTE`). The images of `U0` and `U1`
// are a part of the user's words, so they go as pixels by themselves, and
// a decision changes nothing for them.
//
// Pictures are costly, so they have a budget. This module builds the
// sections, asks the request builder for the compaction message, and
// counts its image and picture parts (`contextImageCost`): an `@id`
// mention of the user adds an image part only when no reference sent that
// image, so the cost of a message is not the sum of its assets.
// 1. The message must be in the limits of one request. While it is not,
//    one more image of `U0` and `U1` goes as text (the kept mark; the user
//    still sees it at its place), from the last image of `U0` back to the
//    first image of `U1`. An image that Dez cannot read goes as text at
//    once: a request with it would fail each time.
// 2. The `show` assets get at most half of the limits, so that the reply
//    can still view pictures, in the order of the answer's lines. One that
//    does not fit is kept as text, and a smaller one after it can still
//    fit.

/** What `compactedSections` needs. */
export interface CompactedSectionsInput {
  /** The sections of the tab. */
  sections: readonly Section[]
  /** The id of the section of the reply that runs; null at a submit. */
  replySectionId: string | null
  /** The model that wrote the answer. */
  model: ModelRef
  /** What the compaction does with each asset (`assetDecisions`). */
  choices: readonly AssetChoice[]
  answer: CompactionAnswer
  /** The jobs of the reply that runs. */
  jobs: readonly JobInfo[]
  /** The cost of the conversation with the compaction request. */
  cost: ConversationCost | undefined
  /** The saved picture of each clip that the model wants to see, by the
   *  id of the clip. A clip with none is kept as text. */
  clipPictures: ReadonlyMap<string, ShownPicture>
  /** The model reads images. Else no asset is shown. */
  sendImages: boolean
  /** The picture limits of one request to the model (`pictureLimits`). */
  limits: PictureBudget
  /** The most images of one message to the model (`imageLimitOf`). */
  imageLimit: number
  /** How the model counts the tokens of an image. */
  rule: ImageTokenRule
  /** The size of the file of each image of the sections that Dez can
   *  read, by its path. An image with no entry goes as text. */
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
// (`referenceKey`) of the images of `U0` and `U1` that do not.
interface Plan {
  shown: ReadonlySet<string>
  asText: ReadonlySet<string>
}

// The key of the image reference at `from` in the text node `node` of the
// section `section`.
function referenceKey(section: number, node: number, from: number): string {
  return `${section}:${node}:${from}`
}

// The image references of `text`, the text of a text node of a user
// section, as a request reads them (`assetTextPieces`: a reference in a
// media tag is none), with offsets in `text`.
function nodeReferences(text: string): ImageReference[] {
  return assetTextPieces(text, 'user').flatMap((piece) => (piece.kind === 'reference'
    ? findImageReferences(text.slice(piece.from, piece.to), 'user').map((reference) => ({ ...reference, from: piece.from, to: piece.to }))
    : []))
}

// The image references of the text nodes of `section` (index `index`), in
// text order. A reference in a prompt pill is not here: the text of a pill
// stays as it is.
function messageImages(section: Section, index: number): { key: string, path: string }[] {
  return section.content.flatMap((node, nodeIndex) => (node.kind === 'text'
    ? nodeReferences(node.text).map((reference) => ({ key: referenceKey(index, nodeIndex, reference.from), path: reference.path }))
    : []))
}

// `section` (index `index`), a kept message of the user, with the kept
// mark on the images of `asText` and on no other image. The marks of a
// message are set new at each compaction. Only a reference whose mark must
// change gets new text.
function withKeptMarks(section: Section, index: number, asText: ReadonlySet<string>): Section {
  let changed = false
  const content = section.content.map((node, nodeIndex): ContentNode => {
    if (node.kind !== 'text') return node
    let text = ''
    let end = 0
    for (const reference of nodeReferences(node.text)) {
      const kept = asText.has(referenceKey(index, nodeIndex, reference.from))
      if (kept === isKeptImage(reference)) continue
      text += node.text.slice(end, reference.from) + imageReferenceText(reference, kept)
      end = reference.to
    }
    // A reference is never empty, so a change moved the end.
    if (end === 0) return node
    changed = true
    return textNode(text + node.text.slice(end))
  })
  return changed ? { ...section, content } : section
}

function isOver(cost: PictureBudget, limits: PictureBudget): boolean {
  return cost.tokens > limits.tokens || cost.bytes > limits.bytes || cost.pictures > limits.pictures
}

/** The sections of a tab after a compaction; see the top of this file. */
export function compactedSections(input: CompactedSectionsInput): CompactedSections {
  const { sections, model, choices, answer, clipPictures, imageBytes } = input
  const scope = compactionScope(sections, input.replySectionId)
  const first = scope.first === null ? null : sections[scope.first]
  const last = scope.last === null ? null : sections[scope.last]
  const noteId = input.newId()
  const carriedId = input.newId()
  const oldTag = sections.length > 0 ? sectionCompactionTag(sections[0]) : null
  const lastId = highestConversationMediaId(sections.map(sectionPlainText))
  const kept = choices.filter((choice) => choice.decision !== 'drop').sort((a, b) => compareMediaIds(a.asset.asset.id, b.asset.asset.id))
  const choiceById = new Map(choices.map((choice) => [choice.asset.asset.id, choice]))
  // An image of `U0` or `U1`: the message sends it, so a `show` adds
  // nothing for it. A clip of these messages still needs its picture.
  const isMessageImage = ({ asset }: AssetChoice) => asset.asset.kind === 'image' && asset.fromUser
    && (asset.asset.section === scope.first || asset.asset.section === scope.last)
  // The choice of the asset whose text is at `from` in the section
  // `index`; undefined for a text that is not the one of its id
  // (`conversationAssets`: of two with one id, only the last one counts).
  const choiceAt = (id: string, index: number, from: number) => {
    const choice = choiceById.get(id)
    if (choice === undefined || choice.decision === 'drop' || choice.asset.asset.section !== index) return undefined
    const { asset } = choice.asset
    return (asset.kind === 'image' ? asset.reference.from : asset.tag.from) === from ? choice : undefined
  }
  // The references of the made images with no id. The compaction section
  // is an agent section too, so it carries the ones of the compaction
  // before.
  const unnamed = sections.slice(0, scope.end).flatMap((section) => (section.role === 'agent'
    ? findImageReferences(sectionPlainText(section), 'agent').filter((reference) => reference.id === null).map((reference) => imageReferenceText(reference, true))
    : []))

  // `A`, `U0`, `U+`, and `U1` for `plan`.
  const head = ({ shown, asText }: Plan): { sections: Section[], pictures: ShownPicture[] } => {
    const assets = kept.map(({ asset, sentence }): NotesAsset => {
      const found = asset.asset
      const keptMark = !shown.has(found.id)
      const text = asset.fromUser ? null : found.kind === 'image' ? imageReferenceText(found.reference, keptMark) : mediaTagTextWithKeptMark(found.tag, keptMark)
      return { id: found.id, kind: asset.kind, facts: asset.facts, origin: asset.origin, sentence, text }
    })
    const pictures = kept.flatMap(({ asset }) => {
      const picture = shown.has(asset.asset.id) ? clipPictures.get(asset.asset.id) : undefined
      return picture === undefined ? [] : [picture]
    })
    const notes = compactionNotesText({
      summary: answer.summary,
      requirements: answer.requirements,
      nextSteps: answer.nextSteps,
      assets,
      unnamed,
      jobs: input.jobs,
      cost: input.cost,
    })
    const result: Section[] = [{
      id: noteId,
      role: 'agent',
      content: [textNode(`${compactionTagText({ count: (oldTag?.count ?? 0) + 1, lastId, pictures })}\n${notes}`)],
      model: cloneModelRef(model),
    }]
    if (first !== null && scope.first !== null) result.push(withKeptMarks(first, scope.first, asText))

    // The assets of the other messages of the user, in section and text
    // order. An image with no id has no decision: it is kept as text.
    const carried: string[] = []
    sections.slice(0, scope.end).forEach((section, index) => {
      if (section.role !== 'user' || index === scope.first || index === scope.last) return
      const text = sectionPlainText(section)
      const lines = [
        ...findImageReferences(text, 'user').flatMap((reference) => {
          if (reference.id === null) return [{ from: reference.from, text: imageReferenceText(reference, true) }]
          return choiceAt(reference.id, index, reference.from) ? [{ from: reference.from, text: imageReferenceText(reference, !shown.has(reference.id)) }] : []
        }),
        ...findMediaTags(text).flatMap((tag) => (choiceAt(tag.id, index, tag.from) ? [{ from: tag.from, text: mediaTagTextWithKeptMark(tag, !shown.has(tag.id)) }] : [])),
      ]
      carried.push(...lines.sort((a, b) => a.from - b.from).map((line) => line.text))
    })
    if (carried.length > 0) result.push({ id: carriedId, role: 'user', content: [textNode([CARRIED_USER_ASSETS_LABEL, ...carried].join('\n'))] })

    if (last !== null && scope.last !== null) result.push(withKeptMarks(last, scope.last, asText))
    return { sections: result, pictures }
  }
  const costOf = (plan: Plan): PictureBudget => contextImageCost(
    sectionsToStreamMessages(head(plan).sections, model, { sendImages: true, sendTools: false }).messages,
    input.rule,
    imageBytes,
  )

  // 1. The images of the kept messages of the user.
  const messageLimits: PictureBudget = { ...input.limits, pictures: Math.min(input.limits.pictures, input.imageLimit) }
  const images = [
    ...(last !== null && scope.last !== null ? messageImages(last, scope.last) : []),
    ...(first !== null && scope.first !== null ? messageImages(first, scope.first) : []),
  ]
  const asText = new Set(images.filter(({ path }) => !imageBytes.has(path)).map(({ key }) => key))
  const asPixels = images.filter(({ key }) => !asText.has(key))
  const noShown: ReadonlySet<string> = new Set()
  let fixed = costOf({ shown: noShown, asText })
  while (isOver(fixed, messageLimits) && asPixels.length > 0) {
    asText.add((asPixels.pop() as { key: string }).key)
    fixed = costOf({ shown: noShown, asText })
  }

  // 2. The `show` assets.
  const shown = new Set<string>()
  if (input.sendImages) {
    const share = (limit: number, messageLimit: number, spent: number) => spent + Math.min(Math.floor(limit / 2), messageLimit - spent)
    const cap: PictureBudget = {
      tokens: share(input.limits.tokens, messageLimits.tokens, fixed.tokens),
      bytes: share(input.limits.bytes, messageLimits.bytes, fixed.bytes),
      pictures: share(input.limits.pictures, messageLimits.pictures, fixed.pictures),
    }
    const wanted = choices.filter((choice) => choice.decision === 'show' && !isMessageImage(choice)).sort((a, b) => a.rank - b.rank)
    for (const { asset } of wanted) {
      const found = asset.asset
      if (found.kind === 'image' ? !imageBytes.has(found.reference.path) : !clipPictures.has(found.id)) continue
      if (!isOver(costOf({ shown: new Set([...shown, found.id]), asText }), cap)) shown.add(found.id)
    }
  }

  const built = head({ shown, asText })
  const reply = scope.reply === null ? null : sections[scope.reply]
  return {
    sections: [
      ...built.sections,
      ...(reply === null ? [] : [{ id: reply.id, role: 'agent' as const, content: [textNode('')], ...modelRefField(reply.model) }]),
      ...sections.slice(scope.end),
    ],
    dropped: choices.filter((choice) => choice.decision === 'drop').map((choice) => choice.asset),
    pictures: built.pictures,
  }
}
