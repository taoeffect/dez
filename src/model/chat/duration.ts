/** For object spreads: `{ durationMs }`, or `{}` without one, because a copy
 *  of a section must never write `durationMs: undefined`. */
export function durationField(durationMs: number | undefined): { durationMs?: number } {
  return durationMs === undefined ? {} : { durationMs }
}
