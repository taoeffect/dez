import fs from 'node:fs'
import path from 'node:path'
import { waitForValue } from './dom'
import { mediaTempDir, writeTestFile } from './fixtures'
import { takeRequest, type MockProviderApp } from './mockProviderApp'
import { answerHeld, startMockServer, type HeldRequest, type MockServer } from './mockServer'
import type { E2EBrowser } from './session'
import { threadSections } from './thread'

// Clips for the specs of the media player: the bytes of short test clips, a
// server that serves them as the CDN of a provider does, and readers of the
// players that the editor shows. The clips are in the formats that the
// GStreamer of the CI image plays: its `gstreamer1.0-plugins-good` package
// has the WAV parser, the WebM and MP4 demuxers, and the VP9 decoder. It
// has no H.264 decoder, so the MP4 clip holds VP9 too.

/** The sample rate of the test audio, in samples a second. */
export const WAV_SAMPLE_RATE = 8000

/** A WAV file of `samples`: mono PCM at 8 kHz, with `sampleBytes` bytes in
 *  each sample. */
export function monoWav (samples: Buffer, sampleBytes: 1 | 2): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + samples.length, 4)
  header.write('WAVEfmt ', 8, 'ascii')
  header.writeUInt32LE(16, 16) // size of the format chunk
  header.writeUInt16LE(1, 20) // format: PCM
  header.writeUInt16LE(1, 22) // channels
  header.writeUInt32LE(WAV_SAMPLE_RATE, 24)
  header.writeUInt32LE(WAV_SAMPLE_RATE * sampleBytes, 28) // bytes per second
  header.writeUInt16LE(sampleBytes, 32) // bytes per sample of all channels
  header.writeUInt16LE(sampleBytes * 8, 34) // bits per sample
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(samples.length, 40)
  return Buffer.concat([header, samples])
}

/** A WAV file with `seconds` of silence: 8-bit mono PCM at 8 kHz. */
export function silentWav (seconds: number): Buffer {
  // 8-bit PCM has no sign: 128 is silence.
  return monoWav(Buffer.alloc(Math.round(seconds * WAV_SAMPLE_RATE), 128), 1)
}

/** A VP9 WebM video of one color: 48 x 36 px (4:3), 2 s, no sound. Made
 *  with:
 *
 *    ffmpeg -f lavfi -i color=c=0x2a7fd4:size=48x36:rate=5:duration=2 \
 *      -c:v libvpx-vp9 -b:v 0 -crf 50 -g 5 -an -pix_fmt yuv420p \
 *      -fflags +bitexact -flags:v +bitexact video.webm */
export const WEBM_VIDEO = fs.readFileSync(new URL('../fixtures/video.webm', import.meta.url))

/** `WEBM_VIDEO` in an MP4 file (the same VP9 stream; a model can take
 *  only MP4 or MOV clips, and the CI GStreamer packages decode VP9 in
 *  MP4 too): 2 s by its movie header. Made with:
 *
 *    ffmpeg -i video.webm -c copy -movflags +faststart video.mp4 */
export const MP4_VIDEO = fs.readFileSync(new URL('../fixtures/video.mp4', import.meta.url))

/** Bytes that no computer decodes as a clip: plain text. A test of a clip
 *  that the computer cannot play uses them in place of a real format that
 *  only some computers decode, so that it gives the same result on each
 *  host. */
export const NOT_A_CLIP = Buffer.from('This text is no clip.\n')

/** One file of a clip server. */
export interface ServedClip {
  /** The `Content-Type` of the answer. */
  type: string
  bytes: Buffer
}

export interface ClipServer extends MockServer {
  /** The URL of the clip `name`. */
  clipUrl: (name: string) => string
}

/** Starts a server that answers `GET /<name>` with the bytes of
 *  `clips[name]`, and any other request with 404. A media element asks for
 *  a clip in parts, so a request with a `Range` header gets that part of
 *  the bytes in a 206 answer. */
