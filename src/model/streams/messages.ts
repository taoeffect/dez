import type { MessagePart, ModelRef, Section, SectionThinking, ThinkingReplay } from '../chat/types'
import { assetTextPieces } from '../chat/assetMentions'
import { sectionIsEmpty, sectionPlainText } from '../chat/content'
import { findAssetMentions, type AssetMention } from '../chat/imageMentions'
import { findImageReferences, IMAGE_TOOL_KEY, type ImageReference } from '../chat/images'
import { findMediaTags, MEDIA_TOOL_ATTRIBUTE, mediaTagRequestText, mediaTagsForRequest, type MediaTag } from '../chat/mediaTags'
import { sameModelRef } from '../chat/modelRef'
import { holdsStoredFilePath, withoutStoredFilePaths } from '../chat/storedFilePaths'
import { thinkingField } from '../chat/thinking'
import { EMPTY_TOOL_RESULT, INTERRUPTED_TOOL_RESULT, agentTextForRequest, splitToolBlocks, type ToolBlock } from '../chat/toolBlocks'
import type { ClipAttachment } from '../providers/clipInputs'
import { minInputImages } from '../providers/clipImages'
import type { ClipInputRules, MediaKind } from '../providers/types'
import { madeAssetIds } from '../tools/jobs'
import type { ToolCall, ToolResult } from '../tools/types'
import { conversationAssets, preparedMediaRequest, type MediaRequestInput } from './mediaRequest'
import type { RequestMessages, StreamMessage } from './types'

export interface RequestOptions {
  // False when the request model does not read images: the images of the
  // newest user message (its references and the images that it mentions)
  // then go as text only, as the images of every earlier message do.
  sendImages: boolean
  // False when the request offers no tools: an agent section's tool calls
  // then go as text (agentSectionMessages).
  sendTools: boolean
}

// The request messages: every section that has text, in order. No path of a
// file that Dez stores or links ever goes to a provider: every text (user
// and agent text, prompt bodies, tool arguments and results) goes through
// `withoutStoredFilePaths`, so an image reference goes as `![image](id=a)`,
// with the ids and other metadata that later requests can name. A clip goes
// as its tag with only the id and the type (`mediaTagRequestText`), in a
// user section (a clip file that the user pasted or dropped) and in an
// agent section: no path and no signed URL. Each message
// is built from its own section and, for the images that it mentions, the
// sections before it.
//
// Only the newest user message carries images (image parts), unless
// `sendImages` is false: its image references, and the images that it
// names with an `@id` mention, however far back they are
// (`userMessageContent`). Every earlier user message goes as text only,
// with each image as its `![image](id=a)` text, so a long conversation
// does not send all its images again with each request. An agent section's
// images go as text only too: both formats take images only from the user.
// So to show a model an old image, or an image that a model made, the user
// mentions it in the new message. A clip adds no part, neither its tag nor
// a mention of it (`@b`): only a media request sends clips (`messageClips`,
// `mediaRequestInput`), so the bytes of a chat request do not depend on
// them.
//
// An image or a clip that a Dez tool made is not text of the model, but
// its reference or tag is in the reply, at the start of the text of the
// round after the tool's group. An agent message leaves it out when a
// result of that group names the asset (`roundRequestText`): the result
// already tells the model the id.
//
// Prompt cache: a message is the same bytes in every later request, with
// one exception. A user message with image parts loses them when a newer
// user message comes, so the first request after that reads it, and what
// follows it, with no cache hit, and the signed thinking replays from there
// on no longer go back (their prefix changed; `wireChat`, apiFormats.ts).
// All request rounds of one reply have the same newest user message, so
// the bytes hold inside a reply.
export function sectionsToStreamMessages(sections: Section[], requestModel: ModelRef, options: RequestOptions): Omit<RequestMessages, 'sendTools'> {
  let imagesLeftOut = 0
  // The images that a mention in the section at hand can name: the path of
  // each image id in the references of that section and of the sections
  // before it, user and agent. When two images have one id (a hand edit),
  // the last one wins. Later sections are never read: the newest user
  // message must keep its parts while the reply after it grows.
  const imagesById = new Map<string, string>()
  const sentSections = sections.filter((section) => !sectionIsEmpty(section))
  const newestUser = sentSections.findLastIndex((section) => section.role === 'user')
  const messages = sentSections.flatMap((section, index): StreamMessage[] => {
    const text = sectionPlainText(section)
    for (const { id, path } of findImageReferences(text, section.role)) {
      if (id !== null) imagesById.set(id, path)
    }
    if (section.role === 'agent') return agentSectionMessages(section, requestModel, options.sendTools)
    const content = index === newestUser ? userMessageContent(text, imagesById) : null
    if (content !== null) {
      if (options.sendImages) return [{ role: 'user', content }]
      // The count is of the image parts that the request has for a model
      // that reads images, so the toast and the request always agree.
      imagesLeftOut = content.filter((part) => part.type === 'image').length
    }
    return [{ role: 'user', content: withoutStoredFilePaths(mediaTagsForRequest(text)) }]
  })

  return { messages, imagesLeftOut }
}

