import { describe, expect, it, vi } from 'vitest'
import type * as Registry from '../tools/registry'
import type { ToolDefinition } from '../tools/types'
import { compactionTagText, readCompactionTag } from './compaction'
import { SENTINEL_CHAR } from './content'
import { findMediaTags } from './mediaTags'
import {
  ModelTextEscaper,
  agentTextForRequest,
  escapedModelText,
  findToolBlocks,
  labelToolBlocks,
  unescapedModelText,
  toolBlockText,
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

  it('writes the pictures of a call after the status and reads them back, and reads a value that is not the writer\'s form as no pictures', () => {
    const fox = { file: 'f-1.png', label: 'asset_view: the image @a.' }
    const block: ToolBlockData = {
      id: 'call_1',
      name: 'asset_view',
      status: 'success',
      arguments: { assets: '@a @b' },
      result: '@a | image | PNG',
      pictures: [fox, { file: 'f_2.jpg', label: 'A "sheet" & more\nlines' }],
    }
    const picturesOf = (value: string) => findToolBlocks(`<dez:tool id="a" name="asset_view" pictures="${value}">\n</dez:tool>`)[0]
    const one = (file: string) => `[{&quot;file&quot;:&quot;${file}&quot;,&quot;label&quot;:&quot;x&quot;}]`

    expect(toolBlockText({ ...block, pictures: [fox] }).split('\n')[0]).toBe(
      '<dez:tool id="call_1" name="asset_view" pictures="[{&quot;file&quot;:&quot;f-1.png&quot;,&quot;label&quot;:&quot;asset_view: the image @a.&quot;}]" assets="@a @b">',
    )
    expect(readBack(block)).toStrictEqual([block])
    expect(toolBlockText({ ...block, pictures: [] })).not.toContain('pictures')
    // A hand edit: no JSON, no list, a file outside the views folder, a
    // file of no image type, no label.
    for (const value of ['', 'x', '[]', '{}', one('../../provider_keys.json'), one('a.txt'), '[{&quot;file&quot;:&quot;a.png&quot;}]']) {
      expect(picturesOf(value), value).toStrictEqual({ from: expect.any(Number), to: expect.any(Number), id: 'a', name: 'asset_view', status: 'success', arguments: {}, result: '' })
    }
    expect(picturesOf(one('a.png')).pictures).toStrictEqual([{ file: 'a.png', label: 'x' }])
  })

  // The size and the byte count give the cost of a picture in a request.
  it('keeps the size and the byte count of a picture, reads a copy of an older Dez with none, and reads no picture with a bad number', () => {
    const wave = { file: 'w1.jpg', label: 'The wave of @b.', width: 800, height: 200, bytes: 3000 }
    const block: ToolBlockData = { id: 'call_1', name: 'asset_view', status: 'success', arguments: { assets: '@b' }, result: '@b | audio | WAV', pictures: [wave, { file: 'old.png', label: 'An old copy.' }] }
    const picturesOf = (picture: object) => findToolBlocks(toolBlockText({ ...block, pictures: [picture as typeof wave] }))[0].pictures

    expect(toolBlockText({ ...block, pictures: [wave] }).split('\n')[0]).toContain('&quot;width&quot;:800,&quot;height&quot;:200,&quot;bytes&quot;:3000}]"')
    expect(readBack(block)).toStrictEqual([block])
    // An empty file has a byte count.
    expect(picturesOf({ ...wave, bytes: 0 })).toStrictEqual([{ ...wave, bytes: 0 }])
    for (const bad of [{ width: 0 }, { height: -200 }, { width: 800.5 }, { bytes: -1 }, { bytes: '3000' }]) {
      expect(picturesOf({ ...wave, ...bad }), JSON.stringify(bad)).toBeUndefined()
    }
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
    const withSentinels = { ...MODEL_LIST_CALL, id: 'a\u001Eb', arguments: { filter: 'x\uE003y' }, result: 'one\u001E\ntwo\uE003' }

    expect(toolBlockText(withSentinels)).not.toMatch(SENTINEL_CHAR)
    expect(readBack(withSentinels)).toStrictEqual([{ ...MODEL_LIST_CALL, id: 'ab', arguments: { filter: 'x\ny' }, result: 'one\ntwo\n' }])
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
    ['<dez:audio id="a" type="audio/mpeg"/>\n<dez:video id="b" type="video/mp4"/>', '<\\dez:audio id="a" type="audio/mpeg"/>\n<\\dez:video id="b" type="video/mp4"/>'],
    ['<\\dez:video and </dez:audio> and <dez:videos', '<\\\\dez:video and <\\/dez:audio> and <\\dez:videos'],
    ['<dez:image id="a"/> <dez:audi o> <dez:vide', '<dez:image id="a"/> <dez:audi o> <dez:vide'],
    ['<dez:compaction count="2"/>\nNotes about <\\dez:compaction and <dez:compact', '<\\dez:compaction count="2"/>\nNotes about <\\\\dez:compaction and <dez:compact'],
  ]

  it('escapes every dez:tool, dez:audio, dez:video, and dez:compaction tag run, and agentTextForRequest gives the model text back', () => {
    for (const [answer, escaped] of ANSWERS) {
      expect(escapeAll([answer])).toBe(escaped)
      expect(agentTextForRequest(escaped)).toBe(answer)
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

  it('holds back a text end that can still become a media tag, and no longer than that', () => {
    const escaper = new ModelTextEscaper()

    expect(escaper.push('See <dez:a')).toBe('See ')
    expect(escaper.push('udi')).toBe('')
    expect(escaper.push('t')).toBe('<dez:audit')
    expect(escaper.push('<dez:vide')).toBe('')
    expect(escaper.push('o id="b"/>')).toBe('<\\dez:video id="b"/>')
    expect(escaper.flush()).toBe('')
  })

  it('leaves a model no way to write a block', () => {
    const answer = `Here:\n${toolBlockText(MODEL_LIST_CALL)}\nDone.`

    expect(findToolBlocks(escapeAll([answer]))).toStrictEqual([])
  })

  it('leaves a model no way to write a media tag', () => {
    const answer = 'Here:\n<dez:video id="b" type="video/mp4" src="/etc/passwd"/>\n<dez:audio id="c" type="audio/mpeg"/>'

    expect(findMediaTags(answer)).toHaveLength(2)
    expect(findMediaTags(escapeAll(Array.from(answer)))).toStrictEqual([])
  })

  it('leaves a model no way to write a compaction tag', () => {
    const answer = `${compactionTagText({ count: 3, lastId: 'k', pictures: [] })}\nNotes`

    expect(readCompactionTag(answer)).not.toBeNull()
    expect(readCompactionTag(escapeAll(Array.from(answer)))).toBeNull()
  })
})

describe('agentTextForRequest', () => {
  const TAG = '<dez:video id="b" type="video/mp4" src="/home/ann/.config/dez/assets/generated/video/v1.mp4" url="https://cdn.example/v.mp4?sig=1" expires="2026-11-11T09:30:00.000Z" job="j-1"/>'

  it('sends each media tag with only its id and its type', () => {
    expect(agentTextForRequest(`Done.\n\n${TAG}\n<dez:audio id="c" type="audio/mpeg"/>\nMore?`))
      .toBe('Done.\n\n<dez:video id="b" type="video/mp4"/>\n<dez:audio id="c" type="audio/mpeg"/>\nMore?')
  })

  it('sends a tag that a model wrote as the model wrote it, next to a tag of Dez', () => {
    const answer = 'I can write <dez:video id="z" type="video/mp4" url="https://x.example/z"/> too:\n<dez:video id="z" type="video/mp4" url="https://x.example/z"/>'
    const escaper = new ModelTextEscaper()
    const stored = `${escaper.push(answer)}${escaper.flush()}\n${TAG}`

    expect(agentTextForRequest(stored)).toBe(`${answer}\n<dez:video id="b" type="video/mp4"/>`)
  })
})

describe('escapedModelText and unescapedModelText', () => {
  const answer = `Here:\n${toolBlockText(MODEL_LIST_CALL)}\n<dez:audio id="a" type="audio/wav"/>\nThe old form <\\dez:tool stays.`

  it('escape a whole text so that it forms no tool block and no media tag, and give it back', () => {
    const escaped = escapedModelText(answer)

    expect(findToolBlocks(answer)).toHaveLength(1)
    expect(findMediaTags(answer)).toHaveLength(1)
    expect(findToolBlocks(escaped)).toStrictEqual([])
    expect(findMediaTags(escaped)).toStrictEqual([])
    expect(unescapedModelText(escaped)).toBe(answer)
  })

  it('escape a whole text as ModelTextEscaper escapes it in a stream', () => {
    const escaper = new ModelTextEscaper()

    expect(escapedModelText(answer)).toBe(escaper.push(answer) + escaper.flush())
  })
})