export async function startClipServer (clips: Readonly<Record<string, ServedClip>>): Promise<ClipServer> {
  const server = await startMockServer((req, res) => {
    const name = (req.url ?? '').slice(1)
    const clip = Object.hasOwn(clips, name) ? clips[name] : undefined
    if (!clip || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
      return
    }
    const total = clip.bytes.length
    const headers = { 'Content-Type': clip.type, 'Accept-Ranges': 'bytes' }
    // `bytes=<first>-<last>`; with no last byte, the part goes to the end.
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    if (!range) {
      res.writeHead(200, { ...headers, 'Content-Length': total })
      res.end(req.method === 'HEAD' ? undefined : clip.bytes)
      return
    }
    const first = Number(range[1])
    const last = range[2] === '' ? total - 1 : Math.min(Number(range[2]), total - 1)
    if (first > last) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` })
      res.end()
      return
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${first}-${last}/${total}`, 'Content-Length': last - first + 1 })
    res.end(req.method === 'HEAD' ? undefined : clip.bytes.subarray(first, last + 1))
  })
  return { ...server, clipUrl: (name) => `${server.url}/${name}` }
}

export type ClipKind = 'audio' | 'video'

/** The text of a media tag, written out here so that the specs do not take
 *  the format from the code under test. No value needs an escape. */
export function clipTag (kind: ClipKind, fields: { id: string, type: string, src?: string, url?: string, expires?: string }): string {
  const attributes = (['id', 'type', 'src', 'url', 'expires'] as const)
    .flatMap((name) => fields[name] === undefined ? [] : [` ${name}="${fields[name]}"`])
  return `<dez:${kind}${attributes.join('')}/>`
}

/** Writes `bytes` as the temp copy `name` of a clip in the test HOME
 *  `home`, and gives its tag with the id `id` and a time that ends in one
 *  hour. An audio clip is a WAV file, a video clip an MP4 file. The copy
 *  is a new file, so the cleanup of old temp copies leaves it. */
export async function tempClipTag (home: string, kind: ClipKind, id: string, name: string, bytes: Buffer): Promise<string> {
  const src = await writeTestFile(path.join(mediaTempDir(home), name), bytes)
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  return clipTag(kind, { id, type: kind === 'audio' ? 'audio/wav' : 'video/mp4', src, expires })
}

/** A job of Venice's queue API, for `finishVeniceJob`. */
export interface VeniceJob {
  /** The path of the ask for the state of the job. */
  retrievePath: string
  modelId: string
  queueId: string
  /** The answer to the ask: the clip of a job that is done. */
  clip: ServedClip
}

/** Answers the held Venice queue request `queue` with the job, takes the
 *  ask for the state of the job (the app asks 5 seconds later), checks
 *  it, and answers it with the clip. */
export async function finishVeniceJob (setup: MockProviderApp, queue: HeldRequest, job: VeniceJob): Promise<void> {
  answerHeld(queue.reply, 'application/json', JSON.stringify({ model: job.modelId, queue_id: job.queueId, status: 'QUEUED' }))
  const retrieve = await takeRequest(setup, job.retrievePath, { model: job.modelId, queue_id: job.queueId })
  answerHeld(retrieve.reply, job.clip.type, job.clip.bytes)
}

/** Ends the job of a reply of a media model (`finishVeniceJob`), and
 *  gives the text of the reply, the section `replyIndex`, once the user
 *  section after it is there. */
export async function answerVeniceJob (setup: MockProviderApp, queue: HeldRequest, job: VeniceJob & { replyIndex: number }): Promise<string> {
  await finishVeniceJob(setup, queue, job)
  await waitForValue(setup.browser, 'sections after the reply', async () => (await threadSections(setup.browser)).length, job.replyIndex + 2)
  return (await threadSections(setup.browser))[job.replyIndex].text
}

/** One player of the active editor, as the page shows it. */
export interface ShownPlayer {
  kind: string | null
  /** The text of the id badge. */
  id: string
  /** False when the player shows a card in place of the clip (the clip is
   *  gone, or this computer cannot play it; `problemCards` reads it). */
  available: boolean
  /** What the media element loads: the URL of a remote clip; 'blob' for a
   *  local file, which the player reads into a blob URL; null for none. */
  source: string | null
  /** The length of the clip in s, to 1 decimal place; null until the media
   *  element has the clip's metadata. */
  seconds: number | null
  /** The size of the video's picture in px; null for an audio clip, and
   *  until the media element has the clip's metadata. */
  picture: { width: number, height: number } | null
  /** The clock of a clip that is not saved; null when it does not show. */
  clock: 'Not saved' | 'Expired' | null
  /** The face of the Save control (`data-state`); null when it does not
   *  show. */
  save: string | null
}

