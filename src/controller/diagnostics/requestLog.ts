import sbp from '@sbp/sbp'
import type { ContextSize } from '../../model/chat/contextSize'
import type { ModelRef } from '../../model/chat/types'
import { inputTokenParts, type ChatUsage } from '../../model/providers/chatUsage'

// The developer's view of the chat requests: one row of ids and numbers for
// each chat request (`dez.provider/streamChat`) that went to a provider, in
// memory only. A row never holds a text, a header, a path, or a URL (the
// rule of the diagnostics), so a developer can print the log and share it.
//
// In the developer console (Help › Developer Console):
//   sbp('dez.diagnostics/printRequestLog')   prints the rows as a table
//   sbp('dez.diagnostics/requestLog')        gives the rows, for a script
//
// A media request is not in the log: it tells no tokens, and no prompt
// cache holds it.

/** How a chat request of the log was sent:
 *  - `chat`: a chat round of a reply. It sends the conversation of its tab.
 *  - `compaction`: the compaction request of a conversation
 *    (controller/compaction.ts). It sends the conversation of its tab, so
 *    it reads the prompt cache of the chat rounds, and its instruction.
 *  - `model_invoke`: the request of a `model_invoke` call to a text model.
 *    It sends only the prompt of the call. */
export type LoggedRequestKind = 'chat' | 'compaction' | 'model_invoke'

/** What the sender of a chat request tells the log at the end of the
 *  request. */
export interface LoggedRequest {
  /** The tab of the reply that sent the request. */
  tabId: string
  kind: LoggedRequestKind
  model: ModelRef
  /** When the sender started the request (`Date.now()`). */
  startedAt: number
  /** What the provider told about the tokens; undefined when it told
   *  nothing, as for a request that failed or that the user stopped. */
  usage?: ChatUsage
  /** The price of the request in USD, as the cost of its tab counts it;
   *  null when it is not known. */
  cost: number | null
  /** The images that the request held. */
  imageCount: number
}

/** One chat request that went to a provider. A number that Dez does not
 *  know is null. */
export interface RequestLogRow {
  /** When Dez started the request, in milliseconds since the epoch. */
  startedAt: number
  tabId: string
  providerId: string
  modelId: string
  kind: LoggedRequestKind
  /** The input tokens that the prompt cache did not give and did not take.
   *  The three input numbers are the parts of `inputTokenParts`. */
  uncachedInputTokens: number | null
  /** The input tokens that the prompt cache gave. */
  cacheReadTokens: number | null
  /** The input tokens that the request put into the prompt cache. */
  cacheWriteTokens: number | null
  outputTokens: number | null
  /** The price of the request in USD. */
  cost: number | null
  /** The context size of the tab right after the request: the provider's
   *  count of the request (its input and its output tokens), else Dez's
   *  estimate of the tab for the model of the request
   *  (`dez.model/tabs/contextSize`). For a `compaction` request, the count
   *  is the size of the conversation that the compaction then replaces,
   *  with the instruction and the notes. Null for a `model_invoke`
   *  request, which holds no conversation, and for a request with no count
   *  whose tab is gone. */
  contextTokens: number | null
  /** Whether `contextTokens` is no count of a provider
   *  (`ContextSize.estimated`); null with no size. */
  contextEstimated: boolean | null
  /** The images that the request held. */
  imageCount: number
  /** The milliseconds from the start of the request before it that sent
   *  the conversation of the same tab to its own start: a prompt cache
   *  entry that no request reads for 5 minutes is gone. Null when the log
   *  holds no such request, and for a `model_invoke` request. */
  sincePreviousMs: number | null
}

/** The most rows that the log keeps: the oldest row goes first. */
export const MAX_REQUEST_LOG_ROWS = 500

// Under the Vite dev server (`npm run tauri dev`), the console gets one
// line for each request. Not `import.meta.env.DEV`: it is true in the unit
// tests too, and the lines would fill their output.
const PRINTS_EACH_REQUEST = import.meta.env.MODE === 'development'

const rows: RequestLogRow[] = []

