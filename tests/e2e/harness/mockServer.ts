import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { waitForValue } from './dom'
import type { E2EBrowser } from './session'

// A mock OpenAI-compatible server in the spec's process. Each spec routes
// its own requests and keeps its own record; this module holds the parts
// they share: the request body, the chat-only routing, the held chat
// requests, the SSE reply parts, the streamed chat reply, the mock provider
// config, start, and stop.

export interface MockServer {
  /** `http://127.0.0.1:<port>`, with no trailing slash. */
  url: string
  stop: () => Promise<void>
}

/** Answers one request. `body` is the whole request body as UTF-8 text,
 *  and `bytes` the same body as it came (a multipart form holds files). */
export type MockHandler = (req: http.IncomingMessage, res: http.ServerResponse, body: string, bytes: Buffer) => void | Promise<void>

/** Starts a server on a free port of 127.0.0.1 that reads each request
 *  body, then passes the request to `handler`. */
export async function startMockServer (handler: MockHandler): Promise<MockServer> {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const bytes = Buffer.concat(chunks)
    await handler(req, res, bytes.toString('utf8'), bytes)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    async stop () {
      // reqwest keeps its connections open, and close() waits for them.
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** Passes the chat requests (a POST to one of `chatPaths`) to `onChat`.
 *  A GET to a path of `jsonAnswers` gets the value of that path as JSON at
 *  once, such as a model list. Every other request gets a 404. */
export async function startChatMock (
  chatPaths: readonly string[],
  onChat: MockHandler,
  jsonAnswers: Readonly<Record<string, unknown>> = {},
): Promise<MockServer> {
  return startMockServer((req, res, body, bytes) => {
    const path = req.url ?? ''
    if (req.method === 'POST' && chatPaths.includes(path)) return onChat(req, res, body, bytes)
    if (req.method === 'GET' && Object.hasOwn(jsonAnswers, path)) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(jsonAnswers[path]))
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
  })
}

/** A chat request whose response the mock keeps open, with nothing sent,
 *  until the test answers it. */
export interface HeldRequest {
  /** The request path, e.g. `mockChatPath(provider)`. */
  path: string
  /** The request body as UTF-8 text. */
  body: string
  /** The request body as it came, and the request headers: a form
   *  (`requestForm`) needs both. */
  bytes: Buffer
  headers: http.IncomingHttpHeaders
  reply: http.ServerResponse
  /** The app closed the connection before the reply ended. */
  closed: boolean
}

/** Answers a held request with a 200 and `body` of the type
 *  `contentType`. */
export function answerHeld (reply: http.ServerResponse, contentType: string, body: string | Buffer): void {
  reply.writeHead(200, { 'Content-Type': contentType })
  reply.end(body)
}

/** One field of a multipart/form-data request: a text, or a file with its
 *  name, type, and bytes. */
export type FormField =
  | { name: string, value: string }
  | { name: string, fileName: string, type: string, bytes: Buffer }

/** The fields of the multipart/form-data body of `request`, in body order,
 *  as a server that follows the standard reads them. */
export async function requestForm (request: HeldRequest): Promise<FormField[]> {
  const form = await new Response(request.bytes, { headers: { 'Content-Type': request.headers['content-type'] ?? '' } }).formData()
  return Promise.all([...form.entries()].map(async ([name, value]) => (typeof value === 'string'
    ? { name, value }
    : { name, fileName: value.name, type: value.type, bytes: Buffer.from(await value.arrayBuffer()) })))
}

export interface HoldingChatMock extends MockServer {
  /** Waits for the oldest chat request that no test took yet, and takes
   *  it. With `path`, the oldest one to that path: requests that the app
   *  sends at the same time (a chat request and the request of a job) come
   *  in any order. */
  waitForRequest: (browser: E2EBrowser, path?: string) => Promise<HeldRequest>
  /** Whether a chat request came that no test took. */
  hasWaitingRequest: () => boolean
  /** Stops the stream of every tab, then destroys the response of every
   *  request since the last drop, taken or not, so that a test that fails
   *  leaves no open request to the next test. The stop comes first because
   *  it shows no error toast, while a reply destroyed under a running stream
   *  shows a sticky one, which would make the next tests fail too. */
  dropOpenReplies: (browser: E2EBrowser) => Promise<void>
}

/** Starts a chat mock for POST to each of `chatPaths` that holds each
 *  request for the test: the test takes it with `waitForRequest` and
 *  answers it. `jsonAnswers`: see `startChatMock`. */
export async function startHoldingChatMock (
  chatPaths: readonly string[],
  jsonAnswers: Readonly<Record<string, unknown>> = {},
): Promise<HoldingChatMock> {
  const sinceDrop: HeldRequest[] = []
  const waiting: HeldRequest[] = []
  const server = await startChatMock(chatPaths, (req, res, body, bytes) => {
    const request: HeldRequest = { path: req.url ?? '', body, bytes, headers: req.headers, reply: res, closed: false }
    res.on('close', () => { request.closed = !res.writableEnded })
    sinceDrop.push(request)
    waiting.push(request)
  }, jsonAnswers)
  return {
    ...server,
    async waitForRequest (browser, path) {
      const oldest = () => waiting.findIndex((request) => path === undefined || request.path === path)
      await waitForValue(browser, path === undefined ? 'chat request' : `request to ${path}`, async () => oldest() >= 0, true)
      const [request] = waiting.splice(oldest(), 1)
      if (!request) throw new Error('waitForRequest: no waiting request')
      return request
    },
    hasWaitingRequest: () => waiting.length > 0,
    async dropOpenReplies (browser) {
      try {
        await browser.execute(async () => {
          const sbp = Reflect.get(window, 'sbp') as (selector: string, ...args: unknown[]) => unknown
          const tabs = sbp('dez.model/tabs/list') as Array<{ id: string }>
          for (const tab of tabs) await sbp('dez.stream/stop', tab.id)
        })
      } finally {
        for (const request of sinceDrop) request.reply.destroy()
        sinceDrop.length = 0
        waiting.length = 0
      }
    },
  }
}

/** A custom provider with one model, served by a mock server under
 *  `/<id>`. */
export interface MockProvider {
  id: string
  name: string
  modelId: string
  modelName: string
  /** The wire format; OpenAI when absent. */
  apiFormat?: 'openai' | 'anthropic'
}

/** The path of the provider's chat requests on its mock server. */
export function mockChatPath (provider: MockProvider): string {
  return provider.apiFormat === 'anthropic'
    ? `/${provider.id}/v1/messages`
    : `/${provider.id}/v1/chat/completions`
}

/** The `customProviders` entry of `provider` on the mock server at
 *  `serverUrl`. The app fetches no model list for it. */
export function mockProviderConfig (provider: MockProvider, serverUrl: string): Record<string, unknown> {
  const apiFormat = provider.apiFormat ?? 'openai'
  return {
    id: provider.id,
    name: provider.name,
    // The app adds `/chat/completions` to an OpenAI base URL, and
    // `/v1/messages` to an Anthropic one (SDK style).
    baseUrl: apiFormat === 'anthropic' ? `${serverUrl}/${provider.id}` : `${serverUrl}/${provider.id}/v1`,
    apiFormat,
    fetchModels: false,
    models: [{ id: provider.modelId, name: provider.modelName }],
  }
}

/** Starts a 200 SSE reply and sends its headers at once. */
export function startEventStream (res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  res.flushHeaders()
}

/** Writes one chat completion SSE frame with one choice. `delta` holds text
 *  fields such as `content`, or `tool_calls` pieces. */
export function writeChatFrame (res: http.ServerResponse, delta: Record<string, unknown>, finishReason: string | null = null): void {
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
}

/** A tool call of a mock model, as an OpenAI-format assistant message
 *  holds it. */
export function openAiToolCall (id: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

/** Answers a chat request with one round that holds only `calls`
 *  (`openAiToolCall`), then ends the stream. */
export function sendToolCalls (res: http.ServerResponse, calls: ReadonlyArray<Record<string, unknown>>): void {
  startEventStream(res)
  writeChatFrame(res, { tool_calls: calls.map((call, index) => ({ index, ...call })) }, 'tool_calls')
  res.end('data: [DONE]\n\n')
}

/** Writes the chat completion SSE frame with which OpenRouter stops a 200
 *  reply that failed: a top-level `error` (`{ code, message, metadata: {
 *  error_type } }`) and `finish_reason: "error"`. */
export function writeChatErrorFrame (res: http.ServerResponse, error: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify({ error, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] })}\n\n`)
}

/** Writes one Anthropic Messages SSE event; its `type` names the event. */
export function writeAnthropicEvent (res: http.ServerResponse, data: Record<string, unknown>): void {
  res.write(`event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`)
}

// The reply streams in several chunks and names `name`, so a test can see
// which request a reply answers.
function replyTokens (name: string): string[] {
  return ['Reply', ' from', ` ${name}`, '.']
}

/** The full text of the reply that `sendChatReply(res, name)` streams. */
export function replyText (name: string): string {
  return replyTokens(name).join('')
}

/** Streams the reply that names `name` as chat completion SSE frames, then
 *  ends the stream with `[DONE]`. When `hold` is set, the stream stays open
 *  after the tokens until `hold` resolves. */
export async function sendChatReply (res: http.ServerResponse, name: string, hold?: Promise<void> | null): Promise<void> {
  startEventStream(res)
  for (const token of replyTokens(name)) writeChatFrame(res, { content: token })
  if (hold) await hold
  res.end('data: [DONE]\n\n')
}

/** Streams the reply that `sendChatReply(res, name)` streams, as Anthropic
 *  Messages SSE events: one text block in several deltas. */
export function sendAnthropicReply (res: http.ServerResponse, name: string): void {
  startEventStream(res)
  writeAnthropicEvent(res, {
    type: 'message_start',
    message: { id: 'msg_mock', type: 'message', role: 'assistant', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } },
  })
  writeAnthropicEvent(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  for (const token of replyTokens(name)) writeAnthropicEvent(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: token } })
  writeAnthropicEvent(res, { type: 'content_block_stop', index: 0 })
  writeAnthropicEvent(res, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } })
  writeAnthropicEvent(res, { type: 'message_stop' })
  res.end()
}
