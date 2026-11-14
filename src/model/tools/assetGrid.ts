import type { ImageComposition, ImageRegion, ImageSize } from '../chat/imageDrawing'
import { FRAME_BOXES, idsListText, imagePictureShows, SHEET_PADDING, sheetGrid, sizeWithin, type ViewDetail } from './assetView'

// The one picture of an `asset_view` call with `layout` "grid": its images
// and the frame sheets of its video clips, top to bottom in the order of
// the call. A run of images goes side by side, in the rows of `sheetGrid`
// (at most `MAX_SHEET_COLUMNS`, as even as can be), each image in the frame
// box of `detail`, so that an image and a frame look the same size. Each
// frame sheet is a line of its own, at its own size. The whole grid is then
// made smaller to the picture side of the view. The webview draws it
// (dez.controller/images/compose); controller/assetView.ts makes the
// pieces.

/** The space between two lines of a grid, but between two lines of images,
 *  which have the space of a frame sheet (`SHEET_PADDING`): it keeps the
 *  frames of each clip, and each run of images, together as one block. */
const GRID_GAP = 16

/** A piece of a grid: the image `id`, or the frame sheet of the video clip
 *  `id`, with the text of what the sheet shows (`frameSheetTexts`). */
export type GridPiece =
  | { kind: 'image', id: string }
  | { kind: 'sheet', id: string, shows: string }

/** The drawing of a grid, and what its texts tell: `scale`, the size of
 *  the picture to the size of its parts (at most 1), and `imagesSmaller`,
 *  whether an image of the grid is a smaller copy in its frame box. */
export interface GridLayout extends ImageComposition {
  scale: number
  imagesSmaller: boolean
}

// The lines of a grid of `pieces`, top to bottom, each one the numbers of
// its pieces, left to right.
function gridLines(pieces: readonly GridPiece[]): number[][] {
  // A run of images, or one sheet.
  const runs: number[][] = []
  pieces.forEach((piece, index) => {
    const last = runs.at(-1)
    if (piece.kind === 'image' && last && pieces[last[0]].kind === 'image') last.push(index)
    else runs.push([index])
  })
  return runs.flatMap((run) => {
    const { columns, rows } = sheetGrid(run.length)
    return Array.from({ length: rows }, (_, row) => run.slice(row * columns, (row + 1) * columns))
  })
}

/** The drawing of the grid of `pieces`, whose files have `sizes` (in the
 *  same order), for a view with `detail`, at most `side` pixels on its
 *  longer side: the place of each piece on a white canvas, as a JPEG. In a
 *  line, the pieces are `SHEET_PADDING` apart, and each one is in the
 *  middle of the height of the line; the lines start at the left edge. */
export function gridLayout(pieces: readonly GridPiece[], sizes: readonly ImageSize[], detail: ViewDetail, side: number): GridLayout {
  const drawn = sizes.map((size, index) => (pieces[index].kind === 'image' ? sizeWithin(size, FRAME_BOXES[detail]) : size))
  const places: ImageRegion[] = []
  let width = 0
  let height = 0
  gridLines(pieces).forEach((line, index, lines) => {
    if (index > 0) {
      const imageLines = pieces[lines[index - 1][0]].kind === 'image' && pieces[line[0]].kind === 'image'
      height += imageLines ? SHEET_PADDING : GRID_GAP
    }
    const lineHeight = Math.max(...line.map((piece) => drawn[piece].height))
    let x = 0
    line.forEach((piece, column) => {
      if (column > 0) x += SHEET_PADDING
      places[piece] = { x, y: height + Math.floor((lineHeight - drawn[piece].height) / 2), ...drawn[piece] }
      x += drawn[piece].width
    })
    width = Math.max(width, x)
    height += lineHeight
  })

  const scale = Math.min(1, side / Math.max(width, height))
  // Each edge goes to the nearest pixel, so that the pieces keep their gaps
  // and no piece has a side of 0.
  const scaled = (start: number, length: number): [number, number] => {
    const from = Math.round(start * scale)
    return [from, Math.max(1, Math.round((start + length) * scale) - from)]
  }
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    places: places.map((place) => {
      const [x, placeWidth] = scaled(place.x, place.width)
      const [y, placeHeight] = scaled(place.y, place.height)
      return { x, y, width: placeWidth, height: placeHeight }
    }),
    // A JPEG has no transparent pixels.
    background: '#ffffff',
    mediaType: 'image/jpeg',
    scale,
    imagesSmaller: pieces.some((piece, index) => piece.kind === 'image' && (drawn[index].width < sizes[index].width || drawn[index].height < sizes[index].height)),
  }
}

/** The note and the picture text of the grid of `pieces`, drawn as
 *  `layout`, for a view with `detail`: its lines, top to bottom, and how
 *  to see more when its parts are smaller copies. */
export function gridTexts(pieces: readonly GridPiece[], layout: GridLayout, detail: ViewDetail): { note: string, shows: string } {
  const map = gridLines(pieces).map((line) => {
    const first = pieces[line[0]]
    if (first.kind === 'sheet') return first.shows
    return line.length === 1 ? imagePictureShows(first.id) : `the images ${idsListText(line.map((piece) => pieces[piece].id))}, left to right`
  }).join('; ')
  const box = FRAME_BOXES[detail]
  const smaller = [
    ...(layout.imagesSmaller ? [`Each image fits in ${box} by ${box} pixels: a larger one is a smaller copy.`] : []),
    ...(layout.scale < 1 ? [`The whole grid is a smaller copy, at ${Math.floor(layout.scale * 100)}% of the size of its parts.`] : []),
  ]
  const ways = ['with fewer assets', ...(detail === 'review' ? ['with `detail` "full"'] : []), 'with `layout` "separate"']
  const advice = `For more detail, call again ${new Intl.ListFormat('en', { type: 'disjunction' }).format(ways)}.`
  return {
    note: [`Grid picture of ${layout.width}x${layout.height} pixels, top to bottom: ${map}.`, ...smaller, ...(smaller.length > 0 ? [advice] : [])].join(' '),
    shows: `a grid, top to bottom: ${map}`,
  }
}
