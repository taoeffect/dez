import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderTemplate } from './template'

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('renderTemplate', () => {
  it('fills every placeholder, with or without spaces inside the braces', () => {
    expect(renderTemplate('You are {{model_name}} on {{ provider_name }}; again {{model_name}}.', {
      model_name: 'm-1',
      provider_name: 'venice',
    })).toBe('You are m-1 on venice; again m-1.')
  })

  it('inserts values as they are, never as template text or HTML', () => {
    expect(renderTemplate('{{a}}|{{b}}', { a: '{{b}} <b>&amp;', b: '$& $1 }}' })).toBe('{{b}} <b>&amp;|$& $1 }}')
  })

  it('ignores values that the template does not use', () => {
    expect(renderTemplate('Plain text.', { unused: 'x' })).toBe('Plain text.')
  })

  it('throws on a placeholder with no value, also one named like an Object.prototype member', () => {
    expect(() => renderTemplate('Hi {{name}}', {})).toThrow('no value for {{name}}')
    expect(() => renderTemplate('{{constructor}}', {})).toThrow('no value for {{constructor}}')
    expect(console.error).toHaveBeenCalled()
  })

  it('throws on braces that do not form a placeholder', () => {
    for (const template of [
      '{{Name}}', '{{ two words }}', '{{name', 'name}}', '{{}}', '{{1x}}',
      '{{{name}}}', '{{name}}}', '{{{name}}', 'a{{name}}}b',
    ]) {
      expect(() => renderTemplate(template, { name: 'x' }), template).toThrow('outside a {{name}} placeholder')
    }
  })
})
