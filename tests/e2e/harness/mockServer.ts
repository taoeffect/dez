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

/** Answers one request. `body` is the whole request body as UTF-8 text. */
export type MockHandler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void | Promise<void>

/** Starts a server on a free port of 127.0.0.1 that reads each request
 *  body, then passes the request to `handler`. */
export async function startMockServer (handler: MockHandler): Promise<MockServer> {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    await handler(req, res, Buffer.concat(chunks).toString('utf8'))
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

/** Answers 404 to every request that is not a POST to one of `chatPaths`,
 *  and passes the chat requests to `onChat`. */
export async function startChatMock (chatPaths: readonly string[], onChat: MockHandler): Promise<MockServer> {
  return startMockServer((req, res, body) => {
    if (req.method !== 'POST' || !chatPaths.includes(req.url ?? '')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
      return
    }
    return onChat(req, res, body)
  })
}

/** A chat request whose response the mock keeps open, with nothing sent,
 *  until the test answers it. */
export interface HeldRequest {
  /** The request body as UTF-8 text. */
  body: string
  reply: http.ServerResponse
  /** The app closed the connection before the reply ended. */
  closed: boolean
}

export interface HoldingChatMock extends MockServer {
  /** Waits for the oldest chat request that no test took yet, and takes
   *  it. */
  waitForRequest: (browser: E2EBrowser) => Promise<HeldRequest>
  /** Whether a chat request came that no test took. */
  hasWaitingRequest: () => boolean
  /** Stops the stream of every tab, then destroys the response of every
   *  request since the last drop, taken or not, so that a test that fails
   *  leaves no open request to the next test. The stop comes first because
   *  it shows no error toast, while a reply destroyed under a running stream
   *  shows a sticky one, which would make the next tests fail too. */
  dropOpenReplies: (browser: E2EBrowser) => Promise<void>
}

/** Starts a chat mock for POST `chatPath` that holds each request for the
 *  test: the test takes it with `waitForRequest` and answers it. */
export async function startHoldingChatMock (chatPath: string): Promise<HoldingChatMock> {
  const sinceDrop: HeldRequest[] = []
  const waiting: HeldRequest[] = []
  const server = await startChatMock([chatPath], (_req, res, body) => {
    const request: HeldRequest = { body, reply: res, closed: false }
    res.on('close', () => { request.closed = !res.writableEnded })
    sinceDrop.push(request)
    waiting.push(request)
  })
  return {
    ...server,
    async waitForRequest (browser) {
      await waitForValue(browser, 'chat request', async () => waiting.length > 0, true)
      const request = waiting.shift()
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

/** A custom provider in the OpenAI format with one model, served by a mock
 *  server under `/<id>/v1`. */
export interface MockProvider {
  id: string
  name: string
  modelId: string
  modelName: string
}

/** The path of the provider's chat requests on its mock server. */
export function mockChatPath (provider: MockProvider): string {
  return `/${provider.id}/v1/chat/completions`
}

/** The `customProviders` entry of `provider` on the mock server at
 *  `serverUrl`. The app fetches no model list for it. */
export function mockProviderConfig (provider: MockProvider, serverUrl: string): Record<string, unknown> {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: `${serverUrl}/${provider.id}/v1`,
    apiFormat: 'openai',
    fetchModels: false,
    models: [{ id: provider.modelId, name: provider.modelName }],
  }
}

/** Starts a 200 SSE reply and sends its headers at once. */
export function startEventStream (res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  res.flushHeaders()
}

/** Writes one chat completion SSE frame with one choice. */
export function writeChatFrame (res: http.ServerResponse, delta: Record<string, string>, finishReason: string | null = null): void {
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
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
