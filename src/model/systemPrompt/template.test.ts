import { describe, expect, it } from 'vitest'
import { renderTemplate, STRAY_BRACE_PROBLEM } from './template'

describe('renderTemplate', () => {
  it('fills every placeholder, with or without spaces inside the braces', () => {
    expect(renderTemplate('You are {{model_name}} on {{ provider_name }}; again {{model_name}}.', {
      model_name: 'm-1',
      provider_name: 'venice',
    })).toStrictEqual({ text: 'You are m-1 on venice; again m-1.' })
  })

  it('inserts values as they are, never as template text or HTML', () => {
    expect(renderTemplate('{{a}}|{{b}}', { a: '{{b}} <b>&amp;', b: '$& $1 }}' })).toStrictEqual({ text: '{{b}} <b>&amp;|$& $1 }}' })
  })

  it('ignores values that the template does not use', () => {
    expect(renderTemplate('Plain text.', { unused: 'x' })).toStrictEqual({ text: 'Plain text.' })
  })

  it('names a placeholder with no value as it is written, with its line, also one named like an Object.prototype member', () => {
    expect(renderTemplate('Hi\r\n\nthere {{ name }}', {})).toStrictEqual({ problem: 'Line 3: {{ name }} is not a variable.' })
    expect(renderTemplate('{{constructor}}', {})).toStrictEqual({ problem: 'Line 1: {{constructor}} is not a variable.' })
  })

  it('finds braces that do not form a placeholder', () => {
    for (const template of [
      '{{Name}}', '{{ two words }}', '{{name', 'name}}', '{{}}', '{{1x}}',
      '{{{name}}}', '{{name}}}', '{{{name}}', 'a{{name}}}b',
    ]) {
      expect(renderTemplate(template, { name: 'x' }), template).toStrictEqual({ problem: `Line 1: ${STRAY_BRACE_PROBLEM}` })
    }
  })

  it('gives the line of the brace, also when the brace is next to a placeholder on a later line', () => {
    expect(renderTemplate('{{name}}\nok\nthen }} here', { name: 'x' })).toStrictEqual({ problem: `Line 3: ${STRAY_BRACE_PROBLEM}` })
    expect(renderTemplate('{{name}}\n\n{{{name}}', { name: 'x' })).toStrictEqual({ problem: `Line 3: ${STRAY_BRACE_PROBLEM}` })
    expect(renderTemplate('{{name}}\n}}{{name}}\n{', { name: 'x' })).toStrictEqual({ problem: `Line 2: ${STRAY_BRACE_PROBLEM}` })
  })

  it('gives the first problem in text order', () => {
    expect(renderTemplate('{{foo}}\n{{', {})).toStrictEqual({ problem: 'Line 1: {{foo}} is not a variable.' })
    expect(renderTemplate('{{\n{{foo}}', {})).toStrictEqual({ problem: `Line 1: ${STRAY_BRACE_PROBLEM}` })
  })
})
