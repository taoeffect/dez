import { describe, expect, it } from 'vitest'
import { errorText, ExplainedError, explainedError, UNEXPECTED_ERROR } from './errorText'

describe('error texts', () => {
  it('puts the details last, on a paragraph of their own, and leaves blank ones out', () => {
    expect([errorText('Venice refused the request.', 'HTTP 400: Bad field'), errorText('No model is selected.', '  ')]).toStrictEqual([
      'Venice refused the request.\n\nDetails: HTTP 400: Bad field',
      'No model is selected.',
    ])
  })

  it('keeps an explained error, and explains any other error as one that Dez did not expect', () => {
    const explained = new ExplainedError('Venice refused the request.', 'HTTP 400')
    const native = explainedError('Write error: No space left on device')
    const blank = explainedError(new Error(''))

    expect(explainedError(explained)).toBe(explained)
    expect([native.message, blank.message]).toStrictEqual([
      `${UNEXPECTED_ERROR}\n\nDetails: Write error: No space left on device`,
      `${UNEXPECTED_ERROR}\n\nDetails: The error has no text. Help › Developer Console shows it.`,
    ])
    expect(explainedError(new TypeError('x is undefined'), 'The model check failed.').message).toBe('The model check failed.\n\nDetails: x is undefined')
  })
})