/** What a media reply (a ModelInfo.request that is not `chat`) sends to
 *  dez.provider/generateMedia. `rules` is what the cache knows of the
 *  model's input (its ModelInfo), with the image rules of the request's
 *  parameter values (`inputImageRulesFor`).
 *
 *  The source of the request is the last user message of `messages` as a
 *  chat request sends it: its text, with no path, and with each image
 *  reference as its `![image](id=a)` text; the images that it holds and
 *  the ones that it names with an `@id` mention, in text order and each
 *  one once; and its clips (`messageClips`). A chat request sends no clip:
 *  only a media request reads them. `preparedMediaRequest` (the code that
 *  the `model_invoke` tool shares) makes the request of that source: the
 *  cut to what the model takes, the names in the prompt, and the lyrics.
 *  `imagesLeftOut` and `clipsLeftOut` count the message's images and clips
 *  that the request does not take, so that the submit can tell the user.
 *
 *  When the message has no image, a request that needs exactly one image
 *  (`minInputImages`) takes the newest image reference of `sections` (the
 *  tab's sections, in which the reply's own section is still empty), so
 *  that "Make it blue" or "Make it move" uses the image of the reply
 *  before. With no image there either, it gets no paths: the submit
 *  refuses the request (`missingImageProblem`), and generateMedia refuses
 *  it too. A model that needs more images takes no such image: one image
 *  can never meet its count, and the refusal tells the count of the
 *  message. A request with a video clip takes no such image: the video is
 *  the reference then, and neither refuses it. */
export function mediaRequestInput(
  kind: MediaKind,
  messages: StreamMessage[],
  sections: Section[],
  rules: ClipInputRules = {},
): MediaRequestInput {
  const content = messages.findLast((message): message is Extract<StreamMessage, { role: 'user' }> => message.role === 'user')?.content ?? ''
  const parts: MessagePart[] = typeof content === 'string' ? [{ type: 'text', text: content }] : content
  const input = preparedMediaRequest(kind, { parts, clips: messageClips(sections), pathsById: conversationAssets(sections).images }, rules)
  if (input.images.length + input.imagesLeftOut > 0 || input.clips.some((clip) => clip.kind === 'video') || minInputImages(kind, rules.images) !== 1) return input
  const newest = sections.map((section) => findImageReferences(sectionPlainText(section), section.role).at(-1)).findLast((reference) => reference !== undefined)
  return { ...input, images: newest ? [newest.path] : [] }
}

/** The clips of the newest user message of `sections`, in text order and
 *  each one once: its media tags (clip files that the user pasted or
 *  dropped) and the clips that it names with an `@id` mention
 *  (imageMentions.ts). A mention names the last media tag with that id in
 *  the message or in a section before it, user or agent. The message is
 *  read as `userMessageContent` reads it (`messageTextPieces`). An id that
 *  an image of the message or of an earlier section has is an image: its
 *  tag and its mentions add no clip. A mention of no image and no clip is
 *  plain text. The text keeps each mention as the user typed it. */
