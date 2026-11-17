import { sectionTextParts } from '../chat/compaction'
import { conversationCostText } from '../chat/compactionNotes'
import { sectionIsEmpty } from '../chat/content'
import type { ConversationCost } from '../chat/conversationCost'
import { IMAGE_ID_SOURCE } from '../chat/images'
import { withoutStoredFilePaths } from '../chat/storedFilePaths'
import type { ModelRef, Section } from '../chat/types'
import { jobsListText, type JobInfo } from '../tools/jobs'
import type { PictureBudget } from './pictureBudget'

// The compaction request: one request to the model of a reply that asks it
// for the notes that take the place of the conversation (chat/compaction.ts).
// It holds the messages of the next request of the reply, so it reads their
// prompt cache, and one more user message: the instruction. The answer has
// three parts: the requirements and decisions (text of the model), which
// middle messages of the user the notes keep, and what to do with each
// asset. Dez quotes the kept messages itself, so the model never rewrites
// the words of the user. This module tells when a compaction is due,
// writes the instruction, and reads the answer. All pure;
// controller/compaction.ts sends the request.

/** Why a compaction is due: the context size, or the images and the
 *  pictures of the context by count, by bytes, or by tokens. */
export type CompactionReason = 'tokens' | 'images' | 'bytes' | 'pictureTokens'

// The share of a picture limit at which a compaction is due. Under 1, so
// that a model in a long reply can still see a picture until then.
const NEAR_PICTURE_LIMIT = 0.9

/** Why the next request of a conversation needs a compaction first; null
 *  when it needs none.
 *
 *  `contextTokens` is the context size of the tab, and `dueSize` the size
 *  at which it needs a compaction (`compactionDueSize`: the compaction
 *  threshold of the model, or more when the newest compaction could not
 *  get the conversation well under it). `spent` is what the images and
 *  the pictures of the next request cost (`contextImageCost`), and
 *  `limits` the picture limits of the model (`pictureLimits`).
 *
 *  A picture limit counts only when a compaction can make room in it, so
 *  only when `spent` is over both of these:
 *  - `leaves`, the most that a compaction leaves
 *    (`compactedPictureLimits`). Without it, a model that takes only a
 *    few images would compact at each request, as the share of a small
 *    limit rounds to the limit itself.
 *  - `kept`, what the images and the pictures cost right after the newest
 *    compaction of the reply (nothing before its first one). A compaction
 *    cannot take out the images that the messages of the user name with
 *    an `@id` mention, so with no newer picture it would make no room. It
 *    also covers a model that takes no image, whose limit is 0. */
export function compactionReason({ contextTokens, dueSize, limits, leaves, spent, kept }: {
  contextTokens: number
  dueSize: number
  limits: PictureBudget
  leaves: PictureBudget
  spent: PictureBudget
  kept: PictureBudget
}): CompactionReason | null {
  if (contextTokens >= dueSize) return 'tokens'
  const isNear = (part: keyof PictureBudget) => spent[part] > Math.max(kept[part], leaves[part]) && spent[part] >= NEAR_PICTURE_LIMIT * limits[part]
  if (isNear('pictures')) return 'images'
  if (isNear('bytes')) return 'bytes'
  if (isNear('tokens')) return 'pictureTokens'
  return null
}

// The index of the section with the id `replySectionId`, or the count of
// the sections when there is none.
function replyIndex(sections: readonly Section[], replySectionId: string): number {
  const index = sections.findIndex((section) => section.id === replySectionId)
  return index < 0 ? sections.length : index
}

/** Whether the conversation `sections` holds a reply with text before the
 *  section of the reply that runs (`replySectionId`). Only the text of a
 *  reply counts (`sectionTextParts`): the compaction block is none, and a
 *  compaction takes the place of every reply before it. So at the first
 *  request of a reply, this tells whether a chat request went since the
 *  newest compaction (`runChatRounds`, controller/stream.ts): a first
 *  message, and a message right after a compaction, bring none. */
export function repliedSinceCompaction(sections: readonly Section[], replySectionId: string): boolean {
  return sections
    .slice(0, replyIndex(sections, replySectionId))
    .some((section, index) => section.role === 'agent' && sectionTextParts(section, index).text.trim() !== '')
}

/** The model of the newest reply with text before the section of the
 *  reply that runs (`replySectionId`); null when no such reply tells its
 *  model. It read the whole conversation in its last request, so it can
 *  write the notes of a conversation that is too large for the model of
 *  the reply that runs. */
