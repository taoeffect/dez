import { usdText } from '../providers/modelPrices'
import { ASSET_NAMES, jobResultState, type JobAssetKind, type JobInfo, type JobResultState, type JobStatus } from '../tools/jobs'
import type { ConversationCost } from './conversationCost'
import { IMAGE_ID_SOURCE } from './images'
import { escapedModelText, modelTextForRequest } from './toolBlocks'

// The notes of a compaction section: its text after the tag line
// (compaction.ts). This module is the one place that writes them, and that
// reads the lines of Dez in them.
//
//   ## Summary
//
//   <text of the model>
//
//   ## Requirements and decisions
//
//   <text of the model>
//
//   ## Next steps
//
//   <text of the model>
//
//   ## Assets of the conversation
//
//   <what the lines are>
//
//   ![/…/assets/generated/images/x.png](id=c|tool=model_invoke|made-by=j-ab12)
//   @c | image | PNG, 1024x768, 1.2 MB | made by the model_invoke job 2 of its reply: "A red fox" | The fox frame of scene 1.
//
//   @a | image | PNG, 800x600, 120 KB | from the user | The reference photo.
//
//   ## Jobs of the reply
//
//   <what the lines are>
//
//   j-ab12 | 2 | model_invoke | finished | given | A red fox in the snow
//
//   ## Cost
//
//   <one sentence>
//
// - The first three parts are the answer of the model to the compaction
//   request (streams/compactionRequest.ts). A blank part is left out.
// - The other parts are of Dez. The compaction removes the tool blocks of
//   the conversation, so these lines are all that still tells who made an
//   asset, and which job is which: `asset_info` reads them
//   (assetOrigins.ts), and the next compaction copies the origin and the
//   sentence of an asset from its line.
// - Every image and clip that the compaction kept has one line. An asset
//   that a model or a tool made has its reference or tag in this section,
//   alone on the line before its line. An asset of the user has its
//   reference or tag in a user section after this one.
// - The sentence is the last column of an asset line, and the label the
//   last one of a job line: both are free text, which can hold the column
//   mark. The columns before them hold no `|`.
// - Every text of a model (the three parts, a sentence, a label of a call)
//   has the escape of model text (`ModelTextEscaper`), so it forms no tag
//   of Dez, and a request sends it with the escape removed. The readers
//   give a text back with the escape removed.
// - A reader takes the last heading of its name. Dez always writes its
//   parts, also with nothing in them, and after the text of the model, so
//   a reader never takes a line of a model for a line of Dez: a model can
//   copy a heading of earlier notes into its answer.
// - Saved conversations hold these lines, and later compactions and
//   `asset_info` read them back. So a new form of a line needs a reader
//   that still takes the old form.

const SUMMARY_HEADING = '## Summary'
const REQUIREMENTS_HEADING = '## Requirements and decisions'
const NEXT_STEPS_HEADING = '## Next steps'
const ASSETS_HEADING = '## Assets of the conversation'
const JOBS_HEADING = '## Jobs of the reply'
const COST_HEADING = '## Cost'

// These texts are in the cached prefix of every request of the
// conversation: never a date, a count, or a random value.
const ASSETS_LEGEND = 'Each line: @id | kind | facts | who made it | what it is, how it was made, and what a later step needs it for. '
  + 'Every id still names its image or clip. An image or a clip that these notes do not show as a picture is kept as its line only.'
const JOBS_LEGEND = 'The jobs of the reply that ran at this compaction. Each line: job id | number in the order of the starts | tool | status | result | how its call begins. '
  + 'result: `ready` means that the next jobs_wait of that reply gives it, `given` that a jobs_wait gave it, and `-` that there is none.'
const NO_ASSETS_TEXT = 'None: these notes keep no image and no clip.'
const NO_JOBS_TEXT = 'None: no job of a reply ran at this compaction.'

const COLUMN = ' | '

/** The line of one asset in the notes. */
export interface NotesAssetLine {
  id: string
  kind: JobAssetKind
  /** The facts of its file (`imageFactsText`, `clipFactsText`), with no
   *  column mark. */
  facts: string
  /** Who made it (`assetOriginText`), with no column mark. */
  origin: string
  /** What the model wrote about it; blank for none. */
  sentence: string
}

/** One asset of the notes: its line, and its text. */
export interface NotesAsset extends NotesAssetLine {
  /** The reference or the tag of an asset that the compaction section
   *  holds; null for an asset of the user, whose text is in a user
   *  section. */
  text: string | null
}

/** The line of one job in the notes. */
export interface NotesJobLine {
  id: string
  /** The place of the job in the order of the starts of its reply. */
  number: number
  tool: string
  status: JobStatus
  result: JobResultState
  /** How its call begins; blank for none. */
  label: string
}

/** What the notes of a compaction hold. */
export interface CompactionNotes {
  /** The three parts of the model's answer, with no escape. */
  summary: string
  requirements: string
  nextSteps: string
  assets: readonly NotesAsset[]
  /** The references of the made images with no id (an image of an old
   *  Dez), each with the kept mark. No line can name one, but its text
   *  must stay, so that the user still has the image. */
  unnamed: readonly string[]
  /** The jobs of the reply that ran at the compaction. */
  jobs: readonly JobInfo[]
  /** The cost of the conversation with the compaction request. */
  cost: ConversationCost | undefined
}

// A text as one cell of a line: on one line, and, but for the last cell of
// a line, with no column mark.
function cell(text: string, last = false): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return last ? line : line.replace(/\s*\|\s*/g, ', ')
}

