import { closesFence, fenceOpener, type Fence } from '../../utils/markdownFence'
import type { Role } from './types'

/** One message of a plain Markdown export: plain text (prompt bodies inline,
 *  no live sentinels) and the role whose heading starts it, if any. */
export interface MarkdownMessage {
  role?: Role
  text: string
}

// CommonMark ends an unclosed fence only at the end of the document, so a
// message that stops inside a code block (a stopped stream) would turn all
// later headings into code. The editor treats each message as its own
// document, so the export closes the fence at the end of its message.
function unclosedFence(text: string): Fence | null {
  let fence: Fence | null = null
  for (const line of text.split('\n')) {
    if (fence) {
      if (closesFence(line, fence)) fence = null
    } else {
      fence = fenceOpener(line)
    }
  }
  return fence
}

/** Messages as plain Markdown for people to read. Save As Markdown and Copy
 *  Markdown both use it, so they give the same text. A message with a role
 *  starts with a `## User` / `## Agent` heading (the editor's role labels);
 *  every message ends with a newline and with a closer for a code fence it
 *  leaves open, and a blank line separates two messages. Whitespace-only
 *  messages give nothing. */
export function messagesAsMarkdown(messages: MarkdownMessage[]): string {
  return messages
    .filter((message) => message.text.trim() !== '')
    .map(({ role, text }) => {
      let output = role ? `## ${role === 'agent' ? 'Agent' : 'User'}\n\n${text}` : text
      if (!text.endsWith('\n')) output += '\n'
      // The closer keeps the opener's indent: a column-0 closer after a fence
      // in a list item would end the list item and open a new fence.
      const fence = unclosedFence(text)
      if (fence) output += `${' '.repeat(fence.indent)}${fence.char.repeat(fence.length)}\n`
      return output
    })
    .join('\n')
}
