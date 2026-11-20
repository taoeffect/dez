import { countOf } from '../../utils/countText'
import { oneLineCut } from '../../utils/oneLineCut'
import { tagEscape } from '../chat/tagEscape'
import type { ToolBlockData } from '../chat/toolBlocks'
import { usdText } from '../providers/modelPrices'
import { argumentWords } from './arguments'
import { ToolError, type ToolArguments, type ToolDefinition, type ToolParameter } from './types'

// Jobs: the slow work of a Dez tool, such as a request to a media model. A
// call of such a tool only starts a job and returns its id at once
// (`jobStartedText`), so the jobs of a reply run at the same time, and the
// model gets their results with `jobs_wait`. controller/jobs.ts runs the
// jobs of a reply. This module has the pure parts: the job ids, the texts
// that the model reads (it is their one writer and recognizer), and the
// definitions of the four job tools.
//
// Every text here is a tool result: it goes to the chat provider and stays
// in the later requests as it is. So it holds no local path, and each one
// tells the model its next act.

/** The state of a job. `finished`: its work gave a result. `failed`: its
 *  work gave an error. `timed out`: its work did not end within its time
 *  limit. `cancelled`: a `job_cancel` call of a model ended it first.
 *  `stopped`: Dez ended it first (its reply ended on its own, or its tab
 *  closed), so no model reads this one. A stop of the user or a new submit
 *  does not end a job: the next reply of the tab gets it (`TabJobs`,
 *  controller/jobs.ts). */
export type JobStatus = 'running' | JobResultStatus | 'cancelled' | 'stopped'

// The statuses of a job that ended with a result for `jobs_wait`. A job
// that a cancel or a stop ended before its work has none.
const JOB_RESULT_STATUSES = ['finished', 'failed', 'timed out'] as const

/** The status of a job that has a result for `jobs_wait`. */
export type JobResultStatus = typeof JOB_RESULT_STATUSES[number]

/** Whether a job of `status` ended with a result for `jobs_wait`: not a
 *  job that runs, and not one that a cancel or a stop ended first. */
export function hasJobResult(status: JobStatus): status is JobResultStatus {
  return (JOB_RESULT_STATUSES as readonly JobStatus[]).includes(status)
}

/** The most jobs of one reply that are open at one time: the jobs that
 *  run, and the ended jobs whose results no reader took yet. A job can
 *  cost money (a provider can charge for a media request when it queues
 *  it), and a model can call a tool in a loop: at this count the model
 *  must read results before it starts more. It is not a count of all the
 *  jobs of a reply, as a reply has no limit of tool rounds. */
export const MAX_OPEN_JOBS = 40

const JOB_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'
const JOB_ID_LENGTH = 4
const JOB_ID_SOURCE = `j-[a-z0-9]{${JOB_ID_LENGTH}}`

/** A new job id: `j-` and 4 letters or digits, as in `j-k3x9`. Short, as
 *  the model writes it back. `taken` tells whether a job of the reply has
 *  the id; `random` gives numbers from 0 up to, but not, 1. A random id is
 *  fine in a tool result; no tool definition holds one. */
export function newJobId(taken: (id: string) => boolean, random: () => number = Math.random): string {
  for (;;) {
    let id = 'j-'
    for (let index = 0; index < JOB_ID_LENGTH; index++) id += JOB_ID_CHARS[Math.floor(random() * JOB_ID_CHARS.length)]
    if (!taken(id)) return id
  }
}

/** Which call of its reply started a job, for the reader of the job's
 *  result. A result comes when its job ends, and an image or a clip of
 *  the job gets its id then, so neither tells the order of the calls. */
export interface JobCall {
  /** The place of the job in the order of the reply's job starts: 1 for
   *  the first job. Two calls can begin with the same words, so only the
   *  number always tells them apart. */
  number: number
  /** How the call begins (`jobCallLabel`); blank for none. */
  label: string
}

// The most characters of a label: it goes into each result of its job.
const JOB_LABEL_CHARS = 80

/** The label of a call from `text`, the argument that tells most what the
 *  call asks for (a prompt, a command line): its start, on one line. It
 *  holds no double quote, as a job part keeps it in an attribute
 *  (`jobPart`). The text is the model's own, which a request already
 *  holds. */
