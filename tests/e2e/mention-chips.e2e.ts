import type { EditorView } from '@codemirror/view'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { startApp, type RunningApp } from './harness/app'
import { clearOpenedUrls, consoleErrors, elementCenter, movePointer, openedUrls, pointerShiftClickAt, resetConsoleErrors, screenshotOnFailure, stopOpenUrl, typeInto, typeKeys, waitFor, waitForValue } from './harness/dom'
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
// plain text. Hovering a chip shows what it names in a tooltip. A chip
// changes no layout: the text keeps its place when the chip comes or goes.
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
const IMAGE_TOOLTIP = {
  title: 'Image id: a',
  text: 'This names the image a. A chat model sees an image of a reply only when one of your messages names it. A model that makes images or clips gets an older image only when your newest message names it.',
}
const AUDIO_TOOLTIP = {
  title: 'Audio id: b',
  text: 'This names the audio clip b. A model that takes audio gets an older clip only when your newest message names it. A chat model gets only the id.',
}

// Lines enough that CM does not draw what is above them while the end of
// the doc is in view.
const FILLER = Array.from({ length: 150 }, (_, line) => `Line ${line + 1}.`).join('\n')

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

  // The open tooltip of a chip, with the place of its bottom edge, or null
  // when none is open.
  async function tooltip (): Promise<{ title: string, text: string, bottom: number } | null> {
    return browser.execute(() => {
      const tip = document.querySelector('.cm-tooltip-hover .dez-image-tooltip')
      if (!tip) return null
      return {
        title: tip.querySelector('.dez-image-tooltip__title')?.textContent ?? '',
        text: tip.querySelector('.dez-image-tooltip__text')?.textContent ?? '',
        bottom: tip.getBoundingClientRect().bottom,
      }
    })
  }

  // The title and the text of the open tooltip.
  async function tooltipText (): Promise<{ title: string, text: string } | null> {
    const tip = await tooltip()
    return tip && { title: tip.title, text: tip.text }
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
    return `![${await writeTestFile(appFilePath(app.home, 'assets', 'images', name), PNG)}](id=a)`
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

  it('shows chips in user and agent sections for the assets of earlier sections, with a tooltip that tells what each one names', async () => {
    const image = await storedImage('mention-roles.png')
    const clip = await tempClipTag(app.home, 'audio', 'b', 'mention-roles.wav', silentWav(1))
    await openSeededConversation(browser, app.home, 'mention-chips-roles', [
      // `@b` names a clip of a later section: no chip.
      { role: 'user', text: `Use @a and @b.\n${image}` },
      { role: 'agent', text: `I made @a brighter.\n${clip}` },
      { role: 'user', text: 'Now mix @b under @a, not @c.' },
    ])
    await waitForValue(browser, 'chips', chips, ['@a', '@a', '@b', '@a'])

    // The agent section's chip.
    await hoverChip(1)
    await waitForValue(browser, 'the tooltip of an image mention', tooltipText, IMAGE_TOOLTIP)
    // Above the chip, so the pointer does not cover it.
    expect((await tooltip())?.bottom).toBeLessThanOrEqual((await chipBox(1)).top)

    await hoverChip(2)
    await waitForValue(browser, 'the tooltip of a clip mention', tooltipText, AUDIO_TOOLTIP)

    await movePointer(browser, await elementCenter(browser, 'header.tab-bar'))
    await waitForValue(browser, 'no tooltip off the chips', tooltipText, null)
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
      `![${stored}](id=a|tool=model_invoke|hidden=${jobId})`,
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
    const next = `![${await writeTestFile(appFilePath(app.home, 'assets', 'images', 'mention-next.png'), PNG)}](id=c)`
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
