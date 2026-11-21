// Cuts of a long text at a count of UTF-16 units. A character outside the
// basic plane (an emoji) is two units, a surrogate pair, and a cut between
// them leaves a half that is no text: a provider can refuse a request that
// holds it. Each cut here drops that half.

/** The first `length` characters of `text`, with no half of a character at
 *  the cut. */
export function startOf(text: string, length: number): string {
  return text.slice(0, length).replace(/[\uD800-\uDBFF]$/, '')
}

/** The last `length` characters of `text`, with no half of a character at
 *  the cut. */
export function endOf(text: string, length: number): string {
  return text.slice(-length).replace(/^[\uDC00-\uDFFF]/, '')
}
