import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { MAX_OPEN_JOBS } from '../tools/jobs'
import { defaultAppState, parseAppStateJson, serializeAppStateJson } from './appState'

describe('app state persistence format', () => {
  it('falls back to default app state when JSON is malformed', () => {
    expect(parseAppStateJson('{')).toEqual(defaultAppState())
  })

  it('filters invalid tabs and preserves valid persisted settings', () => {
    const state = parseAppStateJson(JSON.stringify({
      tabs: [
        {
          id: 'tab',
          title: 'Existing Tab',
          conversationId: 'conversation',
          activeModel: { providerId: 'openrouter', modelId: 'model', modelName: 'Model' },
          createdAt: 34,
        },
        { id: 'missing fields' },
        null,
      ],
      activeTabId: 'tab',
      theme: 'dark',
      editorFontSize: 18,
      defaultNewTabModel: { providerId: 'openrouter', modelId: 'model' },
      lastUsedModel: { providerId: 'zai', modelId: 'chat' },
      favorites: [{ providerId: 'venice', modelId: 'llm' }, null],
      modelOutputFilter: ['video', 'image'],
      providerSettings: { venice: { webSearch: false, veniceSystemPrompt: true } },
      checkForUpdates: false,
      lastUpdateCheckAt: 12,
      doneSound: false,
      doneSoundVolume: 35,
      doneNotification: false,
      shortcuts: { closeTab: 'alt-k', bogus: 'Alt-j', newTab: 'Escape' },
      systemPrompt: 'You are {{model_id}}.\n',
    }))

    expect(state.tabs).toEqual([{
      id: 'tab',
      title: 'Existing Tab',
      conversationId: 'conversation',
      activeModel: { providerId: 'openrouter', modelId: 'model', modelName: 'Model' },
      createdAt: 34,
    }])
    expect(parseAppStateJson('{ "tabs": [null], "activeTabId": null }').tabs).toEqual([])
    expect(state.activeTabId).toBe('tab')
    expect(state.theme).toBe('dark')
    expect(state.editorFontSize).toBe(18)
    expect(state.defaultNewTabModel).toEqual({ providerId: 'openrouter', modelId: 'model' })
    expect(state.lastUsedModel).toEqual({ providerId: 'zai', modelId: 'chat' })
    expect(state.favorites).toEqual([{ providerId: 'venice', modelId: 'llm' }])
    expect(state.modelOutputFilter).toEqual(['image', 'video'])
    expect(state.providerSettings).toEqual({ venice: { webSearch: false, veniceSystemPrompt: true } })
    expect(state.checkForUpdates).toBe(false)
    expect(state.lastUpdateCheckAt).toBe(12)
    expect(state.doneSound).toBe(false)
    expect(state.doneSoundVolume).toBe(35)
    expect(state.doneNotification).toBe(false)
    expect(state.shortcuts).toEqual({ closeTab: 'Alt-k' })
    expect(state.systemPrompt).toBe('You are {{model_id}}.\n')
    expect(parseAppStateJson('{ "shortcuts": "Alt-k" }').shortcuts).toEqual({})
    expect(parseAppStateJson(serializeAppStateJson(state))).toEqual(state)
  })

  it('keeps the incognito flag and the sent mark of a tab, and drops a bad mark but not its tab', () => {
    const tab = { id: 'tab', title: 'Tab', conversationId: 'conversation', activeModel: null, createdAt: 34 }
    const parseTabs = (tabs: unknown[]) => parseAppStateJson(JSON.stringify({ tabs })).tabs
    const marked = parseTabs([{ ...tab, incognito: true, requestSent: true }])

    expect(marked).toStrictEqual([{ ...tab, incognito: true, requestSent: true }])
    expect(parseAppStateJson(serializeAppStateJson({ tabs: marked })).tabs).toStrictEqual(marked)
    expect(parseTabs([{ ...tab, incognito: 'yes', requestSent: false }])).toEqual([tab])
  })

  // A bad flag allows no unknown price: the side that spends less.
  it('keeps the money limit of a tab, drops a limit with a bad sum but not its tab, and reads a bad flag as off', () => {
    const tab = { id: 'tab', title: 'Tab', conversationId: 'conversation', activeModel: null, createdAt: 34 }
    const parseTabs = (tabs: unknown[]) => parseAppStateJson(JSON.stringify({ tabs })).tabs
    const limited = parseTabs([{ ...tab, moneyLimit: { usd: 2.5, unknownPrices: true } }])

    expect(limited).toStrictEqual([{ ...tab, moneyLimit: { usd: 2.5, unknownPrices: true } }])
    expect(parseAppStateJson(serializeAppStateJson({ tabs: limited })).tabs).toStrictEqual(limited)
    expect(parseTabs([{ ...tab, moneyLimit: { usd: 2.5, unknownPrices: 'yes' } }])).toStrictEqual([{ ...tab, moneyLimit: { usd: 2.5, unknownPrices: false } }])
    expect(parseTabs([{ ...tab, moneyLimit: { usd: -1, unknownPrices: true } }, { ...tab, moneyLimit: 5 }])).toEqual([tab, tab])
  })

  it('tolerates missing or malformed providerSettings', () => {
    expect(parseAppStateJson('{}').providerSettings).toEqual({})
    expect(parseAppStateJson('{ "providerSettings": 42 }').providerSettings).toEqual({})
    // A malformed value drops only that key: valid sibling overrides survive
    // both within the same provider and in other providers, and a malformed
    // provider record drops only that provider.
    expect(parseAppStateJson(JSON.stringify({
      providerSettings: {
        venice: { webSearch: false, xSearch: 'broken' },
        openrouter: { someFlag: true },
        zai: 42,
      },
    })).providerSettings).toEqual({
      venice: { webSearch: false },
      openrouter: { someFlag: true },
    })
  })

  it('keeps the chosen model parameters, and drops a bad value, model, or key alone', () => {
    const parse = (value: unknown) => parseAppStateJson(JSON.stringify({ modelParameters: value })).modelParameters
    const saved = { 'venice/film': { duration: '5s', fps: 24 }, 'openrouter/x-ai/film': { duration: 1 }, 'venice/song': { loop: true, force_instrumental: false } }

    expect(parseAppStateJson('{}').modelParameters).toStrictEqual({})
    expect(parse(42)).toStrictEqual({})
    expect(parseAppStateJson(serializeAppStateJson({ modelParameters: saved })).modelParameters).toStrictEqual(saved)
    expect(parse({
      'venice/film': { duration: '5s', loop: true, seed: null, sizes: ['480p'], voice: '' },
      'venice/song': 42,
      // No value is left for this model.
      'venice/speech': { voice: null },
      // Not a full model id.
      film: { duration: '5s' },
      '/film': { duration: '5s' },
    })).toStrictEqual({ 'venice/film': { duration: '5s', loop: true } })
  })

  // JSON.parse makes `__proto__` an own key.
  it('reads no model parameters from a __proto__ key', () => {
    const state = parseAppStateJson('{ "modelParameters": { "__proto__": { "duration": "5s" }, "venice/film": { "__proto__": "5s" } } }')

    expect(Object.keys(state.modelParameters ?? {})).toStrictEqual(['venice/film'])
    expect(Object.getPrototypeOf(state.modelParameters)).toBe(Object.prototype)
  })

  it('keeps the known output types of a hand-edited modelOutputFilter, and ignores a bad type', () => {
    const parseFilter = (value: unknown) => parseAppStateJson(JSON.stringify({ modelOutputFilter: value })).modelOutputFilter
    expect(parseAppStateJson('{}').modelOutputFilter).toEqual([])
    expect(parseFilter(['audio', 'speech', 'audio', 3, 'Text'])).toEqual(['audio'])
    // Only unknown types: every model shows, not none.
    expect(parseFilter(['speech'])).toEqual([])
    expect(parseFilter('image')).toEqual([])
  })

  it('rounds a hand-edited modelPickerSize and raises it to the minimum, and reads a bad one as the default', () => {
    const parseSize = (value: unknown) => parseAppStateJson(JSON.stringify({ modelPickerSize: value })).modelPickerSize
    const defaultSize = { width: 320, maxHeight: 360 }
    expect(parseAppStateJson('{}').modelPickerSize).toStrictEqual(defaultSize)
    expect(parseAppStateJson(serializeAppStateJson({ modelPickerSize: { width: 480, maxHeight: 420 } })).modelPickerSize)
      .toStrictEqual({ width: 480, maxHeight: 420 })
    expect(parseSize({ width: 480.4, maxHeight: 619.5 })).toStrictEqual({ width: 480, maxHeight: 620 })
    expect(parseSize({ width: 100, maxHeight: 900 })).toStrictEqual({ width: 320, maxHeight: 900 })
    expect(parseSize({ width: 500, maxHeight: -4 })).toStrictEqual({ width: 500, maxHeight: 360 })
    expect(parseAppStateJson('{ "modelPickerSize": { "width": 1e400, "maxHeight": 500 } }').modelPickerSize).toStrictEqual(defaultSize)
    expect(parseSize({ width: '500', maxHeight: 500 })).toStrictEqual(defaultSize)
    expect(parseSize({ width: 500 })).toStrictEqual(defaultSize)
    expect(parseSize([500, 500])).toStrictEqual(defaultSize)
    expect(parseSize(null)).toStrictEqual(defaultSize)
  })

  it('reads a modelSettingsSize with no height limit, rounds and raises a hand-edited one, and reads a bad one as the default', () => {
    const parseSize = (value: unknown) => parseAppStateJson(JSON.stringify({ modelSettingsSize: value })).modelSettingsSize
    const defaultSize = { width: 250, maxHeight: null }
    expect(parseAppStateJson('{}').modelSettingsSize).toStrictEqual(defaultSize)
    expect(parseAppStateJson(serializeAppStateJson({ modelSettingsSize: { width: 380, maxHeight: null } })).modelSettingsSize)
      .toStrictEqual({ width: 380, maxHeight: null })
    expect(parseSize({ width: 380.4, maxHeight: 419.5 })).toStrictEqual({ width: 380, maxHeight: 420 })
    expect(parseSize({ width: 100, maxHeight: 40 })).toStrictEqual({ width: 250, maxHeight: 160 })
    expect(parseAppStateJson('{ "modelSettingsSize": { "width": 300, "maxHeight": 1e400 } }').modelSettingsSize).toStrictEqual(defaultSize)
    expect(parseSize({ width: 300 })).toStrictEqual(defaultSize)
    expect(parseSize({ width: 300, maxHeight: '400' })).toStrictEqual(defaultSize)
    expect(parseSize(null)).toStrictEqual(defaultSize)
  })

  it('rounds and clamps a hand-edited editorFontSize, and ignores a bad type', () => {
    const parseFontSize = (value: unknown) => parseAppStateJson(JSON.stringify({ editorFontSize: value })).editorFontSize
    expect(parseAppStateJson('{}').editorFontSize).toBe(15)
    expect(parseFontSize(17.6)).toBe(18)
    expect(parseFontSize(4)).toBe(10)
    expect(parseFontSize(99)).toBe(32)
    expect(parseAppStateJson('{ "editorFontSize": 1e400 }').editorFontSize).toBe(32)
    expect(parseFontSize('20')).toBe(15)
    expect(parseFontSize(null)).toBe(15)
  })

  it('turns the reply-end alerts on at half volume when app_state.json has no alert settings', () => {
    const state = parseAppStateJson('{}')
    expect(state.doneSound).toBe(true)
    expect(state.doneSoundVolume).toBe(50)
    expect(state.doneNotification).toBe(true)
  })

  it('rounds and clamps a hand-edited doneSoundVolume, and ignores bad alert types', () => {
    const parse = (fields: Record<string, unknown>) => parseAppStateJson(JSON.stringify(fields))
    const parseVolume = (value: unknown) => parse({ doneSoundVolume: value }).doneSoundVolume
    expect(parseVolume(0)).toBe(0)
    expect(parseVolume(100)).toBe(100)
    expect(parseVolume(33.5)).toBe(34)
    expect(parseVolume(-3)).toBe(0)
    expect(parseVolume(250)).toBe(100)
    expect(parseAppStateJson('{ "doneSoundVolume": 1e400 }').doneSoundVolume).toBe(100)
    expect(parseVolume('20')).toBe(50)
    expect(parseVolume(null)).toBe(50)
    expect(parse({ doneSound: 'false' }).doneSound).toBe(true)
    expect(parse({ doneNotification: 0 }).doneNotification).toBe(true)
  })

  it('keeps the clip volumes, rounds and clamps a hand-edited volume, and reads each bad value as its default', () => {
    const parseVolumes = (value: unknown) => parseAppStateJson(JSON.stringify({ clipVolumes: value })).clipVolumes
    const full = { volume: 100, muted: false }
    const saved = { audio: { volume: 35, muted: true }, video: { volume: 0, muted: false } }

    expect(parseAppStateJson('{}').clipVolumes).toStrictEqual({ audio: full, video: full })
    expect(parseAppStateJson(serializeAppStateJson({ clipVolumes: saved })).clipVolumes).toStrictEqual(saved)
    expect(parseVolumes({ audio: { volume: 33.5, muted: true }, video: { volume: 250 } }))
      .toStrictEqual({ audio: { volume: 34, muted: true }, video: full })
    expect(parseAppStateJson('{ "clipVolumes": { "video": { "volume": 1e400 } } }').clipVolumes?.video).toStrictEqual(full)
    expect(parseVolumes({ audio: { volume: -3, muted: 'yes' }, video: { volume: '20', muted: true } }))
      .toStrictEqual({ audio: { volume: 0, muted: false }, video: { volume: 100, muted: true } })
    expect(parseVolumes({ audio: 40, video: null })).toStrictEqual({ audio: full, video: full })
    expect(parseVolumes([{ volume: 40 }])).toStrictEqual({ audio: full, video: full })
  })

  it('keeps any system prompt text, also an empty one, and reads any other value as the built-in prompt', () => {
    const parsePrompt = (value: unknown) => parseAppStateJson(JSON.stringify({ systemPrompt: value })).systemPrompt
    expect(parseAppStateJson('{}').systemPrompt).toBeNull()
    expect(parsePrompt('')).toBe('')
    expect(parsePrompt(' \n')).toBe(' \n')
    expect(parsePrompt('{{foo}}')).toBe('{{foo}}')
    expect(parsePrompt(null)).toBeNull()
    expect(parsePrompt(42)).toBeNull()
    expect(parsePrompt(['Hi'])).toBeNull()
  })

  it('keeps a hand-set incognitoOption, and reads a missing or non-boolean one as false', () => {
    const parseOption = (value: unknown) => parseAppStateJson(JSON.stringify({ incognitoOption: value })).incognitoOption
    expect(parseAppStateJson('{}').incognitoOption).toBe(false)
    expect(parseOption(true)).toBe(true)
    expect(parseOption(false)).toBe(false)
    expect(parseOption('true')).toBe(false)
    expect(parseOption(1)).toBe(false)
    expect(parseOption(null)).toBe(false)
  })

  it('keeps a whole window geometry and drops a bad one as a whole', () => {
    const geometry = { width: 1000, height: 700, x: -1280, y: 40, maximized: true }
    const parseWindow = (value: unknown) => parseAppStateJson(JSON.stringify({ window: value })).window
    expect(parseAppStateJson(serializeAppStateJson({ window: geometry })).window).toEqual(geometry)
    expect(parseAppStateJson('{}').window).toBeUndefined()
    expect(parseWindow({ ...geometry, maximized: 'yes' })).toBeUndefined()
    expect(parseWindow({ ...geometry, width: 0 })).toBeUndefined()
    expect(parseWindow({ ...geometry, x: '10' })).toBeUndefined()
    expect(parseWindow('1000x700')).toBeUndefined()
  })

  it('keeps a window geometry with no position, and drops half a position', () => {
    const sizeOnly = { width: 1000, height: 700, maximized: false }
    const parseWindow = (value: unknown) => parseAppStateJson(JSON.stringify({ window: value })).window
    expect(parseWindow(sizeOnly)).toStrictEqual(sizeOnly)
    expect(parseWindow({ ...sizeOnly, x: 10 })).toBeUndefined()
    expect(parseWindow({ ...sizeOnly, y: 10 })).toBeUndefined()
  })
})