export function newestReplyModel(sections: readonly Section[], replySectionId: string): ModelRef | null {
  const newest = sections
    .slice(0, replyIndex(sections, replySectionId))
    .findLast((section) => section.role === 'agent' && section.model !== undefined && !sectionIsEmpty(section))
  return newest?.model ?? null
}

/** What a compaction does with an image or a clip: `show` keeps it as a
 *  picture for the model, `keep` as one line of the notes, and `drop`
 *  takes it out of the conversation. */
export type AssetDecision = 'show' | 'keep' | 'drop'

/** One asset line of an answer. */
export interface AnswerAsset {
  id: string
  decision: AssetDecision
  /** What the model wrote about the asset; blank for none. */
  sentence: string
}

/** What a compaction does with a middle message of the user: `keep`
 *  quotes it in the notes word for word, and `drop` takes it out of the
 *  conversation. */
export type MessageDecision = 'keep' | 'drop'

/** One message line of an answer: `m2: keep`. */
export interface AnswerMessage {
  /** The number of the middle message in the list of the instruction,
   *  from 1 (`m1`). */
  number: number
  decision: MessageDecision
}

/** The answer of a model to a compaction request. */
export interface CompactionAnswer {
  /** The text of the model: what the kept messages of the user do not
   *  tell. */
  requirements: string
  /** In the order of the lines; of two lines with one number, only the
   *  first. */
  messages: AnswerMessage[]
  /** In the order of the lines; of two lines with one id, only the first. */
  assets: AnswerAsset[]
}

/** The most characters of the sentence of an asset. */
export const MAX_ASSET_SENTENCE_LENGTH = 300

/** What the instruction of a compaction request holds. */
export interface CompactionInstruction {
  /** The start of each middle message of the user, oldest first, as text
   *  for people (`middleMessageStarts`, compactionAssets.ts): the list of
   *  the messages part, `m1` to `mN`. */
  middleMessages: readonly string[]
  /** The table of the assets of the conversation (`assetTableText`,
   *  compactionAssets.ts). */
  assetTable: string
  /** The jobs of the reply that runs (`CompactionInput.jobs`). A reply
   *  that sent no request yet has only the jobs that it took over from
   *  a reply that a stop or a new submit cut. */
  jobs: readonly JobInfo[]
  /** The cost of the conversation before this request. */
  cost: ConversationCost | undefined
  /** The request offers the Dez tools. */
  tools: boolean
}

// The list of the middle messages of the instruction: one line for each,
// with its number and its start in quotes. The quote mark keeps a start
// such as "keep going" from reading as a message line when a model copies
// the list into its answer.
function middleMessagesList(starts: readonly string[]): string {
  if (starts.length === 0) return 'No message of the user came between the first and the newest one, so your answer needs no line under the Middle messages heading.'
  const lines = starts.map((start, index) => `m${index + 1}: "${start}"`)
  return ['The messages of the user between the first and the newest one, oldest first, each as its start (the whole messages are above):', ...lines].join('\n')
}

/** The instruction of a compaction request: the text of its last user
 *  message. The answer has the layout that `readCompactionAnswer` reads.
 *  It holds no path of a stored file. */
