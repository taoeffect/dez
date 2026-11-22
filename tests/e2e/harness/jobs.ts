import { expect } from 'vitest'
import { jobsListText, jobsWaitResults, startedJobId, type JobResult } from '../../../src/model/tools/jobs'
import { openAiToolCall, sendToolCalls, toolResult, type HeldRequest } from './mockServer'

// The parts that the specs of the tools with jobs share (`model_invoke`,
// `video`, `apps`): a call starts a job of the reply, and a `jobs_wait`
// call gives its result.

/** The result of a `jobs_list` call in a reply that started no job: the
 *  no-job line, then the money line of a tab with no money limit, as the
 *  tabs of the specs have none. */
export const NO_JOBS_LIST_TEXT = jobsListText([], { limit: undefined, spent: { counted: 0, held: 0 } })

/** A `jobs_wait` call of a mock model: for the first job that ends, or
 *  with `all` for every job. */
export function waitCall (id: string, all = false): Record<string, unknown> {
  return openAiToolCall(id, 'jobs_wait', all ? { all: true } : {})
}

/** The id of the job that the call `callId` started, from its result in
 *  the chat request `request`. */
export function startedJob (request: HeldRequest, callId: string): string {
  const id = startedJobId(toolResult(request, callId))
  if (id === null) throw new Error(`startedJob: ${callId} started no job`)
  return id
}

/** A job of a tool call that ended, as the mock model got it. */
export interface EndedJob {
  jobId: string
  /** The result of the call that started the job. */
  started: string
  /** The result of the job, from the `jobs_wait` call after it. */
  result: JobResult
  /** The chat request that holds the result of the job. It waits for its
   *  answer. */
  next: HeldRequest
}

/** Answers the chat request `request` with `call`, a call of `tool` with
 *  the id `callId` that starts a job, and the request after it with a
 *  `jobs_wait` call, which gives the result of that job. `nextRequest`
 *  takes the next chat request of the reply. No other job of the reply may
 *  run. */
export async function runToolJob (nextRequest: () => Promise<HeldRequest>, request: HeldRequest, tool: string, callId: string, call: Record<string, unknown>): Promise<EndedJob> {
  sendToolCalls(request.reply, [call])
  const second = await nextRequest()
  const jobId = startedJob(second, callId)
  sendToolCalls(second.reply, [waitCall(`${callId}_wait`)])
  const next = await nextRequest()
  const waited = toolResult(next, `${callId}_wait`)
  expect(waited.startsWith('1 job ended. No job still runs.\n\n')).toBe(true)
  const results = jobsWaitResults(waited)
  expect(results.map(({ id, tool: name }) => ({ id, tool: name }))).toStrictEqual([{ id: jobId, tool }])
  return { jobId, started: toolResult(second, callId), result: results[0], next }
}
