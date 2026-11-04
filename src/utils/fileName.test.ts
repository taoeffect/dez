import { describe, expect, it } from 'vitest'
import { safeFileName } from './fileName'

describe('safeFileName', () => {
  it('turns unsafe characters into single spaces instead of joining words', () => {
    expect(safeFileName('What is 2/3? A: "half"|<no>', 'x')).toBe('What is 2 3 A half no')
    expect(safeFileName('C:\\temp\\notes', 'x')).toBe('C temp notes')
  })

  it('turns line breaks and tabs in a title into spaces', () => {
    expect(safeFileName('Hi\nPlease\t\twrite\r\nthis', 'x')).toBe('Hi Please write this')
  })

  it('removes leading dots so the file is not hidden', () => {
    expect(safeFileName('.env setup', 'x')).toBe('env setup')
    expect(safeFileName(' ..config ', 'x')).toBe('config')
  })

  it('removes trailing dots before the caller adds an extension', () => {
    expect(safeFileName('Wait for it...', 'x')).toBe('Wait for it')
  })

  it('keeps the truncation ellipsis and other Unicode', () => {
    expect(safeFileName('Résumé tips für 日本…', 'x')).toBe('Résumé tips für 日本…')
  })

  it('uses the fallback when nothing safe is left', () => {
    expect(safeFileName('', 'Conversation')).toBe('Conversation')
    expect(safeFileName(' /?*. ', 'Conversation')).toBe('Conversation')
  })
})
