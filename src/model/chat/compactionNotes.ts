import { countOf } from '../../utils/countText'
import { usdText } from '../providers/modelPrices'
import { APP_KINDS, APP_NAME_SOURCE, UNKNOWN_APP_KIND, type ListedAppKind } from '../tools/appManifest'
import { APPS_VIRTUAL_ROOT } from '../tools/appsTool'
import { ASSET_NAME_SOURCE, ASSET_NAMES, jobResultLegend, jobResultState, type JobAssetKind, type JobInfo, type JobResultState, type JobStatus } from '../tools/jobs'
import { labelAppTags } from './appTags'
import { openFenceCloser } from './codeRanges'
import { AGENT_MESSAGE_TAG_NAME, blockLinkedRule, COMPACTION_TAG_NAME, readCompactionBlock, USER_MESSAGE_TAG_NAME } from './compaction'
import type { ConversationCost } from './conversationCost'
import { IMAGE_ID_SOURCE, labelImageReferences, type LinkedPathRule } from './images'
import { labelMediaTags } from './mediaTags'
import { notesTableRows, notesTableText, templateStatement, textsStatement, type NotesRow, type NotesTable } from './notesTable'
import { tagEscape } from './tagEscape'
import { escapedModelText, unescapedModelText } from './toolBlocks'
import type { Role } from './types'