describe('custom providers in app state', () => {
  const local = { id: 'local', name: 'Local', baseUrl: 'http://localhost:8080/v1' }
  let consoleError: MockInstance<typeof console.error>

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleError.mockRestore()
  })

  it('fills config defaults and round-trips', () => {
    const state = parseAppStateJson(JSON.stringify({ customProviders: [local] }))

    expect(state.customProviders).toEqual([
      { ...local, apiFormat: 'openai', models: [], fetchModels: true, auth: 'apiKey' },
    ])
    expect(parseAppStateJson(serializeAppStateJson(state))).toEqual(state)
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('drops bad entries and bad models one at a time and keeps valid siblings', () => {
    const state = parseAppStateJson(JSON.stringify({
      customProviders: [
        { ...local, baseUrl: 'ftp://localhost/v1' },
        local,
        { ...local, name: 'Second local' },
        { id: 'openrouter', name: 'Fake OpenRouter', baseUrl: 'https://example.com/v1' },
        { id: 'copilot-clone', name: 'Clone', baseUrl: 'https://example.com', auth: 'githubCopilot' },
        'not an entry',
        {
          id: 'other',
          name: 'Other',
          baseUrl: 'https://other.example/v1',
          models: [{ id: 'good' }, { id: ' ' }, 42, { id: 'also-good', name: 'Also good' }],
        },
      ],
    }))

    expect(state.customProviders?.map((config) => [config.id, config.name])).toEqual([
      ['local', 'Local'],
      ['other', 'Other'],
    ])
    expect(state.customProviders?.[1].models).toEqual([{ id: 'good' }, { id: 'also-good', name: 'Also good' }])
    // Five dropped entries and two dropped models.
    expect(consoleError).toHaveBeenCalledTimes(7)
  })

  // A setting key that a later Dez reserves for its own toggle, such as
  // `tools`, must not drop the whole provider that an older build saved.
  it('drops bad settings one at a time and keeps the provider', () => {
    const webSearch = { key: 'web', label: 'Web search', type: 'boolean', default: false, bodyPath: 'web' }
    const state = parseAppStateJson(JSON.stringify({
      customProviders: [{
        ...local,
        settings: [
          { ...webSearch, key: 'tools', label: 'Tools' },
          webSearch,
          { ...webSearch, key: 'thinking', label: 'Thinking' },
          { ...webSearch, key: 'proto', bodyPath: 'a.__proto__' },
        ],
      }],
    }))

    expect(state.customProviders?.map((config) => config.settings)).toEqual([[webSearch]])
    expect(consoleError).toHaveBeenCalledTimes(3)
    expect(consoleError.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining('Dropped setting 0 of custom provider 0'),
      expect.stringContaining('Dropped setting 2 of custom provider 0'),
      expect.stringContaining('Dropped setting 3 of custom provider 0'),
    ])
  })

  it('falls back to no custom providers when the field is not a list', () => {
    expect(parseAppStateJson('{ "customProviders": { "id": "local" } }').customProviders).toEqual([])
    expect(parseAppStateJson('{}').customProviders).toEqual([])
  })

  it('moves a hand-added apiKey out of the config and never writes it back', () => {
    const state = parseAppStateJson(JSON.stringify({
      customProviders: [
        { ...local, apiKey: ' sk-local-key ' },
        { id: 'blank', name: 'Blank key', baseUrl: 'http://localhost:1234/v1', apiKey: '  ' },
        { id: 'dropped', name: '', baseUrl: 'http://localhost:1/v1', apiKey: 'sk-dropped-key' },
      ],
    }))

    expect(state.customProviderApiKeys).toEqual({ local: 'sk-local-key' })
    expect(state.customProviders?.map((config) => config.id)).toEqual(['local', 'blank'])
    expect(state.customProviders?.[0]).not.toHaveProperty('apiKey')
    const json = serializeAppStateJson(state)
    expect(json).not.toContain('sk-local-key')
    expect(json).not.toContain('customProviderApiKeys')
  })

  it('never logs the content of a dropped entry', () => {
    parseAppStateJson(JSON.stringify({
      customProviders: [{ id: 'leak', name: 'Leak', baseUrl: 'sk-secret-url', apiKey: 'sk-secret-key' }],
    }))

    expect(consoleError).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(consoleError.mock.calls)).not.toMatch(/sk-secret/)
  })
})

