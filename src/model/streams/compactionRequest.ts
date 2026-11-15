import { compactionMessageEnd } from '../chat/compaction'
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
// prompt cache, and one more user message: the instruction. This module
// tells when a compaction is due, writes the instruction, and reads the
// answer. All pure; controller/compaction.ts sends the request.

/** Why a compaction is due: the context size, or the images and the
 *  pictures of the context by count, by bytes, or by tokens. */
export type CompactionReason = 'tokens' | 'images' | 'bytes' | 'pictureTokens'

// The share of a picture limit at which a compaction is due. Under 1, so
// that a model in a long reply can still see a picture until then.
const NEAR_PICTURE_LIMIT = 0.9

/** Why the next request of a conversation needs a compaction first; null
 *  when it needs none.
 *
 *  `contextTokens` is the context size of the tab, and `threshold` the
 *  compaction threshold of the model (`compactionThreshold`). `spent` is
 *  what the images and the pictures of the next request cost
 *  (`contextImageCost`), and `limits` the picture limits of the model
 *  (`pictureLimits`).
 *
 *  With no chat request since the last compaction the answer is null: a
 *  compaction that made no room would come again and again.
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
export function compactionReason({ contextTokens, threshold, limits, leaves, spent, kept, requestSinceCompaction }: {
  contextTokens: number
  threshold: number
  limits: PictureBudget
  leaves: PictureBudget
  spent: PictureBudget
  kept: PictureBudget
  requestSinceCompaction: boolean
}): CompactionReason | null {
  if (!requestSinceCompaction) return null
  if (contextTokens >= threshold) return 'tokens'
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

/** Whether the conversation `sections` holds a reply with text between its
 *  newest compaction (or its start) and the section of the reply that
 *  runs (`replySectionId`). At the first request of a reply, this tells
 *  whether a chat request went since the newest compaction
 *  (`compactionReason`): a first message, and a message right after a
 *  compaction, bring none. */
