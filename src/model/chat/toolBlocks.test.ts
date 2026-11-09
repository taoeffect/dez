import { describe, expect, it, vi } from 'vitest'
import type * as Registry from '../tools/registry'
import type { ToolDefinition } from '../tools/types'
import { SENTINEL_CHAR } from './content'
import {
  ModelTextEscaper,
  findToolBlocks,
  labelToolBlocks,
  toolBlockText,
  unescapeModelText,
  withoutToolBlocks,
  type ToolBlockData,
} from './toolBlocks'

// `model_list` has one string parameter; this tool gives the typed read
// every parameter type.
const { SAMPLE } = vi.hoisted(() => ({
  SAMPLE: {
    name: 'sample',
    description: 'A sample tool.',
    parameters: [
      { name: 'query', type: 'string', description: '', required: true },
      { name: 'limit', type: 'integer', description: '', required: false },
      { name: 'ratio', type: 'number', description: '', required: false },
      { name: 'exact', type: 'boolean', description: '', required: false },
    ],
  } satisfies ToolDefinition,
}))

vi.mock('../tools/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof Registry>()
  return { ...actual, toolDefinition: (name: string) => (name === SAMPLE.name ? SAMPLE : actual.toolDefinition(name)) }
})

const MODEL_LIST_CALL: ToolBlockData = {
  id: 'call_7Qx',
  name: 'model_list',
  status: 'success',
  arguments: { filter: 'gemini' },
  result: '1 model matches "gemini" (full id | name | provider):\nvenice/gemini-3-pro-preview | Gemini 3 Pro Preview | Venice',
}

function readBack(block: ToolBlockData): ToolBlockData[] {
  return findToolBlocks(toolBlockText(block)).map(({ from: _from, to: _to, ...data }) => data)
}

