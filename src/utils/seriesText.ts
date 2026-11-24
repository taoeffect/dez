/** A list in a sentence: `a`, `a and b`, `a, b, and c` (`or` the same). */
export function seriesText(items: readonly string[], conjunction: 'and' | 'or'): string {
  return items.length < 3 ? items.join(` ${conjunction} `) : `${items.slice(0, -1).join(', ')}, ${conjunction} ${items.at(-1)}`
}