export function repliedSinceCompaction(sections: readonly Section[], replySectionId: string): boolean {
  return sections
    .slice(compactionMessageEnd(sections), replyIndex(sections, replySectionId))
    .some((section) => section.role === 'agent' && !sectionIsEmpty(section))
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

/** The answer of a model to a compaction request. */
export interface CompactionAnswer {
  summary: string
  requirements: string
  nextSteps: string
  /** In the order of the lines; of two lines with one id, only the first. */
  assets: AnswerAsset[]
}

/** The most characters of the sentence of an asset. */
export const MAX_ASSET_SENTENCE_LENGTH = 300

/** What the instruction of a compaction request holds. */
export interface CompactionInstruction {
  /** The table of the assets of the conversation (`assetTableText`,
   *  compactionAssets.ts). */
  assetTable: string
  /** The jobs of the reply that runs. A reply that sent no request yet
   *  has none. */
  jobs: readonly JobInfo[]
  /** The cost of the conversation before this request. */
  cost: ConversationCost | undefined
  /** The request offers the Dez tools. */
  tools: boolean
}

/** The instruction of a compaction request: the text of its last user
 *  message. The answer has the layout that `readCompactionAnswer` reads.
 *  It holds no path of a stored file. */
export function compactionInstruction({ assetTable, jobs, cost, tools }: CompactionInstruction): string {
  const text = `[Request from Dez, not a message of the user]

The conversation is near the limit of what one request can hold. So Dez now takes every message above out of the conversation and puts your answer to this request in their place, as notes. The work goes on right after that, from the notes alone: the next request holds only your notes, the first message of the user, and the newest message of the user, word for word. The tool calls and their results are gone then, and so is your thinking.

Write only the notes, as plain text, with these four headings and nothing before or after them.${tools ? ' Call no tool in this answer: Dez does not run it.' : ''}

## Summary
What the user wants, and what was done so far, in the order in which it happened. Include what failed and why, so that it is not tried again.

## Requirements and decisions
Every requirement, preference, and correction of the user, in the user's own words where the wording matters, and every decision that was made, with its reason. Include the exact values that later work needs: names, numbers, settings, and the important parts of prompts and commands.

## Next steps
What is in work now and what comes next, step by step, so that you can go on at once. Name the jobs that still run by their job ids, and tell what to do with their results.

## Assets
One line for each image and clip of the table below, in this form:
@id: show|keep|drop - one sentence

- show: you must see the asset itself to go on. Dez puts it into the notes as a picture (an image as it is, a video clip as a frame sheet, an audio clip as its wave). Pictures are costly, and Dez shows only as many as fit, in the order of your lines: put the most important one first.
- keep: a later step can need the asset, but you do not need to see it now. Dez keeps one line about it in the notes, and its id still names it${tools ? ', so a call can use it, and `asset_view` shows it to you again' : ''}.
- drop: no later step needs the asset. Dez takes it out of the conversation, and its id names nothing any more. Drop the intermediate assets of earlier work that no later step needs, and the versions that a newer one replaced and that the user did not ask to keep.

The sentence tells what the asset is, how it was made (the model or the tool, and the important parts of the prompt or the command), and what a later step needs it for. You read this sentence again at the next compaction, when the calls that made the asset are gone. At most ${MAX_ASSET_SENTENCE_LENGTH} characters.

Dez keeps an asset that your lines do not name. Dez never drops an asset from the user, an asset that was made since the last compaction, an asset that a job that is still open uses, or an asset that your notes name with @id: for those, \`drop\` reads as \`keep\`.

${assetTable}

The jobs of this reply:
${jobsListText(jobs)}

${conversationCostText(cost, 'so far')}`
  return withoutStoredFilePaths(text)
}

type AnswerPart = 'summary' | 'requirements' | 'nextSteps' | 'assets'

// The names that a model gives the four headings, in lower case.
const HEADING_PARTS: ReadonlyMap<string, AnswerPart> = new Map([
  ['summary', 'summary'],
  ['requirements and decisions', 'requirements'],
  ['requirements & decisions', 'requirements'],
  ['requirements', 'requirements'],
  ['decisions', 'requirements'],
  ['next steps', 'nextSteps'],
  ['next step', 'nextSteps'],
  ['assets', 'assets'],
  ['asset', 'assets'],
  ['asset decisions', 'assets'],
])

// A whole line in bold, with a number before it or a colon after it.
const BOLD_LINE = /^(?:\d+[.)]\s*)?(\*\*|__).+\1:?$/

// The part that the heading on `line` starts; null for a line that is no
// heading of the four. A heading has one of the forms that models write:
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
 *    heading, is a part of the summary. A heading that comes two times
 *    goes on with its part.
 *  - An asset line counts only under the assets heading. A line of other
 *    text right after an asset line goes on with the sentence of that
 *    line, up to the next blank line.
 *  - A line can end with CRLF. */
export function readCompactionAnswer(text: string): CompactionAnswer {
  const parts: Record<Exclude<AnswerPart, 'assets'>, string[]> = { summary: [], requirements: [], nextSteps: [] }
  const assets = new Map<string, AnswerAsset>()
  let part: AnswerPart = 'summary'
  // The asset whose sentence the next line can go on with.
  let open: AnswerAsset | null = null
  for (const line of withoutFence(text.replace(/\r\n?/g, '\n')).split('\n')) {
    const heading = headingPart(line)
    if (heading !== null) {
      part = heading
      open = null
      continue
    }
    if (part !== 'assets') {
      parts[part].push(line)
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
    summary: parts.summary.join('\n').trim(),
    requirements: parts.requirements.join('\n').trim(),
    nextSteps: parts.nextSteps.join('\n').trim(),
    assets: [...assets.values()],
  }
}

// The sentence of an asset line, with no bar of a table row at its end.
function sentenceText(text: string): string {
  return text.replace(/\s*\|\s*$/, '').trim()
}

/** Whether `answer` holds notes: text in one of its three parts. An answer
 *  with none (an empty answer, or only asset lines) must not take the
 *  place of a conversation. */
export function answerHasNotes(answer: CompactionAnswer): boolean {
  return answer.summary !== '' || answer.requirements !== '' || answer.nextSteps !== ''
}