// The notes of a compaction section: the lines of its block between the
// tag line and the end line (compaction.ts). This module is the one place
// that writes them, that reads the lines of Dez in them, and that makes
// them a text for people (`compactionNotesForPeople`).
//
//   ## Requirements and decisions
//
//   <text of the model>
//
//   ## Assets of the conversation
//
//   <what the lines are> Each line: @id | kind | facts | who made it | …
//
//   ![id=c|tool=model_invoke|made-by=j-ab12](/…/assets/generated/images/x.png)
//   @c | image | PNG, 1024x768, 1.2 MB | made by the model_invoke job 2 of its reply: "A red fox" | this reply | The fox frame of scene 1.
//
//   @a | image | PNG, 800x600, 120 KB | from the user | - | The reference photo.
//
//   ## Apps of the conversation
//
//   <what the lines are> Each line: app | kind | description.
//
//   /apps/contact-sheet | script | Makes a contact sheet of images.
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
//   ## User messages
//
//   ### First message
//
//   <dez:user-message>
//   <the first message of the user, word for word>
//   </dez:user-message>
//
//   ### Relevant middle messages
//
//   Dez left out 2 other messages of the user here: …
//
//   <dez:user-message>
//   <a middle message that the model kept, word for word>
//   </dez:user-message>
//
//   ### Final message pair
//
//   <label line: the reply of the assistant before the final message>
//
//   <dez:agent-message>
//   <that reply, as the user saw it, with no tool call>
//   </dez:agent-message>
//
//   <label line: the final message of the user>
//
//   <dez:user-message>
//   <the message that the reply answers, word for word>
//   </dez:user-message>
//
// - The messages of the user are the user parts (`notesMessages`), in
//   the order of the conversation, and they are read by their place: the
//   first part is the first message of the conversation, which a later
//   compaction copies from the notes before. Of two or more parts, the
//   last one is the final message: the one that the reply that ran at the
//   compaction answers. The parts between them are the middle messages
//   that the model kept (streams/compactionAssets.ts). When the first
//   message is the final one, the notes hold one part, with the heading
//   `### First and final message`. The model reads the final message
//   last, right before the reply goes on.
// - The final message pair: the reply of the assistant right before the
//   final message, in a reply part (`notesFinalReply`), then the final
//   message, each after a label line of Dez. A short answer of the user
//   ("yes, but …") needs the text that it answers. The reply is the text
//   that the user saw, with no tool block, no hidden asset, and each
//   image reference, media tag, and app tag as its mention or label
//   (streams/compactionAssets.ts), so the part holds no asset. With no
//   such reply, the heading is `### Final message`, with the user part
//   only. Notes of an older Dez have no reply part.
// - The middle part starts with one line that tells how many middle
//   messages Dez left out, when it left out one or more: at this
//   compaction and at the ones before. With no middle message and none
//   left out, the notes have no middle heading.
// - The notes of Dez before this layout had the parts `## First message of
//   the user` (or `## First and newest message of the user`) before the
//   text of the model, `## Summary` and `## Next steps` parts of the
//   model, and `## Newest message of the user` at the end. The readers
//   read them too: the parts are read by place, and a reader of a part of
//   Dez finds its heading.
// - A part is the text of its message between a start line and an end
//   line, each a whole line. A user part has an escape of its own
//   (`messageEscape`). It takes only the tags that would end the part or
//   the block, or form a tool block in this agent section; the image
//   references and the media tags of the user stay as they are, so they
//   still count, at their places. A reply part has the escape of model
//   text. A request sends a user part as a message of the user
//   (streams/messages.ts), and a request and a text for people show each
//   part in a code fence (`messageFence`) in place of its two tag lines.
//   A reader of the lines of Dez skips the parts, so a line of a message
//   is never a line of Dez.
// - The requirements and decisions are the text part of the answer of
//   the model to the compaction request (streams/compactionRequest.ts). A
//   blank part is left out. A part that leaves a code fence open gets a
//   closer line (`openFenceCloser`, codeRanges.ts): code is text, and a
//   `<dez:` line ends a fence, but the headings, image references, and
//   asset rows that Dez writes after the part do not. The fence would else
//   hold them, and a kept image in it would be text, not an image.
// - The parts of the assets, the jobs, and the cost are of Dez. The
//   compaction removes the tool blocks of the conversation, so these lines
//   are all that still tells who made an asset, and which job is which:
//   `asset_info` reads them (assetOrigins.ts), and the next compaction
//   copies the origin and the sentence of an asset from its line.
// - The next compaction of the same reply (no message of the user came
//   between the two) also reads which assets that reply made, and the
//   inputs of its open jobs (streams/compactionAssets.ts): the tool blocks
//   that told them are gone.
// - Every image and clip that the compaction kept has one line. An asset
//   in a message part has its reference or tag there. Any other asset has
//   its reference or tag in this section, alone on the line before its
//   line: an asset that a model or a tool made, and an asset of another
//   message of the user (its origin is "from the user"). In a conversation
//   of an older Dez, an asset of the user can have its reference or tag
//   in a user section after this one.
// - The apps (tools/appsTool.ts) that the text before the compaction
//   named have a part of their own, one line for each. The compaction
//   removes the calls and the tags that named them, so these lines are
//   all that still names them: they tell a model that the apps are
//   there, and their paths keep the apps out of Delete Unreferenced Apps
//   (`namedApps`, appNames.ts). The next compaction finds the names with
//   that same rule, and reads a line only for the kind and the
//   description of an app whose manifest it cannot read. An app is no
//   asset: the part holds no id and no file path. Notes with no app have
//   no such part.
// - The assets, the apps, and the jobs are tables (notesTable.ts): a
//   value that every row has, or that a run of rows has, leaves the rows
//   for one line that tells it, when that makes the text shorter. The
//   reader gives back every column of each row.
// - The sentence is the last column of an asset line, the description
//   the last one of an app line, and the label the last one of a job
//   line: all are free text, which can hold the column mark. The columns
//   before them hold no `|`.
// - Every text of a model (the requirements, a sentence, the description
//   of an app, a label of a call) has the escape of model text
//   (`ModelTextEscaper`), so it forms no tag of Dez, and a request sends
//   it with the escape removed. The readers give a text back with the
//   escape removed.
// - A reader takes the last heading of its name. Dez writes its parts
//   after the text of the model, and the parts of the assets, the jobs,
//   and the cost also with nothing in them, so a reader never takes a
//   line of a model for a line of Dez: a model can copy a heading of
//   earlier notes into its answer. `## User messages` is there only with
//   a first message, but no line of a model has it: the reader of the
//   answer takes each such line as a heading. So a reply part counts only
//   after that heading (`scanMessages`). The part of the apps is there
//   only with an app, so its reader takes it only after the part of the
//   assets, where no text of a model is. No reader looks into a message
//   part.
// - Saved conversations hold these lines, and later compactions and
//   `asset_info` read them back. So a new form of a line needs a reader
//   that still takes the old form. The reader of the tables reads a line
//   by the names of its columns, which the first line of the part tells:
//   the first form wrote all the columns in each line, with these names.

