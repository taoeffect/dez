/** The escape and unescape of a tag name, or of a set of them, in free text. */
export interface TagEscape {
  escape: (text: string) => string
  unescape: (text: string) => string
}

// Free text inside a `dez:` marker (thinking text, a tool result) or next
// to one (model answer text) must not hold a tag that starts or ends a
// marker. Each `<`, `\`…, optional `/`, tag name run gets one more `\`
// after the `<` on escape and loses one on unescape, for each of `tags`.
// Text that already holds the escaped form gets one more `\` too, so
// unescape always gives the exact text back. Each name goes into a regex as
// it is, so it must hold no regex special char.
export function tagEscape(...tags: string[]): TagEscape {
  const names = tags.join('|')
  const run = new RegExp(String.raw`<(\\*)(\/?)(${names})`, 'g')
  const escapedRun = new RegExp(String.raw`<\\(\\*)(\/?)(${names})`, 'g')
  return {
    escape: (text) => text.replace(run, '<\\$1$2$3'),
    unescape: (text) => text.replace(escapedRun, '<$1$2$3'),
  }
}
