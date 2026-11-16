import { countOf } from '../../utils/countText'
import { usdText } from '../providers/modelPrices'
import { ASSET_NAME_SOURCE, ASSET_NAMES, jobResultLegend, jobResultState, type JobAssetKind, type JobInfo, type JobResultState, type JobStatus } from '../tools/jobs'
import type { ConversationCost } from './conversationCost'
import { IMAGE_ID_SOURCE } from './images'
import { notesTableRows, notesTableText, templateStatement, textsStatement, type NotesRow, type NotesTable } from './notesTable'
import { escapedModelText, unescapedModelText } from './toolBlocks'

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
//   <what the lines are> Each line: @id | kind | facts | who made it | …
//
//   ![/…/assets/generated/images/x.png](id=c|tool=model_invoke|made-by=j-ab12)
//   @c | image | PNG, 1024x768, 1.2 MB | made by the model_invoke job 2 of its reply: "A red fox" | this reply | The fox frame of scene 1.
//
//   @a | image | PNG, 800x600, 120 KB | from the user | - | The reference photo.
//
//   ## Jobs of the reply
//
//   <what the lines are> Each line: job id | inputs of an open job | how its call begins.
//   Each job was still running at this compaction.
//   No job has a result.
//
//   Jobs 1 to 28, tool model_invoke:
//   j-ab12 | @a | A red fox in the snow
//   …
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
// - The next compaction of the same reply (no message of the user came
//   between the two) also reads which assets that reply made, and the
//   inputs of its open jobs (streams/compactionAssets.ts): the tool blocks
//   that told them are gone.
// - Every image and clip that the compaction kept has one line. An asset
//   that a model or a tool made has its reference or tag in this section,
//   alone on the line before its line. An asset of the user has its
//   reference or tag in a user section after this one.
// - The assets and the jobs are tables (notesTable.ts): a value that every
//   row has, or that a run of rows has, leaves the rows for one line that
//   tells it, when that makes the text shorter. The reader gives back every
//   column of each row.
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
//   that still takes the old form. The reader of the tables reads a line
//   by the names of its columns, which the first line of the part tells:
//   the first form wrote all the columns in each line, with these names.

const SUMMARY_HEADING = '## Summary'
const REQUIREMENTS_HEADING = '## Requirements and decisions'
const NEXT_STEPS_HEADING = '## Next steps'
const ASSETS_HEADING = '## Assets of the conversation'
const JOBS_HEADING = '## Jobs of the reply'
const COST_HEADING = '## Cost'

// These texts are in the cached prefix of every request of the
// conversation: never a date, a running count, or a random value.
const NO_NOTES_ASSETS_TEXT = 'None: these notes keep no image and no clip.'
const NO_NOTES_JOBS_TEXT = 'None: no job of a reply ran at this compaction.'

// The value of the asset column that marks an asset that the reply that
// ran at the compaction made (`NotesAssetLine.byReply`); `-` for any other.
const BY_REPLY = 'this reply'

// The texts of a kind of asset that every asset has, by its name
// (`ASSET_NAMES`): "Each asset is an image."
const ASSET_KIND_TEXTS = Object.fromEntries(Object.values(ASSET_NAMES).map((name) => [name, `Each asset is ${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name}.`]))

const ASSETS_TABLE: NotesTable = {
  noun: { one: 'Asset', many: 'Assets' },
  intro: 'Every id still names its image or clip. An image or a clip that these notes do not show as a picture is kept as its line only.',
  rowGap: '\n\n',
  columns: [
    { name: '@id', pattern: `@${IMAGE_ID_SOURCE}` },
    { name: 'kind', pattern: ASSET_NAME_SOURCE, shared: textsStatement(ASSET_KIND_TEXTS), groups: true },
    { name: 'facts', pattern: '.*', shared: templateStatement('The facts of each asset: ', '.') },
    // The kind statement comes first: an origin is never "an image".
    { name: 'who made it', pattern: '.*', shared: templateStatement('Each asset is ', '.') },
    {
      name: 'made by the reply that ran at this compaction',
      pattern: `${BY_REPLY}|-`,
      shared: textsStatement({
        [BY_REPLY]: 'The reply that ran at this compaction made each asset.',
        '-': 'No asset was made by the reply that ran at this compaction.',
      }),
      fallback: '-',
    },
    { name: 'what it is, how it was made, and what a later step needs it for', pattern: '.*' },
  ],
}

const JOB_STATUS_TEXTS: Readonly<Record<JobStatus, string>> = {
  running: 'Each job was still running at this compaction.',
  finished: 'Each job finished.',
  failed: 'Each job failed.',
  'timed out': 'Each job timed out.',
  stopped: 'Each job was stopped.',
}

const JOB_RESULT_TEXTS: Readonly<Record<JobResultState, string>> = {
  ready: 'The next jobs_wait of that reply gives the result of each job.',
  given: 'A jobs_wait of that reply gave the result of each job.',
  '-': 'No job has a result.',
}

