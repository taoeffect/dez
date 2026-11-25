import { expect } from 'vitest'
import { filesIn, workDir } from './fixtures'
import type { MockProviderApp } from './mockProviderApp'
import { openAiToolCall, replyText, sendChatReply, toolResult, type HeldRequest, type MockProvider } from './mockServer'
import { pidsWithCwdIn } from './processes'
import { endedReply, openToasts } from './thread'

// The parts that the specs of the tools that run code in Deno share
// (`js_eval`, and `apps invoke`): a `js_eval` call of the mock model, the
// result of its run without the run time line, the error of a result of
// code that threw, the checks at the end of the reply that made the calls,
// and the code of a run that draws a title and writes a frame sequence.

// The run time line of a result of a `js_eval` run (`withRunTime`): the
// last paragraph of its text, before the lines of its assets.
const RUN_TIME_LINE = /\n\nThe code ran for ([^\n]+)\.(?=\n|$)/

/** A `js_eval` call of a mock model: `code`, and with `more` the other
 *  arguments of the call (`inputs`, `timeout_seconds`). */
export function evalCall (id: string, code: string, more: Record<string, unknown> = {}): Record<string, unknown> {
  return openAiToolCall(id, 'js_eval', { code, ...more })
}

/** The result `result` of a `js_eval` run without its run time line, which
 *  every result of a run has: what the result was before Dez told the run
 *  time. The lines of its assets stay. */
export function withoutRunTime (result: string): string {
  expect(result).toMatch(RUN_TIME_LINE)
  return result.replace(RUN_TIME_LINE, '')
}

/** The run time that the result `result` of a `js_eval` run tells, as
 *  "0.4 seconds". */
export function runTime (result: string): string {
  return RUN_TIME_LINE.exec(result)?.[1] ?? ''
}

/** The code of `drawTitle()`, an async function that draws a line of text
 *  in three scripts with skia-canvas and the fonts that Dez ships, leaves
 *  the picture `title.png` (240 × 64) in the output folder, and gives the
 *  count of its dark pixels (`ink`) and the first family of its fonts
 *  (`first`). Its scope must have `Canvas` of skia-canvas,
 *  `useShippedFonts` of dez-media/canvas, and `dez`. */
export const DRAW_TITLE = [
  'async function drawTitle() {',
  '  const families = useShippedFonts(dez.fonts)',
  '  const canvas = new Canvas(240, 64, { gpu: false })',
  '  const ctx = canvas.getContext("2d")',
  '  ctx.fillStyle = "white"',
  '  ctx.fillRect(0, 0, canvas.width, canvas.height)',
  '  ctx.fillStyle = "black"',
  '  ctx.font = `bold 28px ${families}`',
  '  ctx.fillText("Dez 日本 مرحبا", 8, 44)',
  '  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)',
  '  let ink = 0',
  '  for (let index = 0; index < data.length; index += 4) if (data[index] < 128) ink += 1',
  '  await canvas.toFile(`${dez.outputFolder}/title.png`)',
  '  return { ink, first: families.split(", ")[0] }',
  '}',
].join('\n')

/** The size, the frames a second, and the count of the frames of a frame
 *  sequence of `WRITE_FRAMES`. */
export const FRAMES = { width: 64, height: 36, fps: 12, count: 12 }

/** The color (RGBA) of the pixels of a frame sequence with half alpha. */
export const GLOW_COLOR = [255, 128, 0, 128]

/** The code of `writeFrames(name, color, alpha)`, a function that writes
 *  the frame sequence `name` of `FRAMES` into the output folder with
 *  dez-media/frames, each pixel of the RGBA `color`, with the alpha of
 *  each pixel when `alpha` is true, and gives the count of its frames. Its
 *  scope must have `FrameWriter` of dez-media/frames and `dez`. */
export const WRITE_FRAMES = [
  'function writeFrames(name, color, alpha) {',
  `  const { width, height, fps, count } = ${JSON.stringify(FRAMES)}`,
  '  const frames = new FrameWriter(dez.outputFolder, name, { fps, width, height, alpha })',
  '  const pixels = new Uint8Array(width * height * 4)',
  '  for (let index = 0; index < pixels.length; index += 4) pixels.set(color, index)',
  '  for (let frame = 0; frame < count; frame += 1) frames.add(pixels)',
  '  return frames.end()',
  '}',
].join('\n')

/** The result of the `js_eval` call `callId` that `request` sends, without
 *  its run time line (`withoutRunTime`). */
export function codeResult (request: HeldRequest, callId: string): string {
  return withoutRunTime(toolResult(request, callId))
}

/** The error of the result `result` of code that threw, as Deno gave it:
 *  the result without its first line, which tells what Dez did with the
 *  run, and without its run time line. */
export function thrownError (result: string): string {
  const text = withoutRunTime(result)
  return text.slice(text.indexOf('\n') + 1)
}

/**
 * Checks that the runs of the calls of a reply that ended left nothing:
 * the app sends no other request, no program of a call runs, no work
 * folder stays, and no error toast shows.
 */
export async function expectRunsEnded (setup: MockProviderApp): Promise<void> {
  const workRoot = workDir(setup.app.home)
  expect(setup.mock.hasWaitingRequest()).toBe(false)
  expect(pidsWithCwdIn(workRoot)).toStrictEqual([])
  expect(await filesIn(workRoot)).toStrictEqual([])
  expect(await openToasts(setup.browser, 'error')).toStrictEqual([])
}

/**
 * Answers `request` with the last text of a reply of the model of
 * `provider`, and checks the end of the reply: its text ends after the
 * blocks of the calls (so its last calls made no image and no clip), and
 * its runs left nothing (`expectRunsEnded`).
 */
export async function expectReplyEnd (setup: MockProviderApp, provider: MockProvider, request: HeldRequest): Promise<void> {
  await sendChatReply(request.reply, provider.modelName)
  const reply = await endedReply(setup.browser)
  expect(reply.endsWith(`</dez:tool>\n${replyText(provider.modelName)}`)).toBe(true)
  await expectRunsEnded(setup)
}
