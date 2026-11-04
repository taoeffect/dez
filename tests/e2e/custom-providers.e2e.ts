import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { EditorView } from '@codemirror/view'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { startApp, type RunningApp } from './harness/app'
import { click, consoleErrors, resetConsoleErrors, screenshotOnFailure, typeInto, typeKeys, waitFor, waitForValue } from './harness/dom'
import { seedRawAppState } from './harness/fixtures'
import { createSession, destroySession, type E2EBrowser } from './harness/session'

// Custom providers, driven through the real app against a mock
// OpenAI-compatible server in this process.
//
// app_state.json is seeded before launch the way a user would hand-edit it:
// two valid custom providers (one with a hand-added `apiKey`) and three
// entries that the app must drop. Each provider has its own path prefix on
// the mock (`/<prefix>/v1`), so the recorded requests show which provider
// sent them, and a dropped entry can be proved to have sent nothing.
//
// One app session serves the whole file. The tests run in order: the
// Settings tests expect the providers as seeded.

interface MockRequest {
  method: string
  path: string
  authorization: string | null
  body: unknown
}

interface ThreadSection {
  role: string
  text: string
}

interface ProviderRow {
  id: string
  name: string
}

interface ProviderDetail {
  name: string
  badge: string | null
  deletable: boolean
  status: string
  modelsStatus: string
}

const KEYED_API_KEY = 'sk-e2e-keyed'
const ADDED_API_KEY = 'sk-e2e-added'

// What `GET /<prefix>/v1/models` returns for every prefix. The `local`
// provider also lists `shared-model` in its config, with another name.
const SERVER_MODELS = [
  { id: 'shared-model', name: 'Server name' },
  { id: 'fetched-model' },
]

const BUILT_INS: ProviderRow[] = [
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'zai', name: 'Z.ai' },
  { id: 'venice', name: 'Venice' },
  { id: 'charm_hyper', name: 'Charm Hyper' },
  { id: 'minimax', name: 'MiniMax' },
  { id: 'copilot', name: 'GitHub Copilot' },
]

const SEEDED_CUSTOM: ProviderRow[] = [
  { id: 'local', name: 'Local Mock' },
  { id: 'keyed', name: 'Keyed Mock' },
]

// The reply streams in several chunks and names the provider prefix.
function replyTokens (prefix: string): string[] {
  return ['Reply', ' from', ` ${prefix}`, '.']
}

function replyText (prefix: string): string {
  return replyTokens(prefix).join('')
}