describe('toolBlockText and findToolBlocks', () => {
  it('writes the attributes in order on one line and the result as the body', () => {
    const text = toolBlockText(MODEL_LIST_CALL)

    expect(text).toBe([
      '<dez:tool id="call_7Qx" name="model_list" filter="gemini">',
      '1 model matches "gemini" (full id | name | provider):',
      'venice/gemini-3-pro-preview | Gemini 3 Pro Preview | Venice',
      '</dez:tool>',
    ].join('\n'))
    expect(findToolBlocks(`Let me look.\n${text}\nOne model.`)).toStrictEqual([
      { ...MODEL_LIST_CALL, from: 'Let me look.\n'.length, to: 'Let me look.\n'.length + text.length },
    ])
  })

  it('writes a status only for an error or a running call, and an empty result as no body line', () => {
    const running: ToolBlockData = { ...MODEL_LIST_CALL, status: 'running', arguments: {}, result: '' }
    const failed: ToolBlockData = { ...MODEL_LIST_CALL, name: 'web_search', status: 'error', arguments: {}, result: 'Unknown tool: web_search.' }

    expect(toolBlockText(running)).toBe('<dez:tool id="call_7Qx" name="model_list" status="running">\n</dez:tool>')
    expect(toolBlockText(failed)).toBe('<dez:tool id="call_7Qx" name="web_search" status="error">\nUnknown tool: web_search.\n</dez:tool>')
    expect(readBack(running)).toStrictEqual([running])
    expect(readBack(failed)).toStrictEqual([failed])
  })

  // Requests rebuild earlier calls from the blocks, and the prompt cache
  // needs the same bytes each time.
  it('reads back every result and argument value exactly', () => {
    const results = [
      '',
      '\n',
      '\n\n',
      'trailing newlines\n\n',
      '\nleading newline',
      'carriage\r\nreturns\r',
      '</dez:tool>',
      '  </dez:tool>  ',
      '<dez:tool id="x" name="y">',
      '<dez:pill type="user"/>',
      '<dez:pill type="agent">\nthinking\n</dez:pill>',
      '<dez:prompt name="p">\nbody\n</dez:prompt>',
      'already escaped <\\/dez:tool> and <\\\\dez:pill',
      '<!-- title: x | model: y | created: 2 -->',
    ]
    const filters = ['', 'gemini 3', 'say "hi" & <bye>', 'line\nbreak\r', '&quot; &amp; &#10;', '</dez:tool>', 'a/>b>']

    for (const result of results) {
      const block = { ...MODEL_LIST_CALL, result }
      expect(readBack(block), JSON.stringify(result)).toStrictEqual([block])
    }
    for (const filter of filters) {
      const block = { ...MODEL_LIST_CALL, id: filter, name: filter, status: 'error' as const, arguments: { filter } }
      expect(readBack(block), JSON.stringify(filter)).toStrictEqual([block])
      expect(toolBlockText(block).split('\n')[0]).toMatch(/^<dez:tool .*>$/)
    }
  })

  it('gives each parameter its type back from the tool definition', () => {
    const block: ToolBlockData = {
      ...MODEL_LIST_CALL,
      name: 'sample',
      arguments: { query: 'a "b" & c\nd', limit: 3, ratio: -5e-8, exact: false },
    }

    expect(toolBlockText(block).split('\n')[0])
      .toBe('<dez:tool id="call_7Qx" name="sample" query="a &quot;b&quot; &amp; c&#10;d" limit="3" ratio="-5e-8" exact="false">')
    expect(readBack(block)).toStrictEqual([block])
  })

  // Requests send the arguments in this order, so their bytes must not
  // depend on the key order a caller or a hand edit gives.
  it('orders the parameters by definition, then other attributes as given, and keeps a value that does not fit its type as text', () => {
    const written = toolBlockText({ ...MODEL_LIST_CALL, name: 'sample', arguments: { zeta: 'z', exact: true, alpha: 'a', query: 'q' } })
    const [block] = findToolBlocks([
      '<dez:tool  exact = "yes" name="sample" id="a" id="b" extra="1" limit="1.5" ratio="1/2" query="7" more="2" >',
      'r',
      '</dez:tool>',
    ].join('\n'))

    expect(written.split('\n')[0]).toBe('<dez:tool id="call_7Qx" name="sample" query="q" exact="true" zeta="z" alpha="a">')
    expect(block.id).toBe('a')
    expect(Object.entries(block.arguments))
      .toStrictEqual([['query', '7'], ['limit', '1.5'], ['ratio', '1/2'], ['exact', 'yes'], ['extra', '1'], ['more', '2']])
  })

  it('reads the arguments of a tool that Dez does not know as strings', () => {
    const [block] = findToolBlocks('<dez:tool id="a" name="web_search" limit="3" exact="true" __proto__="x">\n</dez:tool>')

    expect(block.arguments).toStrictEqual(Object.fromEntries([['limit', '3'], ['exact', 'true'], ['__proto__', 'x']]))
    expect(Object.hasOwn(block.arguments, '__proto__')).toBe(true)
  })

  it('reads any status other than running as an error', () => {
    const statusOf = (attribute: string) => findToolBlocks(`<dez:tool id="a" name="b"${attribute}>\n</dez:tool>`)[0].status

    expect(statusOf('')).toBe('success')
    expect(statusOf(' status="running"')).toBe('running')
    expect(statusOf(' status="error"')).toBe('error')
    expect(statusOf(' status="success"')).toBe('error')
    expect(statusOf(' status=""')).toBe('error')
  })

  it('finds a block only as whole lines, with an id, a name, and a closing line', () => {
    const block = toolBlockText(MODEL_LIST_CALL)
    const texts = [
      `x ${block}`,
      `${block} x`,
      `${block}x`,
      block.replace('\n</dez:tool>', '\n </dez:tool>'),
      '<dez:tool id="a" name="b">\nno closing line',
      '<dez:tool id="a" name="b">',
      '<dez:tool id="a" name="b">\n',
      '<dez:tool name="b">\nr\n</dez:tool>',
      '<dez:tool id="a">\nr\n</dez:tool>',
      '<dez:tool id="a"\nname="b">\nr\n</dez:tool>',
      '<dez:tool id="a" name="b"> x\nr\n</dez:tool>',
      "<dez:tool id='a' name='b'>\nr\n</dez:tool>",
      '<dez:tool id="a" name="b">\r\nr\r\n</dez:tool>',
    ]

    for (const text of texts) expect(findToolBlocks(text), JSON.stringify(text)).toStrictEqual([])
  })

  it('finds blocks next to each other, and leaves an opening tag whose body meets another tag as text', () => {
    const first = toolBlockText(MODEL_LIST_CALL)
    const second = toolBlockText({ ...MODEL_LIST_CALL, id: 'call_2', result: '' })
    const pair = `${first}\n${second}`
    const broken = `<dez:tool id="lost" name="model_list">\nhand edit\n${second}`

    expect(findToolBlocks(pair).map(({ id, from, to }) => [id, from, to])).toStrictEqual([
      ['call_7Qx', 0, first.length],
      ['call_2', first.length + 1, pair.length],
    ])
    expect(findToolBlocks(broken).map(({ id, from }) => [id, from])).toStrictEqual([['call_2', broken.length - second.length]])
  })

  it('removes live sentinels from every value it writes', () => {
    const text = toolBlockText({ ...MODEL_LIST_CALL, id: 'a\u001Eb', arguments: { filter: 'x\uE003y' }, result: 'one\u001E\ntwo\uE003' })

    expect(text).not.toMatch(SENTINEL_CHAR)
    expect(readBack({ ...MODEL_LIST_CALL, id: 'a\u001Eb', arguments: { filter: 'x\uE003y' }, result: 'one\u001E\ntwo\uE003' }))
      .toStrictEqual([{ ...MODEL_LIST_CALL, id: 'ab', arguments: { filter: 'x\ny' }, result: 'one\ntwo\n' }])
  })
})

