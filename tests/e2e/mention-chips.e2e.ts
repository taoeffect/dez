import type { EditorView } from '@codemirror/view'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { startApp, type RunningApp } from './harness/app'
import { clearOpenedUrls, consoleErrors, elementCenter, movePointer, openedUrls, pointerClickAt, pointerShiftClickAt, resetConsoleErrors, screenshotOnFailure, stopOpenUrl, typeInto, typeKeys, waitFor, waitForValue } from './harness/dom'
import { FIND_FIELD } from './harness/find'
import { appFilePath, seedAppState, writeTestFile } from './harness/fixtures'
import { pasteImageReference, shownImages, solidPng } from './harness/images'
import { silentWav, tempClipTag } from './harness/media'
import { assetInView, flashedAssets, pressMention, recordFlashes } from './harness/mentions'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { docPos, docPosPoint, editorDoc, editorScrollTop, editorSelection, focusEditor, focusedArea, misplacedLines, newTab, openSeededConversation, sbpCall, scrollEditorToEnd, scrollEditorToTop, setCaret, threadSections } from './harness/thread'
import { hidingPart, intermediateInvokeBlock, intermediateParts, toolChips } from './harness/toolChips'

// The chips of `@id` mentions in the thread editor, driven through the
// real app.
//
// A mention that names an image or a clip of its own or an earlier section
// shows as a chip (a fill behind the text, in the mention color), in user
// and agent sections. A word that names no asset (`@zz`, `@a-team`) stays
// plain text. Resting the pointer on a chip shows the asset that it names
// in a box next to the chip, where the asset works as at its place. The
// box stays while the pointer goes from the chip onto it, and Escape
// closes it. A chip changes no layout: the text keeps its place when the
// chip comes or goes.
// A find match shows in place of the part of a chip that it covers.
//
// A plain click on a chip goes to the asset that it names: the editor
// opens the tool call chip that hides it, scrolls it into view, and
// flashes a ring around it. The click changes no text, no selection, and
// no focus. A change that deletes the asset while it flashes ends the
// jump. A press on a link inside a chip opens the link.
//
// One app session serves the whole file. Each test has its own tab. The
// spec stops every `dez.controller/openUrl` call (`stopOpenUrl`).

const PNG = solidPng(40, 24, [220, 60, 40])

// Lines enough that CM does not draw what is above them while the end of
// the doc is in view.
const FILLER = Array.from({ length: 150 }, (_, line) => `Line ${line + 1}.`).join('\n')

// Longer than the grace time after which the box closes once the pointer
// is off the chip, the box, and the gap between them (assetPreview.ts).
const PAST_GRACE_MS = 400

interface Box {
  left: number
  top: number
  width: number
  height: number
}

interface ChipPart {
  text: string
  fill: boolean
  ownColor: boolean
}

// A mention that shows as a chip: a fill, and the mention color.
const WHOLE_CHIP: ChipPart = { text: '@a', fill: true, ownColor: true }