export function messageClips(sections: readonly Section[]): ClipAttachment[] {
  const messageIndex = sections.findLastIndex((section) => section.role === 'user' && !sectionIsEmpty(section))
  if (messageIndex < 0) return []
  const clipsById = conversationAssets(sections.slice(0, messageIndex + 1)).clips

  const clips = new Map<string, ClipAttachment>()
  const add = (id: string) => {
    const clip = clipsById.get(id)
    if (clip && !clips.has(id)) clips.set(id, clip)
  }
  for (const piece of messageTextPieces(sectionPlainText(sections[messageIndex]))) {
    if (piece.kind === 'media') add(piece.tag.id)
    else if (piece.kind === 'gap') for (const { id } of piece.mentions) add(id)
  }
  return [...clips.values()]
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
 *  definitions cannot hold tool calls. */
export function agentSectionMessages(section: Section, requestModel: ModelRef, sendTools: boolean): StreamMessage[] {
  const rounds = agentRounds(sectionPlainText(section))
  // The first group's blocks are always in the first round; a section that
  // ends at its first group has only that round.
  if (!sendTools && rounds[0].blocks.length > 0) return [{ role: 'agent', content: textWithToolCalls(rounds) }]

  return rounds.flatMap((round, index): StreamMessage[] => {
    const content = withoutStoredFilePaths(roundRequestText(rounds, index))
    const thinking = roundThinking(section, requestModel, rounds, index)
    if (round.blocks.length === 0) return content.trim() === '' ? [] : [{ role: 'agent', content, ...thinking }]
    return [
      { role: 'agent', content, ...thinking, toolCalls: round.blocks.map(toolCall) },
      { role: 'tool', results: round.blocks.map(toolResult) },
    ]
  })
}

// The text of the round `index` as a request sends it, before the path
// scrub: the text that the model wrote (`agentTextForRequest`), without
// the references and the tags of the images and the clips that the tools
// of the group before the round made and named in their results
// (`madeAssetIds`, tools/jobs.ts).
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
// The stored text never changes, and the stored result of a block never
// changes, so a round is the same bytes in every request.
function roundRequestText(rounds: readonly AgentRound[], index: number): string {
  const made = new Set(rounds[index - 1]?.blocks.flatMap((block) => madeAssetIds(block.result)))
  return agentTextForRequest(made.size === 0 ? rounds[index].text : withoutToolAssets(rounds[index].text, made))
}

// `text` without the image references and the media tags of the assets
// `ids` that have the mark of a Dez tool. Each one goes with the line
// breaks around it, which Dez wrote (`writeAsset` and `writeModelText`,
// controller/stream.ts); one blank line stays where text is on both sides.
// So a round that wrote only calls gives a blank text, and a round's
// answer starts with the model's own words.
function withoutToolAssets(text: string, ids: ReadonlySet<string>): string {
  const assets = [
    ...findImageReferences(text, 'agent').filter(({ id, metadata }) => id !== null && ids.has(id) && metadata.some((item) => item.key === IMAGE_TOOL_KEY)),
    ...findMediaTags(text).filter(({ id, other }) => ids.has(id) && other.some((attribute) => attribute.name === MEDIA_TOOL_ATTRIBUTE)),
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

// The content of the newest user message, the only one with image parts:
// text and image parts in doc order (`messageTextPieces`). Each image part
// comes right after its reference's text, `![image](id=a)`, at the end of
// the text part before it, so that a model can name the image by its id
// (and `promptWithNames`, mediaRequest.ts, finds that text). A media tag
// goes in its request form and adds no part.
//
// An `@id` mention (imageMentions.ts) that names an image of `imagesById`
// counts as that image at that place: its image part comes right after the
// mention, which stays in the text as the user typed it. A mentioned image
// goes once, at its first mention. A mention of an image that the text
// itself holds adds no part: the reference sends that image.
//
// Null for a text with no image part: the message then goes as the text
// that an older user message sends (`sectionsToStreamMessages`). So a
// text-only request body is the same bytes as before images existed (the
// prefix hashes of saved thinking replays depend on it), and the message
// keeps its bytes when a newer user message comes. A whitespace-only text
// after the last image is left out: Anthropic refuses a text block with no
// visible text.
function userMessageContent(text: string, imagesById: ReadonlyMap<string, string>): MessagePart[] | null {
  const pieces = messageTextPieces(text)
  const parts: MessagePart[] = []
  // The images that the message has a part for, or gets one for below.
  const sentImages = new Set(pieces.flatMap((piece) => (piece.kind === 'reference' ? [piece.path] : [])))
  // The scrubbed text since the last image part.
  let pendingText = ''
  for (const piece of pieces) {
    switch (piece.kind) {
      case 'media':
        pendingText += withoutStoredFilePaths(mediaTagRequestText(piece.tag))
        break
      case 'reference':
        parts.push({ type: 'text', text: pendingText + piece.text }, { type: 'image', path: piece.path })
        pendingText = ''
        break
      case 'gap': {
        // An image part after each mention that adds one.
        let start = 0
        for (const mention of piece.mentions) {
          const path = imagesById.get(mention.id)
          if (path === undefined || sentImages.has(path)) continue
          sentImages.add(path)
          parts.push({ type: 'text', text: pendingText + piece.text.slice(start, mention.to) }, { type: 'image', path })
          pendingText = ''
          start = mention.to
        }
        pendingText += piece.text.slice(start)
      }
    }
  }

  if (parts.length === 0) return null
  if (pendingText.trim()) parts.push({ type: 'text', text: pendingText })
  return parts
}

// A run of the text of a user message, as a request reads it: a media tag,
// an image reference (its text after the path scrub, and its path), or a
// text between them (after the path scrub, with its `@id` mentions).
type MessageTextPiece =
  | { kind: 'media', tag: MediaTag }
  | { kind: 'reference', text: string, path: string }
  | { kind: 'gap', text: string, mentions: AssetMention[] }

// The pieces of a user message's text, in order, with no empty gap
// (`assetTextPieces`, which the editor's mention chips read too). Both
// readers of a message's images and clips use it (`userMessageContent`,
// `messageClips`), so a mention names the same thing in a chat request and
// in a media request. References and mentions are read in the text outside
// media tags, and mentions after the path scrub: a bare path can hold an
// `@`, and a cut there would send the start of the path.
function messageTextPieces(text: string): MessageTextPiece[] {
  return assetTextPieces(text, 'user').map((piece): MessageTextPiece => {
    if (piece.kind === 'media') return piece
    const scrubbed = withoutStoredFilePaths(text.slice(piece.from, piece.to))
    return piece.kind === 'reference'
      ? { kind: 'reference', text: scrubbed, path: piece.path }
      : { kind: 'gap', text: scrubbed, mentions: findAssetMentions(scrubbed) }
  })
}
