import { tagEscape } from '../chat/tagEscape'
import type { ToolDefinition } from './types'

// Jobs: the slow work of a Dez tool, such as a request to a media model. A
// call of such a tool only starts a job and returns its id at once
// (`jobStartedText`), so the jobs of a reply run at the same time, and the
// model gets their results with `jobs_wait`. controller/jobs.ts runs the
// jobs of a reply. This module has the pure parts: the job ids, the texts
// that the model reads (it is their one writer and recognizer), and the
// definitions of the three job tools.
//
// Every text here is a tool result: it goes to the chat provider and stays
// in the later requests as it is. So it holds no local path, and each one
// tells the model its next act.

/** The state of a job. `finished`: its work gave a result. `failed`: its
 *  work gave an error. `timed out`: its work did not end within its time
 *  limit. `stopped`: its reply ended first (a stop or a new submit), so no
 *  model reads this one. */
export type JobStatus = 'running' | 'finished' | 'failed' | 'timed out' | 'stopped'

/** The status of a job that has a result for `jobs_wait`. */
export type JobResultStatus = Exclude<JobStatus, 'running' | 'stopped'>

/** The most jobs that one reply starts. A job can cost money (a provider
 *  can charge for a media request when it queues it), and a model can call
 *  a tool in a loop. */
export const MAX_JOBS_PER_REPLY = 40

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

/** The result of a call that started the job `jobId`. A runner can add
 *  lines after it. */
export function jobStartedText(jobId: string): string {
  return `Started the job ${jobId}. It runs in the background. Start the other jobs that you need now, then call jobs_wait to get the results.`
}

const STARTED_JOB = new RegExp(`^Started the job (${JOB_ID_SOURCE})\\.`)

/** The id of the job that a call started, from its result text
 *  (`jobStartedText`); null for any other text. */
export function startedJobId(resultText: string): string | null {
  return STARTED_JOB.exec(resultText)?.[1] ?? null
}

/** The error result of a call that would start one job too many. */
export const JOB_LIMIT_TEXT = `Dez did not start this job: this reply already started ${MAX_JOBS_PER_REPLY} jobs, which is the most for one reply. `
  + 'Call jobs_wait for the results of the jobs that still run, then tell the user what is not done. The next message of the user starts a new count.'

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

/** One asset of a job after Dez put it into the reply: `id` is its new id
 *  there, or null when the reply took no asset any more. */
export interface WrittenJobAsset {
  kind: JobAssetKind
  id: string | null
}

function assetLine({ kind, id }: WrittenJobAsset): string {
  return id === null
    ? `The reply stopped before Dez could add the ${ASSET_NAMES[kind]} of this job to it, so there is no new ${ASSET_NAMES[kind]}.`
    : `Made the ${ASSET_NAMES[kind]} @${id}.`
}

/** The result text of a job for its reader: the job's own `text` as it is
 *  (an error text too), then one line for each asset. The lines name the
 *  assets by their ids only. */
export function jobResultText(text: string, assets: readonly WrittenJobAsset[]): string {
  return [...(text.trim() === '' ? [] : [text]), ...assets.map(assetLine)].join('\n')
}

const ASSET_NAME_SOURCE = Object.values(ASSET_NAMES).join('|')
// One line of `assetLine`, of either form.
const ASSET_LINE = new RegExp(`^(?:Made the (?:${ASSET_NAME_SOURCE}) @[a-z]+\\.|The reply stopped before Dez could add the (${ASSET_NAME_SOURCE}) of this job to it, so there is no new \\1\\.)$`)

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

function jobPart({ id, tool, status, text }: JobResult): string {
  const body = text.trim() === '' ? NO_JOB_OUTPUT_TEXT : jobTextEscape.escape(text)
  return `<job id="${id}" tool="${tool}" status="${status}">\n${body}\n</job>`
}

/** The result of a `jobs_wait` call: a first line that tells how many jobs
 *  ended and how many of the reply's jobs still run (`running`), then one
 *  part for each job of `results`:
 *
 *      <job id="j-k3x9" tool="model_invoke" status="finished">
 *      Made the image @c.
 *      </job>
 *
 *  `results` is empty only when no job runs (`NO_OPEN_JOBS_TEXT`). */
export function jobsWaitText(results: readonly JobResult[], running: number): string {
  if (results.length === 0) return NO_OPEN_JOBS_TEXT
  const rest = running === 0
    ? 'No job still runs.'
    : `${running === 1 ? '1 job still runs' : `${running} jobs still run`}: call jobs_wait again to get ${running === 1 ? 'its result' : 'their results'}.`
  return [`${results.length === 1 ? '1 job' : `${results.length} jobs`} ended. ${rest}`, ...results.map(jobPart)].join('\n\n')
}