describe('labelToolBlocks and withoutToolBlocks', () => {
  const block = toolBlockText(MODEL_LIST_CALL)

  it('replaces each block with a label', () => {
    expect(labelToolBlocks(`Look:\n${block}\n${block}\ndone`, ' ')).toBe('Look:\n \n \ndone')
  })

  it('joins the text around blocks with one blank line and drops blank pieces', () => {
    expect(withoutToolBlocks(`Let me look.\n${block}\nThere is one model.\n`)).toBe('Let me look.\n\nThere is one model.\n')
    expect(withoutToolBlocks(`Two lookups:  \n\n${block}\n${block}\n  \n${block}\n \n\n    indented code`))
      .toBe('Two lookups:\n\n    indented code')
    expect(withoutToolBlocks(`${block}\n${block}`)).toBe('')
  })

  it('gives a text with no block back as it is', () => {
    const text = '  no blocks\n\n<dez:tool id="a" name="b">\n'

    expect(withoutToolBlocks(text)).toBe(text)
    expect(labelToolBlocks(text, ' ')).toBe(text)
  })
})

describe('ModelTextEscaper', () => {
  function escapeAll(tokens: string[]): string {
    const escaper = new ModelTextEscaper()
    return tokens.map((token) => escaper.push(token)).join('') + escaper.flush()
  }

  const ANSWERS: [string, string][] = [
    ['Use <dez:tool id="a" name="b"> and </dez:tool> here', 'Use <\\dez:tool id="a" name="b"> and <\\/dez:tool> here'],
    ['<\\dez:tool and <\\\\/dez:tool', '<\\\\dez:tool and <\\\\\\/dez:tool'],
    ['<dez:pill type="user"/> <dez:toolbox> a < b <<dez:tool', '<dez:pill type="user"/> <\\dez:toolbox> a < b <<\\dez:tool'],
    ['ends in a partial tag <\\/dez:to', 'ends in a partial tag <\\/dez:to'],
  ]

  it('escapes every dez:tool tag run, and unescapeModelText gives the model text back', () => {
    for (const [answer, escaped] of ANSWERS) {
      expect(escapeAll([answer])).toBe(escaped)
      expect(unescapeModelText(escaped)).toBe(answer)
    }
  })

  it('gives the same text for a tag split across tokens at any point', () => {
    for (const [answer, escaped] of ANSWERS) {
      expect(escapeAll(Array.from(answer)), answer).toBe(escaped)
      for (let at = 0; at <= answer.length; at++) {
        expect(escapeAll([answer.slice(0, at), answer.slice(at)]), `${answer} at ${at}`).toBe(escaped)
      }
    }
  })

  it('holds back only a text end that can still become a tag', () => {
    const escaper = new ModelTextEscaper()

    expect(escaper.push('a < b')).toBe('a < b')
    expect(escaper.push(' x <\\')).toBe(' x ')
    expect(escaper.push('/dez:to')).toBe('')
    expect(escaper.push('ol>')).toBe('<\\\\/dez:tool>')
    expect(escaper.push('<dez')).toBe('')
    expect(escaper.flush()).toBe('<dez')
    expect(escaper.flush()).toBe('')
  })

  it('leaves a model no way to write a block', () => {
    const answer = `Here:\n${toolBlockText(MODEL_LIST_CALL)}\nDone.`

    expect(findToolBlocks(escapeAll([answer]))).toStrictEqual([])
  })
})