export function jobCallLabel(text: string): string {
  return oneLineCut(text.replace(/"/g, '\''), JOB_LABEL_CHARS)
}

/** The result of a call that started the job `jobId` as the job `number`
 *  of its reply (`JobCall.number`). A runner can add lines after it.
 *  `startedJob` reads the text back up to the number, so a new wording
 *  must keep that start. */
export function jobStartedText(jobId: string, number: number): string {
  return `Started the job ${jobId}. It is job ${number} of this reply, and it runs in the background. Start the other jobs that you need now, within the limit of open jobs, then call jobs_wait to get the results.`
}

const STARTED_JOB = new RegExp(`^Started the job (${JOB_ID_SOURCE})\\.(?: It is job (\\d+) of this reply\\b)?`)

/** The id and the number (`JobCall.number`) of the job that a call
 *  started, from its result text (`jobStartedText`); the number is null
 *  when the text does not tell it. Null for any other text. */
export function startedJob(resultText: string): { id: string, number: number | null } | null {
  const match = STARTED_JOB.exec(resultText)
  return match ? { id: match[1], number: match[2] === undefined ? null : Number(match[2]) } : null
}

/** The id of the job that a call started, from its result text
 *  (`jobStartedText`); null for any other text. */
export function startedJobId(resultText: string): string | null {
  return startedJob(resultText)?.id ?? null
}

/** A job that a call of a tool block started. */
export interface BlockJobStart {
  id: string
  /** `JobCall.number`; null when the result text does not tell it. */
  number: number | null
  /** The tool and the arguments of the call that started the job: those
   *  of the block, or those of a tool call of its code. */
  name: string
  arguments: ToolArguments
}

/** The jobs that the calls of `block` started, from their result texts
 *  (`startedJob`), one entry for each job: the tool calls of the code of a
 *  `js_eval` block in their order (`ToolBlockData.bridged`), then the call
 *  of the block itself. The first call that tells a job has its entry:
 *  code can return the result text of its tool call, and the result of
 *  its block then starts with the start text of that call. */
export function blockJobStarts(block: Pick<ToolBlockData, 'name' | 'arguments' | 'result' | 'bridged'>): BlockJobStart[] {
  const starts: BlockJobStart[] = []
  for (const { name, arguments: args, result } of [...block.bridged?.calls ?? [], block]) {
    const started = startedJob(result)
    if (started && !starts.some((start) => start.id === started.id)) starts.push({ ...started, name, arguments: args })
  }
  return starts
}

// What an open job is (`MAX_OPEN_JOBS`), in each text that tells the limit.
const OPEN_JOB_MEANING = 'a job that runs, or an ended job whose result no jobs_wait call gave yet'

/** The rule of the open jobs (`MAX_OPEN_JOBS`), which the description of
 *  `jobs_wait` tells in full. A model must learn it before it calls: Dez
 *  runs all the calls of a round before the model reads a result, so the
 *  error text (`JOB_LIMIT_TEXT`) comes too late for a model that starts
 *  more jobs than the limit in one round. Static text: the limit is a
 *  constant of the code, so the cached prefix keeps its bytes. */
const OPEN_JOBS_RULE = `At most ${MAX_OPEN_JOBS} jobs of a reply can be open at one time (${OPEN_JOB_MEANING}): Dez refuses a call that would start one more. `
  + `For more work than that, start at most ${MAX_OPEN_JOBS} jobs, call \`jobs_wait\` with \`all\`, then start the next ${MAX_OPEN_JOBS}.`

/** What the description of each tool whose call starts a job tells of
 *  jobs (`startJob`, controller/tools.ts): the limit goes where the model
 *  reads how to call, and `jobs_wait` tells the rest of its rule. */
export const JOB_CALL_NOTE = 'The call starts a job and returns its job id at once; `jobs_wait` gives the result. '
  + `At most ${MAX_OPEN_JOBS} jobs can be open at one time (see \`jobs_wait\`).`

/** The error result of a call that would start one open job too many
 *  (`MAX_OPEN_JOBS`). */
export const JOB_LIMIT_TEXT = `Dez did not start this job: ${MAX_OPEN_JOBS} jobs of this reply are open (${OPEN_JOB_MEANING}), which is the most at one time. `
  + 'Call jobs_wait: each result that it gives makes room for one new job. A job that you no longer need makes room too when you cancel it with job_cancel. '
  + 'Then make this call again.'

// The time limits that a call can give its job. A shorter limit ends a
// request before a provider can answer. The longest one is also far below
// the most that a timer takes.
const MIN_JOB_TIMEOUT_SECONDS = 10
const MAX_JOB_TIMEOUT_SECONDS = 3600

// A default time limit in words, as in `30 minutes`. Each default is a
// whole count of minutes.
function minutesText(seconds: number): string {
  return `${seconds / 60} minutes`
}

/** The `timeout_seconds` parameter of a tool whose call starts a job with
 *  the default time limit `defaultSeconds`. Static text: it goes into a
 *  tool definition or a help text. */
export function jobTimeoutParameter(defaultSeconds: number): ToolParameter {
  return {
    name: 'timeout_seconds',
    type: 'integer',
    description: `The most seconds that the job runs, from ${MIN_JOB_TIMEOUT_SECONDS} to ${MAX_JOB_TIMEOUT_SECONDS}. A job that runs longer stops with no result. `
      + `The default is ${defaultSeconds} (${minutesText(defaultSeconds)}).`,
    required: false,
  }
}

/** The time limit of the job of a call, in milliseconds: its
 *  `timeout_seconds` (`jobTimeoutParameter`), else `defaultSeconds`.
 *  Throws a `ToolError` for a value outside the range. */
export function jobTimeoutMs(args: ToolArguments, defaultSeconds: number): number {
  const seconds = args.timeout_seconds
  if (seconds === undefined) return defaultSeconds * 1000
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < MIN_JOB_TIMEOUT_SECONDS || seconds > MAX_JOB_TIMEOUT_SECONDS) {
    throw new ToolError(`\`timeout_seconds\` must be a whole number from ${MIN_JOB_TIMEOUT_SECONDS} to ${MAX_JOB_TIMEOUT_SECONDS}. `
      + `Leave it out for the default of ${minutesText(defaultSeconds)}.`)
  }
  return seconds * 1000
}

/** The `is_intermediate` parameter of a tool whose job makes images or
 *  clips (`model_invoke`, the `join_clips` and `ffmpeg` subcommands of
 *  `video`). With `true`, the job marks what it makes as hidden assets
 *  (`hidesAssets` of `TabJobs.start`, chat/hiddenAssets.ts). Nothing of
 *  a request or of a result that the model reads changes. Static text: it
 *  goes into a tool definition or a help text. */
export const INTERMEDIATE_PARAMETER: ToolParameter = {
  name: 'is_intermediate',
  type: 'boolean',
  description: 'Set it to `true` when the call makes only a part that you use to assemble the result that the user asked for, '
    + 'and not a result that the user asked to see: a frame, one scene of a video, a sound track. '
    + 'The image or the clip is then hidden in your reply: the user sees only the chip of this call, and can open the chip to see it. '
    + 'It gets an id as any other one, which a later call can name with @id. '
    + 'The default is `false`: the image or the clip shows in your reply.',
  required: false,
}

/** Whether the checked arguments of a call set `is_intermediate`
 *  (`INTERMEDIATE_PARAMETER`). */
export function isIntermediate(args: ToolArguments): boolean {
  return args[INTERMEDIATE_PARAMETER.name] === true
}

// Whole seconds, as a job's time is not exact.
function secondsText(milliseconds: number): string {
  const count = Math.round(milliseconds / 1000)
  return count === 1 ? '1 second' : `${count} seconds`
}

/** The result text of a job that did not end within `timeoutMs`. `state`
 *  is the last state that the job reported (blank for none): it names the
 *  provider's own job id when the job has one, so the user can ask the
 *  provider for the output. */
export function jobTimedOutText(timeoutMs: number, state: string): string {
  return `The job did not end within its time limit of ${secondsText(timeoutMs)}, so Dez stopped it. It has no result. This is not a fault of the call.`
    + (state.trim() === '' ? '' : ` The last state of the job: ${state}`)
}

/** What a job made, by the names that the texts use. */
export type JobAssetKind = 'image' | 'audio' | 'video'

/** The name of each kind of asset in a text for a model. */
export const ASSET_NAMES: Readonly<Record<JobAssetKind, string>> = { image: 'image', audio: 'audio clip', video: 'video clip' }

/** The names of `ASSET_NAMES` as one regex alternation, with no group:
 *  the readers of the texts that name a kind of asset use it. */
export const ASSET_NAME_SOURCE = Object.values(ASSET_NAMES).join('|')

/** The start of the sentence with which a tool result names an image or a
 *  clip that its call made and that Dez put into the reply, as in "Made
 *  the image @b." and "Made the image @b from @a." Every result that tells
 *  of such an asset starts a line with it (a job part of `jobs_wait`, and
 *  the result of a tool that makes its asset in its call). A request reads
 *  it: the result tells the model of the asset, so the asset's own text in
 *  the reply does not go (`madeAssetIds`; `roundRequestText`,
 *  streams/messages.ts). */
export function madeAssetText(kind: JobAssetKind, id: string): string {
  return `Made the ${ASSET_NAMES[kind]} @${id}`
}

// `madeAssetText`, with the id as its one group.
const MADE_ASSET_SOURCE = `Made the (?:${ASSET_NAME_SOURCE}) @([a-z]+)`
const MADE_ASSET_LINE_START = new RegExp(`^${MADE_ASSET_SOURCE}\\b`, 'gm')

/** The ids of the assets that a tool result names with `madeAssetText`, in
 *  text order. Only that sentence start counts, not any `@id` word: a
 *  result can name an asset that its call did not make (an input, an
 *  example). */
export function madeAssetIds(resultText: string): string[] {
  return [...resultText.matchAll(MADE_ASSET_LINE_START)].map((match) => match[1])
}

/** One asset of a job after Dez put it into the reply: `id` is its new id
 *  there, or null when the reply took no asset any more. */
export interface WrittenJobAsset {
  kind: JobAssetKind
  id: string | null
}

function assetLine({ kind, id }: WrittenJobAsset): string {
  return id === null
    ? `The reply stopped before Dez could add the ${ASSET_NAMES[kind]} of this job to it, so there is no new ${ASSET_NAMES[kind]}.`
    : `${madeAssetText(kind, id)}.`
}

/** The result text of a job for its reader: the job's own `text` as it is
 *  (an error text too), then one line for each asset. The lines name the
 *  assets by their ids only. */
export function jobResultText(text: string, assets: readonly WrittenJobAsset[]): string {
  return [...(text.trim() === '' ? [] : [text]), ...assets.map(assetLine)].join('\n')
}

// One line of `assetLine`, of either form.
const ASSET_LINE = new RegExp(`^(?:${MADE_ASSET_SOURCE}\\.|The reply stopped before Dez could add the (${ASSET_NAME_SOURCE}) of this job to it, so there is no new \\2\\.)$`)

/** The job's own text of a `jobResultText`: the text without the lines of
 *  its assets. Blank when the job gave only assets. A last line of the
 *  job's own text that reads as an asset line is lost too; the editor,
 *  which shows this text to the user, takes that risk. */
export function jobOwnText(resultText: string): string {
  const lines = resultText.split('\n')
  while (lines.length > 0 && ASSET_LINE.test(lines[lines.length - 1])) lines.pop()
  return lines.join('\n')
}

/** The result of one job, as a `jobs_wait` result gives it. */
export interface JobResult {
  id: string
  /** The tool whose call started the job. */
  tool: string
  status: JobResultStatus
  /** `jobResultText`. */
  text: string
  call: JobCall
}

/** The result of a `jobs_wait` call when no job runs and no result waits. */
export const NO_OPEN_JOBS_TEXT = 'No job of this reply runs, and you already have the result of every job that ended. Call jobs_wait again only after you start a new job.'

// The body of a part when its job gave no text and no asset.
const NO_JOB_OUTPUT_TEXT = 'The job gave no output.'

// A job's text is free text (the answer of another model, the log of a
// program), so it can hold a `</job>` line or a whole part of another job.
// The escape of the `job` tag keeps each part whole for the model and for
// a later reader of the parts.
const jobTextEscape = tagEscape('job')

function jobPart({ id, tool, status, text, call }: JobResult): string {
  const body = text.trim() === '' ? NO_JOB_OUTPUT_TEXT : jobTextEscape.escape(text)
  const label = call.label === '' ? '' : ` call="${call.label}"`
  return `<job id="${id}" number="${call.number}" tool="${tool}" status="${status}"${label}>\n${body}\n</job>`
}

// A list of words in an English sentence, as in "j-aaaa, j-bbbb, and j-cccc".
function wordList(words: readonly string[]): string {
  return new Intl.ListFormat('en', { type: 'conjunction' }).format(words)
}

/** The result of a `jobs_wait` call: a first line that tells how many jobs
 *  ended, how many of the reply's jobs still run (`running`), and how many
 *  results of other jobs wait for a later call (`ready`, only after a call
 *  that names its jobs), then one part for each job of `results`, which
 *  names its call (`JobCall`):
 *
 *      <job id="j-k3x9" number="2" tool="model_invoke" status="finished" call="A red fox in the snow">
 *      Made the image @c.
 *      </job>
 *
 *  `results` is empty when no job runs and no result waits
 *  (`NO_OPEN_JOBS_TEXT`), or when a call names jobs (`jobs`) whose results
 *  an earlier call gave, or that were cancelled. `cancelled` are the ids
 *  of the jobs that the call names and that a `job_cancel` call cancelled:
 *  the first line tells that they give no result. */
export function jobsWaitText(results: readonly JobResult[], running: number, ready = 0, cancelled: readonly string[] = []): string {
  if (results.length === 0 && running === 0 && ready === 0 && cancelled.length === 0) return NO_OPEN_JOBS_TEXT
  let rest = 'No job still runs.'
  if (running === 1) rest = '1 job still runs: call jobs_wait again to get its result.'
  else if (running > 1) rest = `${running} jobs still run: call jobs_wait again to get their results (with \`all\`, one call waits for all of them).`
  if (ready === 1) rest += ' The result of 1 other job is ready: call jobs_wait to get it.'
  else if (ready > 1) rest += ` The results of ${ready} other jobs are ready: call jobs_wait to get them.`
  let named = ''
  if (cancelled.length === 1) named = `The job ${cancelled[0]} that \`jobs\` names was cancelled with job_cancel, so it gives no result. `
  else if (cancelled.length > 1) named = `The jobs ${wordList(cancelled)} that \`jobs\` names were cancelled with job_cancel, so they give no result. `
  if (results.length === 0) return `${named}You already have the result of ${cancelled.length === 0 ? 'each' : 'any other'} job that \`jobs\` names. ${rest}`
  return [`${countOf(results.length, 'job')} ended. ${named}${rest}`, ...results.map(jobPart)].join('\n\n')
}

// The ids of the jobs that the `jobs` argument of a call names (its words,
// `argumentWords`), each once, in order. Throws a `ToolError` for an id of
// no job of the reply (`knownIds`), so that a call with a wrong id acts on
// no job.
function namedJobIds(args: ToolArguments, knownIds: readonly string[]): string[] {
  const ids = [...new Set(argumentWords(args, 'jobs'))]
  const unknown = ids.filter((id) => !knownIds.includes(id))
  if (unknown.length > 0) throw new ToolError(unknownJobText(unknown, knownIds))
  return ids
}

/** The ids of the jobs that the `jobs` argument of a `jobs_wait` call
 *  names (`namedJobIds`); null for a call that names none. Throws a
 *  `ToolError` for `jobs` together with `all`, and for an id of no job of
 *  the reply (`knownIds`). */
export function waitedJobIds(args: ToolArguments, knownIds: readonly string[]): string[] | null {
  const ids = namedJobIds(args, knownIds)
  if (ids.length === 0) return null
  if (args.all === true) {
    throw new ToolError('Set `jobs` or `all`, not both: `jobs` waits for the jobs that it names, and `all` for every job of this reply. Call jobs_wait again with one of them.')
  }
  return ids
}

/** The ids of the jobs that the `jobs` argument of a `job_cancel` call
 *  names (`namedJobIds`). Throws a `ToolError` for a call that names none,
 *  and for an id of no job of the reply (`knownIds`). */
export function cancelledJobIds(args: ToolArguments, knownIds: readonly string[]): string[] {
  const ids = namedJobIds(args, knownIds)
  if (ids.length > 0) return ids
  throw new ToolError(knownIds.length === 0
    ? 'This reply has started no job, so there is no job to cancel.'
    : `Name the jobs to cancel in \`jobs\`, as in "j-k3x9 j-ab12". The jobs of this reply are ${knownIds.join(', ')}.`)
}

// One part of `jobPart`. The body is escaped, so its first `\n</job>` line
// is the end of the part, and a part inside a body does not start one.
const JOB_PART = new RegExp(
  `<job id="(${JOB_ID_SOURCE})" number="(\\d+)" tool="([^"\\n]*)" status="(${JOB_RESULT_STATUSES.join('|')})"(?: call="([^"\\n]*)")?>\\n([\\s\\S]*?)\\n</job>`,
  'g',
)

/** The results in the result text of a `jobs_wait` call (`jobsWaitText`),
 *  in order, each with the text that `jobResultText` gave (blank for a job
 *  with no output). None for any other text. */
export function jobsWaitResults(resultText: string): JobResult[] {
  return [...resultText.matchAll(JOB_PART)].map(([, id, number, tool, status, label, body]) => ({
    id,
    tool,
    status: status as JobResultStatus,
    text: body === NO_JOB_OUTPUT_TEXT ? '' : jobTextEscape.unescape(body),
    call: { number: Number(number), label: label ?? '' },
  }))
}

/** One job of a reply, as `jobs_list` and `job_inspect` tell it: a job
 *  that the reply started, or that an earlier reply of the tab started
 *  before the user cut it. */
export interface JobInfo {
  id: string
  /** The tool whose call started the job. */
  tool: string
  status: JobStatus
  /** A `jobs_wait` gave the result. */
  delivered: boolean
  /** How long the job ran, or runs so far. */
  elapsedMs: number
  /** The last state that the job reported; blank for none. */
  state: string
  call: JobCall
  /** The ids of the assets that the call of the job names as inputs (its
   *  `@id` mentions). A compaction keeps them while the job is open
   *  (`openJobInputs`, streams/compactionAssets.ts). */
  inputs: readonly string[]
  /** The price in USD of the paid request of the job: the provider's own,
   *  else its quote, and 0 for a request that the provider refused. Null
   *  when no price is known; absent for a job that sent no paid request. */
  cost?: number | null
}

/** The result of a `jobs_list` call for a reply with no job. */
export const NO_JOBS_TEXT = 'This reply has started no job.'

/** Whether a `jobs_wait` gave the result of `job`, as the job lists tell
 *  it (`jobsListText`, the notes of a compaction). `ready`: the next
 *  `jobs_wait` gives the result. A job with no result (`hasJobResult`)
 *  has `-`. */
export type JobResultState = '-' | 'given' | 'ready'

export function jobResultState(job: Pick<JobInfo, 'status' | 'delivered'>): JobResultState {
  if (!hasJobResult(job.status)) return '-'
  return job.delivered ? 'given' : 'ready'
}

/** Whether `job` is open (`MAX_OPEN_JOBS`): it still runs, or it ended
 *  with a result that no `jobs_wait` gave yet. A stopped or cancelled job
 *  has no result, so it is not open. */
export function isOpenJob(job: Pick<JobInfo, 'status' | 'delivered'>): boolean {
  return job.status === 'running' || jobResultState(job) === 'ready'
}

const JOB_RESULT_STATES: readonly JobResultState[] = ['ready', 'given', '-']

/** What the values of the `result` column of a job list mean
 *  (`JobResultState`): each one of `values`, or all of them. `of` names the
 *  reply when the reader is not in it (the notes of a compaction). */
export function jobResultLegend(of = '', values: ReadonlySet<string> = new Set(JOB_RESULT_STATES)): string {
  const meanings: Record<JobResultState, string> = { ready: `the next jobs_wait${of} gives it`, given: 'a jobs_wait gave it', '-': 'there is none' }
  const parts = JOB_RESULT_STATES.filter((state) => values.has(state)).map((state, index) => `\`${state}\` ${index === 0 ? 'means ' : ''}that ${meanings[state]}`)
  return `result: ${wordList(parts)}.`
}

/** What the paid requests of `jobs` cost: the sum of the known prices, how
 *  many jobs have one, and how many sent a paid request with no known
 *  price (`JobInfo.cost`). */
export function jobsSpend(jobs: readonly JobInfo[]): { usd: number, priced: number, unpriced: number } {
  const prices = jobs.flatMap(({ cost }) => (typeof cost === 'number' ? [cost] : []))
  return { usd: prices.reduce((sum, cost) => sum + cost, 0), priced: prices.length, unpriced: jobs.filter(({ cost }) => cost === null).length }
}

// The last line of `jobsListText`: what the paid requests of the jobs cost,
// from the prices that the jobs know (`JobInfo.cost`), with no request.
function spendText(jobs: readonly JobInfo[]): string {
  const { usd, priced, unpriced } = jobsSpend(jobs)
  if (priced === 0 && unpriced === 0) return 'Spend: none. No job of this reply sent a paid request.'
  if (priced === 0) return `Spend: unknown. No price is known for ${unpriced === 1 ? 'the job' : `the ${unpriced} jobs`} that sent a paid request.`
  const rest = unpriced === 0 ? '' : `, and ${countOf(unpriced, 'job')} with no known price`
  return `Spend (an estimate): ${usdText(usd)} for ${countOf(priced, 'job')} with a known price `
    + `(the provider's price, else its quote; a refused request costs nothing)${rest}.`
}

/** The result of a `jobs_list` call: a first line with the count, the
 *  columns, and what their values mean, then one line for each job, in the
 *  order of their starts, and a last line with the spend of the reply on
 *  paid requests. The label of the call is the last column of a job line:
 *  it is free text, which can hold the column mark. */
export function jobsListText(jobs: readonly JobInfo[]): string {
  if (jobs.length === 0) return NO_JOBS_TEXT
  const head = `${countOf(jobs.length, 'job')} of this reply (number | id | tool | status | result | seconds | call). `
    + 'number: the place of the job in the order of the starts. '
    + `${jobResultLegend()} `
    + 'seconds: how long the job ran, or runs so far. '
    + 'call: how the prompt or the arguments of its call begin.'
  const rows = jobs.map((job) => [
    job.call.number, job.id, job.tool, job.status, jobResultState(job), Math.round(job.elapsedMs / 1000), job.call.label === '' ? '-' : job.call.label,
  ].join(' | '))
  return [head, ...rows, spendText(jobs)].join('\n')
}

/** The result of a `job_inspect` call: the status of the job, what to do
 *  for its result, the last state that it reported, and its call. */
export function jobInspectText(job: JobInfo): string {
  const time = secondsText(job.elapsedMs)
  const name = `The job ${job.id} (job ${job.call.number} of this reply, ${job.tool})`
  const result = job.delivered ? 'A jobs_wait call gave its result.' : 'Its result is ready: call jobs_wait to get it.'
  let status: string
  switch (job.status) {
    case 'running':
      status = `${name} runs, for ${time} so far. Call jobs_wait to wait for its result.`
      break
    case 'cancelled':
      status = `${name} was cancelled after ${time}, with no result.`
      break
    case 'stopped':
      status = `${name} stopped after ${time}, with no result.`
      break
    default:
      status = `${name} ${job.status} after ${time}. ${result}`
  }
  const state = job.state.trim() === '' ? 'The job reported no state.' : `State: ${job.state}`
  return [status, state, ...(job.call.label === '' ? [] : [`Its call begins: ${job.call.label}`])].join('\n')
}

// A job in a `job_cancel` result, as in "j-k3x9 (job 2)".
function cancelJobName(job: JobInfo): string {
  return `${job.id} (job ${job.call.number})`
}

// What a `job_cancel` result tells of the result of a named job that had
// ended before the call (`JobResultState`).
const ENDED_JOB_RESULT_TEXTS: Readonly<Record<JobResultState, string>> = {
  ready: 'Its result stays: the next jobs_wait gives it.',
  given: 'A jobs_wait gave its result.',
  '-': 'It has no result.',
}

/** The result of a `job_cancel` call: the jobs that it cancelled, what a
 *  cancel does, each named job that had ended before (with its status and
 *  its result), and how many jobs of the reply still run (`running`).
 *  `named` are the jobs that the call names, as they are after it, in the
 *  order of its `jobs`; `cancelled` are the ids of the ones that it
 *  cancelled. A normal result, also when no named job ran. */
export function jobCancelText(named: readonly JobInfo[], cancelled: readonly string[], running: number): string {
  const lines: string[] = []
  const cancelledNow = named.filter((job) => cancelled.includes(job.id))
  if (cancelledNow.length > 0) {
    lines.push(`Cancelled ${countOf(cancelledNow.length, 'job')}: ${wordList(cancelledNow.map(cancelJobName))}. `
      + 'A cancelled job gives no result and no image or clip, and jobs_list shows it as cancelled. '
      + 'A request that its provider took before the cancel can still cost money.')
  }
  for (const job of named) {
    if (cancelled.includes(job.id)) continue
    const name = `The job ${cancelJobName(job)}`
    lines.push(job.status === 'cancelled'
      ? `${name} was cancelled before.`
      : `${name} had already ended (${job.status}), so it was not cancelled. ${ENDED_JOB_RESULT_TEXTS[jobResultState(job)]}`)
  }
  if (running === 0) lines.push('No job of this reply still runs.')
  else if (running === 1) lines.push('1 job of this reply still runs: jobs_wait gives its result.')
  else lines.push(`${running} jobs of this reply still run: jobs_wait gives their results.`)
  return lines.join('\n')
}

/** The error result of a call whose job ids (`unknownIds`) name no job of
 *  the reply; `knownIds` are the ids of its jobs. */
export function unknownJobText(unknownIds: readonly string[], knownIds: readonly string[]): string {
  const names = `${unknownIds.length === 1 ? 'the id' : 'the ids'} ${unknownIds.map((id) => JSON.stringify(id)).join(', ')}`
  const earlier = 'The jobs of an earlier reply that ended on its own ended with that reply, and no job lives through a close of the tab or a restart of Dez.'
  return knownIds.length === 0
    ? `This reply has started no job, so no job has ${names}. ${earlier} Use only the id of a job that you started in this reply.`
    : `No job of this reply has ${names}. ${earlier} The jobs of this reply are ${knownIds.join(', ')}: use only these ids.`
}

// The descriptions are static (no running counts, no dates): the tools array
// and the system prompt, which lists them, are in the provider's prompt
// cache. They are brief, as each word goes with every chat request, but a
// model must learn from them alone how jobs run at the same time, how many
// can be open, and that a result comes in the order of the job ends, not of
// the calls.

export const JOBS_WAIT_TOOL: ToolDefinition = {
  name: 'jobs_wait',
  description: 'Wait for the jobs of this reply, and get their results. '
    + 'A Dez tool whose work takes long starts a job: its call returns a job id at once, and the work runs in the background. '
    + `Jobs run at the same time, so start the jobs that you need before you wait. ${OPEN_JOBS_RULE} `
    + '`jobs_wait` returns when one or more jobs ended (with `jobs`: when each job that you name ended). '
    + 'It gives the result of each of those jobs once, with its job id and its status (finished, failed, or timed out). '
    + 'The results come in the order in which the jobs ended, which is not the order of your calls. '
    + 'So each result names its call: `number` is the place of the job in the order of the starts (the result of the call that started it told the same number), '
    + 'and `call` is how the prompt or the arguments of that call begin. '
    + 'An image or a clip that a job made goes into your reply then, and the result gives its id. '
    + 'These ids follow the order of the results too: before you use them in an order (the scenes of a video), read from `number` which call made each one. '
    + 'The first line tells how many jobs still run: call `jobs_wait` again until none runs. Get the result of every job before you end your reply. '
    + 'A stop of the user or a new message does not end the jobs: they count as jobs of the next reply, which gets their results with `jobs_wait`, and their numbers count on. '
    + 'Dez ends them when the user closes the tab or quits Dez, and `job_cancel` ends the jobs that you name.',
  parameters: [
    {
      name: 'all',
      type: 'boolean',
      description: 'Set it to `true` to wait until every job of this reply ended, and to get all their results in one call. '
        + 'Each `jobs_wait` call costs one more request with the whole conversation: '
        + 'set it when you need all the results before your next step. The default is `false`.',
      required: false,
    },
    {
      name: 'jobs',
      type: 'string',
      description: 'The ids of the jobs to wait for, as in "j-k3x9 j-ab12". The call waits until each of these jobs ended, and gives only their results; '
        + 'the results of the other jobs stay for a later jobs_wait call. '
        + 'Use it when your next step needs only some of the results, as an image for your next call while music still runs. '
        + 'Do not set it together with `all`.',
      required: false,
    },
  ],
}

export const JOBS_LIST_TOOL: ToolDefinition = {
  name: 'jobs_list',
  description: 'List the jobs of this reply, in the order of the starts: the number, the id, the tool, and the status of each job, '
    + 'whether `jobs_wait` gave its result, how long it ran, and how its call begins. '
    + 'The last line is an estimate of what the paid requests of these jobs cost. '
    + 'It does not wait, and it gives no result of a job.',
  parameters: [],
}

export const JOB_INSPECT_TOOL: ToolDefinition = {
  name: 'job_inspect',
  description: 'Tell the status of one job of this reply, and the last state that the job reported, such as how far its work is. '
    + 'It does not wait, and it gives no result of a job.',
  parameters: [
    { name: 'job_id', type: 'string', description: 'The id of the job, as the result of the call that started it gave it, as in "j-k3x9".', required: true },
  ],
}

export const JOB_CANCEL_TOOL: ToolDefinition = {
  name: 'job_cancel',
  description: 'Cancel jobs of this reply that run, when their work is no longer needed: the user changed what they want, or a job has a wrong model or a wrong input. '
    + 'A cancelled job ends its requests at once, gives no result and no image or clip, and makes room for a new job; `jobs_list` shows it as cancelled. '
    + 'A request that the provider took before the cancel can still cost money. '
    + 'A job that already ended keeps its result. You can start new jobs after a cancel.',
  parameters: [
    {
      name: 'jobs',
      type: 'string',
      description: 'The ids of the jobs to cancel, as in "j-k3x9 j-ab12". If an id names no job of this reply, the call cancels no job.',
      required: true,
    },
  ],
}