/** The facts text of an asset (`imageFactsText`, `clipFactsText`, or the
 *  text of a file that Dez could not read) as the notes and the asset
 *  table of a compaction request hold it: with `, ` in place of the column
 *  mark. */
export function notesFactsText(facts: string): string {
  return cell(facts)
}

function assetLineText({ id, kind, facts, origin, sentence }: NotesAssetLine): string {
  const cells = [`@${id}`, ASSET_NAMES[kind], cell(facts), escapedModelText(cell(origin)), escapedModelText(cell(sentence, true))]
  // A line with no sentence ends with the origin.
  return cells.filter((text, index) => index < 4 || text !== '').join(COLUMN)
}

function jobLineText(job: JobInfo): string {
  const label = cell(job.call.label, true)
  return [job.id, job.call.number, cell(job.tool), job.status, jobResultState(job), escapedModelText(label === '' ? '-' : label)].join(COLUMN)
}

/** What the requests of a conversation cost up to a moment, which `upTo`
 *  names (as in "so far"), as one line for a model. */
export function conversationCostText(cost: ConversationCost | undefined, upTo: string): string {
  const start = `Cost of the conversation ${upTo}`
  if (!cost || cost.requests === 0) return `${start}: none. Dez counted no request.`
  const { usd, requests, unpriced } = cost
  const count = requests === 1 ? '1 request' : `${requests} requests`
  if (unpriced === requests) return `${start}: unknown. Dez knows no price of its ${count}.`
  const rest = unpriced === 0 ? '' : ` ${unpriced} of them ${unpriced === 1 ? 'has' : 'have'} no known price, and the sum leaves ${unpriced === 1 ? 'it' : 'them'} out.`
  return `${start} (an estimate): ${usdText(usd)} for ${count}.${rest}`
}

/** The text of the notes: the text of a compaction section after its tag
 *  line. */
export function compactionNotesText(notes: CompactionNotes): string {
  const parts: string[] = []
  const add = (heading: string, text: string) => parts.push(`${heading}\n\n${text}`)
  const modelParts: Array<readonly [string, string]> = [
    [SUMMARY_HEADING, notes.summary],
    [REQUIREMENTS_HEADING, notes.requirements],
    [NEXT_STEPS_HEADING, notes.nextSteps],
  ]
  for (const [heading, text] of modelParts) {
    if (text.trim() !== '') add(heading, escapedModelText(text.trim()))
  }
  const entries = notes.assets.map((asset) => (asset.text === null ? assetLineText(asset) : `${asset.text}\n${assetLineText(asset)}`))
  add(ASSETS_HEADING, entries.length > 0 || notes.unnamed.length > 0 ? [ASSETS_LEGEND, ...entries, ...notes.unnamed].join('\n\n') : NO_ASSETS_TEXT)
  add(JOBS_HEADING, notes.jobs.length > 0 ? `${JOBS_LEGEND}\n\n${notes.jobs.map(jobLineText).join('\n')}` : NO_JOBS_TEXT)
  add(COST_HEADING, conversationCostText(notes.cost, 'up to this compaction'))
  return parts.join('\n\n')
}

// The lines of the last part of `text` with `heading`: from the line after
// the heading to the next heading of that level.
function partLines(text: string, heading: string): string[] {
  const lines = text.split('\n')
  const start = lines.lastIndexOf(heading)
  if (start < 0) return []
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  return lines.slice(start + 1, end < 0 ? lines.length : end)
}

const KIND_BY_NAME = new Map(Object.entries(ASSET_NAMES).map(([kind, name]) => [name, kind as JobAssetKind]))
const ASSET_LINE = new RegExp(`^@(${IMAGE_ID_SOURCE}) \\| (${[...KIND_BY_NAME.keys()].join('|')}) \\| (.*)$`)
const JOB_LINE = /^(\S+) \| (\d+) \| ([^|]*) \| (running|finished|failed|timed out|stopped) \| (-|given|ready) \| (.*)$/

/** The asset lines of the notes in `text` (the text of a compaction
 *  section), by asset id. Of two lines with one id, the last one counts. */
export function notesAssetLines(text: string): Map<string, NotesAssetLine> {
  const found = new Map<string, NotesAssetLine>()
  for (const line of partLines(text, ASSETS_HEADING)) {
    const match = ASSET_LINE.exec(line)
    if (!match) continue
    const [facts, origin, ...sentence] = match[3].split(COLUMN)
    if (origin === undefined) continue
    found.set(match[1], {
      id: match[1],
      kind: KIND_BY_NAME.get(match[2]) as JobAssetKind,
      facts,
      origin: modelTextForRequest(origin),
      sentence: modelTextForRequest(sentence.join(COLUMN)),
    })
  }
  return found
}

/** The job lines of the notes in `text` (the text of a compaction
 *  section), by job id. */
export function notesJobLines(text: string): Map<string, NotesJobLine> {
  const found = new Map<string, NotesJobLine>()
  for (const line of partLines(text, JOBS_HEADING)) {
    const match = JOB_LINE.exec(line)
    if (!match) continue
    const label = modelTextForRequest(match[6])
    found.set(match[1], {
      id: match[1],
      number: Number(match[2]),
      tool: match[3],
      status: match[4] as JobStatus,
      result: match[5] as JobResultState,
      label: label === '-' ? '' : label,
    })
  }
  return found
}