/** The players that the active editor shows, in doc order. */
export async function shownPlayers (browser: E2EBrowser): Promise<ShownPlayer[]> {
  return browser.execute(() => Array.from(document.querySelectorAll<HTMLElement>('.cm-content .media-player'), (player) => {
    const media = player.querySelector<HTMLMediaElement>('video, audio')
    const src = media?.getAttribute('src') ?? null
    const clock = player.querySelector('.media-player__clock')
    const loaded = media !== null && Number.isFinite(media.duration)
    return {
      kind: player.getAttribute('data-kind'),
      id: player.querySelector('.media-player__id')?.textContent?.trim() ?? '',
      available: !player.hasAttribute('data-unavailable'),
      source: src?.startsWith('blob:') ? 'blob' : src,
      seconds: loaded ? Math.round(media.duration * 10) / 10 : null,
      picture: loaded && media instanceof HTMLVideoElement ? { width: media.videoWidth, height: media.videoHeight } : null,
      clock: clock === null ? null : clock.hasAttribute('data-expired') ? 'Expired' : 'Not saved',
      save: player.querySelector('.media-player__save')?.getAttribute('data-state') ?? null,
    }
  }))
}

/** The text of each player tooltip that is open, in doc order. */
export async function openPlayerTooltips (browser: E2EBrowser): Promise<string[]> {
  return browser.execute(() => Array.from(
    document.querySelectorAll<HTMLElement>('.cm-content .media-player__tooltip[data-open]'),
    // The title and the text of a notice are blocks with no space between.
    (tooltip) => Array.from(tooltip.children, (part) => part.textContent?.trim() ?? '').join(' ') || (tooltip.textContent?.trim() ?? ''),
  ))
}

/** The card of a player that shows no clip. */
export interface ProblemCard {
  /** Why the clip does not play (`data-unavailable`): `gone` or
   *  `cannot-play`. */
  cause: string
  /** The lines of the card's text. */
  lines: string[]
}

/** The cards of the players of the active editor that show no clip, in doc
 *  order. */
export async function problemCards (browser: E2EBrowser): Promise<ProblemCard[]> {
  return browser.execute(() => Array.from(document.querySelectorAll<HTMLElement>('.cm-content .media-player[data-unavailable]'), (player) => ({
    cause: player.getAttribute('data-unavailable') ?? '',
    lines: Array.from(player.querySelector('.media-player__unavailable-text')?.children ?? [], (line) => line.textContent?.trim() ?? ''),
  })))
}

/** Waits until the card of a player fills the screen (`on`), or until
 *  nothing does. The page is ready for a click only when the layout is at
 *  rest: the fullscreen button has its new state (video.js sets it at
 *  `fullscreenchange`), and two reads of the window size agree, because the
 *  window gets its new size in steps. */
export async function waitForPlayerFullscreen (browser: E2EBrowser, on: boolean): Promise<void> {
  let state: { card: boolean, button: boolean, size: string } | undefined
  let sizeBefore = ''
  try {
    await browser.waitUntil(async () => {
      state = await browser.execute(() => ({
        card: document.fullscreenElement?.matches('.cm-content .media-player__card') ?? false,
        button: document.querySelector('.cm-content .media-player__fullscreen[data-fullscreen]') !== null,
        size: `${window.innerWidth}x${window.innerHeight}`,
      }))
      const atRest = state.card === on && state.button === on && state.size === sizeBefore
      sizeBefore = state.size
      return atRest
    }, { timeout: 10_000, interval: 150 })
  } catch (err) {
    throw new Error(`player fullscreen: expected ${on}, got ${JSON.stringify(state)}`, { cause: err })
  }
}
