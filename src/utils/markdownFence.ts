// CommonMark fenced code block rules, shared by the editor's table scan and
// the Markdown export. Container blocks (lists, blockquotes) are not tracked.

export interface Fence {
  char: string
  length: number
  /** Spaces before the opening marker (0 to 3). */
  indent: number
}

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

export function fenceOpener(line: string): Fence | null {
  const match = FENCE_OPEN.exec(line)
  if (!match) return null
  const marker = match[2]
  // CommonMark: a backtick fence's info string has no backticks, so a line
  // like ```code``` is inline code, not a fence.
  if (marker[0] === '`' && line.includes('`', match[0].length)) return null
  return { char: marker[0], length: marker.length, indent: match[1].length }
}

export function closesFence(line: string, fence: Fence): boolean {
  const close = FENCE_CLOSE.exec(line)
  return close !== null && close[1][0] === fence.char && close[1].length >= fence.length
}
