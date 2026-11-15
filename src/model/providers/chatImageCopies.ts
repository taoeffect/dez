import type { ImageMediaType } from '../chat/images'

// What Dez knows of the images that chat requests send, in memory, for the
// run of the app. A chat request sends a large image as a smaller copy
// (`chatImageDrawing`, imageSize.ts), and every later request of the
// conversation sends that image again. So Dez keeps the copy, and decodes
// and draws an image one time only. A copy that left the memory is drawn
// again, and the webview draws the same file to the same bytes.
//
// An entry is found by the bytes of the image file, not by its path: a
// linked file can change where it is (an SVG can even keep its length),
// and a request must then send the new image.

/** The file that a chat request sends in place of an image file. */
export interface ChatImageCopy {
  bytes: Uint8Array
  mediaType: ImageMediaType
}

/** The key of the image file `bytes` of the type `mediaType` in a
 *  `ChatImageCopies`: the SHA-256 of the bytes, and the type, as the same
 *  bytes are drawn in another way as an SVG. */
export async function chatImageKey(bytes: Uint8Array, mediaType: ImageMediaType): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return `${mediaType}:${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

/** The copies of image files, by key (`chatImageKey`): for each file, its
 *  copy, or null for a file that goes as it is. The copies together have
 *  at most `maxBytes` bytes: when a new one does not fit, the copies that
 *  were read the longest time ago go first.
 *
 *  It also keeps, by the path of each image, how many bytes a request
 *  sends for it, as the newest read of the image found (a request, or a
 *  count of the bytes of a request: the picture budget), so that a count
 *  reads no file that Dez already read. That count is not checked against
 *  the file: it can be old for a linked file that changed, until the next
 *  request reads the file. */
export class ChatImageCopies {
  // In the order of the newest read or write of each entry, the oldest
  // first (a Map keeps the order of its inserts).
  private readonly entries = new Map<string, ChatImageCopy | null>()
  private copyBytes = 0
  private readonly bytesByPath = new Map<string, number>()

  constructor(private readonly maxBytes: number) {}

  /** How many bytes a request sends for the image at `path`, as the newest
   *  read of it (a request or a count of the picture budget) found;
   *  undefined when Dez has not read it yet. */
  requestBytes(path: string): number | undefined {
    return this.bytesByPath.get(path)
  }

  noteRequestBytes(path: string, bytes: number): void {
    this.bytesByPath.set(path, bytes)
  }

  /** The copy of the file of `key`; null for a file that goes as it is;
   *  undefined for a file that has no entry. */
  get(key: string): ChatImageCopy | null | undefined {
    const copy = this.entries.get(key)
    if (copy === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, copy)
    return copy
  }

  /** Keeps `copy` (null: the file goes as it is) for the file of `key`. A
   *  copy that is larger than the whole limit is not kept. */
  set(key: string, copy: ChatImageCopy | null): void {
    this.remove(key)
    const bytes = copy?.bytes.length ?? 0
    if (bytes > this.maxBytes) return
    for (const [oldest, held] of this.entries) {
      if (this.copyBytes + bytes <= this.maxBytes) break
      // An entry with no copy holds no bytes.
      if (held) this.remove(oldest)
    }
    this.entries.set(key, copy)
    this.copyBytes += bytes
  }

  clear(): void {
    this.entries.clear()
    this.copyBytes = 0
    this.bytesByPath.clear()
  }

  private remove(key: string): void {
    this.copyBytes -= this.entries.get(key)?.bytes.length ?? 0
    this.entries.delete(key)
  }
}

/** The copies of the images that the chat requests of this run of the app
 *  send. 64 MiB hold the copies of about a hundred large images: a JPEG
 *  copy has some hundred kilobytes. */
export const chatImageCopies = new ChatImageCopies(64 * 1024 ** 2)
