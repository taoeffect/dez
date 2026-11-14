import { byteSizeText } from '../utils/byteSize'
import { formatName } from '../utils/formatName'

// The facts that the hover overlay of an image or a clip shows next to its
// id (`ImageWidget` in src/view/editor/images.ts, `MediaPlayer.vue`), as one
// short text in one order for both: the size of the content (an image's
// pixels, a clip's length), the file type, and the size of the file.

/** What Dez knows of an image or a clip. A fact that is not known, or not
 *  known yet, is null and is left out of the text. */
export interface AssetFacts {
  /** The size of an image, in pixels. */
  pixels?: { width: number, height: number } | null
  /** The length of a clip, in seconds. */
  seconds?: number | null
  /** The file extension of the asset's type, such as `png` or `webm`. */
  extension: string | null
  /** The size of the asset's file, in bytes. */
  bytes: number | null
}

/** A clip's length as the player's own duration shows it (video.js
 *  `formatTime`), so the two never differ: whole seconds as `m:ss`, and
 *  `h:mm:ss` from one hour on. */
export function clipLengthText(seconds: number): string {
  const total = Math.floor(seconds)
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  const rest = String(total % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`
}

/** The facts of an asset as one text, such as `1024 × 768 · PNG · 1.2 MB`
 *  or `0:02 · WebM · 48 KB`; empty when no fact is known. */
export function assetFactsText({ pixels, seconds, extension, bytes }: AssetFacts): string {
  const facts: string[] = []
  if (pixels) facts.push(`${pixels.width} × ${pixels.height}`)
  if (seconds != null) facts.push(clipLengthText(seconds))
  if (extension) facts.push(formatName(extension))
  if (bytes !== null) facts.push(byteSizeText(bytes))
  return facts.join(' · ')
}
