import { describe, expect, it } from 'vitest'
import { exportFileName } from './assetExport'

const STORED_IMAGE = '/home/ann/.config/dez/assets/images/0c4e7a51-9b2d-4f6a-8e13-5d7c9a2b4f60.png'

describe('exportFileName', () => {
  it('names a stored file after the conversation and the id, with the extension of the file', () => {
    expect(exportFileName({ id: 'a', kind: 'image', source: { kind: 'file', path: STORED_IMAGE, linked: false } }, 'A red fox')).toBe('A red fox a.png')
    expect(exportFileName({ id: 'b', kind: 'video', source: { kind: 'file', path: '/home/ann/.cache/dez/media/c1.webm', linked: false } }, 'Clips')).toBe('Clips b.webm')
  })

  it('names the asset by its kind in a tab with no title, and leaves out an id that it does not have', () => {
    expect(exportFileName({ id: 'c', kind: 'audio', source: { kind: 'file', path: '/x/assets/generated/audio/c.wav', linked: false } }, null)).toBe('audio c.wav')
    expect(exportFileName({ id: null, kind: 'image', source: { kind: 'file', path: STORED_IMAGE, linked: false } }, null)).toBe('image.png')
    expect(exportFileName({ id: null, kind: 'image', source: { kind: 'file', path: STORED_IMAGE, linked: false } }, 'Fox')).toBe('Fox.png')
  })

  it('makes a title with characters that a file name cannot have into a safe name', () => {
    expect(exportFileName({ id: 'a', kind: 'image', source: { kind: 'file', path: STORED_IMAGE, linked: false } }, '.hidden: a/b?…')).toBe('hidden a b … a.png')
    expect(exportFileName({ id: 'a', kind: 'image', source: { kind: 'file', path: STORED_IMAGE, linked: false } }, '///')).toBe('image a.png')
  })

  it('keeps the name of a linked file', () => {
    expect(exportFileName({ id: 'd', kind: 'video', source: { kind: 'file', path: '/home/ann/Videos/Holiday 2025.mov', linked: true } }, 'Edit')).toBe('Holiday 2025.mov')
  })

  it('takes the extension of a URL clip from its type, else from its URL, else gives none', () => {
    expect(exportFileName({ id: 'e', kind: 'video', source: { kind: 'url', url: 'https://cdn.example/out?sig=1', type: 'video/mp4' } }, null)).toBe('video e.mp4')
    expect(exportFileName({ id: 'e', kind: 'video', source: { kind: 'url', url: 'https://cdn.example/out/v.webm?sig=1', type: null } }, null)).toBe('video e.webm')
    expect(exportFileName({ id: 'e', kind: 'audio', source: { kind: 'url', url: 'https://cdn.example/out?sig=1', type: 'application/octet-stream' } }, null)).toBe('audio e')
  })
})
