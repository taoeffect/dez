import { describe, expect, it } from 'vitest'
import { failedCheck, refusalReport, type UpdateCheck } from './refusal'

// The names of `Check` in src-tauri/src/updater/verify.rs; a Rust test
// (`sends_a_refusal_as_an_object_and_other_failures_as_text`, mod.rs) holds
// the same four.
const CHECKS: UpdateCheck[] = ['manifestSignature', 'versionSignature', 'version', 'dmgSha256']

describe('failedCheck', () => {
  it.each(CHECKS)('reads the refusal that Rust sends for the check %s', (check) => {
    const message = "The signature of the update's manifest is from a key that Dez does not trust."
    expect(failedCheck({ check, message })).toEqual({ check, message })
  })

  // Every other failure of the two commands is a sentence.
  it.each([
    { error: 'Dez has no checked download of Dez 0.16.0. Download it again.', title: 'a plain message' },
    { error: new Error('GitHub answered the download of the update manifest with HTTP 404'), title: 'an Error' },
    { error: { check: 'codeSignature', message: 'The app failed its code signature check.' }, title: 'a check that Dez does not know' },
    { error: { check: 'version' }, title: 'a check with no message' },
    { error: { message: 'The update is refused.' }, title: 'a message with no check' },
    { error: null, title: 'null' },
  ])('gives null for $title', ({ error }) => {
    expect(failedCheck(error)).toBeNull()
  })
})

describe('refusalReport', () => {
  const report = (check: UpdateCheck) => refusalReport({ version: '0.16.0', check, message: 'What Rust found.' }, '0.15.1')

  // The developer needs both versions, the failed check, and Rust's finding.
  it.each(CHECKS)('names both versions, the check %s, and what Rust found', (check) => {
    const text = report(check)
    expect(text).toContain('Dez 0.15.1')
    expect(text).toContain('Dez 0.16.0')
    expect(text).toContain(`(${check})`)
    expect(text).toContain('What Rust found.')
  })

  // The words, without the name in parentheses, already tell the checks
  // apart.
  it('describes each of the four checks in its own words', () => {
    const words = CHECKS.map((check) => report(check).replace(`(${check})`, ''))
    expect(new Set(words).size).toBe(4)
  })
})
