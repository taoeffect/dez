import { describe, expect, it } from 'vitest'
import { pathWithTilde } from './homePath'

describe('pathWithTilde', () => {
  it('puts ~ in place of the home folder of a path inside it', () => {
    expect(pathWithTilde('/home/anna/.cache/dez/media/9f3c.mp4', '/home/anna')).toBe('~/.cache/dez/media/9f3c.mp4')
    expect(pathWithTilde('/Users/anna/Library/Caches/dez/media/9f3c.mp4', '/Users/anna')).toBe('~/Library/Caches/dez/media/9f3c.mp4')
  })

  it('gives ~ for the home folder itself', () => {
    expect(pathWithTilde('/home/anna', '/home/anna')).toBe('~')
  })

  it('keeps a path that is outside the home folder', () => {
    expect(pathWithTilde('/tmp/dez/media/9f3c.mp4', '/home/anna')).toBe('/tmp/dez/media/9f3c.mp4')
    expect(pathWithTilde('/home', '/home/anna')).toBe('/home')
  })

  it('keeps a folder whose name only starts like the home folder', () => {
    expect(pathWithTilde('/home/annabel/.cache/dez/media/9f3c.mp4', '/home/anna')).toBe('/home/annabel/.cache/dez/media/9f3c.mp4')
    expect(pathWithTilde('/home/annabel', '/home/anna')).toBe('/home/annabel')
  })

  it('takes a home folder that ends with a slash', () => {
    expect(pathWithTilde('/home/anna/.cache/dez', '/home/anna/')).toBe('~/.cache/dez')
  })

  it('keeps every path when the home folder is the root or is not known', () => {
    expect(pathWithTilde('/var/cache/dez/media/9f3c.mp4', '/')).toBe('/var/cache/dez/media/9f3c.mp4')
    expect(pathWithTilde('/var/cache/dez/media/9f3c.mp4', '')).toBe('/var/cache/dez/media/9f3c.mp4')
  })
})