const REQUIREMENTS_HEADING = '## Requirements and decisions'
const ASSETS_HEADING = '## Assets of the conversation'
const APPS_HEADING = '## Apps of the conversation'
const JOBS_HEADING = '## Jobs of the reply'
const COST_HEADING = '## Cost'
const USER_MESSAGES_HEADING = '## User messages'
const FIRST_MESSAGE_HEADING = '### First message'
const ONLY_MESSAGE_HEADING = '### First and final message'
const MIDDLE_MESSAGES_HEADING = '### Relevant middle messages'
const FINAL_MESSAGE_HEADING = '### Final message'
const FINAL_PAIR_HEADING = '### Final message pair'

const MESSAGE_START_LINE = `<${USER_MESSAGE_TAG_NAME}>`
const MESSAGE_END_LINE = `</${USER_MESSAGE_TAG_NAME}>`
const REPLY_START_LINE = `<${AGENT_MESSAGE_TAG_NAME}>`
const REPLY_END_LINE = `</${AGENT_MESSAGE_TAG_NAME}>`
// The escape of the text of a user part. Not the escape of model text:
// that one also takes the media tags, so a clip of the user would not
// count, and its unescape would change a text of the user that holds
// `<\dez:audio`. A user part needs no escape of the reply tag: no start
// line opens a part in a part.
const messageEscape = tagEscape('dez:tool', COMPACTION_TAG_NAME, USER_MESSAGE_TAG_NAME)

// The start line, the end line, and the unescape of the text of each kind
// of message part, by the role of its message.
const PART_FORMS: Readonly<Record<Role, { start: string, end: string, unescape: (text: string) => string }>> = {
  user: { start: MESSAGE_START_LINE, end: MESSAGE_END_LINE, unescape: messageEscape.unescape },
  agent: { start: REPLY_START_LINE, end: REPLY_END_LINE, unescape: unescapedModelText },
}

// These texts are in the cached prefix of every request of the
// conversation: never a date, a running count, or a random value.
const NO_NOTES_ASSETS_TEXT = 'None: these notes keep no image and no clip.'
const NO_NOTES_JOBS_TEXT = 'None: no job of a reply ran at this compaction.'
// The label lines of the two parts of the final message pair.
const REPLY_LABEL = 'The last reply of the assistant before the final message of the user, with its tool calls left out:'
const FINAL_LABEL = 'The final message of the user, which came after that reply:'

// The line at the start of the middle part that tells how many middle
// messages Dez left out (`CompactionNotes.leftOutMessages`), and its
// reader. The count is fixed until the next compaction, so the line can be
// in the cached prefix.
function leftOutText(count: number): string {
  const [its, it] = count === 1 ? ['its', 'it'] : ['their', 'them']
  return `Dez left out ${countOf(count, 'other message')} of the user here: the work at hand no longer needed ${its} words, and the notes above tell what of ${it} still counts.`
}
const LEFT_OUT_LINE = /^Dez left out ([\d,]+) other messages? of the user here:/

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
  cancelled: 'Each job was cancelled.',
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

const APP_PATH_START = `${APPS_VIRTUAL_ROOT}/`