describe('mention chips', () => {
  let app: RunningApp
  let browser: E2EBrowser

  // The text of each chip that the editor draws, in doc order.
  async function chips (): Promise<string[]> {
    return browser.execute(() => Array.from(document.querySelectorAll('.cm-content .dez-mention'), (chip) => chip.textContent ?? ''))
  }

  // The parts of the mentions that the editor draws, in doc order, each
  // with its look: whether it has a fill, and whether its color is another
  // one than the color of its line's text. A mention is one part, except
  // where a find match cuts it.
  async function chipParts (): Promise<ChipPart[]> {
    return browser.execute(() => Array.from(document.querySelectorAll('.cm-content .dez-mention'), (part) => {
      const line = part.closest('.cm-line')
      if (!line) throw new Error('chipParts: a mention is in no line')
      const style = getComputedStyle(part)
      return { text: part.textContent ?? '', fill: style.backgroundColor !== 'rgba(0, 0, 0, 0)', ownColor: style.color !== getComputedStyle(line).color }
    }))
  }

  // The box of the chip at `index` (doc order).
  async function chipBox (index: number): Promise<Box> {
    return browser.execute((at: number) => {
      const chip = document.querySelectorAll('.cm-content .dez-mention')[at]
      if (!chip) throw new Error(`chipBox: no chip ${at}`)
      const { left, top, width, height } = chip.getBoundingClientRect()
      return { left, top, width, height }
    }, index)
  }

  // Moves the pointer onto the chip at `index`.
  async function hoverChip (index: number): Promise<void> {
    const box = await chipBox(index)
    await movePointer(browser, { x: box.left + box.width / 2, y: box.top + box.height / 2 })
  }

  // What the preview box of a chip shows, once it is in its place: `image
  // <file name>`, or `<kind> player`; null when no box shows.
  async function previewAsset (): Promise<string | null> {
    return browser.execute(() => {
      const box = document.querySelector<HTMLElement>('.dez-asset-preview[data-shown]')
      if (!box || box.getAnimations().length > 0) return null
      const image = box.querySelector<HTMLImageElement>('.dez-image__img')
      const player = box.querySelector<HTMLElement>('.media-player')
      if (image) return `image ${image.alt}`
      return player ? `${player.dataset.kind ?? ''} player` : 'nothing'
    })
  }

  // The box of the preview, and whether it is in the text of the editor.
  async function previewPlace (): Promise<Box & { inText: boolean }> {
    return browser.execute(() => {
      const box = document.querySelector('.dez-asset-preview[data-shown]')
      if (!box) throw new Error('previewPlace: no preview box shows')
      const { left, top, width, height } = box.getBoundingClientRect()
      return { left, top, width, height, inText: box.closest('.cm-content') !== null }
    })
  }

  // The box of the editor line whose text starts with `start`.
  async function lineBox (start: string): Promise<Box> {
    return browser.execute((wanted: string) => {
      const line = Array.from(document.querySelectorAll('.cm-content .cm-line')).find((el) => (el.textContent ?? '').startsWith(wanted))
      if (!line) throw new Error(`lineBox: no line starts with ${JSON.stringify(wanted)}`)
      const { left, top, width, height } = line.getBoundingClientRect()
      return { left, top, width, height }
    }, start)
  }

  // The places that tell a move of text: the box of each line whose text
  // starts with one of `lineStarts`, and the x of each doc position of
  // `positions`, in tenths of a px. (WebKit measures a char some thousandths
  // of a px off when a find match cuts its text node; a chip that takes
  // room moves text by whole px.)
  async function textLayout (lineStarts: string[], positions: number[]): Promise<{ boxes: Box[], xs: number[] }> {
    const boxes: Box[] = []
    for (const start of lineStarts) boxes.push(await lineBox(start))
    const xs: number[] = []
    for (const pos of positions) xs.push(Math.round((await docPosPoint(browser, pos, 1)).x * 10))
    return { boxes, xs }
  }

  // The image `name` as a stored file, as its reference with the id `a`.
  async function storedImage (name: string): Promise<string> {
    return `![id=a](${await writeTestFile(appFilePath(app.home, 'assets', 'images', name), PNG)})`
  }

  beforeAll(async () => {
    app = await startApp()
    try {
      await seedAppState(app.home)
      browser = await createSession(app.binary, app.port)
    } catch (err) {
      await app.stop()
      throw err
    }
    await waitFor(browser, 'header.tab-bar', 60_000)
    await stopOpenUrl(browser)
  })

  // Errors thrown inside CodeMirror plugins are only logged, so the page
  // records console.error calls and each test checks the record.
  beforeEach(async () => {
    await resetConsoleErrors(browser)
    await clearOpenedUrls(browser)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    if (ctx.task.result?.state === 'fail') return
    expect(await consoleErrors(browser)).toEqual([])
  })

  afterAll(async () => {
    if (browser) await destroySession(browser)
    await app?.stop()
  })

  it('gives a mention its chip as soon as the tab has the image that it names, and no chip to a word that names nothing', async () => {
    await newTab(browser)
    await focusEditor(browser)
    await typeKeys(browser, 'Make @a.foo red and @a, hello, not @zz or @a-team. ')
    // No image yet: `@a` names nothing.
    expect(await chips()).toEqual([])

    // A chip ends after the id: the `.foo` and the `,` are outside it.
    await pasteImageReference(browser, PNG, 'a')
    await waitForValue(browser, 'the chips of the mentions that were there', chips, ['@a', '@a'])
    await typeKeys(browser, ' Then @a')
    await waitForValue(browser, 'the chip of the typed mention', chips, ['@a', '@a', '@a'])
    expect(await chipParts()).toEqual([WHOLE_CHIP, WHOLE_CHIP, WHOLE_CHIP])

    // The mention is plain text: Backspace takes one char, and the chip
    // goes with the id.
    await browser.keys(Key.Backspace)
    await waitForValue(browser, 'the chips after Backspace', chips, ['@a', '@a'])
    expect((await threadSections(browser))[0].text.endsWith(' Then @')).toBe(true)
  })

  it('shows chips in user and agent sections for the assets of earlier sections, and a box with the asset that a chip names', async () => {
    const image = await storedImage('mention-roles.png')
    const clip = await tempClipTag(app.home, 'audio', 'b', 'mention-roles.wav', silentWav(1))
    await openSeededConversation(browser, app.home, 'mention-chips-roles', [
      // `@b` names a clip of a later section: no chip.
      { role: 'user', text: `Use @a and @b.\n${image}` },
      { role: 'agent', text: `I made @a brighter.\n${clip}` },
      { role: 'user', text: 'Now mix @b under @a, not @c.' },
    ])
    await waitForValue(browser, 'chips', chips, ['@a', '@a', '@b', '@a'])

    // The agent section's chip: the box shows the image next to the chip,
    // not over it, and outside the text of the editor.
    await hoverChip(1)
    await waitForValue(browser, 'the box of an image mention', previewAsset, 'image mention-roles.png')
    const box = await previewPlace()
    const chip = await chipBox(1)
    expect(box.top + box.height <= chip.top || box.top >= chip.top + chip.height).toBe(true)
    expect(box.inText).toBe(false)

    // While a box shows, another chip shows its own box, and its clip plays
    // there.
    await hoverChip(2)
    await waitForValue(browser, 'the box of a clip mention', previewAsset, 'audio player')
    await pointerClickAt(browser, await elementCenter(browser, '.dez-asset-preview .media-player__play'))
    await waitForValue(browser, 'the clip played in the box', () => browser.execute(() => (document.querySelector<HTMLMediaElement>('.dez-asset-preview audio')?.played.length ?? 0) > 0), true)

    await movePointer(browser, await elementCenter(browser, 'header.tab-bar'))
    await waitForValue(browser, 'no box off the chips', previewAsset, null)
  })

  it('shows the box below a chip at the top and above a chip at the end, keeps it while the pointer goes onto it, and closes it on Escape or a press on its chip', async () => {
    const image = `![id=a](${await writeTestFile(appFilePath(app.home, 'assets', 'images', 'mention-box.png'), solidPng(240, 120, [40, 90, 220]))})`
    await openSeededConversation(browser, app.home, 'mention-chips-box', [
      { role: 'user', text: `See @a here.\n${image}\n${FILLER}\nAnd @a at the end.` },
    ])
    await focusEditor(browser)
    // The side of the box from the chip `index` that CM draws: 'above' or
    // 'below'.
    const side = async (index: number): Promise<string> => {
      const box = await previewPlace()
      const chip = await chipBox(index)
      if (box.top + box.height <= chip.top) return 'above'
      return box.top >= chip.top + chip.height ? 'below' : 'over'
    }
    // The text of the line of each chip that CM draws. A scroll draws the
    // chip of the other end a frame later, and CM keeps the line of the
    // caret (at the top) drawn.
    const chipLines = (): Promise<string[]> => browser.execute(() => Array.from(
      document.querySelectorAll('.cm-content .dez-mention'),
      (chip) => chip.closest('.cm-line')?.textContent ?? '',
    ))

    await scrollEditorToTop(browser)
    await waitForValue(browser, 'the chip at the top', chipLines, ['See @a here.'])
    await hoverChip(0)
    await waitForValue(browser, 'the box of the chip at the top', previewAsset, 'image mention-box.png')
    expect(await side(0)).toBe('below')
    await movePointer(browser, await elementCenter(browser, 'header.tab-bar'))
    await waitForValue(browser, 'no box off the chip', previewAsset, null)

    await scrollEditorToEnd(browser)
    await waitForValue(browser, 'the chip at the end', async () => (await chipLines()).at(-1), 'And @a at the end.')
    const end = (await chipLines()).length - 1
    await hoverChip(end)
    await waitForValue(browser, 'the box of the chip at the end', previewAsset, 'image mention-box.png')
    expect(await side(end)).toBe('above')
    const box = await previewPlace()
    const chip = await chipBox(end)

    // The pointer rests in the gap between the chip and the box, past the
    // grace time, then goes on onto the image in the box.
    const gapY = (box.top + box.height + chip.top) / 2
    await movePointer(browser, { x: chip.left + chip.width / 2, y: gapY })
    await browser.pause(PAST_GRACE_MS)
    expect(await previewAsset()).toBe('image mention-box.png')
    await movePointer(browser, await elementCenter(browser, '.dez-asset-preview .dez-image__img'))
    await browser.pause(PAST_GRACE_MS)
    expect(await previewAsset()).toBe('image mention-box.png')

    // The actions of the image's toolbar are at its top right, as far in
    // from the top as from the right, with the magnifier first.
    await waitForValue(browser, 'the toolbar of the image in the box', () => browser.execute(() => {
      const actions = document.querySelector('.dez-asset-preview .dez-image__actions')
      return actions !== null && getComputedStyle(actions).opacity === '1' && getComputedStyle(actions).transform === 'none'
    }), true)
    const corner = await browser.execute(() => {
      const image = document.querySelector('.dez-asset-preview .dez-image__img')?.getBoundingClientRect()
      const actions = document.querySelector('.dez-asset-preview .dez-image__actions')
      const place = actions?.getBoundingClientRect()
      if (!image || !actions || !place) throw new Error('the box has no image, or no actions')
      return { top: Math.round(place.top - image.top), right: Math.round(image.right - place.right), first: actions.firstElementChild?.classList.contains('dez-image__zoom') ?? false }
    })
    expect(corner.top).toBeGreaterThan(0)
    expect(corner.right).toBe(corner.top)
    expect(corner.first).toBe(true)

    // The magnifier shows the image of the box in the zoom, over the box,
    // which stays under it until the zoom closes.
    await pointerClickAt(browser, await elementCenter(browser, '.dez-asset-preview .dez-image__zoom'))
    await waitFor(browser, '.dez-image-zoom .dez-image-zoom__img')
    await browser.pause(PAST_GRACE_MS)
    expect(await previewAsset()).toBe('image mention-box.png')
    await browser.keys(Key.Escape)
    await waitForValue(browser, 'no zoom after Escape', () => browser.execute(() => document.querySelector('.dez-image-zoom') === null), true)
    expect(await previewAsset()).toBe('image mention-box.png')

    // Escape in the editor closes the box, and only the box.
    expect(await focusedArea(browser)).toBe('editor')
    const doc = await editorDoc(browser)
    await browser.keys(Key.Escape)
    await waitForValue(browser, 'no box after Escape', previewAsset, null)
    expect(await editorDoc(browser)).toBe(doc)
    expect(await focusedArea(browser)).toBe('editor')

    // A press on the chip closes its box, and the jump still goes.
    await hoverChip(end)
    await waitForValue(browser, 'the box again', previewAsset, 'image mention-box.png')
    await recordFlashes(browser)
    await pressMention(browser, end)
    await waitForValue(browser, 'no box after the press', previewAsset, null)
    await waitForValue(browser, 'the image in view', () => assetInView(browser, 'a'), true)
    await waitForValue(browser, 'the flash of the image', () => flashedAssets(browser), ['image a'])
  })

  it('changes no layout: the text keeps its place when a chip goes', async () => {
    const image = await storedImage('mention-layout.png')
    await openSeededConversation(browser, app.home, 'mention-chips-layout', [
      { role: 'user', text: `Put (@a) here, please.\nSecond line.\n${image}` },
    ])
    await waitForValue(browser, 'the chip', chips, ['@a'])
    await waitForValue(browser, 'the image', async () => (await shownImages(browser)).length, 1)

    // The boxes of the mention's line and of the line below it, and the x
    // of the mention's start, of its end, and of the last char of its line.
    const from = await docPos(browser, '@a')
    const layout = async () => textLayout(['Put', 'Second'], [from, from + 2, await docPos(browser, '\nSecond', -1)])
    const withChip = await layout()
    expect(await misplacedLines(browser)).toEqual([])

    // Backspace after the image takes its `)`: the reference is plain text
    // then, so `@a` names nothing. The image is below the two lines, so its
    // change of height moves neither.
    await focusEditor(browser)
    await setCaret(browser, (await editorDoc(browser)).length)
    await browser.keys(Key.Backspace)
    await waitForValue(browser, 'no chip', chips, [])

    expect(await layout()).toEqual(withChip)
    expect(await misplacedLines(browser)).toEqual([])
  })

  it('shows a find match in place of the part of a chip that it covers, and moves no text', async () => {
    const image = await storedImage('mention-find.png')
    await openSeededConversation(browser, app.home, 'mention-chips-find', [
      { role: 'user', text: `Put (@a) here.\n${image}` },
    ])
    await waitForValue(browser, 'the chip', chipParts, [WHOLE_CHIP])
    const from = await docPos(browser, '@a')
    const layout = async () => textLayout(['Put'], [from, from + 1, from + 2, from + 8])
    const withChip = await layout()

    // The only "a" of the text is the id: the match takes the chip of the
    // id, and the "@" keeps its part of the chip.
    await sbpCall(browser, 'dez.editor/openFind')
    await typeInto(browser, FIND_FIELD, 'a', { clear: true })
    await waitForValue(browser, 'the parts with a match on the id', chipParts, [
      { text: '@', fill: true, ownColor: true },
      { text: 'a', fill: false, ownColor: false },
    ])
    expect(await layout()).toEqual(withChip)

    await typeInto(browser, FIND_FIELD, '@a', { clear: true })
    await waitForValue(browser, 'the mention in a match', chipParts, [{ text: '@a', fill: false, ownColor: false }])
    expect(await layout()).toEqual(withChip)

    await browser.keys(Key.Escape)
    await waitForValue(browser, 'the chip after find', chipParts, [WHOLE_CHIP])
    expect(await layout()).toEqual(withChip)
  })

  it('goes to the image or the clip that a chip names and flashes it, and leaves the text, the selection, and the focus alone', async () => {
    const image = await storedImage('mention-jump.png')
    const clip = await tempClipTag(app.home, 'audio', 'b', 'mention-jump.wav', silentWav(1))
    await openSeededConversation(browser, app.home, 'mention-chips-jump', [
      { role: 'user', text: `The picture:\n${image}\nThe sound:\n${clip}` },
      { role: 'agent', text: FILLER },
      { role: 'user', text: 'Compare @a with @b.' },
    ])
    await focusEditor(browser)
    const from = await docPos(browser, 'Compare')
    await setCaret(browser, from, from + 'Compare'.length)
    const doc = await editorDoc(browser)
    const selection = await editorSelection(browser)

    for (const [index, id, flashed] of [[0, 'a', 'image a'], [1, 'b', 'player b']] as const) {
      await scrollEditorToEnd(browser)
      await waitForValue(browser, 'the chips at the end', chips, ['@a', '@b'])
      expect(await assetInView(browser, id)).toBe(false)

      await recordFlashes(browser)
      await pressMention(browser, index)
      await waitForValue(browser, `${flashed} in view`, () => assetInView(browser, id), true)
      await waitForValue(browser, `the flash of ${flashed}`, () => flashedAssets(browser), [flashed])
      expect(await editorDoc(browser)).toBe(doc)
      expect(await editorSelection(browser)).toEqual(selection)
      expect(await focusedArea(browser)).toBe('editor')
    }
  })

  it('opens the closed chip of the tool call that hides the image, and shows and flashes the image in its panel', async () => {
    const jobId = 'j-mtn1'
    const stored = await writeTestFile(appFilePath(app.home, 'assets', 'generated', 'images', 'mention-hidden.png'), PNG)
    const reply = [
      intermediateInvokeBlock('call_mention', jobId),
      `![id=a|tool=model_invoke|hidden=${jobId}](${stored})`,
      FILLER,
    ].join('\n\n')
    await openSeededConversation(browser, app.home, 'mention-chips-hidden', [
      { role: 'user', text: 'Make a draft' },
      { role: 'agent', text: reply },
      { role: 'user', text: 'Use @a.' },
    ])
    await scrollEditorToTop(browser)
    await waitForValue(browser, 'the closed chip that hides the image', () => intermediateParts(browser), [hidingPart('image')])
    expect(await shownImages(browser)).toStrictEqual([])
    await scrollEditorToEnd(browser)
    await waitForValue(browser, 'the chip', chips, ['@a'])

    const focus = await focusedArea(browser)
    await recordFlashes(browser)
    await pressMention(browser, 0)
    await waitForValue(browser, 'the open chip', async () => (await toolChips(browser)).map(({ open }) => open), [true])
    await waitForValue(browser, 'the image in the panel', () => shownImages(browser), [{ alt: 'mention-hidden.png', width: 40, height: 24 }])
    await waitForValue(browser, 'the image in view', () => assetInView(browser, 'a'), true)
    expect(await flashedAssets(browser)).toEqual(['image a'])
    expect(await focusedArea(browser)).toBe(focus)
  })

  it('ends a jump when a change deletes the asset, so the asset that then starts at its place does not flash', async () => {
    const image = await storedImage('mention-deleted.png')
    const next = `![id=c](${await writeTestFile(appFilePath(app.home, 'assets', 'images', 'mention-next.png'), PNG)})`
    await openSeededConversation(browser, app.home, 'mention-chips-deleted', [
      { role: 'user', text: `${image}\n${next}\nSee @a.` },
    ])
    await waitForValue(browser, 'the chip', chips, ['@a'])

    await recordFlashes(browser)
    await pressMention(browser, 0)
    // In the frame of the flash, so that the jump still runs: a program
    // change (no user event, as the Delete of a clip) removes the line of
    // the image. The next image then starts where the image started.
    await browser.execute((line: string) => new Promise<void>((resolve) => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('.cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      const removeOnFlash = () => {
        if (!(Reflect.get(window, '__e2eFlashes') as string[]).includes('image a')) {
          requestAnimationFrame(removeOnFlash)
          return
        }
        const from = view.state.doc.toString().indexOf(line)
        view.dispatch({ changes: { from, to: from + line.length } })
        resolve()
      }
      removeOnFlash()
    }), `${image}\n`)
    expect(await editorDoc(browser)).not.toContain(image)
    expect(await flashedAssets(browser)).toEqual(['image a'])
  })

  it('leaves a press on a link in a chip and a Shift+click to the editor, and does not move an asset in view', async () => {
    const image = await storedImage('mention-link.png')
    await openSeededConversation(browser, app.home, 'mention-chips-link', [
      { role: 'user', text: `${image}\nSee [the draft @a](https://example.com/a) or @a, then stop.` },
    ])
    await waitForValue(browser, 'the chips', chips, ['@a', '@a'])
    await waitForValue(browser, 'the image in view', () => assetInView(browser, 'a'), true)
    await focusEditor(browser)
    const end = (await editorDoc(browser)).length
    await setCaret(browser, end)
    const scrollTop = await editorScrollTop(browser)

    // The image is in view: the click flashes it and scrolls nothing.
    await recordFlashes(browser)
    await pressMention(browser, 1)
    await waitForValue(browser, 'the flash', () => flashedAssets(browser), ['image a'])
    expect(await editorScrollTop(browser)).toBe(scrollTop)
    expect(await editorSelection(browser)).toEqual({ anchor: end, head: end })

    await recordFlashes(browser)
    await pressMention(browser, 0)
    await waitForValue(browser, 'the opened link', () => openedUrls(browser), ['https://example.com/a'])
    expect(await flashedAssets(browser)).toEqual([])
    expect(await editorSelection(browser)).toEqual({ anchor: end, head: end })

    // A Shift+click selects to the place of the press, as on other text.
    const mention = (await editorDoc(browser)).lastIndexOf('@a')
    await pointerShiftClickAt(browser, await docPosPoint(browser, mention + 1, 1))
    await waitForValue(browser, 'the selection of the Shift+click', () => editorSelection(browser), { anchor: end, head: mention + 1 })
    expect(await flashedAssets(browser)).toEqual([])
    expect(await focusedArea(browser)).toBe('editor')
  })
})
