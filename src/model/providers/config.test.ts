import { describe, expect, it } from 'vitest'
import { BUILT_IN_PROVIDER_CONFIGS, BUILT_IN_PROVIDER_IDS } from './builtins'
import { configIssueText, customProviderConfigSchema, providerConfigSchema } from './config'

describe('provider config schema', () => {
  it('fills defaults, trims text, and drops unknown keys such as apiKey', () => {
    const config = customProviderConfigSchema.parse({
      id: 'local',
      name: '  Local server  ',
      baseUrl: ' http://localhost:8080/v1// ',
      apiKey: 'sk-plain-text',
    })

    expect(config).toEqual({
      id: 'local',
      name: 'Local server',
      baseUrl: 'http://localhost:8080/v1',
      apiFormat: 'openai',
      models: [],
      fetchModels: true,
      auth: 'apiKey',
    })
  })

  it('accepts only ids of 1-64 letters, digits, "-" and "_" that are not reserved', () => {
    const valid = (id: string) => providerConfigSchema.safeParse({ id, name: 'P', baseUrl: 'http://h' }).success

    expect(valid('my-server_2')).toBe(true)
    expect(valid('x'.repeat(64))).toBe(true)
    expect(valid('x'.repeat(65))).toBe(false)
    expect(valid('')).toBe(false)
    expect(valid('ollama/local')).toBe(false)
    expect(valid('has space')).toBe(false)
    // Ids are keys of plain objects and of the picker's Favorites group.
    expect(valid('__proto__')).toBe(false)
    expect(valid('constructor')).toBe(false)
    expect(valid('toString')).toBe(false)
    expect(valid('__favorites__')).toBe(false)
  })

  it('requires a name and an http or https base URL', () => {
    const valid = (name: string, baseUrl: string) =>
      providerConfigSchema.safeParse({ id: 'p', name, baseUrl }).success

    expect(valid('P', 'https://api.example.com/v1')).toBe(true)
    expect(valid('   ', 'http://localhost:8080/v1')).toBe(false)
    expect(valid('P', 'localhost:8080/v1')).toBe(false)
    expect(valid('P', 'ftp://example.com')).toBe(false)
    expect(valid('P', 'not a url')).toBe(false)
  })

  it('rejects base URLs that would swallow request paths or hold credentials', () => {
    const valid = (baseUrl: string) =>
      providerConfigSchema.safeParse({ id: 'p', name: 'P', baseUrl }).success

    // Request paths are added as text, so a query or fragment would end up
    // in front of them, even an empty one.
    expect(valid('https://host/v1?api-version=1')).toBe(false)
    expect(valid('https://host/v1?')).toBe(false)
    expect(valid('https://host/v1#part')).toBe(false)
    expect(valid('https://host/v1#')).toBe(false)
    expect(valid('https://host/v1/?a=1/')).toBe(false)
    // app_state.json holds the base URL in plain text.
    expect(valid('https://user:pass@host/v1')).toBe(false)
    expect(valid('https://user@host/v1')).toBe(false)
    expect(valid('https://:pass@host/v1')).toBe(false)
    // An encoded "?" is part of the path.
    expect(valid('https://host/v%3F1')).toBe(true)
  })

  it('rejects headers the native HTTP bridge cannot send, naming the header', () => {
    const parse = (headers: Record<string, string>) =>
      providerConfigSchema.safeParse({ id: 'p', name: 'P', baseUrl: 'http://h', headers })
    const issueText = (headers: Record<string, string>) => {
      const result = parse(headers)
      return result.success ? '' : configIssueText(result.error)
    }

    expect(parse({ 'X-Api_Key.2': 'tab\tand UTF-8 é are sent' }).success).toBe(true)
    expect(issueText({ 'X Api': 'v' })).toMatch(/^headers\.X Api: /)
    expect(parse({ '': 'v' }).success).toBe(false)
    expect(parse({ 'X:Api': 'v' }).success).toBe(false)
    expect(issueText({ 'X-Api': 'a\r\nInjected: 1' })).toMatch(/^headers\.X-Api: /)
    expect(parse({ 'X-Api': 'a\u0000b' }).success).toBe(false)
    expect(parse({ 'X-Api': 'a\u001Fb' }).success).toBe(false)
    expect(parse({ 'X-Api': 'a\u007Fb' }).success).toBe(false)
  })

  it('keeps built-in ids and GitHub Copilot sign-in away from custom providers', () => {
    const base = { name: 'P', baseUrl: 'http://localhost:8080/v1' }

    expect(customProviderConfigSchema.safeParse({ ...base, id: 'openrouter' }).success).toBe(false)
    expect(customProviderConfigSchema.safeParse({ ...base, id: 'p', auth: 'githubCopilot' }).success).toBe(false)
    expect(providerConfigSchema.safeParse({ ...base, id: 'openrouter', auth: 'githubCopilot' }).success).toBe(true)
  })

  it('rejects setting body paths with empty or __proto__ segments', () => {
    const withPath = (bodyPath: string) => providerConfigSchema.safeParse({
      id: 'p',
      name: 'P',
      baseUrl: 'http://h',
      settings: [{ key: 'k', label: 'K', type: 'boolean', default: true, bodyPath }],
    }).success

    expect(withPath('options.flag')).toBe(true)
    expect(withPath('__proto__.flag')).toBe(false)
    expect(withPath('options..flag')).toBe(false)
    expect(withPath('')).toBe(false)
  })

  it('reserves the Thinking toggle key for settings', () => {
    const withKey = (key: string) => providerConfigSchema.safeParse({
      id: 'p',
      name: 'P',
      baseUrl: 'http://h',
      settings: [{ key, label: 'K', type: 'boolean', default: true, bodyPath: 'options.flag' }],
    }).success

    expect(withKey('reasoning')).toBe(true)
    expect(withKey('thinking')).toBe(false)
  })

  it('keeps the image fields, and rejects a bad image path, model flag, or header', () => {
    const parse = (fields: Record<string, unknown>) =>
      providerConfigSchema.safeParse({ id: 'p', name: 'P', baseUrl: 'http://h', ...fields })
    const fields = {
      models: [{ id: 'm', imageInput: false }],
      modelImageInput: { path: 'architecture.input_modalities' },
      imageRequestHeaders: { 'X-Vision': 'true' },
    }

    expect(parse(fields).data).toMatchObject(fields)
    expect(parse({ modelImageInput: { path: 'architecture..input_modalities' } }).success).toBe(false)
    expect(parse({ modelImageInput: { path: '' } }).success).toBe(false)
    expect(parse({ models: [{ id: 'm', imageInput: 'yes' }] }).success).toBe(false)
    expect(parse({ imageRequestHeaders: { 'Bad Name': 'true' } }).success).toBe(false)
  })

  it('keeps an empty thinking object and accepts only JSON objects as bodies', () => {
    const parse = (thinking: unknown) => providerConfigSchema.safeParse({ id: 'p', name: 'P', baseUrl: 'http://h', thinking })
    const bodies = {
      enabledBody: { reasoning: { enabled: true, effort: null, levels: ['low', 2] } },
      disabledBody: { venice_parameters: { disable_thinking: true } },
    }

    // Present means "supports thinking", so an empty object must survive.
    expect(parse({}).data?.thinking).toEqual({})
    expect(parse(bodies).data?.thinking).toEqual(bodies)
    expect(parse({ enabledBody: 'reasoning' }).success).toBe(false)
    expect(parse({ enabledBody: [{ reasoning: true }] }).success).toBe(false)
    expect(parse({ disabledBody: { when: () => false } }).success).toBe(false)
  })

  it('rejects thinking body keys that name Object.prototype members, at any depth', () => {
    // JSON.parse makes `__proto__` an own key, as in a hand-edited app_state.json.
    const parseJson = (thinking: string) => providerConfigSchema.safeParse({
      id: 'p',
      name: 'P',
      baseUrl: 'http://h',
      thinking: JSON.parse(thinking),
    })

    expect(parseJson('{"enabledBody":{"reasoning":{"enabled":true}}}').success).toBe(true)
    expect(parseJson('{"enabledBody":{"__proto__":{"polluted":true}}}').success).toBe(false)
    expect(parseJson('{"enabledBody":{"a":{"__proto__":{"polluted":true}}}}').success).toBe(false)
    expect(parseJson('{"disabledBody":{"constructor":{"prototype":1}}}').success).toBe(false)
    expect(parseJson('{"disabledBody":{"list":[{"prototype":1}]}}').success).toBe(false)
  })

  it('writes every built-in exactly as the schema would produce it', () => {
    // Built-ins skip the schema at run time, so each literal must already be
    // in the schema's output form.
    for (const config of BUILT_IN_PROVIDER_CONFIGS) {
      expect(providerConfigSchema.parse(config)).toEqual(config)
    }
    expect(new Set(BUILT_IN_PROVIDER_IDS).size).toBe(BUILT_IN_PROVIDER_IDS.length)
  })
})
