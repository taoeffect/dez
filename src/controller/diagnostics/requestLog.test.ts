import sbp from '@sbp/sbp'
import { describe, expect, it } from 'vitest'
import type { ContextSize } from '../../model/chat/contextSize'
import type { ModelRef } from '../../model/chat/types'
import { logRequest, MAX_REQUEST_LOG_ROWS, type LoggedRequest, type RequestLogRow } from './requestLog'

// The context size that the tab store tells for each tab, by the id of the
// model that it estimates for; none for a tab that is gone. With no model,
// the store estimates for the active model of the tab, which no test here
// wants: the stub then tells nothing.
const tabSizes: Record<string, Record<string, ContextSize>> = {}

sbp('sbp/selectors/register', {
  'dez.model/tabs/contextSize' (tabId: string, model?: ModelRef): ContextSize | undefined {
    return model && tabSizes[tabId]?.[model.modelId]
  },
})

const log = () => sbp('dez.diagnostics/requestLog') as RequestLogRow[]

// The log lives as long as the module, so each test logs under tabs of its
// own and reads only their rows.
const rowsOf = (tabId: string) => log().filter((row) => row.tabId === tabId)

// A chat round of the tab `tabId` that told no tokens and no price.
function chatRound(tabId: string, request: Partial<LoggedRequest> = {}): LoggedRequest {
  return { tabId, kind: 'chat', model: { providerId: 'venice', modelId: 'claude-sonnet' }, startedAt: 1000, cost: null, imageCount: 0, ...request }
}

describe('the request log', () => {
  it('keeps the input tokens of a request in their three parts, and takes the count of the provider as the context size', () => {
    const tabId = crypto.randomUUID()

    logRequest(chatRound(tabId, { usage: { inputTokens: 1200, cachedInputTokens: 900, cacheWriteTokens: 250, outputTokens: 300 }, cost: 0.012, imageCount: 2 }))

    expect(rowsOf(tabId)).toStrictEqual([{
      startedAt: 1000,
      tabId,
      providerId: 'venice',
      modelId: 'claude-sonnet',
      kind: 'chat',
      uncachedInputTokens: 50,
      cacheReadTokens: 900,
      cacheWriteTokens: 250,
      outputTokens: 300,
      cost: 0.012,
      contextTokens: 1500,
      contextEstimated: false,
      imageCount: 2,
      sincePreviousMs: null,
    }])
  })

  // A request that failed, or that the user stopped, tells no tokens.
  it('has no number that the provider did not tell, and then takes the context size of the tab, if the tab is still there', () => {
    const [kept, gone] = [crypto.randomUUID(), crypto.randomUUID()]
    tabSizes[kept] = { 'claude-sonnet': { tokens: 4200, estimated: true } }

    logRequest(chatRound(kept))
    logRequest(chatRound(gone, { usage: { outputTokens: 20 }, cost: 0 }))

    const unknown = { uncachedInputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }
    expect(rowsOf(kept)).toMatchObject([{ ...unknown, outputTokens: null, cost: null, contextTokens: 4200, contextEstimated: true }])
    expect(rowsOf(gone)).toMatchObject([{ ...unknown, outputTokens: 20, cost: 0, contextTokens: null, contextEstimated: null }])
  })

  // The model of the newest reply can write the notes of a compaction
  // (`earlierReplyWriter`), and the user can choose another model while a
  // reply runs: the estimate depends on the model (the system prompt, the
  // tools, the token rates of its family).
  it('takes the context size of the tab for the model of the request, not for the active model of the tab', () => {
    const tabId = crypto.randomUUID()
    tabSizes[tabId] = { 'claude-sonnet': { tokens: 4200, estimated: true }, 'glm-4.6': { tokens: 3900, estimated: true } }

    logRequest(chatRound(tabId))
    logRequest(chatRound(tabId, { kind: 'compaction', model: { providerId: 'venice', modelId: 'glm-4.6' } }))

    expect(rowsOf(tabId).map((row) => [row.kind, row.modelId, row.contextTokens])).toStrictEqual([
      ['chat', 'claude-sonnet', 4200],
      ['compaction', 'glm-4.6', 3900],
    ])
  })

  // The prompt cache of a conversation lives 5 minutes after its last
  // request. A `model_invoke` request sends no conversation.
  it('tells how long before a request the request before it of the same conversation started', () => {
    const [tabId, other] = [crypto.randomUUID(), crypto.randomUUID()]

    logRequest(chatRound(tabId, { startedAt: 1000 }))
    logRequest(chatRound(other, { startedAt: 2000 }))
    logRequest(chatRound(tabId, { kind: 'model_invoke', startedAt: 3000, usage: { inputTokens: 400, outputTokens: 30 } }))
    logRequest(chatRound(tabId, { startedAt: 61_000 }))
    // A stopped round, whose result came after the end of a newer round.
    logRequest(chatRound(tabId, { startedAt: 30_000 }))

    expect(rowsOf(tabId).map((row) => [row.kind, row.startedAt, row.sincePreviousMs])).toStrictEqual([
      ['chat', 1000, null],
      ['model_invoke', 3000, null],
      ['chat', 61_000, 60_000],
      ['chat', 30_000, 29_000],
    ])
    expect(rowsOf(tabId)[1]).toMatchObject({ uncachedInputTokens: 400, outputTokens: 30, contextTokens: null, contextEstimated: null })
    expect(rowsOf(other)[0].sincePreviousMs).toBeNull()
  })

  it(`keeps only the newest ${MAX_REQUEST_LOG_ROWS} rows`, () => {
    const tabId = crypto.randomUUID()

    for (let startedAt = 0; startedAt < MAX_REQUEST_LOG_ROWS + 3; startedAt++) logRequest(chatRound(tabId, { startedAt }))

    expect(log()).toHaveLength(MAX_REQUEST_LOG_ROWS)
    expect(log().map((row) => row.startedAt)).toStrictEqual(Array.from({ length: MAX_REQUEST_LOG_ROWS }, (_, index) => index + 3))
  })
})
