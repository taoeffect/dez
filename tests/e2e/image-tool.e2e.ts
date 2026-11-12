import fs from 'node:fs'
import type http from 'node:http'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openAiChatBody } from './harness/chatBody'
import { consoleErrors, resetConsoleErrors, screenshotOnFailure, typeKeys, waitForValue } from './harness/dom'
import { decodedImage, generatedImagesDir, jpegImage, pasteImageReference, pngDataUrl, shownImages, STRIPE_COLORS, STRIPES_PNG, STRIPES_SVG, WEBKIT_SVG_SIZES, type DecodedImage } from './harness/images'
import { startMockProviderApp, type MockProviderApp } from './harness/mockProviderApp'
import { replyText, sendChatReply, startEventStream, writeChatFrame, type MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import { focusEditor, newTab, pickModel, submit, threadSections } from './harness/thread'

// The `image` tool's `flip`, `rotate`, color, and `convert` calls, driven
// through the real app against a mock server in this process. The webview
// draws each new image, and the tests read the pixels of the stored files.
// A flip mirrors the image. A turn by a right angle swaps the sides.
// Another angle makes a larger image with transparent corners, or (with
// `keep_size`) an image of the same size with a smaller turned image, and
// `fill` paints the blank parts. A turned SVG is drawn as a PNG. A turned
// JPEG stays a JPEG, unless the turn leaves transparent corners: then it is
// a PNG. The color calls (`brightness`, `contrast`, `saturation`, `invert`)
// change each color value and keep the transparency. A convert makes a
// JPEG on white, a WebP (where the webview writes WebP), or an SVG that
// holds the PNG of the image, which the editor shows and Dez draws again.
//
// One app session serves the whole file.

const TOOLER: MockProvider = { id: 'tooler', name: 'Tool Mock', modelId: 'tool-model', modelName: 'Tool Model' }

const [RED, GREEN, BLUE] = STRIPE_COLORS.map((rgb) => [...rgb, 255])
const TRANSPARENT = [0, 0, 0, 0]

// The file type of each extension of a stored image.
const FILE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' }

/** The largest difference of a channel of `pixel` from that of `color`:
 *  JPEG and WebP keep colors only near to their values. */
function colorDistance (pixel: readonly number[] | undefined, color: readonly number[]): number {
  return Math.max(...color.map((value, index) => Math.abs((pixel?.[index] ?? Infinity) - value)))
}

/** An `image` call of the mock model, and the result that Dez gives. */
interface ImageCall {
  id: string
  command: string
  parameters: Record<string, unknown>
  result: string
}

function wireCall (call: ImageCall): Record<string, unknown> {
  return {
    id: call.id,
    type: 'function',
    function: { name: 'image', arguments: JSON.stringify({ command: call.command, parameters: JSON.stringify(call.parameters) }) },
  }
}

/** The messages of a round of `calls`: the assistant message, then the
 *  results. */
function roundMessages (calls: ImageCall[]): unknown[] {
  return [
    { role: 'assistant', content: 'Drawing.', tool_calls: calls.map(wireCall) },
    ...calls.map((call) => ({ role: 'tool', tool_call_id: call.id, content: call.result })),
  ]
}

/** Answers a chat request with one round of `calls`. */
function sendImageCalls (reply: http.ServerResponse, calls: ImageCall[]): void {
  startEventStream(reply)
  writeChatFrame(reply, { content: 'Drawing.' })
  writeChatFrame(reply, { tool_calls: calls.map((call, index) => ({ index, ...wireCall(call) })) }, 'tool_calls')
  reply.end('data: [DONE]\n\n')
}

/** The messages of the chat request body `body`. */
function sentMessages (body: string): unknown[] {
  const sent: unknown = JSON.parse(body)
  if (!sent || typeof sent !== 'object' || !('messages' in sent) || !Array.isArray(sent.messages)) throw new Error('sentMessages: the body has no messages')
  return sent.messages
}

describe('image tool flip, rotate, color changes, and convert', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser
  let generatedDir: string

  /** Types "Turn " into a new tab, pastes `image`, and waits for its
   *  reference. */
  async function pasteInNewTab (image: Buffer, type: string): Promise<void> {
    await newTab(browser)
    await pickModel(browser, TOOLER.name, TOOLER.modelName)
    await focusEditor(browser)
    await typeKeys(browser, 'Turn ')
    await pasteImageReference(browser, image, 'a', type)
  }

  /** Ends the reply after the calls, and gives the paths of the images
   *  that the calls made, by their ids. Each path is in the folder of the
   *  generated images. */
  async function madeImages (reply: http.ServerResponse): Promise<Record<string, string>> {
    await sendChatReply(reply, TOOLER.modelName)
    await waitForValue(browser, 'sections after the reply', async () => (await threadSections(browser)).length, 3)
    const text = (await threadSections(browser))[1].text
    expect(text.endsWith(replyText(TOOLER.modelName))).toBe(true)
    const paths = Object.fromEntries([...text.matchAll(/!\[([^\]]+)\]\(id=([b-z])\|tool=image\)/g)].map((match) => [match[2], match[1]]))
    for (const file of Object.values(paths)) expect(path.dirname(file)).toBe(generatedDir)
    return paths
  }

  /** The size of the stored image `file`, and the colors of its pixels at
   *  `points` (each a column and a row). */
  async function filePixels (file: string, points: Array<[number, number]>): Promise<DecodedImage> {
    const bytes = await fs.promises.readFile(file)
    const url = `data:${FILE_TYPES[path.extname(file)]};base64,${bytes.toString('base64')}`
    return decodedImage(browser, url, points)
  }

  beforeAll(async () => {
    setup = await startMockProviderApp(TOOLER)
    browser = setup.browser
    generatedDir = generatedImagesDir(setup.app.home)
  })

  beforeEach(async () => {
    await resetConsoleErrors(browser)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    await setup.mock.dropOpenReplies(browser)
    if (ctx.task.result?.state === 'fail') return
    expect(await consoleErrors(browser)).toEqual([])
  })

  afterAll(async () => {
    await setup?.stop()
  })

  it('flips and rotates a PNG: mirrored stripes, swapped sides, a larger image with transparent corners, and a kept size with a fill', async () => {
    // 90 x 20: red, green, and blue stripes of 30 columns.
    await pasteInNewTab(STRIPES_PNG, 'image/png')
    await submit(browser, '')
    const first = await setup.mock.waitForRequest(browser)
    const withImage = { role: 'user', content: [{ type: 'text', text: 'Turn ![image](id=a)' }, { type: 'image_url', image_url: { url: pngDataUrl(STRIPES_PNG) } }] }
    expect(JSON.parse(first.body)).toEqual(openAiChatBody(TOOLER, [withImage]))

    // The third call names the image of the second. A turn of 45 degrees
    // needs a box of 90 cos 45 + 20 sin 45 = 77.8 pixels on each side.
    const calls: ImageCall[] = [
      { id: 'call_flip', command: 'flip', parameters: { image: 'a', direction: 'horizontal' }, result: 'Made the image @b from @a. The image @b is 90x20 pixels.' },
      { id: 'call_right', command: 'rotate', parameters: { image: 'a', angle: 90 }, result: 'Made the image @c from @a. The image @c is 20x90 pixels.' },
      { id: 'call_flip_turned', command: 'flip', parameters: { image: 'c', direction: 'vertical' }, result: 'Made the image @d from @c. The image @d is 20x90 pixels.' },
      { id: 'call_slant', command: 'rotate', parameters: { image: 'a', angle: 45 }, result: 'Made the image @e from @a. The image @e is 78x78 pixels.' },
      {
        id: 'call_kept',
        command: 'rotate',
        parameters: { image: 'a', angle: -45, keep_size: true, fill: '#ff8800' },
        result: 'Made the image @f from @a. The image @f is 90x20 pixels.',
      },
    ]
    sendImageCalls(first.reply, calls)
    const second = await setup.mock.waitForRequest(browser)
    expect(JSON.parse(second.body)).toEqual(openAiChatBody(TOOLER, [withImage, ...roundMessages(calls)]))

    const made = await madeImages(second.reply)
    expect(Object.keys(made)).toStrictEqual(['b', 'c', 'd', 'e', 'f'])
    for (const file of Object.values(made)) expect(path.extname(file)).toBe('.png')
    expect(await filePixels(made.b, [[15, 10], [45, 10], [75, 10]])).toEqual({ width: 90, height: 20, pixels: [BLUE, GREEN, RED] })
    // A clockwise turn puts the left side at the top.
    expect(await filePixels(made.c, [[10, 15], [10, 45], [10, 75]])).toEqual({ width: 20, height: 90, pixels: [RED, GREEN, BLUE] })
    expect(await filePixels(made.d, [[10, 15], [10, 45], [10, 75]])).toEqual({ width: 20, height: 90, pixels: [BLUE, GREEN, RED] })
    // The stripes run from the top left to the bottom right, and the left
    // corner is blank.
    expect(await filePixels(made.e, [[20, 20], [39, 39], [58, 58], [2, 39]])).toEqual({ width: 78, height: 78, pixels: [RED, GREEN, BLUE, TRANSPARENT] })
    // The turned image is small in the middle, so the ends are the fill.
    expect(await filePixels(made.f, [[2, 10], [88, 10]])).toEqual({ width: 90, height: 20, pixels: [[255, 136, 0, 255], [255, 136, 0, 255]] })
  })

  // No provider is known to take SVG images, and a canvas does not encode
  // SVG.
  it('flips and rotates a pasted SVG into PNG images', async () => {
    await pasteInNewTab(STRIPES_SVG, 'image/svg+xml')
    await waitForValue(browser, 'loaded SVG', async () => ((await shownImages(browser))[0]?.width ?? 0) > 0, true)
    const [shown] = await shownImages(browser)
    const svgSize = { width: shown.width, height: shown.height }
    expect(WEBKIT_SVG_SIZES).toContainEqual(svgSize)
    const { width, height } = svgSize
    const stripe = width / 3

    await submit(browser, '')
    const first = await setup.mock.waitForRequest(browser)
    const calls: ImageCall[] = [
      { id: 'call_flip_svg', command: 'flip', parameters: { image: 'a', direction: 'horizontal' }, result: `Made the image @b from @a. The image @b is ${width}x${height} pixels.` },
      { id: 'call_rotate_svg', command: 'rotate', parameters: { image: 'a', angle: 90 }, result: `Made the image @c from @a. The image @c is ${height}x${width} pixels.` },
    ]
    sendImageCalls(first.reply, calls)
    const second = await setup.mock.waitForRequest(browser)
    expect(sentMessages(second.body).slice(-3)).toEqual(roundMessages(calls))

    const made = await madeImages(second.reply)
    expect(Object.values(made).map((file) => path.extname(file))).toStrictEqual(['.png', '.png'])
    const middle = Math.floor(height / 2)
    expect(await filePixels(made.b, [[stripe / 2, middle], [stripe * 1.5, middle], [stripe * 2.5, middle]])).toEqual({ ...svgSize, pixels: [BLUE, GREEN, RED] })
    expect(await filePixels(made.c, [[middle, stripe / 2], [middle, stripe * 1.5], [middle, stripe * 2.5]])).toEqual({ width: height, height: width, pixels: [RED, GREEN, BLUE] })
  })

  // A JPEG has no transparent pixels: its blank corners would be black.
  it('saves a turned JPEG as a PNG when the turn leaves transparent corners, and as a JPEG when a fill paints them or the turn leaves none', async () => {
    const jpeg = await jpegImage(browser, STRIPES_PNG)
    await pasteInNewTab(jpeg, 'image/jpeg')
    await submit(browser, '')
    const first = await setup.mock.waitForRequest(browser)
    const calls: ImageCall[] = [
      { id: 'call_bare', command: 'rotate', parameters: { image: 'a', angle: 45 }, result: 'Made the image @b from @a. The image @b is 78x78 pixels.' },
      { id: 'call_white', command: 'rotate', parameters: { image: 'a', angle: 45, fill: 'white' }, result: 'Made the image @c from @a. The image @c is 78x78 pixels.' },
      { id: 'call_right_jpeg', command: 'rotate', parameters: { image: 'a', angle: 90 }, result: 'Made the image @d from @a. The image @d is 20x90 pixels.' },
    ]
    sendImageCalls(first.reply, calls)
    const second = await setup.mock.waitForRequest(browser)
    expect(sentMessages(second.body).slice(-4)).toEqual(roundMessages(calls))

    const made = await madeImages(second.reply)
    expect(Object.values(made).map((file) => path.extname(file))).toStrictEqual(['.png', '.jpg', '.jpg'])
    const corners = await filePixels(made.b, [[2, 39], [39, 39]])
    expect(corners.pixels[0]).toEqual(TRANSPARENT)
    expect(corners.pixels[1]?.[3]).toBe(255)
    // A JPEG keeps colors only near to their values.
    const [whiteCorner = []] = (await filePixels(made.c, [[2, 39]])).pixels
    expect(Math.min(...whiteCorner)).toBeGreaterThanOrEqual(250)
    expect(await filePixels(made.d, [[10, 45]])).toMatchObject({ width: 20, height: 90 })
  })

  // The colors are those of `changeColors` (src/model/chat/imageColors.ts)
  // for the stripe colors, worked out by hand.
  it('changes the brightness, the contrast, the saturation, and the colors of a PNG, and keeps its transparent pixels', async () => {
    await pasteInNewTab(STRIPES_PNG, 'image/png')
    await submit(browser, '')
    const first = await setup.mock.waitForRequest(browser)
    // The last call inverts the turned image of the call before it, whose
    // corners are transparent.
    const calls: ImageCall[] = [
      { id: 'call_dark', command: 'brightness', parameters: { image: 'a', amount: 0.5 }, result: 'Made the image @b from @a. The image @b is 90x20 pixels.' },
      { id: 'call_flat', command: 'contrast', parameters: { image: 'a', amount: 0.5 }, result: 'Made the image @c from @a. The image @c is 90x20 pixels.' },
      { id: 'call_gray', command: 'saturation', parameters: { image: 'a', amount: 0 }, result: 'Made the image @d from @a. The image @d is 90x20 pixels.' },
      { id: 'call_negative', command: 'invert', parameters: { image: 'a' }, result: 'Made the image @e from @a. The image @e is 90x20 pixels.' },
      { id: 'call_slant_colors', command: 'rotate', parameters: { image: 'a', angle: 45 }, result: 'Made the image @f from @a. The image @f is 78x78 pixels.' },
      { id: 'call_negative_slant', command: 'invert', parameters: { image: 'f' }, result: 'Made the image @g from @f. The image @g is 78x78 pixels.' },
    ]
    sendImageCalls(first.reply, calls)
    const second = await setup.mock.waitForRequest(browser)
    expect(sentMessages(second.body).slice(-7)).toEqual(roundMessages(calls))

    const made = await madeImages(second.reply)
    expect(Object.keys(made)).toStrictEqual(['b', 'c', 'd', 'e', 'f', 'g'])
    const stripes: Array<[number, number]> = [[15, 10], [45, 10], [75, 10]]
    expect(await filePixels(made.b, stripes)).toEqual({ width: 90, height: 20, pixels: [[110, 20, 20, 255], [20, 80, 30, 255], [20, 45, 110, 255]] })
    expect(await filePixels(made.c, stripes)).toEqual({ width: 90, height: 20, pixels: [[174, 84, 84, 255], [84, 144, 94, 255], [84, 109, 174, 255]] })
    expect(await filePixels(made.d, stripes)).toEqual({ width: 90, height: 20, pixels: [[78, 78, 78, 255], [127, 127, 127, 255], [89, 89, 89, 255]] })
    expect(await filePixels(made.e, stripes)).toEqual({ width: 90, height: 20, pixels: [[35, 215, 215, 255], [215, 95, 195, 255], [215, 165, 35, 255]] })
    // The green stripe in the middle, and a blank corner.
    expect(await filePixels(made.g, [[39, 39], [2, 39]])).toEqual({ width: 78, height: 78, pixels: [[215, 95, 195, 255], TRANSPARENT] })
  })

  // Not every webview writes WebP (a canvas that cannot gives a PNG), so the
  // test asks the page first and expects the unwritable-format error where
  // it does not. The SVG holds the PNG of the image: the editor shows it, and
  // Dez draws it again for a convert to PNG and for the PNG copy of a request.
  it('converts a PNG to a JPEG on white, a WebP, and an SVG, and draws the SVG again as a PNG and in a request', async () => {
    const writesWebp = await browser.execute(() => document.createElement('canvas').toDataURL('image/webp').startsWith('data:image/webp'))
    await pasteInNewTab(STRIPES_PNG, 'image/png')
    await submit(browser, '')
    const first = await setup.mock.waitForRequest(browser)
    // The corners of `b` are transparent.
    const calls: ImageCall[] = [
      { id: 'call_slant_convert', command: 'rotate', parameters: { image: 'a', angle: 45 }, result: 'Made the image @b from @a. The image @b is 78x78 pixels.' },
      { id: 'call_jpeg', command: 'convert', parameters: { image: 'b', format: 'jpeg' }, result: 'Made the image @c from @b. The image @c is 78x78 pixels.' },
      { id: 'call_svg', command: 'convert', parameters: { image: 'a', format: 'svg' }, result: 'Made the image @d from @a. The image @d is 90x20 pixels.' },
      { id: 'call_svg_png', command: 'convert', parameters: { image: 'd', format: 'png' }, result: 'Made the image @e from @d. The image @e is 90x20 pixels.' },
      {
        id: 'call_webp',
        command: 'convert',
        parameters: { image: 'b', format: 'webp' },
        result: writesWebp
          ? 'Made the image @f from @b. The image @f is 78x78 pixels.'
          : 'Dez cannot make WebP images on this computer: its web view does not write them. This is not a fault of the call, and there is no new image from @b. '
            + 'If another format will do for the user, call convert with "jpeg"; else tell the user that this computer cannot make WebP images.',
      },
    ]
    sendImageCalls(first.reply, calls)
    const second = await setup.mock.waitForRequest(browser)
    expect(sentMessages(second.body).slice(-6)).toEqual(roundMessages(calls))

    const made = await madeImages(second.reply)
    const extensions = Object.fromEntries(Object.entries(made).map(([id, file]) => [id, path.extname(file)]))
    expect(extensions).toStrictEqual({ b: '.png', c: '.jpg', d: '.svg', e: '.png', ...(writesWebp ? { f: '.webp' } : {}) })
    if (!writesWebp) {
      expect(await consoleErrors(browser)).toEqual([expect.stringContaining('The tool image failed')])
      await resetConsoleErrors(browser)
    }

    const [whiteCorner, jpegMiddle] = (await filePixels(made.c, [[2, 39], [39, 39]])).pixels
    expect(Math.min(...whiteCorner ?? [])).toBeGreaterThanOrEqual(250)
    expect(colorDistance(jpegMiddle, GREEN)).toBeLessThanOrEqual(12)

    const stripes: Array<[number, number]> = [[15, 10], [45, 10], [75, 10]]
    expect((await fs.promises.readFile(made.d, 'utf8')).startsWith('<svg ')).toBe(true)
    await waitForValue(browser, 'shown SVG', async () => (await shownImages(browser)).map(({ width, height }) => `${width}x${height}`)[3], '90x20')
    expect(await filePixels(made.d, stripes)).toEqual({ width: 90, height: 20, pixels: [RED, GREEN, BLUE] })
    expect(await filePixels(made.e, stripes)).toEqual({ width: 90, height: 20, pixels: [RED, GREEN, BLUE] })

    if (writesWebp) {
      const webp = await filePixels(made.f, [[2, 39], [39, 39]])
      expect(webp).toMatchObject({ width: 78, height: 78 })
      expect(webp.pixels[0]?.[3]).toBe(0)
      expect(colorDistance(webp.pixels[1], GREEN)).toBeLessThanOrEqual(12)
    }

    // The request sends the SVG as a PNG that the webview drew.
    await submit(browser, 'Look at @d')
    const third = await setup.mock.waitForRequest(browser)
    const [mention] = sentMessages(third.body).slice(-1)
    expect(mention).toEqual({ role: 'user', content: [{ type: 'text', text: 'Look at @d' }, { type: 'image_url', image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } }] })
    const sentUrl = /"url":"(data:image\/png;base64,[^"]+)"/.exec(third.body)?.[1] ?? ''
    expect(await decodedImage(browser, sentUrl, [[15, 10], [45, 10], [75, 10]])).toEqual({ width: 90, height: 20, pixels: [RED, GREEN, BLUE] })
    await sendChatReply(third.reply, TOOLER.modelName)
    await waitForValue(browser, 'sections after the second reply', async () => (await threadSections(browser)).length, 5)
  })
})
