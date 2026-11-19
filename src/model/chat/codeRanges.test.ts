import { parser } from '@lezer/markdown'
import { describe, expect, it, vi } from 'vitest'
import { codeRanges, inCode, openFenceCloser } from './codeRanges'
import type { LinkedPathRule } from './images'

const codeTexts = (text: string, rule: LinkedPathRule = 'user') => codeRanges(text, rule).map(({ from, to }) => text.slice(from, to))

const TAG = '<dez:audio id="a" type="audio/wav"/>'

describe('codeRanges', () => {
  it.each([
    ['a backtick fence', 'a\n```js\n![x](/y.png)\n```\nb', ['```js\n![x](/y.png)\n```']],
    ['a tilde fence', 'a\n~~~\nx\n~~~\nb', ['~~~\nx\n~~~']],
    ['a fence with no closer, to the end of the text', 'a\n```\nx\n\ny', ['```\nx\n\ny']],
    ['a fence that a shorter run does not close', '````\nx\n```\ny', ['````\nx\n```\ny']],
    ['a fence that a longer run closes', '```\nx\n`````\ny', ['```\nx\n`````']],
    ['a fence in a list item', '- a\n  ```\n  x\n  ```\nb', ['```\n  x\n  ```']],
    ['a fence in a block quote', '> ```\n> x\n> ```', ['```\n> x\n> ```']],
    ['a code span', 'a `b` c ``d ` e``', ['`b`', '``d ` e``']],
    ['a code span over two lines of a paragraph', 'a `b\nc` d', ['`b\nc`']],
    ['no code span over a blank line', 'a `b\n\nc` d', []],
    ['no code span for a lone backtick', 'a ` b', []],
    ['an indented block', 'a\n\n    x\n    y\nb', ['x\n    y']],
    ['no indented block for a line of a paragraph', 'a\n    b', []],
    ['an indented block in a list item', '- a\n\n      x', ['x']],
  ])('finds %s', (_name, text, expected) => {
    expect(codeTexts(text)).toStrictEqual(expected)
  })

  it('ends the code at a line of Dez in a text that is not a user text', () => {
    const fence = `\`\`\`\nx\n${TAG}\n![id=b](/y.png)`
    const span = 'a `b\n</dez:tool>\nc` d'

    expect(codeTexts(fence, 'agent')).toStrictEqual(['```\nx\n'])
    expect(codeTexts(fence, new Set())).toStrictEqual(['```\nx\n'])
    expect(codeTexts(span, 'agent')).toStrictEqual([])
    expect(codeTexts(fence, 'user')).toStrictEqual([fence])
    expect(codeTexts(span, 'user')).toStrictEqual(['`b\n</dez:tool>\nc`'])
  })

  it('gives the offsets of the whole text for the code after a line of Dez', () => {
    const text = `a\n${TAG}\nb \`c\` d\n</dez:tool>\n\`e\``

    expect(codeTexts(text, 'agent')).toStrictEqual(['`c`', '`e`'])
  })

  it('takes a line as a line of Dez only at its start', () => {
    expect(codeTexts(`\`\`\`\nx ${TAG}\ny`, 'agent')).toStrictEqual([`\`\`\`\nx ${TAG}\ny`])
  })

  // The editor reads the whole doc again on each key press, in the same
  // order. A reply with many tool calls has thousands of runs with code,
  // and each one that the cache dropped is parsed again.
  it('parses no run of a long reply again on the next read', () => {
    const block = (index: number) => `I run \`ffprobe\` (${index}).\n<dez:tool id="c${index}" name="video">\n{\n    "index": ${index}\n}\n</dez:tool>\n`
    const text = Array.from({ length: 1000 }, (_, index) => block(index)).join('')
    const first = codeRanges(text, 'agent')
    const parse = vi.spyOn(parser, 'parse')
    try {
      expect(codeRanges(text, 'agent')).toStrictEqual(first)
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })

  // `codeRanges` parses only a text with a code sign (a backtick, `~~~`, a
  // tab, or 4 spaces in a row). These samples have code with as little of a
  // sign as there can be, or no code, and the parser must agree.
  it.each([
    '>     x',
    '>\tx',
    '-     x',
    '-\tx',
    '1.     x',
    '- a\n\n      x',
    '> - a\n>\n>       x',
    '\tx',
    'a\n\n    x',
    '- a\n   b',
    '>    x',
    '   x',
  ])('skips the parse only for a text that has no code: %j', (text) => {
    let parsed = false
    parser.parse(text).iterate({
      enter: (node) => {
        if (['FencedCode', 'CodeBlock', 'InlineCode'].includes(node.name)) parsed = true
      },
    })

    expect(codeRanges(text, 'user').length > 0).toBe(parsed)
  })
})

describe('inCode', () => {
  it('takes the start of a range and not its end', () => {
    const ranges = [{ from: 2, to: 4 }, { from: 6, to: 9 }]

    expect([0, 1, 2, 3, 4, 5, 6, 8, 9, 10].map((offset) => inCode(ranges, offset)))
      .toStrictEqual([false, false, true, true, false, false, true, true, false, false])
    expect(inCode([], 0)).toBe(false)
  })
})

describe('openFenceCloser', () => {
  it.each<[string, string, string | null]>([
    ['a top-level fence with no closer', 'a\n\n```js\nx', '```'],
    ['a long fence with no closer', '````\nx\n```', '````'],
    ['a tilde fence with no closer', '~~~\nx', '~~~'],
    ['an indented fence with no closer', '  ```\nx', '```'],
    ['a closed fence', '```\nx\n```', null],
    ['an open fence in a list item', '- a\n  ```\n  x', null],
    ['an open fence in a block quote', '> ```\n> x', null],
    ['a code span', 'a `b`', null],
    ['no code', 'a ``` b', null],
  ])('gives the closer of %s', (_name, text, closer) => {
    expect(openFenceCloser(text)).toBe(closer)
  })

  it('closes the fence for the parser', () => {
    const text = 'a\n\n````\nx'
    const closed = `${text}\n${openFenceCloser(text)}\n\n![id=a](/y.png)`

    expect(codeTexts(closed)).toStrictEqual(['````\nx\n````'])
  })
})