const JOBS_TABLE: NotesTable = {
  noun: { one: 'Job', many: 'Jobs' },
  intro: 'The jobs of the reply that ran at this compaction, in the order of their starts.',
  rowGap: '\n',
  columns: [
    { name: 'job id', pattern: '\\S+' },
    { name: 'number in the order of the starts', pattern: '\\d+', counts: true },
    { name: 'tool', pattern: '[^|]*', shared: templateStatement('The tool of each job: ', '.'), groups: true },
    { name: 'status', pattern: Object.keys(JOB_STATUS_TEXTS).join('|'), shared: textsStatement(JOB_STATUS_TEXTS), groups: true },
    {
      name: 'result',
      pattern: Object.keys(JOB_RESULT_TEXTS).join('|'),
      shared: textsStatement(JOB_RESULT_TEXTS),
      groups: true,
      legend: (values) => jobResultLegend(' of that reply', values),
    },
    {
      name: 'inputs of an open job',
      pattern: `@${IMAGE_ID_SOURCE}(?: @${IMAGE_ID_SOURCE})*|-`,
      shared: textsStatement({ '-': 'No open job had an input.' }),
      legend: () => 'An open job still ran at this compaction, or no jobs_wait had given its result.',
      fallback: '-',
    },
    { name: 'how its call begins', pattern: '.*' },
  ],
}

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
  /** The reply that ran at the compaction made it. False for an asset of
   *  the user, an asset of an earlier reply, and a line of an older Dez. */
  byReply: boolean
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
  /** The ids of the inputs of a job that was open at the compaction (it
   *  ran, or no `jobs_wait` had given its result), in order. Empty for
   *  any other job, and for a line of an older Dez. */
  inputs: string[]
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
  /** The ids of the inputs of each open job of `jobs`, by job id
   *  (`openJobInputs`, streams/compactionAssets.ts). */
  jobInputs: ReadonlyMap<string, readonly string[]>
  /** The cost of the conversation with the compaction request. */
  cost: ConversationCost | undefined
}

/** A text as one cell of a line of the notes: on one line, and, but for
 *  the last cell of a line, with `, ` in place of the column mark. The
 *  asset table of a compaction request holds the facts and the origin of
 *  an asset in this form too. */
export function notesCellText(text: string, last = false): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return last ? line : line.replace(/\s*\|\s*/g, ', ')
}

function assetRow({ id, kind, facts, origin, sentence, byReply, text }: NotesAsset): NotesRow {
  return {
    cells: [`@${id}`, ASSET_NAMES[kind], notesCellText(facts), escapedModelText(notesCellText(origin)), byReply ? BY_REPLY : '-', escapedModelText(notesCellText(sentence, true))],
    before: text,
  }
}

function jobRow(job: JobInfo, inputs: readonly string[] = []): NotesRow {
  const label = notesCellText(job.call.label, true)
  const inputWords = inputs.length > 0 ? inputs.map((id) => `@${id}`).join(' ') : '-'
  return {
    cells: [job.id, String(job.call.number), notesCellText(job.tool), job.status, jobResultState(job), inputWords, escapedModelText(label === '' ? '-' : label)],
    before: null,
  }
}

/** What the requests of a conversation cost up to a moment, which `upTo`
 *  names (as in "so far"), as one line for a model. */
export function conversationCostText(cost: ConversationCost | undefined, upTo: string): string {
  const start = `Cost of the conversation ${upTo}`
  if (!cost || cost.requests === 0) return `${start}: none. Dez counted no request.`
  const { usd, requests, unpriced } = cost
  const count = countOf(requests, 'request')
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
  const assets = notes.assets.map(assetRow)
  add(ASSETS_HEADING, assets.length > 0 || notes.unnamed.length > 0 ? [notesTableText(ASSETS_TABLE, assets), ...notes.unnamed].join('\n\n') : NO_NOTES_ASSETS_TEXT)
  add(JOBS_HEADING, notes.jobs.length > 0 ? notesTableText(JOBS_TABLE, notes.jobs.map((job) => jobRow(job, notes.jobInputs.get(job.id)))) : NO_NOTES_JOBS_TEXT)
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

/** The asset lines of the notes in `text` (the text of a compaction
 *  section), by asset id. Of two lines with one id, the last one counts. */
export function notesAssetLines(text: string): Map<string, NotesAssetLine> {
  const found = new Map<string, NotesAssetLine>()
  for (const [id, kind, facts, origin, byReply, sentence] of notesTableRows(ASSETS_TABLE, partLines(text, ASSETS_HEADING))) {
    found.set(id.slice(1), {
      id: id.slice(1),
      kind: KIND_BY_NAME.get(kind) as JobAssetKind,
      facts,
      origin: unescapedModelText(origin),
      sentence: unescapedModelText(sentence),
      byReply: byReply === BY_REPLY,
    })
  }
  return found
}

/** The job lines of the notes in `text` (the text of a compaction
 *  section), by job id. */
export function notesJobLines(text: string): Map<string, NotesJobLine> {
  const found = new Map<string, NotesJobLine>()
  for (const [id, number, tool, status, result, inputs, label] of notesTableRows(JOBS_TABLE, partLines(text, JOBS_HEADING))) {
    const call = unescapedModelText(label)
    found.set(id, {
      id,
      number: Number(number),
      tool,
      status: status as JobStatus,
      result: result as JobResultState,
      label: call === '-' ? '' : call,
      inputs: inputs === '-' ? [] : inputs.split(' ').map((word) => word.slice(1)),
    })
  }
  return found
}