describe('open jobs in app state', () => {
  const providerJob = { providerId: 'venice', modelId: 'video-model', kind: 'video', jobId: 'queue-1', resume: { queue_id: 'queue-1' }, quote: 0.4 }
  const job = { id: 'j-abcd', number: 1, tool: 'model_invoke', label: 'make a video', inputs: ['3'], hidesAssets: false, model: { providerId: 'venice', modelId: 'video-model' }, timeoutMs: 600000, cost: 0.4, providerJob }
  const mediaReply = { sectionIndex: 1, model: { providerId: 'venice', modelId: 'video-model', modelName: 'Video' }, providerJob }
  const parseOpenJobs = (value: unknown) => parseAppStateJson(JSON.stringify({ openJobs: value })).openJobs
  let consoleError: MockInstance<typeof console.error>

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleError.mockRestore()
  })

  it('keeps the jobs and the media reply of each conversation, and writes them back', () => {
    const openJobs = { first: { jobs: [job, { ...job, id: 'j-efgh', number: 2, cost: undefined, providerJob: undefined }] }, second: { mediaReply } }
    const state = parseAppStateJson(JSON.stringify({ openJobs }))

    expect(state.openJobs).toStrictEqual({
      first: { jobs: [job, { id: 'j-efgh', number: 2, tool: 'model_invoke', label: 'make a video', inputs: ['3'], hidesAssets: false, model: job.model, timeoutMs: 600000 }] },
      second: { mediaReply },
    })
    expect(parseAppStateJson(serializeAppStateJson(state))).toStrictEqual(state)
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('writes no key for a map with no conversation, and reads a missing or bad map as empty', () => {
    expect(serializeAppStateJson({ ...defaultAppState(), openJobs: {} })).not.toContain('openJobs')
    expect(parseAppStateJson('{}').openJobs).toStrictEqual({})
    expect(parseOpenJobs([job])).toStrictEqual({})
  })

  it('drops a bad job, a repeated id or number, and the jobs over the limit, one at a time', () => {
    const overLimit = 5
    const many = Array.from({ length: MAX_OPEN_JOBS + overLimit }, (_, index) => ({ ...job, id: `j-${index}`, number: index + 1 }))
    const jobs = [{ ...job, number: 0 }, job, { ...job, number: 2 }, { ...job, id: 'j-other' }, 'not a job', ...many.slice(1)]
    const parsed = parseOpenJobs({ conversation: { jobs } })?.conversation?.jobs

    expect(parsed?.map(({ id }) => id)).toEqual([job.id, ...many.slice(1, MAX_OPEN_JOBS).map(({ id }) => id)])
    // A bad number, a repeated id, a repeated number, no object, and the
    // jobs over the limit.
    expect(consoleError).toHaveBeenCalledTimes(4 + overLimit)
  })

  // The job keeps its number, and comes back as a job whose work is lost.
  it('drops only the provider job or the cost of a job when that field is bad', () => {
    const parsed = parseOpenJobs({ conversation: { jobs: [{ ...job, cost: 'free', providerJob: { ...providerJob, kind: 'transcription' } }] } })
    expect(parsed).toStrictEqual({ conversation: { jobs: [{ ...job, cost: undefined, providerJob: undefined }] } })
  })

  it('gives no key to a conversation with nothing left, and keeps the jobs when only the media reply is bad', () => {
    expect(parseOpenJobs({ empty: { jobs: [] }, bad: { jobs: [{ id: 'j-1' }] }, none: null })).toStrictEqual({})
    expect(parseOpenJobs({ conversation: { jobs: [job], mediaReply: { ...mediaReply, sectionIndex: -1 } } })).toStrictEqual({ conversation: { jobs: [job] } })
  })

  it('keeps a __proto__ key of a conversation or of a resume value as a plain key', () => {
    const parsed = parseAppStateJson(`{ "openJobs": { "__proto__": { "jobs": [${JSON.stringify({ ...job, providerJob: undefined })}] }, "c": { "mediaReply": ${JSON.stringify(mediaReply).replace('"queue_id"', '"__proto__"')} } } }`).openJobs ?? {}

    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype)
    expect(Object.keys(parsed)).toEqual(['__proto__', 'c'])
    const resume = parsed.c?.mediaReply?.providerJob.resume ?? {}
    expect(Object.getPrototypeOf(resume)).toBe(Object.prototype)
    expect(Object.keys(resume)).toEqual(['__proto__'])
  })
})