// The context size of the tab of `request` right after it. The tokens that
// the provider counted for the request are that size
// (`dez.model/tabs/countRequestContext` keeps the same sum for the tab).
// With no count, the size is Dez's estimate of the tab as it is now, for
// the model of the request: the tab's active model can be another one (the
// model of the newest reply writes some compactions, and the user can
// choose a model while a reply runs).
function contextAfter(request: LoggedRequest): ContextSize | undefined {
  const { inputTokens, outputTokens } = request.usage ?? {}
  if (inputTokens !== undefined && outputTokens !== undefined) return { tokens: inputTokens + outputTokens, estimated: false }
  return sbp('dez.model/tabs/contextSize', request.tabId, request.model) as ContextSize | undefined
}

// The start of the newest request of the log that sent the conversation of
// the tab of `request` (so no `model_invoke` request) and started before
// it. The rows are in the order of the request ends, and a stopped request
// can end after a newer one, so the newest start is not always in the last
// row.
function previousStart(request: LoggedRequest): number | undefined {
  let previous: number | undefined
  for (const row of rows) {
    if (row.tabId !== request.tabId || row.kind === 'model_invoke' || row.startedAt > request.startedAt) continue
    if (previous === undefined || row.startedAt > previous) previous = row.startedAt
  }
  return previous
}

// A row as the console shows it: a clock time, the start of the tab id (a
// whole UUID makes the table too wide), and short column names.
function shownRow(row: RequestLogRow): Record<string, string | number | boolean | null> {
  return {
    time: new Date(row.startedAt).toLocaleTimeString(),
    tab: row.tabId.slice(0, 8),
    provider: row.providerId,
    model: row.modelId,
    kind: row.kind,
    uncached: row.uncachedInputTokens,
    'cache read': row.cacheReadTokens,
    'cache write': row.cacheWriteTokens,
    output: row.outputTokens,
    'cost ($)': row.cost,
    context: row.contextTokens,
    estimated: row.contextEstimated,
    images: row.imageCount,
    'since last (s)': row.sincePreviousMs === null ? null : row.sincePreviousMs / 1000,
  }
}

/** Adds the row of `request` to the log. The sender of a chat request
 *  calls it once, at the end of each request that went to the provider,
 *  also when the request failed or the user stopped it. A request that did
 *  not go has no row. */
export function logRequest(request: LoggedRequest): void {
  // Only a request that sends the conversation of its tab has a context
  // size, and reads the prompt cache entries that the tab's request before
  // it wrote. A `model_invoke` request sends only the prompt of its call.
  const conversation = request.kind !== 'model_invoke'
  const input = inputTokenParts(request.usage)
  const context = conversation ? contextAfter(request) : undefined
  const previous = conversation ? previousStart(request) : undefined
  const row: RequestLogRow = {
    startedAt: request.startedAt,
    tabId: request.tabId,
    providerId: request.model.providerId,
    modelId: request.model.modelId,
    kind: request.kind,
    uncachedInputTokens: input?.uncached ?? null,
    cacheReadTokens: input?.cacheRead ?? null,
    cacheWriteTokens: input?.cacheWrite ?? null,
    outputTokens: request.usage?.outputTokens ?? null,
    cost: request.cost,
    contextTokens: context?.tokens ?? null,
    contextEstimated: context?.estimated ?? null,
    imageCount: request.imageCount,
    sincePreviousMs: previous === undefined ? null : request.startedAt - previous,
  }
  rows.push(row)
  if (rows.length > MAX_REQUEST_LOG_ROWS) rows.shift()
  // Never `console.error`: every e2e spec fails on one.
  if (PRINTS_EACH_REQUEST) {
    console.info(`Chat request: ${Object.entries(shownRow(row)).map(([name, value]) => `${name} ${value ?? '?'}`).join(', ')}`)
  }
}

export default sbp('sbp/selectors/register', {
  // The rows of the log, the oldest first, as copies.
  'dez.diagnostics/requestLog' (): RequestLogRow[] {
    return rows.map((row) => ({ ...row }))
  },

  // Prints the rows of the log as a table in the console.
  'dez.diagnostics/printRequestLog' (): void {
    console.table(rows.map(shownRow))
  },
})
