import { startedJobId } from '../../../src/model/tools/jobs'
import { openAiToolCall, toolResult, type HeldRequest } from './mockServer'

// The parts that the specs of the tools with jobs share (`model_invoke`,
// `video`): a call starts a job of the reply, and a `jobs_wait` call gives
// its result.

/** A `jobs_wait` call of a mock model. */
export function waitCall (id: string): Record<string, unknown> {
  return openAiToolCall(id, 'jobs_wait', {})
}

/** The id of the job that the call `callId` started, from its result in
 *  the chat request `request`. */
export function startedJob (request: HeldRequest, callId: string): string {
  const id = startedJobId(toolResult(request, callId))
  if (id === null) throw new Error(`startedJob: ${callId} started no job`)
  return id
}