const APPS_TABLE: NotesTable = {
  noun: { one: 'App', many: 'Apps' },
  intro: 'The apps that the conversation named before this compaction, each as it was then. Dez keeps the files of each one.',
  rowGap: '\n',
  columns: [
    { name: 'app', pattern: `${APP_PATH_START}${APP_NAME_SOURCE}` },
    { name: 'kind', pattern: [...APP_KINDS, `\\${UNKNOWN_APP_KIND}`].join('|') },
    { name: 'description', pattern: '.*' },
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
  /** The reference or the tag of the asset, which goes on the line before
   *  its line; null for an asset whose text is in a message part. */
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

/** The line of one app in the notes. */
export interface NotesApp {
  /** The name of the app: the name of its folder. */
  name: string
  kind: ListedAppKind
  /** What the app is: the description of its manifest, or a text of Dez
   *  that tells why Dez knows none; blank for none. */
  description: string
}

/** What the notes of a compaction hold. */
export interface CompactionNotes {
  /** The first message of the user, as its plain text (a prompt pill as
   *  its body); null when the conversation has none. Each message of the
   *  user has this form. */
  firstMessage: string | null
  /** The middle messages of the user that the notes keep, oldest first. */
  middleMessages: readonly string[]
  /** How many middle messages of the user the notes left out, at this
   *  compaction and at the ones before it. */
  leftOutMessages: number
  /** The message of the user that the reply that runs answers; null when
   *  it is the first message, or when there is none. */
  finalMessage: string | null
  /** The reply of the assistant right before `finalMessage`, as the user
   *  saw it (`CompactionScope.finalReply`, streams/compactionAssets.ts),
   *  with no escape; null for none. The notes hold it only with a final
   *  message. */
  finalReply: string | null
  /** The text part of the model's answer, with no escape. */
  requirements: string
  assets: readonly NotesAsset[]
  /** The references of the images with no id (an image of an old Dez)
   *  that the notes keep, each with the kept mark, and not in a message
   *  part. No line can name one, but its text must stay, so that the user
   *  still has the image. */
  unnamed: readonly string[]
  /** The apps that the text before the compaction named, by name. */
  apps: readonly NotesApp[]
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

function appRow({ name, kind, description }: NotesApp): NotesRow {
  return { cells: [`${APP_PATH_START}${name}`, kind, escapedModelText(notesCellText(description, true))], before: null }
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

// The text of a user part: the start line, the text with its escape, and
// the end line.
function messagePartText(text: string): string {
  return `${MESSAGE_START_LINE}\n${messageEscape.escape(text)}\n${MESSAGE_END_LINE}`
}

// The text of a reply part: the start line, the text with the escape of
// model text, and the end line.
function replyPartText(text: string): string {
  return `${REPLY_START_LINE}\n${escapedModelText(text)}\n${REPLY_END_LINE}`
}

// The part of the messages of the user in `notes`, with no heading: a
// sub-part for each kind of message, in the order of the conversation.
function userMessagesText({ firstMessage, middleMessages, leftOutMessages, finalMessage, finalReply }: CompactionNotes): string {
  const parts: string[] = []
  if (firstMessage !== null) parts.push(`${finalMessage === null ? ONLY_MESSAGE_HEADING : FIRST_MESSAGE_HEADING}\n\n${messagePartText(firstMessage)}`)
  if (middleMessages.length > 0 || leftOutMessages > 0) {
    const lines = [...(leftOutMessages > 0 ? [leftOutText(leftOutMessages)] : []), ...middleMessages.map(messagePartText)]
    parts.push(`${MIDDLE_MESSAGES_HEADING}\n\n${lines.join('\n\n')}`)
  }
  if (finalMessage !== null && finalReply === null) parts.push(`${FINAL_MESSAGE_HEADING}\n\n${messagePartText(finalMessage)}`)
  if (finalMessage !== null && finalReply !== null) {
    parts.push([FINAL_PAIR_HEADING, REPLY_LABEL, replyPartText(finalReply), FINAL_LABEL, messagePartText(finalMessage)].join('\n\n'))
  }
  return parts.join('\n\n')
}

// `text`, a text of a model in the notes, with a closer line for the code
// fence that it leaves open at its end.
function closedFences(text: string): string {
  const closer = openFenceCloser(text)
  return closer === null ? text : `${text}\n${closer}`
}

/** The text of the notes: the lines of a compaction block between its tag
 *  line and its end line (`compactionBlockText`). */
export function compactionNotesText(notes: CompactionNotes): string {
  const parts: string[] = []
  const add = (heading: string, text: string) => parts.push(`${heading}\n\n${text}`)
  if (notes.requirements.trim() !== '') add(REQUIREMENTS_HEADING, closedFences(escapedModelText(notes.requirements.trim())))
  const assets = notes.assets.map(assetRow)
  add(ASSETS_HEADING, assets.length > 0 || notes.unnamed.length > 0 ? [notesTableText(ASSETS_TABLE, assets), ...notes.unnamed].join('\n\n') : NO_NOTES_ASSETS_TEXT)
  if (notes.apps.length > 0) add(APPS_HEADING, notesTableText(APPS_TABLE, notes.apps.map(appRow)))
  add(JOBS_HEADING, notes.jobs.length > 0 ? notesTableText(JOBS_TABLE, notes.jobs.map((job) => jobRow(job, notes.jobInputs.get(job.id)))) : NO_NOTES_JOBS_TEXT)
  add(COST_HEADING, conversationCostText(notes.cost, 'up to this compaction'))
  if (notes.firstMessage !== null) add(USER_MESSAGES_HEADING, userMessagesText(notes))
  return parts.join('\n\n')
}

/** One message part of the notes. The offsets are in the notes. */
export interface NotesMessage {
  /** `user` for a message of the user, `agent` for the reply of the
   *  assistant in the final message pair. */
  role: Role
  /** The text of the message, with the escape of the part removed. */
  text: string
  /** The text with its escape: from the line after the start line to
   *  the line break before the end line. */
  from: number
  to: number
  /** The whole part: from the start line to after the end line, or to the
   *  end of the notes for a part with no end line. */
  partFrom: number
  partTo: number
}

// The message parts of `notes`, and whether each of its lines is a line of
// a part. A line that is a start line opens a part, and the first later
// line that is the end line of its kind closes it. With no end line, the
// part runs to the end of the notes.
//
// The start line of a reply opens a part only after the first line
// `## User messages` outside the parts. The reader of the answer of a
// model takes each such line as a heading (streams/compactionRequest.ts),
// so the requirements never hold one, and the first one is the heading of
// Dez. The requirements of the notes before the escape of model text took
// the reply tag can hold its start line bare, and they come before that
// heading. Such a line must open no part: the part would hide the lines of
// Dez after it (`partLines`), and the next compaction would lose them.
function scanMessages(notes: string): { messages: NotesMessage[], lines: string[], inMessage: boolean[] } {
  const lines = notes.split('\n')
  const inMessage = lines.map(() => false)
  const messages: NotesMessage[] = []
  const add = (role: Role, partFrom: number, endLineFrom: number, partTo: number) => {
    const form = PART_FORMS[role]
    const from = Math.min(partFrom + form.start.length + 1, notes.length)
    const to = Math.max(from, endLineFrom - 1)
    messages.push({ role, text: form.unescape(notes.slice(from, to)), from, to, partFrom, partTo })
  }
  let open: { role: Role, from: number } | null = null
  let afterHeading = false
  let offset = 0
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (open !== null) {
      inMessage[index] = true
      if (line === PART_FORMS[open.role].end) {
        add(open.role, open.from, offset, offset + line.length)
        open = null
      }
    } else if (line === MESSAGE_START_LINE || (afterHeading && line === REPLY_START_LINE)) {
      inMessage[index] = true
      open = { role: line === MESSAGE_START_LINE ? 'user' : 'agent', from: offset }
    } else if (line === USER_MESSAGES_HEADING) {
      afterHeading = true
    }
    offset += line.length + 1
  }
  if (open !== null) add(open.role, open.from, notes.length + 1, notes.length)
  return { messages, lines, inMessage }
}

/** The message parts of the notes `notes` (`CompactionBlock.notes`) of
 *  both kinds, the user parts and the reply part, in order. */
export function notesMessageParts(notes: string): NotesMessage[] {
  return scanMessages(notes).messages
}

/** The user parts of the notes `notes` (`CompactionBlock.notes`), in
 *  order. The first one is the first message of the user; of two or more,
 *  the last one is the final message, and the ones between them are the
 *  middle messages. */
export function notesMessages(notes: string): NotesMessage[] {
  return scanMessages(notes).messages.filter((message) => message.role === 'user')
}

/** The reply of the final message pair of the notes `notes`
 *  (`CompactionNotes.finalReply`), with no escape: the reply part right
 *  before the last user part; null when there is none. Any other reply
 *  part (a hand edit) counts for nothing. */
export function notesFinalReply(notes: string): string | null {
  const parts = scanMessages(notes).messages
  const last = parts.findLastIndex((part) => part.role === 'user')
  return last > 0 && parts[last - 1].role === 'agent' ? parts[last - 1].text : null
}

/** How many middle messages of the user the notes `notes` left out
 *  (`CompactionNotes.leftOutMessages`); 0 for the notes of an older Dez,
 *  which have no line of the count. */
export function notesLeftOutMessages(notes: string): number {
  for (const line of partLines(notes, USER_MESSAGES_HEADING)) {
    const match = LEFT_OUT_LINE.exec(line)
    if (match) return Number(match[1].replace(/,/g, ''))
  }
  return 0
}

/** The fence of a code block that quotes the message `text` of a message
 *  part: backticks, one more than the longest run of backticks in `text`,
 *  and at least 3. A run inside a code block that is shorter than its
 *  fence does not close it (CommonMark), so the text can hold any fence of
 *  its own. The request form and the form for people of a message only
 *  make its runs shorter, so the fence of its raw text fits each form. */
export function messageFence(text: string): string {
  let longest = 0
  let run = 0
  for (const char of text) {
    run = char === '`' ? run + 1 : 0
    if (run > longest) longest = run
  }
  return '`'.repeat(Math.max(3, longest + 1))
}

// The lines of the last part of `text` with `heading`: from the line after
// the heading to the next heading of that level. The lines of the message
// parts do not count. With `after`, a heading of a part that Dez always
// writes, the part counts only when it comes after that part: a part
// that Dez leaves out when it has no line could else be text of a model.
function partLines(text: string, heading: string, after?: string): string[] {
  const { lines: all, inMessage } = scanMessages(text)
  const lines = all.filter((_, index) => !inMessage[index])
  const start = lines.lastIndexOf(heading)
  if (start < 0 || (after !== undefined && start < lines.lastIndexOf(after))) return []
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  return lines.slice(start + 1, end < 0 ? lines.length : end)
}

const KIND_BY_NAME = new Map(Object.entries(ASSET_NAMES).map(([kind, name]) => [name, kind as JobAssetKind]))

/** The asset lines of the notes `notes` (`CompactionBlock.notes`), by
 *  asset id. Of two lines with one id, the last one counts. */
export function notesAssetLines(notes: string): Map<string, NotesAssetLine> {
  const found = new Map<string, NotesAssetLine>()
  for (const [id, kind, facts, origin, byReply, sentence] of notesTableRows(ASSETS_TABLE, partLines(notes, ASSETS_HEADING))) {
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

/** The job lines of the notes `notes` (`CompactionBlock.notes`), by job
 *  id. */
export function notesJobLines(notes: string): Map<string, NotesJobLine> {
  const found = new Map<string, NotesJobLine>()
  for (const [id, number, tool, status, result, inputs, label] of notesTableRows(JOBS_TABLE, partLines(notes, JOBS_HEADING))) {
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

/** The app lines of the notes `notes` (`CompactionBlock.notes`), by the
 *  name of the app. */
export function notesAppLines(notes: string): Map<string, NotesApp> {
  const found = new Map<string, NotesApp>()
  for (const [path, kind, description] of notesTableRows(APPS_TABLE, partLines(notes, APPS_HEADING, ASSETS_HEADING))) {
    const name = path.slice(APP_PATH_START.length)
    found.set(name, { name, kind: kind as ListedAppKind, description: unescapedModelText(description) })
  }
  return found
}

/** The notes `notes` (`CompactionBlock.notes`, or a part of them), whose
 *  linked paths count by `rule` (`blockLinkedRule`), as a text for people
 *  to read: each image reference, media tag, and app tag as its label
 *  (`[image]`, `[video]`, `[app <name>]`), so no file path, the text of
 *  the model with its escape removed, and each message part as the text of
 *  its message in a code fence (`messageFence`). The chips of a
 *  compaction, Copy Markdown, Save As Markdown, the History preview, and
 *  the search show the notes in this form.
 *
 *  The labels go in first, while the text of the model still has its
 *  escape: with the escape removed first, a tag that a model wrote would
 *  read as a tag of Dez. */
export function compactionNotesForPeople(notes: string, rule: LinkedPathRule): string {
  const labeled = (text: string) => labelAppTags(labelMediaTags(labelImageReferences(text, rule), rule), rule)
  const pieces: string[] = []
  let from = 0
  for (const part of notesMessageParts(notes)) {
    const fence = messageFence(part.text)
    const text = part.role === 'user' ? labeled(part.text) : unescapedModelText(labeled(notes.slice(part.from, part.to)))
    pieces.push(unescapedModelText(labeled(notes.slice(from, part.partFrom))), `${fence}\n${text}\n${fence}`)
    from = part.partTo
  }
  pieces.push(unescapedModelText(labeled(notes.slice(from))))
  return pieces.join('')
}

/** `text`, which starts the text of section `index` of a conversation
 *  (role `role`), for a text that people read, with `sectionText` the
 *  caller's form of the text of a section (Markdown, the preview, the
 *  search). When that section is a compaction section: its notes for
 *  people (`compactionNotesForPeople`) in place of its block, and then the
 *  text after the block as `sectionText` gives it, with a blank line
 *  between them. Any other text comes back as `sectionText` gives it.
 *
 *  The notes never go through `sectionText`: they are no text of a
 *  section, and their model text has no escape any more, so a pass of a
 *  section (tool blocks, media tags) would read a tag that a model quoted
 *  as a tag of Dez. */
export function compactionTextForPeople(text: string, index: number, role: Role, sectionText: (text: string) => string): string {
  const block = index === 0 && role === 'agent' ? readCompactionBlock(text) : null
  if (!block) return sectionText(text)
  return [compactionNotesForPeople(block.notes, blockLinkedRule(block)), sectionText(text.slice(block.textFrom))].filter((part) => part.trim() !== '').join('\n\n')
}

/** The notes for the two chips of a compaction, each for people
 *  (`compactionNotesForPeople`, with `rule`): `assets` is the part of the
 *  assets of the conversation, with no heading, and `summary` every other
 *  line, in its order, with the headings and the message parts.
 *  The assets part is the last one with its heading, as the readers of
 *  the lines of Dez take it (`partLines`). */
export function compactionNotesParts(notes: string, rule: LinkedPathRule): { assets: string, summary: string } {
  const { lines, inMessage } = scanMessages(notes)
  const start = lines.findLastIndex((line, index) => !inMessage[index] && line === ASSETS_HEADING)
  if (start < 0) return { assets: '', summary: compactionNotesForPeople(notes, rule).trim() }
  const next = lines.findIndex((line, index) => index > start && !inMessage[index] && line.startsWith('## '))
  const end = next < 0 ? lines.length : next
  return {
    assets: compactionNotesForPeople(lines.slice(start + 1, end).join('\n'), rule).trim(),
    summary: compactionNotesForPeople([...lines.slice(0, start), ...lines.slice(end)].join('\n'), rule).trim(),
  }
}