export function compactionInstruction({ middleMessages, assetTable, jobs, cost, tools }: CompactionInstruction): string {
  const text = `[Request from Dez, not a message of the user]

The conversation is near the limit of what one request can hold. So Dez now takes every message above out of the conversation and puts your answer to this request in their place, as notes. The work goes on right after that, from the notes alone: the next request holds only your notes and the messages of the user that Dez quotes in them word for word (the first message, the middle messages that you keep, and the newest message). The tool calls and their results are gone then, and so is your thinking.

Write only the notes, as plain text, with these three headings and nothing before or after them.${tools ? ' Call no tool in this answer: Dez does not run it.' : ''}

## Requirements and decisions
What the work needs to know that the kept messages of the user do not tell word for word:
- every decision that was made, with its reason, and what failed and why, so that it is not tried again;
- each requirement, preference, correction, and rejection of the user that is in a message that you drop;
- what the user rejected or replaced, and what to use in its place: name a rejected or replaced asset by what it is, not by its @id (see Assets);
- the exact values that later work needs: names, numbers, settings, and the important parts of prompts and commands.
End this part with one or two sentences that tell where the work on the newest message of the user stands: what is done, what is not, and the job ids of the jobs that it waits for.

## Middle messages
Keep each message of the user whose words the work on the newest message still needs: an instruction, a requirement, a correction, or a choice that still counts, also when it is old. Drop a message that the work no longer needs, such as "ok", or a request whose work is done and changes nothing later, and put what still counts of it under Requirements and decisions. Dez quotes each kept message in the notes word for word, with its images and clips. A dropped message leaves the conversation, but its images and clips stay as assets. Dez keeps a message that your lines do not name.

One line for each message of the list below, in this form:
m1: keep|drop

${middleMessagesList(middleMessages)}

## Assets
Keep only what the work at hand needs. Dez keeps every asset of the user by itself. Of the assets that a model or a tool made, keep only an asset that you still need to finish the request that you work on now (an input of something that you still have to make or finish, and a result of this reply that the user must get), and an asset that your notes name. Drop every other made asset: the inputs of work that is finished, the versions that a newer one replaced, the versions that the user rejected, and the assets of earlier replies that the work at hand does not use.

One line for each image and clip of the table below, in this form:
@id: show|keep|drop - one sentence

- show: you must see the asset itself to go on. Dez puts it into the notes as a picture (an image as it is, a video clip as a frame sheet, an audio clip as its wave). Pictures are costly, and Dez shows only as many as fit, in the order of your lines: put the most important one first.
- keep: the work at hand needs the asset, but you do not need to see it now. Dez keeps one line about it in the notes, and its id still names it${tools ? ', so a call can use it, and `asset_view` shows it to you again' : ''}.
- drop: the work at hand does not need the asset. Dez takes it out of the conversation, and its id names nothing any more.

The sentence tells what the asset is, how it was made (the model or the tool, and the important parts of the prompt or the command), and what a later step needs it for. You read this sentence again at the next compaction, when the calls that made the asset are gone. At most ${MAX_ASSET_SENTENCE_LENGTH} characters.

Dez drops an asset of an earlier reply that your lines do not name, and keeps an asset of this reply that they do not name. Dez never drops an asset from the user, an asset that an open job uses, or an asset that your notes or a kept message of the user name with @id: for those, \`drop\` reads as \`keep\`. So name a rejected or dropped asset in your notes by what it was, not by its @id. When Dez keeps an asset that the user rejected (a kept message of the user names it, or an open job uses it), its sentence tells that the user rejected it, and what the user wants in its place.

${assetTable}

The jobs of this reply:
${jobsListText(jobs)}

${conversationCostText(cost, 'so far')}`
  return withoutStoredFilePaths(text)
}

type AnswerPart = 'requirements' | 'messages' | 'assets'

// The names that a model gives the three headings, in lower case. The
// headings of the parts of older notes (`summary`, `next steps`) are text
// of the requirements part: a model can copy them from the notes of an
// earlier compaction, and their text must not be lost.
const HEADING_PARTS: ReadonlyMap<string, AnswerPart> = new Map([
  ['requirements and decisions', 'requirements'],
  ['requirements & decisions', 'requirements'],
  ['requirements', 'requirements'],
  ['decisions', 'requirements'],
  ['summary', 'requirements'],
  ['next steps', 'requirements'],
  ['next step', 'requirements'],
  ['middle messages', 'messages'],
  ['relevant middle messages', 'messages'],
  ['user messages', 'messages'],
  ['messages', 'messages'],
  ['assets', 'assets'],
  ['asset', 'assets'],
  ['asset decisions', 'assets'],
  // The assets heading of the earlier notes (compactionNotes.ts), which a
  // second compaction request holds.
  ['assets of the conversation', 'assets'],
])

// A whole line in bold, with a number before it or a colon after it.
const BOLD_LINE = /^(?:\d+[.)]\s*)?(\*\*|__).+\1:?$/