// One part of `jobPart`. The body is escaped, so its first `\n</job>` line
// is the end of the part, and a part inside a body does not start one.
const JOB_PART = new RegExp(`<job id="(${JOB_ID_SOURCE})" tool="([^"\\n]*)" status="(finished|failed|timed out)">\\n([\\s\\S]*?)\\n</job>`, 'g')

/** The results in the result text of a `jobs_wait` call (`jobsWaitText`),
 *  in order, each with the text that `jobResultText` gave (blank for a job
 *  with no output). None for any other text. */
export function jobsWaitResults(resultText: string): JobResult[] {
  return [...resultText.matchAll(JOB_PART)].map(([, id, tool, status, body]) => ({
    id,
    tool,
    status: status as JobResultStatus,
    text: body === NO_JOB_OUTPUT_TEXT ? '' : jobTextEscape.unescape(body),
  }))
}

/** One job of a reply, as `jobs_list` and `job_inspect` tell it. */
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
}

/** The result of a `jobs_list` call for a reply with no job. */
export const NO_JOBS_TEXT = 'This reply has started no job.'

// `ready`: the next `jobs_wait` gives the result. A stopped job has none.
function resultColumn(job: JobInfo): string {
  if (job.status === 'running' || job.status === 'stopped') return '-'
  return job.delivered ? 'given' : 'ready'
}

/** The result of a `jobs_list` call: a first line with the count, the
 *  columns, and what their values mean, then one line for each job, in the
 *  order of their starts. */
export function jobsListText(jobs: readonly JobInfo[]): string {
  if (jobs.length === 0) return NO_JOBS_TEXT
  const head = `${jobs.length === 1 ? '1 job' : `${jobs.length} jobs`} of this reply (id | tool | status | result | seconds). `
    + 'result: `ready` means that the next jobs_wait gives it, `given` that a jobs_wait gave it, and `-` that there is none. '
    + 'seconds: how long the job ran, or runs so far.'
  return [head, ...jobs.map((job) => [job.id, job.tool, job.status, resultColumn(job), Math.round(job.elapsedMs / 1000)].join(' | '))].join('\n')
}

/** The result of a `job_inspect` call: the status of the job, what to do
 *  for its result, and the last state that it reported. */
export function jobInspectText(job: JobInfo): string {
  const time = secondsText(job.elapsedMs)
  const name = `The job ${job.id} (${job.tool})`
  const result = job.delivered ? 'A jobs_wait call gave its result.' : 'Its result is ready: call jobs_wait to get it.'
  let status: string
  switch (job.status) {
    case 'running':
      status = `${name} runs, for ${time} so far. Call jobs_wait to wait for its result.`
      break
    case 'stopped':
      status = `${name} stopped after ${time}, with no result.`
      break
    default:
      status = `${name} ${job.status} after ${time}. ${result}`
  }
  return `${status}\n${job.state.trim() === '' ? 'The job reported no state.' : `State: ${job.state}`}`
}

/** The error result of a `job_inspect` call whose `jobId` names no job of
 *  the reply; `knownIds` are the ids of its jobs. */
export function unknownJobText(jobId: string, knownIds: readonly string[]): string {
  const earlier = 'A job of an earlier reply ended with that reply.'
  return knownIds.length === 0
    ? `This reply has started no job, so it has no job ${JSON.stringify(jobId)}. ${earlier} Call job_inspect only with the id of a job that you started in this reply.`
    : `This reply has no job with the id ${JSON.stringify(jobId)}. ${earlier} The jobs of this reply are ${knownIds.join(', ')}: call job_inspect again with one of these ids.`
}

// The descriptions are static (no counts, no dates): the tools array and
// the system prompt, which lists them, are in the provider's prompt cache.
// They are brief, as each word goes with every chat request, but a model
// must learn from them alone how jobs run at the same time.

export const JOBS_WAIT_TOOL: ToolDefinition = {
  name: 'jobs_wait',
  description: 'Wait for the jobs of this reply, and get their results. '
    + 'A Dez tool whose work takes long starts a job: its call returns a job id at once, and the work runs in the background. '
    + 'Jobs run at the same time, so start every job that you need before you wait. '
    + '`jobs_wait` returns when one or more jobs ended. It gives the result of each of those jobs once, with its job id and its status (finished, failed, or timed out). '
    + 'An image or a clip that a job made goes into your reply then, and the result gives its id. '
    + 'The first line tells how many jobs still run: call `jobs_wait` again until none runs. Get the result of every job before you end your reply.',
  parameters: [],
}

export const JOBS_LIST_TOOL: ToolDefinition = {
  name: 'jobs_list',
  description: 'List the jobs that this reply started: the id, the tool, and the status of each job, whether `jobs_wait` gave its result, and how long it ran. '
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
