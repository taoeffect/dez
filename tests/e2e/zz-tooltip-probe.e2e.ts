import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { elementCenter, movePointer, pointerClick, waitForValue } from './harness/dom'
import { makeConversation, seedConversation } from './harness/fixtures'
import { WEBM_VIDEO, openPlayerTooltips, shownPlayers, silentWav, startClipServer, waitForPlayerFullscreen, type ClipServer } from './harness/media'
import { startMockProviderApp, type MockProviderApp } from './harness/mockProviderApp'
import type { MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import { editorDoc, focusEditor, newTab, sbpCall, setCaret } from './harness/thread'

// THROWAWAY probe 2 for STEP-34.

const SPEAKER: MockProvider = { id: 'speaker', name: 'Speaker Mock', modelId: 'speak-model', modelName: 'Speak Model' }
const OUT = '/tmp/dez-step34'
const DRAG = { id: 'dragMouse', parameters: { pointerType: 'mouse' } } as const
const TOOLTIP = '.cm-content .media-player__clock + media-tooltip'

describe('tooltip probe 2', () => {
  let setup: MockProviderApp
  let clips: ClipServer
  let browser: E2EBrowser
  const facts: Record<string, unknown> = {}

  beforeAll(async () => {
    fs.mkdirSync(OUT, { recursive: true })
    clips = await startClipServer({
      'tone.wav': { type: 'audio/wav', bytes: silentWav(2) },
      'video.webm': { type: 'video/webm', bytes: WEBM_VIDEO },
    })
    setup = await startMockProviderApp(SPEAKER, { models: [{ id: SPEAKER.modelId, name: SPEAKER.modelName }] })
    browser = setup.browser
  })

  afterAll(async () => {
    fs.writeFileSync(path.join(OUT, 'probe2.json'), JSON.stringify(facts, null, 2))
    await setup?.stop()
    await clips?.stop()
  })

  const state = (): Promise<Record<string, unknown>> => browser.execute((tooltipSelector: string) => {
    const content = document.querySelector('.cm-content') as Element
    const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view
    const sel = getSelection()
    const active = document.activeElement
    const video = document.querySelector<HTMLVideoElement>('.cm-content .media-player__video')
    return {
      open: document.querySelector(tooltipSelector)?.hasAttribute('data-open') ?? null,
      selection: sel?.toString() ?? null,
      anchorIn: sel?.anchorNode ? (sel.anchorNode.parentElement?.className ?? '') : null,
      focusIn: sel?.focusNode ? ((sel.focusNode instanceof Element ? sel.focusNode : sel.focusNode.parentElement)?.className ?? '') : null,
      active: active ? `${active.tagName.toLowerCase()}.${active.className}` : null,
      editorSelection: `${view.state.selection.main.anchor}-${view.state.selection.main.head}`,
      hasFocus: view.hasFocus,
      paused: video ? video.paused : null,
      time: video ? video.currentTime : null,
      fullscreen: document.fullscreenElement?.localName ?? null,
    }
  }, TOOLTIP)

  const pause = async (ms: number): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, ms)
    await promise
  }

  // The stand-in for the planned code.
  const install = (): Promise<void> => browser.execute((tooltipSelector: string) => {
    const tooltip = document.querySelector(tooltipSelector) as HTMLElement
    Reflect.set(tooltip, 'disableHoverablePopup', false)
    if (!document.getElementById('probe-style')) {
      const style = document.createElement('style')
      style.id = 'probe-style'
      style.textContent = `
        .media-player__clock + .media-player__tooltip { pointer-events: auto; user-select: text; -webkit-user-select: text; }
        .media-player__clock + .media-player__tooltip::after { content: ''; position: absolute; left: 0; right: 0; height: calc(var(--media-tooltip-side-offset) + 2px); }
        .media-player__clock + .media-player__tooltip[data-side="top"]::after { top: 100%; }
        .media-player__clock + .media-player__tooltip[data-side="bottom"]::after { bottom: 100%; }
        .cm-content .media-player__clock + .media-player__tooltip ::selection { background-color: var(--color-selection, #d7d4f0) !important; }
      `
      document.head.appendChild(style)
    }
    const root = tooltip.closest('.dez-media') as HTMLElement
    const content = document.querySelector('.cm-content') as Element
    const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view
    let owed = false
    let textPress = false
    const log: string[] = []
    Reflect.set(window, '__probeLog', log)
    const giveBack = (): void => {
      if (owed && root.contains(document.activeElement)) view.focus()
      owed = false
    }
    const clamp = (): void => {
      const selection = getSelection()
      if (!selection || selection.rangeCount === 0) return
      const range = selection.getRangeAt(0)
      const startsInside = tooltip.contains(range.startContainer)
      const endsInside = tooltip.contains(range.endContainer)
      if (startsInside === endsInside) return
      const mode = Reflect.get(window, '__probeClamp') as string
      const texts = document.createTreeWalker(tooltip, NodeFilter.SHOW_TEXT)
      const first = texts.nextNode() as Text
      let last = first
      while (texts.nextNode()) last = texts.currentNode as Text
      if (mode === 'deep') {
        selection.setBaseAndExtent(
          startsInside ? range.startContainer : first, startsInside ? range.startOffset : 0,
          endsInside ? range.endContainer : last, endsInside ? range.endOffset : last.length,
        )
      } else {
        selection.setBaseAndExtent(
          startsInside ? range.startContainer : tooltip, startsInside ? range.startOffset : 0,
          endsInside ? range.endContainer : tooltip, endsInside ? range.endOffset : tooltip.childNodes.length,
        )
      }
      log.push(`clamped ${mode}: ${JSON.stringify(getSelection()?.toString())}`)
    }
    tooltip.addEventListener('mousedown', (event) => event.stopPropagation())
    root.addEventListener('pointerdown', (event) => {
      if (view.hasFocus) owed = true
      textPress = event.target instanceof Element && event.target.closest('media-tooltip') === tooltip
      if (!textPress) return
      const release = new AbortController()
      const end = (released: Event): void => {
        // Stands for the rule "no give-back at the end of a tooltip press"
        // of the root's own listeners.
        released.stopPropagation()
        release.abort()
        textPress = false
        if (Reflect.get(window, '__probeClamp')) clamp()
        log.push(`release open=${tooltip.hasAttribute('data-open')}`)
        if (!tooltip.hasAttribute('data-open')) giveBack()
      }
      window.addEventListener('pointerup', end, { capture: true, signal: release.signal })
      window.addEventListener('pointercancel', end, { capture: true, signal: release.signal })
    }, true)
    root.addEventListener('open-change', (event) => {
      const open = (event as CustomEvent<{ open: boolean, reason: string }>).detail
      log.push(`open-change ${(event.target as Element).className} ${JSON.stringify(open)}`)
      if (event.target !== tooltip || open.open || textPress) return
      giveBack()
    }, true)
  }, TOOLTIP)

  const tooltipRects = (): Promise<{
    clock: { left: number, right: number, top: number, bottom: number }
    tooltip: { left: number, right: number, top: number, bottom: number }
    side: string | null
    lines: { text: string, left: number, right: number, top: number, bottom: number }[]
    cursor: string
  }> => browser.execute((tooltipSelector: string) => {
    const tooltip = document.querySelector(tooltipSelector) as HTMLElement
    const clockRect = (tooltip.previousElementSibling as Element).getBoundingClientRect()
    const tooltipRect = tooltip.getBoundingClientRect()
    const lines = Array.from(tooltip.children, (child) => {
      const range = document.createRange()
      range.selectNodeContents(child)
      const [first] = Array.from(range.getClientRects())
      return { text: child.textContent ?? '', left: first.left, right: first.right, top: first.top, bottom: first.bottom }
    })
    return {
      clock: { left: clockRect.left, right: clockRect.right, top: clockRect.top, bottom: clockRect.bottom },
      tooltip: { left: tooltipRect.left, right: tooltipRect.right, top: tooltipRect.top, bottom: tooltipRect.bottom },
      side: tooltip.getAttribute('data-side'),
      lines,
      cursor: getComputedStyle(tooltip.children[1]).cursor,
    }
  }, TOOLTIP)

  const hoverClock = async (): Promise<void> => {
    await movePointer(browser, { x: 5, y: 5 })
    await pause(300)
    await movePointer(browser, await elementCenter(browser, '.media-player__clock'))
    await waitForValue(browser, 'tooltip open', async () => (await openPlayerTooltips(browser)).length, 1)
  }

  // From the clock's center straight up (or down) into the tooltip, then to
  // the point, in small steps. Opens the tooltip first when it is closed.
  const walkTo = async (to: { x: number, y: number }): Promise<boolean[]> => {
    if (!(await state()).open) await hoverClock()
    const from = await elementCenter(browser, '.media-player__clock')
    const rects = await tooltipRects()
    const edge = { x: from.x, y: rects.side === 'bottom' ? rects.tooltip.top + 5 : rects.tooltip.bottom - 5 }
    const open: boolean[] = []
    let at = from
    for (const stop of [edge, to]) {
      const steps = Math.ceil(Math.hypot(stop.x - at.x, stop.y - at.y) / 3)
      for (let step = 1; step <= steps; step++) {
        await movePointer(browser, { x: at.x + (stop.x - at.x) * step / steps, y: at.y + (stop.y - at.y) * step / steps })
        open.push((await state()).open as boolean)
      }
      at = stop
    }
    return open
  }

  const clicks = async (point: { x: number, y: number }, count: number): Promise<void> => {
    let action = browser.action('pointer', DRAG).move({ x: Math.round(point.x), y: Math.round(point.y), origin: 'viewport' })
    for (let i = 0; i < count; i++) action = action.down({ button: 0 }).up({ button: 0 })
    await action.perform()
    await pause(200)
  }

  const drag = async (label: string, from: { x: number, y: number }, to: { x: number, y: number }): Promise<void> => {
    let action = browser.action('pointer', DRAG).move({ x: Math.round(from.x), y: Math.round(from.y), origin: 'viewport' }).down({ button: 0 })
    const steps = 10
    for (let step = 1; step <= steps; step++) {
      action = action.move({ x: Math.round(from.x + (to.x - from.x) * step / steps), y: Math.round(from.y + (to.y - from.y) * step / steps), origin: 'viewport', duration: 20 })
    }
    await action.perform(true)
    await pause(150)
    facts[`${label}.held`] = await state()
    await browser.action('pointer', DRAG).up({ button: 0 }).perform()
    await pause(150)
    facts[`${label}.released`] = await state()
  }

  const middle = (rect: { left: number, right: number, top: number, bottom: number }): { x: number, y: number } => ({ x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 })

  it('audio: selection bounds, give-back, bottom side', async () => {
    await newTab(browser)
    const tempDir = path.join(setup.app.home, '.cache', 'dez', 'media')
    await fs.promises.mkdir(tempDir, { recursive: true })
    const tempPath = path.join(tempDir, 'kept-copy.wav')
    await fs.promises.writeFile(tempPath, silentWav(2))
    const expires = new Date(Date.now() + 3600_000).toISOString()
    const tag = `<dez:audio id="a" type="audio/wav" src="${tempPath}" expires="${expires}"/>`
    const filler = Array.from({ length: 60 }, (_, i) => `Line ${i}.`).join('\n\n')
    await seedConversation(setup.app.home, makeConversation({
      id: 'probe',
      title: 'probe',
      sections: [
        { role: 'user', nodes: [{ kind: 'text', text: 'Make clips and more text here' }] },
        { role: 'agent', nodes: [{ kind: 'text', text: `Some words before.\n\n${tag}\n\nSome words after.\n\n${filler}` }] },
        { role: 'user', nodes: [{ kind: 'text', text: '' }] },
      ],
    }))
    await sbpCall(browser, 'dez.model/tabs/openConversation', 'probe')
    await waitForValue(browser, 'player', async () => (await shownPlayers(browser))[0]?.seconds, 2)
    await install()
    await focusEditor(browser)
    await setCaret(browser, 5)

    await hoverClock()
    const rects = await tooltipRects()
    facts.rects = rects

    const pathLine = rects.lines[2]
    const pathY = (pathLine.top + pathLine.bottom) / 2
    const clock = middle(rects.clock)

    // Triple click on the path: no clamp, the clamp to the tooltip's end,
    // the clamp to the end of its last text.
    for (const mode of ['', 'shallow', 'deep']) {
      await browser.execute((value: string) => { Reflect.set(window, '__probeClamp', value) }, mode)
      const point = { x: pathLine.left + 20, y: pathY }
      facts[`walk.${mode}`] = (await walkTo(point)).every(Boolean)
      await clicks(point, 3)
      facts[`triple.${mode}`] = await state()
    }

    // A drag from the path straight down, over the bridge, to the clock.
    await walkTo({ x: clock.x, y: pathY })
    await drag('dragDown', { x: clock.x, y: pathY }, clock)

    // A doc change while the selection is in the tooltip.
    await walkTo({ x: pathLine.left + 1, y: pathY })
    await drag('dragPath', { x: pathLine.left + 1, y: pathY }, { x: pathLine.right - 1, y: pathY })
    await browser.execute(() => {
      const content = document.querySelector('.cm-content') as Element
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view
      view.dispatch({ changes: { from: view.state.doc.length, insert: 'Z' } })
    })
    await pause(200)
    facts.afterDocChange = await state()

    // A drag that leaves the tooltip on the right: held there, then
    // released there.
    await drag('dragOut', { x: pathLine.left + 1, y: pathY }, { x: rects.tooltip.right + 60, y: pathY })
    await pause(300)
    facts.afterDragOut = await state()
    await browser.keys('X')
    await pause(100)
    facts.docAfterKey = (await editorDoc(browser)).slice(0, 12)
    facts.afterKey = await state()

    // Escape with the focus on the card.
    await walkTo({ x: pathLine.left + 30, y: pathY })
    await clicks({ x: pathLine.left + 30, y: pathY }, 2)
    facts.beforeEscape = await state()
    await browser.keys('Escape')
    await pause(300)
    facts.afterEscape = await state()
    facts.logBeforeDiagonal = await browser.execute(() => (Reflect.get(window, '__probeLog') as string[]).filter((line) => !line.startsWith('open-change')))

    // A diagonal move from the clock to the start of the path, which leaves
    // the clock through its side: with no close delay, and with one.
    for (const delay of [0, 150]) {
      await browser.execute((selector: string, ms: number) => { Reflect.set(document.querySelector(selector) as Element, 'closeDelay', ms) }, TOOLTIP, delay)
      for (const stepMs of [5, 40]) {
        await hoverClock()
        const from = await elementCenter(browser, '.media-player__clock')
        const to = { x: pathLine.left + 5, y: (pathLine.top + pathLine.bottom) / 2 }
        const steps = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 4)
        let action = browser.action('pointer', DRAG).move({ x: from.x, y: from.y, origin: 'viewport' })
        for (let step = 1; step <= steps; step++) {
          action = action.move({ x: Math.round(from.x + (to.x - from.x) * step / steps), y: Math.round(from.y + (to.y - from.y) * step / steps), origin: 'viewport', duration: stepMs })
        }
        const start = Date.now()
        await action.perform()
        facts[`diagonal.${delay}.${stepMs}.ms`] = Date.now() - start
        await pause(400)
        facts[`diagonal.${delay}.${stepMs}`] = (await state()).open
      }
    }
    // From the clock to the Save control, with the close delay.
    await hoverClock()
    await movePointer(browser, await elementCenter(browser, '.media-player__save'))
    facts.toSaveAtOnce = await openPlayerTooltips(browser)
    await pause(500)
    facts.toSaveLater = await openPlayerTooltips(browser)

    // The tooltip below: the player at the top of the viewport.
    await movePointer(browser, { x: 5, y: 5 })
    await pause(300)
    await browser.execute(() => {
      const scroller = document.querySelector('.cm-scroller') as HTMLElement
      const clock = document.querySelector('.cm-content .media-player__clock') as HTMLElement
      scroller.scrollTop += clock.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 4
    })
    await pause(300)
    await hoverClock()
    const below = await tooltipRects()
    facts.below = below
    const belowLine = below.lines[2]
    facts.walkBelow = await walkTo({ x: belowLine.left + 20, y: (belowLine.top + belowLine.bottom) / 2 })
    await browser.saveScreenshot(path.join(OUT, 'below.png'))
    facts.log = await browser.execute(() => Reflect.get(window, '__probeLog'))
  })

  it('video: over the picture and in fullscreen', async () => {
    await newTab(browser)
    const url = clips.clipUrl('video.webm')
    const expires = new Date(Date.now() + 3600_000).toISOString()
    const tag = `<dez:video id="a" type="video/webm" src="${url}" url="${url}" expires="${expires}"/>`
    await seedConversation(setup.app.home, makeConversation({
      id: 'probe-video',
      title: 'probe-video',
      sections: [
        { role: 'user', nodes: [{ kind: 'text', text: 'Make clips and more text here' }] },
        { role: 'agent', nodes: [{ kind: 'text', text: tag }] },
        { role: 'user', nodes: [{ kind: 'text', text: '' }] },
      ],
    }))
    await sbpCall(browser, 'dez.model/tabs/openConversation', 'probe-video')
    await waitForValue(browser, 'player', async () => (await shownPlayers(browser))[0]?.seconds, 2)
    await install()
    await focusEditor(browser)
    await setCaret(browser, 5)

    for (const mode of ['window', 'fullscreen']) {
      if (mode === 'fullscreen') {
        await pointerClick(browser, '.media-player__fullscreen')
        await waitForPlayerFullscreen(browser, true)
      }
      await hoverClock()
      const rects = await tooltipRects()
      facts[`video.${mode}.rects`] = rects
      facts[`video.${mode}.videoRect`] = await browser.execute(() => {
        const rect = (document.querySelector('.cm-content .media-player__video') as Element).getBoundingClientRect()
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
      })
      const line = rects.lines[1]
      const point = { x: line.left + 20, y: (line.top + line.bottom) / 2 }
      facts[`video.${mode}.walk`] = (await walkTo(point)).every(Boolean)
      facts[`video.${mode}.before`] = await state()
      await clicks(point, 1)
      facts[`video.${mode}.click`] = await state()
      await clicks(point, 2)
      facts[`video.${mode}.double`] = await state()
      await drag(`video.${mode}.drag`, { x: line.left + 1, y: point.y }, { x: line.right - 1, y: point.y })
      await browser.saveScreenshot(path.join(OUT, `video-${mode}.png`))
      await movePointer(browser, { x: rects.tooltip.left - 40, y: rects.tooltip.top - 40 })
      await pause(500)
      facts[`video.${mode}.left`] = await state()
    }
    facts.videoLog = await browser.execute(() => Reflect.get(window, '__probeLog'))
  })
})
