/** `text` on one line, cut at `max` code points with an ellipsis, so
 *  that the cut leaves no half of a character. */
export function oneLineCut(text: string, max: number): string {
  const line = [...text.replace(/\s+/g, ' ').trim()]
  return line.length <= max ? line.join('') : `${line.slice(0, max - 1).join('').trimEnd()}…`
}