// Records every request in `requests`. A body that is not JSON is recorded
// as its raw text.
async function startMockServer (requests: MockRequest[]): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const text = Buffer.concat(chunks).toString('utf8')
    let body: unknown = null
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    }
    const path = req.url ?? ''
    requests.push({ method: req.method ?? '', path, authorization: req.headers.authorization ?? null, body })

    const route = /^\/([a-z]+)\/v1\/(models|chat\/completions)$/.exec(path)
    if (req.method === 'GET' && route?.[2] === 'models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: SERVER_MODELS }))
    } else if (req.method === 'POST' && route?.[2] === 'chat/completions') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      for (const token of replyTokens(route[1])) {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: token } }] })}\n\n`)
      }
      res.end('data: [DONE]\n\n')
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  return server
}

describe('custom providers', () => {
  let app: RunningApp
  let browser: E2EBrowser
  let server: http.Server
  let mockUrl = ''
  let stateFile = ''
  const requests: MockRequest[] = []

  function requestsTo (path: string): MockRequest[] {
    return requests.filter((request) => request.path === path)
  }

  async function savedCustomProviders (): Promise<unknown> {
    try {
      return JSON.parse(await fs.promises.readFile(stateFile, 'utf8')).customProviders ?? null
    } catch {
      return null
    }
  }

  async function textOf (selector: string): Promise<string | null> {
    return browser.execute(
      (sel: string) => document.querySelector(sel)?.textContent?.trim() ?? null,
      selector
    )
  }

  async function sbpCall (selector: string, ...args: unknown[]): Promise<unknown> {
    return browser.execute(async (sel: string, selectorArgs: unknown[]) => {
      const sbp = Reflect.get(window, 'sbp') as (selector: string, ...args: unknown[]) => unknown
      return await sbp(sel, ...selectorArgs)
    }, selector, args)
  }

  // The active tab's sections as role and plain text.
  async function threadSections (): Promise<ThreadSection[]> {
    return browser.execute(() => {
      const sbp = Reflect.get(window, 'sbp') as (selector: string, ...args: unknown[]) => unknown
      const sections = sbp('dez.model/thread/sections') as Array<{ role: string, content: Array<{ kind: string, text?: string }> }>
      return sections.map((section) => ({
        role: section.role,
        text: section.content.map((node) => node.kind === 'text' ? node.text ?? '' : '').join(''),
      }))
    })
  }

  async function editorDoc (): Promise<string> {
    return browser.execute(() => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('editorDoc: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      return String(view.state.doc)
    })
  }

  async function pickerGroups (): Promise<Array<{ provider: string, models: string[] }>> {
    return browser.execute(() =>
      Array.from(document.querySelectorAll('.model-dropdown .model-group')).map((group) => ({
        provider: group.querySelector('.model-group-header')?.textContent?.trim() ?? '',
        models: Array.from(group.querySelectorAll('.model-item-name')).map((name) => name.textContent?.trim() ?? ''),
      }))
    )
  }

  async function openPicker (): Promise<void> {
    await click(browser, '.model-selector-btn')
    await waitFor(browser, '.model-dropdown', 10_000)
  }

  // Picks the model named `modelName` in the picker group of `providerName`.
  async function pickModel (providerName: string, modelName: string): Promise<void> {
    await openPicker()
    await waitForValue(browser, `${providerName} in the picker`, async () =>
      (await pickerGroups()).find((group) => group.provider === providerName)?.models.includes(modelName) ?? false, true)
    await browser.execute((provider: string, model: string) => {
      const group = Array.from(document.querySelectorAll('.model-dropdown .model-group')).find(
        (candidate) => candidate.querySelector('.model-group-header')?.textContent?.trim() === provider
      )
      const item = Array.from(group?.querySelectorAll<HTMLElement>('.model-item') ?? []).find(
        (candidate) => candidate.querySelector('.model-item-name')?.textContent?.trim() === model
      )
      if (!item) throw new Error(`pickModel: ${provider} › ${model} not found`)
      item.click()
    }, providerName, modelName)
    await waitForValue(browser, 'selected model', () => textOf('.model-selector-label'), modelName)
  }

  // Types `text` at the end of the active tab, then submits it with
  // Ctrl+Enter. A new reply lands after the trailing user section.
  async function submit (text: string): Promise<void> {
    await browser.execute(() => {
      const content = document.querySelector('.cm-content') as HTMLElement | null
      if (!content) throw new Error('submit: .cm-content not found')
      content.focus()
    })
    await browser.keys([Key.Control, Key.End])
    await typeKeys(browser, text)
    await browser.keys([Key.Control, Key.Enter])
  }

  // Waits until the active tab holds `expected` and no stream runs.
  async function waitForThread (expected: ThreadSection[]): Promise<void> {
    await waitForValue(browser, 'thread sections', threadSections, expected)
    await waitForValue(browser, 'streaming', () => browser.execute(() => {
      const sbp = Reflect.get(window, 'sbp') as (selector: string, ...args: unknown[]) => unknown
      return sbp('dez.model/streams/isStreaming', sbp('dez.model/tabs/activeId')) as boolean
    }), false)
    expect(await sbpCall('dez.model/streams/activeTabError')).toBeNull()
  }

  async function providerLists (): Promise<{ builtIn: ProviderRow[], custom: ProviderRow[] }> {
    return browser.execute(() => {
      // The custom list is not rendered while it is empty.
      const [builtIn, custom] = Array.from(document.querySelectorAll('.provider-manager .provider-list')).map((list) =>
        Array.from(list.querySelectorAll<HTMLElement>('.provider-row')).map((row) => ({
          id: row.dataset.providerId ?? '',
          name: row.querySelector('.provider-row-name')?.textContent?.trim() ?? '',
        }))
      )
      return { builtIn: builtIn ?? [], custom: custom ?? [] }
    })
  }

  async function providerDetail (): Promise<ProviderDetail> {
    return browser.execute(() => {
      const text = (selector: string) => document.querySelector(selector)?.textContent?.trim() ?? null
      return {
        name: text('.provider-detail-name') ?? '',
        badge: text('.provider-detail .provider-badge'),
        deletable: document.querySelector('.provider-detail .provider-delete-btn') !== null,
        status: text('.provider-detail .provider-status') ?? '',
        modelsStatus: text('.provider-detail .provider-models-status') ?? '',
      }
    })
  }

  async function openProviderSettings (): Promise<void> {
    await sbpCall('dez.model/settings/open', 'providers')
    await waitFor(browser, '.provider-manager .provider-row', 10_000)
  }

  async function closeSettings (): Promise<void> {
    await browser.keys([Key.Escape])
    await waitForValue(browser, 'Settings open', () => browser.execute(() => document.querySelector('.provider-manager') !== null), false)
  }

  // Types into a Settings field and commits it with Enter, the way the
  // name and URL fields save (they do not save on `input`).
  async function enterField (selector: string, text: string): Promise<void> {
    await typeInto(browser, selector, text, { clear: true })
    await browser.keys([Key.Enter])
  }

  beforeAll(async () => {
    server = await startMockServer(requests)
    mockUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    app = await startApp()
    try {
      stateFile = await seedRawAppState(app.home, {
        customProviders: [
          { id: 'local', name: 'Local Mock', baseUrl: `${mockUrl}/local/v1`, models: [{ id: 'shared-model', name: 'Config name' }] },
          // Dropped: no name.
          { id: 'noname', baseUrl: `${mockUrl}/noname/v1` },
          // Dropped: the id of a built-in.
          { id: 'openrouter', name: 'Fake OpenRouter', baseUrl: `${mockUrl}/collision/v1` },
          // Dropped: the id of an earlier entry.
          { id: 'local', name: 'Duplicate Mock', baseUrl: `${mockUrl}/duplicate/v1` },
          { id: 'keyed', name: 'Keyed Mock', baseUrl: `${mockUrl}/keyed/v1`, apiKey: KEYED_API_KEY },
        ],
      })
      browser = await createSession(app.binary, app.port)
    } catch (err) {
      await app.stop()
      throw err
    }
    await waitFor(browser, 'header.tab-bar', 60_000)
    // The app-state parse logs each dropped entry before the store gets the
    // list, so once the list has the two valid entries, the logs are done.
    await waitForValue(browser, 'loaded custom providers', async () =>
      ((await sbpCall('dez.model/customProviders/list')) as unknown[]).length, 2)
  })

  // beforeAll waits for the startup logs of the dropped entries, so they
  // happen before the first reset and are not in the record.
  beforeEach(async () => {
    await resetConsoleErrors(browser)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    if (ctx.task.result?.state === 'fail') return
    expect(await consoleErrors(browser)).toEqual([])
  })

  afterAll(async () => {
    await destroySession(browser)
    await app?.stop()
    // reqwest keeps its connections open, and close() waits for them.
    server?.closeAllConnections()
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve())
  })

  it('drops invalid entries and moves a hand-added API key out of app_state.json', async () => {
    // The startup check of each valid provider: the key goes only to the
    // provider that has one.
    await waitForValue(browser, 'startup model checks', async () =>
      ['/local/v1/models', '/keyed/v1/models'].map((path) => requestsTo(path).length > 0), [true, true])
    expect(requestsTo('/local/v1/models')[0].authorization).toBeNull()
    expect(requestsTo('/keyed/v1/models')[0].authorization).toBe(`Bearer ${KEYED_API_KEY}`)
    // These requests show that the startup check run has begun. Once it
    // ends, every provider it checked has sent its request (the mock records
    // a request before it answers), so a wrongly kept entry would show here.
    await waitForValue(browser, 'startup check run', () => sbpCall('dez.model/modelCache/refreshing'), false)
    expect(requests.filter((request) => /^\/(noname|collision|duplicate)\//.test(request.path))).toEqual([])

    // The import saves app state once, without the key and without the
    // dropped entries.
    await waitForValue(browser, 'customProviders in app_state.json', savedCustomProviders, [
      { id: 'local', name: 'Local Mock', baseUrl: `${mockUrl}/local/v1`, apiFormat: 'openai', models: [{ id: 'shared-model', name: 'Config name' }], fetchModels: true, auth: 'apiKey' },
      { id: 'keyed', name: 'Keyed Mock', baseUrl: `${mockUrl}/keyed/v1`, apiFormat: 'openai', models: [], fetchModels: true, auth: 'apiKey' },
    ])
    expect(await fs.promises.readFile(stateFile, 'utf8')).not.toContain(KEYED_API_KEY)
  })

  it('lists the config and server models of each valid custom provider in the picker', async () => {
    await openPicker()
    // Built-ins have no key here, so only the custom groups show. The config
    // model comes first and keeps its config name; the server's copy of it
    // is not listed again.
    await waitForValue(browser, 'picker groups', pickerGroups, [
      { provider: 'Local Mock', models: ['Config name', 'fetched-model'] },
      { provider: 'Keyed Mock', models: ['Server name', 'fetched-model'] },
    ])
    await browser.keys([Key.Escape])
    await waitForValue(browser, 'picker open', () => browser.execute(() => document.querySelector('.model-dropdown') !== null), false)
  })

  it('streams a reply from a provider without a key', async () => {
    await pickModel('Local Mock', 'Config name')
    await submit('Hello mock')
    await waitForThread([
      { role: 'user', text: 'Hello mock' },
      { role: 'agent', text: replyText('local') },
      { role: 'user', text: '' },
    ])
    expect(await editorDoc()).toContain(replyText('local'))

    // The second turn sends the first reply back with the `assistant` role.
    await submit('And again')
    await waitForThread([
      { role: 'user', text: 'Hello mock' },
      { role: 'agent', text: replyText('local') },
      { role: 'user', text: 'And again' },
      { role: 'agent', text: replyText('local') },
      { role: 'user', text: '' },
    ])

    const chats = requestsTo('/local/v1/chat/completions')
    expect(chats.map((request) => [request.method, request.authorization])).toEqual([['POST', null], ['POST', null]])
    expect(chats[0].body).toEqual({
      model: 'shared-model',
      stream: true,
      messages: [{ role: 'user', content: 'Hello mock' }],
    })
    expect(chats[1].body).toEqual({
      model: 'shared-model',
      stream: true,
      messages: [
        { role: 'user', content: 'Hello mock' },
        { role: 'assistant', content: replyText('local') },
        { role: 'user', content: 'And again' },
      ],
    })
  })

  it('sends the stored key to a provider whose key came from app_state.json', async () => {
    await sbpCall('dez.model/tabs/create')
    await waitForValue(browser, 'new tab', threadSections, [{ role: 'user', text: '' }])
    await pickModel('Keyed Mock', 'fetched-model')
    await submit('Hello keyed')
    await waitForThread([
      { role: 'user', text: 'Hello keyed' },
      { role: 'agent', text: replyText('keyed') },
      { role: 'user', text: '' },
    ])

    const chats = requestsTo('/keyed/v1/chat/completions')
    expect(chats.map((request) => request.authorization)).toEqual([`Bearer ${KEYED_API_KEY}`])
    expect(chats[0].body).toEqual({
      model: 'fetched-model',
      stream: true,
      messages: [{ role: 'user', content: 'Hello keyed' }],
    })
  })

  it('shows built-ins with a badge and no delete control in Settings › Providers', async () => {
    // The picker footer is the way users reach this page.
    await openPicker()
    await click(browser, '.model-picker-configure')
    await waitFor(browser, '.provider-manager .provider-row', 10_000)

    expect(await providerLists()).toEqual({ builtIn: BUILT_INS, custom: SEEDED_CUSTOM })

    for (const row of [...BUILT_INS, ...SEEDED_CUSTOM]) {
      await click(browser, `.provider-row[data-provider-id="${row.id}"]`)
      const builtIn = BUILT_INS.includes(row)
      const isCopilot = row.id === 'copilot'
      await waitForValue(browser, `${row.name} details`, providerDetail, {
        name: row.name,
        badge: builtIn ? 'Built-in' : null,
        deletable: !builtIn,
        status: builtIn ? (isCopilot ? 'Not signed in' : 'No API key') : 'Connected',
        modelsStatus: builtIn
          ? (isCopilot ? 'Sign in with GitHub to use this provider' : 'Add an API key to use this provider')
          : '2 models available',
      })
    }
    await closeSettings()
  })

  it('adds, edits, and deletes a custom provider in Settings › Providers', async () => {
    await openProviderSettings()
    // The pane switches to the new provider once the list has it, and never
    // shows "No provider selected." on the way. A MutationObserver sees each
    // render from the click until the new provider's name shows.
    const sawEmptyPane = await browser.execute(() => new Promise<boolean>((resolve) => {
      let sawEmpty = false
      const finish = () => {
        observer.disconnect()
        resolve(sawEmpty)
      }
      const observer = new MutationObserver(() => {
        if (document.querySelector('.provider-detail-empty')) sawEmpty = true
        if (document.querySelector('.provider-detail-name')?.textContent?.trim() === 'New provider') finish()
      })
      observer.observe(document.body, { subtree: true, childList: true, characterData: true })
      setTimeout(finish, 5_000)
      document.querySelector<HTMLElement>('.provider-add-btn')?.click()
    }))
    expect(sawEmptyPane).toBe(false)
    await waitForValue(browser, 'custom providers after the add', async () => (await providerLists()).custom.length, 3)
    const addedId = (await providerLists()).custom[2].id
    expect(await textOf('.provider-detail-name')).toBe('New provider')
    expect(await browser.execute(() => document.querySelector<HTMLInputElement>('.provider-name-input')?.value)).toBe('New provider')

    // The URL goes first: a save starts a model check, and the default URL
    // has no server (its failed check would log an error).
    await enterField('.provider-base-url-input', `${mockUrl}/added/v1/`)
    await waitForValue(browser, 'saved base URL', () => browser.execute(
      () => document.querySelector<HTMLInputElement>('.provider-base-url-input')?.value ?? null
    ), `${mockUrl}/added/v1`)
    expect(await textOf('.provider-hint')).toBe(`Chat requests go to ${mockUrl}/added/v1/chat/completions`)
    await waitForValue(browser, 'models status', () => textOf('.provider-models-status'), '2 models available')

    await enterField('.provider-name-input', 'Added Mock')
    await waitForValue(browser, 'custom providers after the rename', async () => (await providerLists()).custom,
      [...SEEDED_CUSTOM, { id: addedId, name: 'Added Mock' }])
    expect(await textOf('.provider-detail-name')).toBe('Added Mock')

    // A model add saves the config, which drops the cached models and starts
    // a check. While it runs, the header must agree with the Models line.
    // A MutationObserver reads both in the render where the Models line
    // first says "Checking…"; the check's reply comes in a later task.
    await typeInto(browser, '.provider-model-input', 'added-model')
    const duringCheck = await browser.execute(() => new Promise<{ status: string, modelsStatus: string }>((resolve) => {
      const read = () => ({
        status: document.querySelector('.provider-detail .provider-status')?.textContent?.trim() ?? '',
        modelsStatus: document.querySelector('.provider-detail .provider-models-status')?.textContent?.trim() ?? '',
      })
      const observer = new MutationObserver(() => {
        const texts = read()
        if (texts.modelsStatus !== 'Checking…') return
        observer.disconnect()
        resolve(texts)
      })
      observer.observe(document.body, { subtree: true, childList: true, characterData: true })
      setTimeout(() => {
        observer.disconnect()
        resolve(read())
      }, 5_000)
      document.querySelector<HTMLElement>('.provider-model-add-btn')?.click()
    }))
    expect(duringCheck).toEqual({ status: 'Checking…', modelsStatus: 'Checking…' })
    await waitForValue(browser, 'model list', () => browser.execute(() =>
      Array.from(document.querySelectorAll('.provider-model-row .provider-model-id')).map((id) => id.textContent?.trim() ?? '')
    ), ['added-model'])
    await waitForValue(browser, 'models status', () => textOf('.provider-models-status'), '3 models available')

    // A key saved here goes to the key store, and from there to the server.
    await typeInto(browser, '.provider-key-input', ADDED_API_KEY)
    // A click on the selected row must not drop the unsaved key.
    await click(browser, `.provider-row[data-provider-id="${addedId}"]`)
    expect(await browser.execute(() => document.querySelector<HTMLInputElement>('.provider-key-input')?.value)).toBe(ADDED_API_KEY)
    // A key save marks only its own provider as saving. One page script
    // clicks Save and then other rows, and reads each pane after Vue renders
    // it (a microtask). The native reply is a later task, so the save is
    // still running at each read.
    const duringSave = await browser.execute(async (otherId: string, savingId: string) => {
      const pane = async (providerId: string) => {
        document.querySelector<HTMLElement>(`.provider-row[data-provider-id="${providerId}"]`)?.click()
        await Promise.resolve()
        return {
          name: document.querySelector('.provider-detail-name')?.textContent?.trim() ?? null,
          save: document.querySelector('.provider-key-save-btn')?.textContent?.trim() ?? null,
          removeDisabled: document.querySelector<HTMLButtonElement>('.provider-key-remove-btn')?.disabled ?? null,
        }
      }
      document.querySelector<HTMLElement>('.provider-key-save-btn')?.click()
      return { other: await pane(otherId), saving: await pane(savingId) }
    }, 'keyed', addedId)
    expect(duringSave).toEqual({
      other: { name: 'Keyed Mock', save: 'Save', removeDisabled: false },
      saving: { name: 'Added Mock', save: 'Saving…', removeDisabled: null },
    })
    await waitForValue(browser, 'key placeholder', () => browser.execute(
      () => document.querySelector<HTMLInputElement>('.provider-key-input')?.placeholder ?? null
    ), 'Key saved — paste to replace')
    // The key save starts a model check with the key. The Models line said
    // "3 models available" before the save too, so wait for the request.
    await waitForValue(browser, 'model check with the key', async () =>
      requestsTo('/added/v1/models').at(-1)?.authorization ?? null, `Bearer ${ADDED_API_KEY}`)
    expect(requestsTo('/added/v1/models')[0].authorization).toBeNull()
    expect(await sbpCall('dez.native/getConfiguredProviderIds')).toContain(addedId)

    await waitForValue(browser, 'added provider in app_state.json', async () => {
      const saved = await savedCustomProviders()
      return Array.isArray(saved) ? saved.find((config) => config.id === addedId) ?? null : null
    }, {
      id: addedId,
      name: 'Added Mock',
      baseUrl: `${mockUrl}/added/v1`,
      apiFormat: 'openai',
      models: [{ id: 'added-model' }],
      fetchModels: true,
      auth: 'apiKey',
    })
    expect(await fs.promises.readFile(stateFile, 'utf8')).not.toContain(ADDED_API_KEY)

    await click(browser, '.provider-delete-btn')
    // The deleted row leaves the list at once, not when the key delete ends,
    // so it cannot be clicked. The page script reads the list after Vue
    // renders the click (a microtask); the native key delete replies in a
    // later task.
    const rowDuringDelete = await browser.execute(async (deletedId: string) => {
      document.querySelector<HTMLElement>('.provider-delete-confirm-btn')?.click()
      await Promise.resolve()
      return document.querySelector(`.provider-row[data-provider-id="${deletedId}"]`) !== null
    }, addedId)
    expect(rowDuringDelete).toBe(false)
    await waitForValue(browser, 'custom providers after the delete', async () => (await providerLists()).custom, SEEDED_CUSTOM)
    // The neighbor of the deleted row is selected.
    expect(await textOf('.provider-detail-name')).toBe('Keyed Mock')
    await waitForValue(browser, 'custom provider ids in app_state.json', async () => {
      const saved = await savedCustomProviders()
      return Array.isArray(saved) ? saved.map((config) => config.id) : null
    }, ['local', 'keyed'])
    expect(await sbpCall('dez.native/getConfiguredProviderIds')).not.toContain(addedId)
    await closeSettings()
  })
})
