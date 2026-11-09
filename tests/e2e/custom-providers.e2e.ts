import fs from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { startApp, type RunningApp } from './harness/app'
import { openAiChatBody } from './harness/chatBody'
import { click, closeSettings, consoleErrors, resetConsoleErrors, screenshotOnFailure, typeInto, waitFor, waitForValue } from './harness/dom'
import { readAppState, seedRawAppState } from './harness/fixtures'
import { replyText, sendChatReply, startMockServer, type MockServer } from './harness/mockServer'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { editorDoc, openPicker, pickerGroups, pickModel, sbpCall, submit, threadSections, waitForThread } from './harness/thread'

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
  { id: 'kimi', name: 'Kimi' },
  { id: 'copilot', name: 'GitHub Copilot' },
]

const SEEDED_CUSTOM: ProviderRow[] = [
  { id: 'local', name: 'Local Mock' },
  { id: 'keyed', name: 'Keyed Mock' },
]

// Records every request in `requests`. A body that is not JSON is recorded
// as its raw text.
async function startProvidersMock (requests: MockRequest[]): Promise<MockServer> {
  return startMockServer(async (req, res, text) => {
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
      // The reply names the provider prefix.
      await sendChatReply(res, route[1])
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
    }
  })
}

describe('custom providers', () => {
  let app: RunningApp
  let browser: E2EBrowser
  let server: MockServer
  let mockUrl = ''
  let stateFile = ''
  const requests: MockRequest[] = []

  function requestsTo (path: string): MockRequest[] {
    return requests.filter((request) => request.path === path)
  }

  async function savedCustomProviders (): Promise<unknown> {
    return (await readAppState(app.home))?.customProviders ?? null
  }

  async function textOf (selector: string): Promise<string | null> {
    return browser.execute(
      (sel: string) => document.querySelector(sel)?.textContent?.trim() ?? null,
      selector
    )
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
    await sbpCall(browser, 'dez.model/settings/open', 'providers')
    await waitFor(browser, '.provider-manager .provider-row', 10_000)
  }

  // Types into a Settings field and commits it with Enter, the way the
  // name and URL fields save (they do not save on `input`).
  async function enterField (selector: string, text: string): Promise<void> {
    await typeInto(browser, selector, text, { clear: true })
    await browser.keys([Key.Enter])
  }

  beforeAll(async () => {
    server = await startProvidersMock(requests)
    mockUrl = server.url
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
      ((await sbpCall(browser, 'dez.model/customProviders/list')) as unknown[]).length, 2)
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
    await server?.stop()
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
    await waitForValue(browser, 'startup check run', () => sbpCall(browser, 'dez.model/modelCache/refreshing'), false)
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
    await openPicker(browser)
    // Built-ins have no key here, so only the custom groups show. The config
    // model comes first and keeps its config name; the server's copy of it
    // is not listed again.
    await waitForValue(browser, 'picker groups', () => pickerGroups(browser), [
      { provider: 'Local Mock', models: ['Config name', 'fetched-model'] },
      { provider: 'Keyed Mock', models: ['Server name', 'fetched-model'] },
    ])
    await browser.keys([Key.Escape])
    await waitForValue(browser, 'picker open', () => browser.execute(() => document.querySelector('.model-dropdown') !== null), false)
  })

  it('streams a reply from a provider without a key', async () => {
    await pickModel(browser, 'Local Mock', 'Config name')
    await submit(browser, 'Hello mock')
    await waitForThread(browser, [
      { role: 'user', text: 'Hello mock' },
      { role: 'agent', text: replyText('local') },
      { role: 'user', text: '' },
    ])
    expect(await editorDoc(browser)).toContain(replyText('local'))

    // The second turn sends the first reply back with the `assistant` role.
    await submit(browser, 'And again')
    await waitForThread(browser, [
      { role: 'user', text: 'Hello mock' },
      { role: 'agent', text: replyText('local') },
      { role: 'user', text: 'And again' },
      { role: 'agent', text: replyText('local') },
      { role: 'user', text: '' },
    ])

    const chats = requestsTo('/local/v1/chat/completions')
    expect(chats.map((request) => [request.method, request.authorization])).toEqual([['POST', null], ['POST', null]])
    const localModel = { id: 'local', modelId: 'shared-model' }
    expect(chats[0].body).toEqual(openAiChatBody(localModel, [{ role: 'user', content: 'Hello mock' }]))
    expect(chats[1].body).toEqual(openAiChatBody(localModel, [
      { role: 'user', content: 'Hello mock' },
      { role: 'assistant', content: replyText('local') },
      { role: 'user', content: 'And again' },
    ]))
  })

  it('sends the stored key to a provider whose key came from app_state.json', async () => {
    await sbpCall(browser, 'dez.model/tabs/create')
    await waitForValue(browser, 'new tab', () => threadSections(browser), [{ role: 'user', text: '' }])
    await pickModel(browser, 'Keyed Mock', 'fetched-model')
    await submit(browser, 'Hello keyed')
    await waitForThread(browser, [
      { role: 'user', text: 'Hello keyed' },
      { role: 'agent', text: replyText('keyed') },
      { role: 'user', text: '' },
    ])

    const chats = requestsTo('/keyed/v1/chat/completions')
    expect(chats.map((request) => request.authorization)).toEqual([`Bearer ${KEYED_API_KEY}`])
    expect(chats[0].body).toEqual(openAiChatBody({ id: 'keyed', modelId: 'fetched-model' }, [{ role: 'user', content: 'Hello keyed' }]))
  })

  it('shows built-ins with a badge and no delete control in Settings › Providers', async () => {
    // The picker footer is the way users reach this page.
    await openPicker(browser)
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
    await closeSettings(browser)
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
    expect(await sbpCall(browser, 'dez.native/getConfiguredProviderIds')).toContain(addedId)

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
    expect(await sbpCall(browser, 'dez.native/getConfiguredProviderIds')).not.toContain(addedId)
    await closeSettings(browser)
  })
})
