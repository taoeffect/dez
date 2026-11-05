import http from 'node:http'
import type { AddressInfo } from 'node:net'

// A mock OpenAI-compatible server in the spec's process. Each spec routes
// its own requests and keeps its own record; this module holds the parts
// they share: the request body, the streamed chat reply, start, and stop.

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
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  for (const token of replyTokens(name)) {
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: token } }] })}\n\n`)
  }
  if (hold) await hold
  res.end('data: [DONE]\n\n')
}
