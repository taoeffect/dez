import { describe, expect, it } from 'vitest'
import { parseToolArguments } from './arguments'
import type { ToolDefinition } from './types'

const SAMPLE: ToolDefinition = {
  name: 'sample',
  description: 'A sample tool.',
  parameters: [
    { name: 'query', type: 'string', description: 'The query.', required: true },
    { name: 'limit', type: 'integer', description: 'The limit.', required: false },
    { name: 'ratio', type: 'number', description: 'The ratio.', required: false },
    { name: 'exact', type: 'boolean', description: 'Exact match.', required: false },
  ],
}

const NO_PARAMETERS: ToolDefinition = { name: 'bare', description: 'No parameters.', parameters: [] }

const SAMPLE_PARAMETERS = 'The parameters of sample are: query (string, required), limit (integer), ratio (number), exact (boolean).'
const SAMPLE_FORM = `Send one JSON object, as in {"query": "..."}. ${SAMPLE_PARAMETERS}`
const MISSING_QUERY = 'The required parameter "query" is missing. Add it as a string, as in {"query": "..."}.'

describe('parseToolArguments', () => {
  it('gives typed values in definition order', () => {
    const result = parseToolArguments(SAMPLE, '{"exact":false,"ratio":0.5,"limit":3,"query":"gemini"}')
    expect(result).toStrictEqual({ ok: true, arguments: { query: 'gemini', limit: 3, ratio: 0.5, exact: false } })
    expect(result.ok && Object.keys(result.arguments)).toStrictEqual(['query', 'limit', 'ratio', 'exact'])
  })

  it('reads null and absent optional values as absent', () => {
    expect(parseToolArguments(SAMPLE, '{"query":"a","limit":null}')).toStrictEqual({ ok: true, arguments: { query: 'a' } })
  })

  it('reads blank text as no arguments', () => {
    expect(parseToolArguments(NO_PARAMETERS, '')).toStrictEqual({ ok: true, arguments: {} })
    expect(parseToolArguments(NO_PARAMETERS, ' \n')).toStrictEqual({ ok: true, arguments: {} })
    expect(parseToolArguments(SAMPLE, '')).toStrictEqual({ ok: false, error: MISSING_QUERY })
  })

  it('refuses a missing or null required value', () => {
    expect(parseToolArguments(SAMPLE, '{}')).toStrictEqual({ ok: false, error: MISSING_QUERY })
    expect(parseToolArguments(SAMPLE, '{"query":null}')).toStrictEqual({ ok: false, error: MISSING_QUERY })
  })

  it('refuses text that is not a JSON object, and gives an example call and the parameters', () => {
    expect(parseToolArguments(SAMPLE, '{"query":')).toStrictEqual({ ok: false, error: `The arguments are not valid JSON. ${SAMPLE_FORM}` })
    for (const json of ['null', '[]', '"query"', '3']) {
      expect(parseToolArguments(SAMPLE, json)).toStrictEqual({ ok: false, error: `The arguments are not a JSON object. ${SAMPLE_FORM}` })
    }
  })

  it('gives an example with the first parameter of a tool with no required one, and {} for a tool with none', () => {
    const optional: ToolDefinition = { ...SAMPLE, parameters: SAMPLE.parameters.slice(1) }
    expect(parseToolArguments(optional, '[]')).toStrictEqual({
      ok: false,
      error: 'The arguments are not a JSON object. Send one JSON object, as in {"limit": 1}. '
        + 'The parameters of sample are: limit (integer), ratio (number), exact (boolean).',
    })
    expect(parseToolArguments(NO_PARAMETERS, '{')).toStrictEqual({
      ok: false,
      error: 'The arguments are not valid JSON. bare has no parameters: send {} as the arguments.',
    })
  })

  it('refuses an unknown key, even one that names an Object.prototype member, and lists the parameters', () => {
    expect(parseToolArguments(SAMPLE, '{"query":"a","Query":"b"}')).toStrictEqual({ ok: false, error: `sample has no parameter "Query". ${SAMPLE_PARAMETERS}` })
    expect(parseToolArguments(SAMPLE, '{"query":"a","__proto__":{}}')).toStrictEqual({ ok: false, error: `sample has no parameter "__proto__". ${SAMPLE_PARAMETERS}` })
    expect(parseToolArguments(NO_PARAMETERS, '{"query":"a"}')).toStrictEqual({
      ok: false,
      error: 'bare has no parameter "query". bare has no parameters: send {} as the arguments.',
    })
  })

  it('does not read an absent parameter from Object.prototype', () => {
    const tool: ToolDefinition = { ...NO_PARAMETERS, parameters: [{ name: 'constructor', type: 'string', description: '', required: false }] }
    expect(parseToolArguments(tool, '{}')).toStrictEqual({ ok: true, arguments: {} })
  })

  it('refuses a value of the wrong type, with no coercion, and gives a value of the right type', () => {
    const mustBe = (name: string, type: string, example: string) => ({ ok: false, error: `The parameter "${name}" must be ${type}, as in {"${name}": ${example}}.` })
    expect(parseToolArguments(SAMPLE, '{"query":3}')).toStrictEqual(mustBe('query', 'a string', '"..."'))
    expect(parseToolArguments(SAMPLE, '{"query":"a","limit":"3"}')).toStrictEqual(mustBe('limit', 'an integer', '1'))
    expect(parseToolArguments(SAMPLE, '{"query":"a","limit":1.5}')).toStrictEqual(mustBe('limit', 'an integer', '1'))
    expect(parseToolArguments(SAMPLE, '{"query":"a","ratio":true}')).toStrictEqual(mustBe('ratio', 'a number', '1.5'))
    expect(parseToolArguments(SAMPLE, '{"query":"a","exact":"true"}')).toStrictEqual(mustBe('exact', 'true or false', 'true'))
  })

  it('refuses a number too large for a finite value', () => {
    const error = 'The parameter "ratio" must be a number, as in {"ratio": 1.5}.'
    expect(parseToolArguments(SAMPLE, '{"query":"a","ratio":1e999}')).toStrictEqual({ ok: false, error })
    expect(parseToolArguments(SAMPLE, '{"query":"a","ratio":-1e999}')).toStrictEqual({ ok: false, error })
  })

  it('accepts a whole number written with a fraction as an integer', () => {
    expect(parseToolArguments(SAMPLE, '{"query":"a","limit":2.0}')).toStrictEqual({ ok: true, arguments: { query: 'a', limit: 2 } })
  })
})
