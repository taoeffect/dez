import { pointerClickAt, waitForValue, type Point } from './dom'
import type { E2EBrowser } from './session'

// The mention chips of the active editor (src/view/editor/mentions.ts), and
// what a click on one does (src/view/editor/assetJump.ts): it scrolls the
// asset that the chip names into view and flashes it. Each image and player
// is named here by its kind and the text of its id badge: `image a`,
// `player b`.

/** Presses the mention chip `index` (doc order) with a pointer click. CM
 *  draws only the lines near its view, so the chip must be drawn. The
 *  press waits until two reads, one poll interval apart, give the chip the
 *  same place: an image above it can still load and move it. */
export async function pressMention (browser: E2EBrowser, index: number): Promise<void> {
  // Not `let point: Point | null = null`: TypeScript would take it for null
  // after the callback, which it does not see assign.
  let point = null as Point | null
  await waitForValue(browser, `settled place of mention ${index}`, async () => {
    const last = point
    point = await browser.execute((at: number) => {
      const chip = document.querySelectorAll('.cm-content .dez-mention')[at]
      if (!chip) throw new Error(`pressMention: no mention chip ${at}`)
      const { left, top, width, height } = chip.getBoundingClientRect()
      return { x: left + width / 2, y: top + height / 2 }
    }, index)
    return last !== null && point.x === last.x && point.y === last.y
  }, true)
  await pointerClickAt(browser, point as Point)
}

/** Starts a new record of the flashes of the active editor. A flash shows
 *  for a second only, so a `MutationObserver` records each image and player
 *  that gets the flash attribute, and `flashedAssets` reads the record. */
export async function recordFlashes (browser: E2EBrowser): Promise<void> {
  await browser.execute(() => {
    const content = document.querySelector('.cm-content')
    if (!content) throw new Error('recordFlashes: .cm-content not found')
    const flashes: string[] = []
    Reflect.set(window, '__e2eFlashes', flashes)
    ;(Reflect.get(window, '__e2eFlashObserver') as MutationObserver | undefined)?.disconnect()
    const observer = new MutationObserver((records) => {
      for (const { target } of records) {
        if (!(target instanceof Element) || !target.hasAttribute('data-flash')) continue
        const image = target.classList.contains('dez-image')
        const badge = target.querySelector(image ? '.dez-image__id' : '.media-player__id-text')
        flashes.push(`${image ? 'image' : 'player'} ${badge?.textContent?.trim() ?? ''}`)
      }
    })
    observer.observe(content, { subtree: true, attributes: true, attributeFilter: ['data-flash'] })
    Reflect.set(window, '__e2eFlashObserver', observer)
  })
}

/** The assets that flashed since `recordFlashes`, each once, in the order
 *  of their first flash. A jump flashes an asset again when the editor
 *  draws it anew. The read waits two frames, so that a jump that a click
 *  started has flashed what it found. */
export async function flashedAssets (browser: E2EBrowser): Promise<string[]> {
  return browser.execute(() => new Promise<string[]>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      resolve([...new Set(Reflect.get(window, '__e2eFlashes') as string[])])
    }))
  }))
}

/** Whether the editor draws the image or the player with the id `id`, and
 *  its whole box is in the visible part of the editor's scroller and of
 *  the kept assets list that holds it, within 1 px: the sizes of the rows
 *  of the list are fractions of a px, so its last row can end a fraction
 *  past the list's box when the list is at its end. */
export async function assetInView (browser: E2EBrowser, id: string): Promise<boolean> {
  return browser.execute((wanted: string) => {
    const root = Array.from(document.querySelectorAll('.cm-content :is(.dez-image, .dez-media)'))
      .find((candidate) => candidate.querySelector('.dez-image__id, .media-player__id-text')?.textContent?.trim() === wanted)
    if (!root) return false
    const rect = root.getBoundingClientRect()
    if (rect.height === 0) return false
    const inside = (box: Element | null) => {
      if (!box) return true
      const { top, bottom } = box.getBoundingClientRect()
      return rect.top >= top - 1 && rect.bottom <= bottom + 1
    }
    return inside(document.querySelector('.cm-scroller')) && inside(root.closest('.dez-asset-list'))
  }, id)
}
