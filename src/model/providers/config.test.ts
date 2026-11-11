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

  it('reserves the Thinking and Tools toggle keys for settings', () => {
    const withKey = (key: string) => providerConfigSchema.safeParse({
      id: 'p',
      name: 'P',
      baseUrl: 'http://h',
      settings: [{ key, label: 'K', type: 'boolean', default: true, bodyPath: 'options.flag' }],
    }).success

    expect(withKey('reasoning')).toBe(true)
    expect(withKey('thinking')).toBe(false)
    expect(withKey('tools')).toBe(false)
  })

  it('keeps the image, tool, and thinking fields, and rejects a bad capability path, model flag, or header', () => {
    const parse = (fields: Record<string, unknown>) =>
      providerConfigSchema.safeParse({ id: 'p', name: 'P', baseUrl: 'http://h', ...fields })
    const fields = {
      models: [{ id: 'm', imageInput: false, toolCalling: false, thinking: false }],
      modelImageInput: { path: 'architecture.input_modalities' },
      modelToolCalling: { path: 'supported_parameters', missing: false },
      modelThinking: { path: 'supported_parameters', missing: true },
      imageRequestHeaders: { 'X-Vision': 'true' },
    }

    expect(parse(fields).data).toMatchObject(fields)
    expect(parse({ modelImageInput: { path: 'architecture..input_modalities' } }).success).toBe(false)
    expect(parse({ modelImageInput: { path: '' } }).success).toBe(false)
    expect(parse({ modelToolCalling: { path: 'capabilities.' } }).success).toBe(false)
    expect(parse({ modelToolCalling: { path: 'tools', missing: 'no' } }).success).toBe(false)
    expect(parse({ modelThinking: { path: '.reasoning' } }).success).toBe(false)
    expect(parse({ modelThinking: 'supported_parameters' }).success).toBe(false)
    expect(parse({ models: [{ id: 'm', imageInput: 'yes' }] }).success).toBe(false)
    expect(parse({ models: [{ id: 'm', toolCalling: 1 }] }).success).toBe(false)
    expect(parse({ models: [{ id: 'm', thinking: 'off' }] }).success).toBe(false)
    expect(parse({ imageRequestHeaders: { 'Bad Name': 'true' } }).success).toBe(false)
  })

  it('keeps where the model list tells which models take a toggle, and rejects a bad path', () => {
    const setting = { key: 'k', label: 'K', type: 'boolean', default: true, bodyPath: 'options.flag' }
    const parse = (modelSupport: unknown) =>
      providerConfigSchema.safeParse({ id: 'p', name: 'P', baseUrl: 'http://h', settings: [{ ...setting, modelSupport }] })

    expect(parse({ path: 'caps.flag', missing: false }).data?.settings).toStrictEqual([{ ...setting, modelSupport: { path: 'caps.flag', missing: false } }])
    expect(parse({ path: 'caps..flag' }).success).toBe(false)
    expect(parse({ missing: true }).success).toBe(false)
    expect(parse('caps.flag').success).toBe(false)
  })

  it('keeps a model\'s outputs and request kind, and rejects unknown values or an empty outputs list', () => {
    const parseModel = (model: Record<string, unknown>) =>
      providerConfigSchema.safeParse({ id: 'p', name: 'P', baseUrl: 'http://h', models: [{ id: 'm', ...model }] })
    const fields = { outputs: ['image', 'text'], request: 'imageEdit' }

    expect(parseModel(fields).data?.models).toStrictEqual([{ id: 'm', ...fields }])
    // A config model is always listed, so it must make something.
    expect(parseModel({ outputs: [] }).success).toBe(false)
    expect(parseModel({ outputs: ['speech'] }).success).toBe(false)
    expect(parseModel({ outputs: 'image' }).success).toBe(false)
    expect(parseModel({ request: 'speech' }).success).toBe(false)
  })

  it('keeps the model list query, the output type mapping, and the media API, and rejects bad ones', () => {
    const parse = (fields: Record<string, unknown>) =>
      providerConfigSchema.safeParse({ id: 'p', name: 'P', baseUrl: 'http://h', ...fields })
    const outputs = (values: unknown) => parse({ modelOutputs: { path: 'type', values } }).success
    const fields = {
      modelListQuery: { type: 'all' },
      // A type that makes nothing (embeddings) needs an empty list, unlike a
      // config model's outputs.
      modelOutputs: {
        path: 'arch.out',
        values: {
          text: { outputs: ['text'], request: 'chat' },
          image: { outputs: ['image'], requiredPath: 'price.image' },
          // The request kind depends on a second value of the entry.
          video: { outputs: ['video'], requestBy: { path: 'spec.kind', values: { 'text-to-video': 'video' } } },
          embed: { outputs: [] },
        },
      },
      imageOutputBody: { modalities: ['image', 'text'] },
      mediaApi: { format: 'openrouter', modelRequestBodies: [{ request: 'tts', modelIdPrefix: 'heygen/', body: { response_format: 'pcm' } }] },
    }

    expect(parse(fields).data).toMatchObject(fields)
    expect(parse({ modelListQuery: { limit: 10 } }).success).toBe(false)
    expect(parse({ modelOutputs: { path: 'arch..out', values: {} } }).success).toBe(false)
    expect(parse({ modelOutputs: { path: 'type' } }).success).toBe(false)
    expect(outputs({ tts: { outputs: ['speech'] } })).toBe(false)
    expect(outputs({ tts: { outputs: 'audio' } })).toBe(false)
    expect(outputs({ tts: { request: 'chat' } })).toBe(false)
    expect(outputs({ video: { outputs: ['video'], request: 'speech' } })).toBe(false)
    expect(outputs({ video: { outputs: ['video'], requestBy: { path: 'spec..kind', values: {} } } })).toBe(false)
    expect(outputs({ video: { outputs: ['video'], requestBy: { path: 'spec.kind', values: { 'text-to-video': 'film' } } } })).toBe(false)
    expect(outputs({ video: { outputs: ['video'], requestBy: { path: 'spec.kind' } } })).toBe(false)
    expect(outputs({ image: { outputs: ['image'], requiredPath: 'price..image' } })).toBe(false)
    expect(parse({ imageOutputBody: ['image'] }).success).toBe(false)
    expect(parse({ mediaApi: { format: 'openai' } }).success).toBe(false)
    expect(parse({ mediaApi: {} }).success).toBe(false)
  })

  it('takes a model request body only for a media kind, a model id prefix, and a JSON object', () => {
    const parse = (part: Record<string, unknown>) => providerConfigSchema.safeParse({
      id: 'p',
      name: 'P',
      baseUrl: 'http://h',
      mediaApi: { format: 'venice', modelRequestBodies: [{ request: 'music', modelIdPrefix: 'song-', body: { loop: true }, ...part }] },
    }).success

    expect(parse({})).toBe(true)
    // A chat request gets its fixed body part from `requestBody`.
    expect(parse({ request: 'chat' })).toBe(false)
    expect(parse({ request: 'none' })).toBe(false)
    // An empty prefix would name every model.
    expect(parse({ modelIdPrefix: '' })).toBe(false)
    expect(parse({ body: ['pcm'] })).toBe(false)
    expect(parse({ body: JSON.parse('{"__proto__":{"polluted":true}}') })).toBe(false)
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

  it('rejects body part keys that name Object.prototype members, at any depth', () => {
    // JSON.parse makes `__proto__` an own key, as in a hand-edited app_state.json.
    const parseJson = (fields: string) => providerConfigSchema.safeParse({
      id: 'p',
      name: 'P',
      baseUrl: 'http://h',
      ...JSON.parse(fields),
    })

    expect(parseJson('{"thinking":{"enabledBody":{"reasoning":{"enabled":true}}}}').success).toBe(true)
    expect(parseJson('{"thinking":{"enabledBody":{"__proto__":{"polluted":true}}}}').success).toBe(false)
    expect(parseJson('{"thinking":{"enabledBody":{"a":{"__proto__":{"polluted":true}}}}}').success).toBe(false)
    expect(parseJson('{"thinking":{"disabledBody":{"constructor":{"prototype":1}}}}').success).toBe(false)
    expect(parseJson('{"thinking":{"disabledBody":{"list":[{"prototype":1}]}}}').success).toBe(false)
    expect(parseJson('{"requestBody":{"options":{"fixed":true}}}').data?.requestBody).toEqual({ options: { fixed: true } })
    expect(parseJson('{"requestBody":{"options":{"__proto__":{"polluted":true}}}}').success).toBe(false)
    expect(parseJson('{"requestBody":["options"]}').success).toBe(false)
    expect(parseJson('{"imageOutputBody":{"image_config":{"__proto__":{"polluted":true}}}}').success).toBe(false)
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
