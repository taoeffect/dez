/** A number with thousands separators, the same on every computer:
 *  `57,408`. */
export function countText(count: number): string {
  return count.toLocaleString('en-US')
}

/** `count` things, as in `1 picture`, `12 pictures`. */
export function countOf(count: number, name: string): string {
  return `${countText(count)} ${name}${count === 1 ? '' : 's'}`
}
