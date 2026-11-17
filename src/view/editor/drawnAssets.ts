import type { EditorView } from '@codemirror/view'

// The images and the players that the editor draws (`createImage` in
// images.ts, `createPlayer` in media.ts), at their own place or in the
// panel of a chip (toolCalls.ts, compactionChip.ts, AssetList.vue), and
// where the text of each one is in the doc. A mention chip (mentions.ts)
// finds the drawn asset that it names by that place, and flashes it.
//
// images.ts, media.ts, and toolCalls.ts read this module. It must import
// none of them.

/** Tells where the text of a drawn image or player starts in the doc now;
 *  null when it is not in the doc any more. The trash, the Save, and the
 *  tooltips of an asset work on its text. An asset at its own place finds
 *  its text by its DOM. A hidden asset is drawn in the panel of its chip,
 *  whose DOM is at the place of the chip, so the chip gives this. */
export type AssetPlace = () => number | null

/** The class of the root element of each drawn image and player, so that
 *  `drawnAssetAt` can find the roots. */
const DRAWN_ASSET_CLASS = 'dez-drawn-asset'

const places = new WeakMap<Element, AssetPlace>()

/** Notes `root`, the root element of a drawn image or player, with its
 *  place. */
export function noteDrawnAsset(root: HTMLElement, place: AssetPlace): void {
  root.classList.add(DRAWN_ASSET_CLASS)
  places.set(root, place)
}

/** The root of the first drawn image or player of `view` whose text starts
 *  at `from` now; null when the editor draws none there now: CM draws only
 *  the lines near the view, a closed panel draws nothing, and the long list
 *  of a panel draws only the rows near its own view (`AssetList.vue`). */
export function drawnAssetAt(view: EditorView, from: number): HTMLElement | null {
  for (const root of view.contentDOM.querySelectorAll<HTMLElement>(`.${DRAWN_ASSET_CLASS}`)) {
    if (places.get(root)?.() === from) return root
  }
  return null
}

/** How long the ring of a flash shows; its animation (`dezTheme`) is as
 *  long. */
export const ASSET_FLASH_MS = 1000

const FLASH_ATTRIBUTE = 'data-flash'

const flashTimers = new WeakMap<Element, number>()

/** Shows a ring around the drawn asset `root` for `ASSET_FLASH_MS`, so
 *  that the user sees which asset a mention chip named. The ring is CSS on
 *  the attribute (`dezTheme`), as the selected look is (assetSelection.ts):
 *  CM ignores DOM changes inside a widget, so the attribute starts no
 *  update. A flash of a root that flashes already starts anew. */
export function flashDrawnAsset(root: HTMLElement): void {
  clearTimeout(flashTimers.get(root))
  if (root.hasAttribute(FLASH_ATTRIBUTE)) {
    root.removeAttribute(FLASH_ATTRIBUTE)
    // A layout read between the two writes makes WebKit drop the running
    // animation, so it starts again from its first frame.
    void root.offsetWidth
  }
  root.setAttribute(FLASH_ATTRIBUTE, '')
  flashTimers.set(root, window.setTimeout(() => root.removeAttribute(FLASH_ATTRIBUTE), ASSET_FLASH_MS))
}
