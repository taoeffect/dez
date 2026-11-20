import { expect } from 'vitest'
import { filesIn, workDir } from './fixtures'
import type { MockProviderApp } from './mockProviderApp'
import { openAiToolCall, replyText, sendChatReply, type HeldRequest, type MockProvider } from './mockServer'
import { pidsWithCwdIn } from './processes'
import { endedReply, openToasts } from './thread'

// The parts that the specs of the `js_eval` tool share: a call of the mock
// model, and the end of the reply that made the calls.

/** A `js_eval` call of a mock model: `code`, and with `more` the other
 *  arguments of the call (`timeout_seconds`). */
export function evalCall (id: string, code: string, more: Record<string, unknown> = {}): Record<string, unknown> {
  return openAiToolCall(id, 'js_eval', { code, ...more })
}

/**
 * Answers `request` with the last text of a reply of the model of
 * `provider`, and checks the end of the reply: its text ends after the
 * blocks of the calls, the app sends no other request, no program of a call
 * runs, no work folder stays, and no error toast shows.
 */
export async function expectReplyEnd (setup: MockProviderApp, provider: MockProvider, request: HeldRequest): Promise<void> {
  const workRoot = workDir(setup.app.home)
  await sendChatReply(request.reply, provider.modelName)
  const reply = await endedReply(setup.browser)
  expect(reply.endsWith(`</dez:tool>\n${replyText(provider.modelName)}`)).toBe(true)
  expect(setup.mock.hasWaitingRequest()).toBe(false)
  expect(pidsWithCwdIn(workRoot)).toStrictEqual([])
  expect(await filesIn(workRoot)).toStrictEqual([])
  expect(await openToasts(setup.browser, 'error')).toStrictEqual([])
}
