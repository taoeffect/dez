import { describe, expect, it } from 'vitest'
import { playCopyTarget } from './playCopies'

// A `canPlayType` that gives the answer of `plays` for a type of each
// container in it, and '' for any other type.
function canPlay(plays: Record<string, 'probably' | 'maybe'>): (type: string) => string {
  return (type) => Object.entries(plays).find(([container]) => type.startsWith(`${container};`))?.[1] ?? ''
}

describe('playCopyTarget', () => {
  it('takes H.264 in MP4 when the computer plays it, as every macOS does', () => {
    expect(playCopyTarget(canPlay({ 'video/mp4': 'probably', 'video/webm': 'probably' }))).toBe('mp4')
    expect(playCopyTarget(canPlay({ 'video/mp4': 'maybe' }))).toBe('mp4')
  })

  it('takes VP9 in WebM on a computer with no H.264 decoder', () => {
    expect(playCopyTarget(canPlay({ 'video/webm': 'probably' }))).toBe('webm')
    expect(playCopyTarget(canPlay({ 'video/webm': 'maybe' }))).toBe('webm')
  })

  it('takes nothing on a computer that plays neither, so that Dez makes no copy', () => {
    expect(playCopyTarget(canPlay({}))).toBeNull()
  })
})
