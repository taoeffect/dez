import { describe, expect, it } from 'vitest'
import { ChatImageCopies, chatImageKey, type ChatImageCopy } from './chatImageCopies'

// A JPEG copy of `bytes` bytes.
const copyOf = (bytes: number): ChatImageCopy => ({ bytes: new Uint8Array(bytes), mediaType: 'image/jpeg' })

describe('chatImageKey', () => {
  const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')

  it('is the same for the same bytes of the same type', async () => {
    expect(await chatImageKey(SVG, 'image/svg+xml')).toBe(await chatImageKey(Uint8Array.from(SVG), 'image/svg+xml'))
  })

  // A linked SVG can change and keep its length.
  it('differs for other bytes of the same length', async () => {
    const other = Uint8Array.from(SVG)
    other[5] += 1

    expect(await chatImageKey(other, 'image/svg+xml')).not.toBe(await chatImageKey(SVG, 'image/svg+xml'))
  })

  // The same bytes go as a PNG drawing as an SVG, and as they are as a PNG.
  it('differs for the same bytes of another type', async () => {
    expect(await chatImageKey(SVG, 'image/png')).not.toBe(await chatImageKey(SVG, 'image/svg+xml'))
  })
})

describe('ChatImageCopies', () => {
  it('tells a file with no entry from a file that goes as it is', () => {
    const copies = new ChatImageCopies(100)
    copies.set('as-it-is', null)

    expect(copies.get('as-it-is')).toBeNull()
    expect(copies.get('unknown')).toBeUndefined()
  })

  it('removes the copies that were read the longest time ago when a new copy does not fit', () => {
    const copies = new ChatImageCopies(100)
    copies.set('a', copyOf(40))
    copies.set('b', copyOf(40))
    // `a` is now the newest read.
    copies.get('a')

    copies.set('c', copyOf(40))

    expect(copies.get('b')).toBeUndefined()
    expect(copies.get('a')).toStrictEqual(copyOf(40))
    expect(copies.get('c')).toStrictEqual(copyOf(40))
  })

  it('removes as many copies as the new copy needs', () => {
    const copies = new ChatImageCopies(100)
    copies.set('a', copyOf(30))
    copies.set('b', copyOf(30))
    copies.set('c', copyOf(30))

    copies.set('d', copyOf(60))

    expect([copies.get('a'), copies.get('b')]).toStrictEqual([undefined, undefined])
    expect(copies.get('c')).toStrictEqual(copyOf(30))
    expect(copies.get('d')).toStrictEqual(copyOf(60))
  })

  // It holds no bytes, so its removal makes no room.
  it('keeps the entry of a file that goes as it is when a new copy does not fit', () => {
    const copies = new ChatImageCopies(100)
    copies.set('as-it-is', null)
    copies.set('a', copyOf(80))

    copies.set('b', copyOf(80))

    expect(copies.get('as-it-is')).toBeNull()
    expect(copies.get('a')).toBeUndefined()
    expect(copies.get('b')).toStrictEqual(copyOf(80))
  })

  it('keeps no copy that is larger than the whole limit, and removes no other copy for it', () => {
    const copies = new ChatImageCopies(100)
    copies.set('a', copyOf(80))

    copies.set('b', copyOf(101))

    expect(copies.get('b')).toBeUndefined()
    expect(copies.get('a')).toStrictEqual(copyOf(80))
  })

  it('counts the bytes of an entry one time when it is set again', () => {
    const copies = new ChatImageCopies(100)
    copies.set('a', copyOf(60))
    copies.set('a', copyOf(60))

    copies.set('b', copyOf(40))

    expect(copies.get('a')).toStrictEqual(copyOf(60))
    expect(copies.get('b')).toStrictEqual(copyOf(40))
  })

  it('keeps the byte count of what the newest request sent for a path', () => {
    const copies = new ChatImageCopies(100)
    expect(copies.sentBytes('/home/u/a.png')).toBeUndefined()

    copies.noteSent('/home/u/a.png', 500)
    copies.noteSent('/home/u/a.png', 700)

    expect(copies.sentBytes('/home/u/a.png')).toBe(700)
  })

  it('holds nothing after a clear, and has its whole room again', () => {
    const copies = new ChatImageCopies(100)
    copies.set('a', copyOf(90))
    copies.noteSent('/home/u/a.png', 90)

    copies.clear()
    copies.set('b', copyOf(90))
    copies.set('c', copyOf(10))

    expect(copies.get('a')).toBeUndefined()
    expect(copies.sentBytes('/home/u/a.png')).toBeUndefined()
    expect(copies.get('b')).toStrictEqual(copyOf(90))
    expect(copies.get('c')).toStrictEqual(copyOf(10))
  })
})