// The part that the heading on `line` starts; null for a line that is no
// heading of the three. A heading has one of the forms that models write:
// `## Name`, `**Name**`, `Name:`, with a number before the name or a colon
// after it. A line that is only a name is no heading: it can be a line of
// the notes.
function headingPart(line: string): AnswerPart | null {
  const text = line.trim()
  if (!text.startsWith('#') && !text.endsWith(':') && !BOLD_LINE.test(text)) return null
  const name = text
    .replace(/^#+|#+$/g, '')
    .replace(/[*_`]/g, '')
    .replace(/^\s*\d+[.)]\s*/, '')
    .replace(/\s*:\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  return HEADING_PARTS.get(name) ?? null
}

// An asset line in the forms that models write: a list mark or a table bar
// before it, marks of code or bold around the id and the decision, and any
// of `:`, `|`, `=`, `-`, `>`, or a space between the three. The groups: the
// id, the decision, the sentence. With the `i` flag for the decision, so
// the reader checks the letter case of the id itself.
const ASSET_LINE = new RegExp(
  String.raw`^\s*(?:[-*+•]\s+|\d+[.)]\s+)?\|?\s*[\`*_]*@(${IMAGE_ID_SOURCE})[\`*_]*[\s:|=>–—-]+[\`*_]*(show|keep|drop)\b[\`*_]*[\s:|=>–—-]*(.*)$`,
  'i',
)

// A message line in the forms of an asset line, with the number of a
// middle message (`m2`) in place of the id. Text after the decision (a
// reason) is left out. The groups: the number, the decision.
const MESSAGE_LINE = new RegExp(String.raw`^\s*(?:[-*+•]\s+|\d+[.)]\s+)?\|?\s*[\`*_]*m(\d+)[\`*_]*[\s:|=>–—-]+[\`*_]*(keep|drop)\b`, 'i')

// `text` with no code fence around the whole of it.
function withoutFence(text: string): string {
  const lines = text.trim().split('\n')
  if (lines.length < 2 || !lines[0].startsWith('```') || !lines[lines.length - 1].startsWith('```')) return text
  return lines.slice(1, -1).join('\n')
}

/** The answer of a model to a compaction request, read with the small
 *  faults that models make.
 *
 *  - A heading counts in each form of `headingPart`, in any letter case.
 *    The text before the first heading, and the text of an answer with no
 *    heading, is a part of the requirements. A heading that comes two
 *    times goes on with its part.
 *  - A message line counts only under the messages heading, and any other
 *    line there is left out: a model can quote a message of the user
 *    there, which Dez quotes itself.
 *  - An asset line counts only under the assets heading. A line of other
 *    text right after an asset line goes on with the sentence of that
 *    line, up to the next blank line.
 *  - A line can end with CRLF. */
export function readCompactionAnswer(text: string): CompactionAnswer {
  const requirements: string[] = []
  const messages = new Map<number, AnswerMessage>()
  const assets = new Map<string, AnswerAsset>()
  let part: AnswerPart = 'requirements'
  // The asset whose sentence the next line can go on with.
  let open: AnswerAsset | null = null
  for (const line of withoutFence(text.replace(/\r\n?/g, '\n')).split('\n')) {
    const heading = headingPart(line)
    if (heading !== null) {
      part = heading
      open = null
      continue
    }
    if (part === 'requirements') {
      requirements.push(line)
      continue
    }
    if (part === 'messages') {
      const match = MESSAGE_LINE.exec(line)
      const number = match ? Number(match[1]) : NaN
      if (match && !messages.has(number)) messages.set(number, { number, decision: match[2].toLowerCase() as MessageDecision })
      continue
    }
    const match = ASSET_LINE.exec(line)
    if (match && match[1] === match[1].toLowerCase()) {
      const asset: AnswerAsset = { id: match[1], decision: match[2].toLowerCase() as AssetDecision, sentence: sentenceText(match[3]) }
      // A second line of an id still takes the lines that go on with it,
      // so that they do not join the asset before.
      open = asset
      if (!assets.has(asset.id)) assets.set(asset.id, asset)
    } else if (line.trim() === '') {
      open = null
    } else if (open) {
      open.sentence = `${open.sentence} ${sentenceText(line)}`.trim()
    }
  }
  return {
    requirements: requirements.join('\n').trim(),
    messages: [...messages.values()],
    assets: [...assets.values()],
  }
}

// The sentence of an asset line, with no bar of a table row at its end.
function sentenceText(text: string): string {
  return text.replace(/\s*\|\s*$/, '').trim()
}

/** Whether `answer` holds notes: requirements text, a message line, or an
 *  asset line. Dez quotes the kept messages of the user itself, so the
 *  text of the model is not the only record of the work. An answer with
 *  nothing that Dez can read (an empty one, or one cut off at once) must
 *  not take the place of a conversation. */
export function answerHasNotes(answer: CompactionAnswer): boolean {
  return answer.requirements !== '' || answer.messages.length > 0 || answer.assets.length > 0
}
