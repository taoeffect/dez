// Error texts for the user (the AGENTS.md rule): first Dez's explanation,
// which tells whose fault it is (the message, the model choice, the
// provider, the network, or Dez) and what to do; then the raw details (a
// provider's own text, an HTTP status, a native error) for a developer. The
// details are a paragraph of their own at the end (toasts keep line
// breaks), so a reader can stop before them.

/** The last advice of a text for an error that can be a defect of Dez. */
export const REPORT_ADVICE = 'If the error stays, report it at Help › Dez on GitHub.'

/** The explanation of an error that Dez did not expect: a defect of Dez, or
 *  a raw text of a lower layer that no code explained. */
export const UNEXPECTED_ERROR = `Dez hit an error that it did not expect. Try again. ${REPORT_ADVICE}`

/** The text of an error for the user: `explanation`, then `details` after
 *  "Details:" on a paragraph of their own. Blank details are left out. */
export function errorText(explanation: string, details = ''): string {
  const raw = details.trim()
  return raw === '' ? explanation : `${explanation}\n\nDetails: ${raw}`
}

/** The raw text of a caught value, for the details of an error text: the
 *  message of an `Error` (native errors are plain strings), else the value
 *  as text. */
export function rawErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** An error whose message Dez wrote for the user (`errorText`). It keeps
 *  both parts, so a caller can add advice to the explanation and keep the
 *  details last (`explainedError`, the job id of a clip). Code throws one
 *  for each text that a user reads; any other error is one that Dez did
 *  not expect. */
export class ExplainedError extends Error {
  constructor(
    readonly explanation: string,
    readonly details = '',
    options?: ErrorOptions,
  ) {
    super(errorText(explanation, details), options)
    this.name = 'ExplainedError'
  }
}

/** `error` itself when it is an `ExplainedError`; else an error that Dez did
 *  not expect, as one with `unexpected` as its explanation and the raw text
 *  as its details. An error with no text tells where the error is. */
export function explainedError(error: unknown, unexpected = UNEXPECTED_ERROR): ExplainedError {
  if (error instanceof ExplainedError) return error
  const raw = rawErrorText(error).trim()
  return new ExplainedError(unexpected, raw === '' ? 'The error has no text. Help › Developer Console shows it.' : raw, { cause: error })
}
