import { Facet, type EditorSelection, type EditorState, type Extension } from '@codemirror/state'
import { ViewPlugin, type EditorView } from '@codemirror/view'
import type { DocRange } from './pendingRanges'

// Images and players are widgets in place of their source text. CM draws a
// selection as a layer behind the text (`tables.ts`), and the opaque box of
// an image or of a player's card hides that layer, so an asset inside a
// selection did not look selected. This module marks the drawn widget of
// each asset that a selection holds with `data-selected`, and `dezTheme`
// (cmEditor.ts) draws a tint of the selection color over it.

const SELECTED_ATTRIBUTE = 'data-selected'

/** One kind of asset: the class of its widget's root element, and the doc
 *  ranges of its widgets in a state, in doc order. */
interface AssetKind {
  rootClass: string
  ranges: (state: EditorState) => readonly DocRange[]
}

const assetKinds = Facet.define<AssetKind>()

/** Whether a range of `selection` holds all of `asset`. A caret holds
 *  nothing. The asset ranges are atomic, so a selection that the user makes
 *  holds an asset fully or not at all. */
function selectionHolds(selection: EditorSelection, asset: DocRange): boolean {
  return selection.ranges.some((range) => !range.empty && range.from <= asset.from && range.to >= asset.to)
}

/** The range of `ranges` (in doc order) that starts at `from`, if any. */
function rangeStartingAt(ranges: readonly DocRange[], from: number): DocRange | undefined {
  let low = 0
  let high = ranges.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const range = ranges[middle]
    if (range.from === from) return range
    if (range.from < from) low = middle + 1
    else high = middle - 1
  }
  return undefined
}

/** A drawn asset widget (its root element), and whether a selection range
 *  holds its asset. */
type DrawnAsset = [root: HTMLElement, selected: boolean]

/** The drawn asset widgets of `view`. CM draws only the lines near the
 *  view, so this reads the drawn roots and finds each one's range by its
 *  start. */
function drawnAssets(view: EditorView): DrawnAsset[] {
  const { state } = view
  const drawn: DrawnAsset[] = []
  for (const { rootClass, ranges } of state.facet(assetKinds)) {
    const assets = ranges(state)
    if (assets.length === 0) continue
    for (const root of view.contentDOM.querySelectorAll<HTMLElement>(`.${rootClass}`)) {
      const asset = rangeStartingAt(assets, view.posAtDOM(root))
      drawn.push([root, asset !== undefined && selectionHolds(state.selection, asset)])
    }
  }
  return drawn
}

function markSelected(drawn: DrawnAsset[]): void {
  for (const [root, selected] of drawn) {
    if (root.hasAttribute(SELECTED_ATTRIBUTE) !== selected) root.toggleAttribute(SELECTED_ATTRIBUTE, selected)
  }
}

/** One object, so that CM runs it once a frame however often it is asked. */
const markRequest = { read: drawnAssets, write: markSelected }

/** Keeps `data-selected` on the drawn asset widgets. It changes only that
 *  attribute of a root that CM already drew, so a selection change never
 *  draws a widget again: no image loads again, and no player starts anew
 *  (the player gotchas of AGENTS.md). The work is a measure request, which
 *  CM runs after it brought the DOM up to date (a redrawn line has new
 *  roots) and before the next paint, in the frame in which the selection
 *  layer draws. It runs after every update: a new root can come with a doc
 *  change, a scroll, or a redraw for other decorations. CM ignores DOM
 *  changes inside a widget, so the attribute starts no update. */
const selectedAssetMarker = ViewPlugin.define((view) => {
  view.requestMeasure(markRequest)
  return {
    update: (update) => update.view.requestMeasure(markRequest),
  }
})

/** Gives the assets of `ranges`, whose widgets have roots of the class
 *  `rootClass`, the selected look inside a selection. The marker is one
 *  value, so a state with more than one kind of asset still has it once. */
export function selectedAssetLook(rootClass: string, ranges: (state: EditorState) => readonly DocRange[]): Extension {
  return [assetKinds.of({ rootClass, ranges }), selectedAssetMarker]
}
