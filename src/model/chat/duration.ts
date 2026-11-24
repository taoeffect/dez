/** For object spreads: `{ durationMs }`, or `{}` without one, because a copy
 *  of a section must never write `durationMs: undefined`. */
export function durationField(durationMs: number | undefined): { durationMs?: number } {
  return durationMs === undefined ? {} : { durationMs }
}

/** A tool call that runs this long or longer shows its time on its chip
 *  (live while it runs), keeps the time on its block, and tells it to the
 *  model. An agent pill shows its live time from this mark on too. A
 *  quicker call is no news, and a time on every chip would be noise. */
export const TIMED_CALL_MIN_MS = 1000

/** A `duration-ms` attribute (of a pill marker or a tool block). Dez writes
 *  whole, non-negative milliseconds; any other value (a hand edit) reads as
 *  "unknown", as a bad `model` does. */
export function parseDurationMs(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null
  const durationMs = Number(value)
  return Number.isSafeInteger(durationMs) ? durationMs : null
}
