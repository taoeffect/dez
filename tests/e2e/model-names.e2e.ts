import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startApp, type RunningApp } from './harness/app'
import { click, consoleErrors, openHistoryPanel, resetConsoleErrors, screenshotOnFailure, waitFor, waitForValue } from './harness/dom'
import { makeConversation, seedConversation, seedRawAppState } from './harness/fixtures'
import { replyText, sendChatReply, startChatMock, type MockServer } from './harness/mockServer'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { activeConversationId, activeTabStreaming, maskPillDuration, newTab, openPicker, pickModel, pressRolePill, rolePillHeights, savedPillLines, sbpCall, submit, threadSections, waitForThread } from './harness/thread'

// The model on agent role pills, the model names in history rows, and the
// full model names as tooltips in the model picker, driven through the real
// app against a mock OpenAI-compatible server in this process.
//
// One custom provider ("Mock Provider") has three named config models. Its id
// is a UUID, as the id of a provider added in Settings is, so a check can see
// that no row shows it. Its model ids hold a `/`, as OpenRouter ids do, so
// the `provider/model` key in pills and files has two slashes.
// `fetchModels: false` keeps the model list to the config, so the mock serves
// only chat requests.
//
// One app session serves the whole file. The tests from the model switch
// on run in order in one tab: each builds on the replies of the one before.

/** The model part of an agent role pill. */
interface ChipView {
  key: string
  name: string
  provider: string | null
  switched: boolean
  streaming: boolean
  title: string
  ariaLabel: string
}

interface HistoryRowView {
  model: string | null
  provider: string | null
  key: string | null
  /** `textContent` of the meta line: the spans join with no space, and the
   *  `·` before the provider name is CSS. */
  meta: string
}

interface SeparatorView {
  index: number
  role: string
  chip: ChipView | null
}

const PROVIDER = { id: '6f1d2c3b-8a47-4e5f-9b10-2c3d4e5f6a7b', name: 'Mock Provider' }
const ALPHA = { key: `${PROVIDER.id}/acme/alpha`, modelId: 'acme/alpha', name: 'Alpha One' }
const BETA = { key: `${PROVIDER.id}/acme/beta`, modelId: 'acme/beta', name: 'Beta Two' }
// Its name is wider than the editor column, so its pill must shrink the name.
const LONG = {
  key: `${PROVIDER.id}/acme/long`,
  modelId: 'acme/long',
  name: 'Gamma Extended Preview Edition With An Extremely Long Display Name That Never Fits On One Editor Line',
}
// A model of a provider that was deleted.
const GONE_PROVIDER_ID = '0b7c6a52-5f2e-4c1d-9a8b-3e4f5a6b7c8d'
const GONE = { key: `${GONE_PROVIDER_ID}/old-model`, providerId: GONE_PROVIDER_ID, modelId: 'old-model' }

// What the model part of a pill must show. The title and the aria-label
// list the same facts; the aria-label (on the model part, so the role word
// and the thinking triangle stay readable) labels the model and the
// provider, and says "Generating" while the reply streams.
function expectedChip (
  key: string,
  name: string,
  provider: string | null,
  options: { switchedFrom?: string, streaming?: boolean } = {}
): ChipView {
  const providerText = provider ?? 'Unknown provider'
  const switched = options.switchedFrom ? [`Switched from ${options.switchedFrom}`] : []
  const streaming = options.streaming ?? false
  return {
    key,
    name,
    provider,
    switched: options.switchedFrom !== undefined,
    streaming,
    title: [name, providerText, key, ...switched].join('\n'),
    ariaLabel: [`Model: ${name}`, `Provider: ${providerText}`, key, ...switched, ...(streaming ? ['Generating'] : [])].join(', '),
  }
}

interface MockState {
  /** The `model` of each chat request, in order. */
  chatModels: string[]
  /** When set, the next reply sends its tokens, then waits for this
   *  promise before it ends the stream. */
  hold: Promise<void> | null
}

describe('model names', () => {
  let app: RunningApp
  let browser: E2EBrowser
  let server: MockServer
  const mock: MockState = { chatModels: [], hold: null }

  // Every role separator of the active editor, with the model part of its
  // pill.
  async function separators (): Promise<SeparatorView[]> {
    return browser.execute(() =>
      Array.from(document.querySelectorAll<HTMLElement>('.cm-content .dez-role-separator')).map((separator) => {
        const pill = separator.querySelector<HTMLElement>('.dez-role-separator__label')
        const key = pill?.dataset.modelKey
        return {
          index: Number(separator.dataset.sectionIndex),
          role: separator.dataset.role ?? '',
          chip: pill && key !== undefined
            ? {
                key,
                name: pill.querySelector('.dez-role-separator__model-name')?.textContent ?? '',
                provider: pill.querySelector('.dez-role-separator__model-provider')?.textContent ?? null,
                switched: pill.dataset.switched === '1',
                streaming: pill.dataset.streaming === '1',
                title: pill.title,
                ariaLabel: pill.querySelector('.dez-role-separator__model')?.getAttribute('aria-label') ?? '',
              }
            : null,
        }
      })
    )
  }

  // The marker line of each section in the active tab's conversation file,
  // or null while the file does not exist. The reply time changes from run
  // to run, so its digits read as `#`.
  async function activeTabPillLines (): Promise<string[] | null> {
    return (await savedPillLines(app.home, await activeConversationId(browser)))?.map(maskPillDuration) ?? null
  }

  // The model part of the history row of each title in `titles`.
  async function historyRows (titles: string[]): Promise<Record<string, HistoryRowView>> {
    return browser.execute((wanted: string[]) => Object.fromEntries(
      Array.from(document.querySelectorAll('.history-row'))
        .map((row) => [row.querySelector('h3')?.textContent ?? '', row] as const)
        .filter(([title]) => wanted.includes(title))
        .map(([title, row]) => [title, {
          model: row.querySelector('.history-row-model-name')?.textContent ?? null,
          provider: row.querySelector('.history-row-model-provider')?.textContent ?? null,
          key: row.querySelector('.history-row-model')?.getAttribute('title') ?? null,
          meta: row.querySelector('.history-row-meta')?.textContent ?? '',
        }])
    ), titles)
  }

  // Each model row of the open picker's Mock Provider group: the shown
  // name, its tooltip, and whether the row cuts the name off.
  async function pickerRows (): Promise<Array<{ name: string, title: string, clipped: boolean }>> {
    return browser.execute((provider: string) => {
      const group = Array.from(document.querySelectorAll('.model-dropdown .model-group')).find(
        (candidate) => candidate.querySelector('.model-group-header')?.textContent?.trim() === provider
      )
      return Array.from(group?.querySelectorAll<HTMLElement>('.model-item-name') ?? []).map((name) => ({
        name: name.textContent?.trim() ?? '',
        title: name.title,
        clipped: name.scrollWidth > name.clientWidth,
      }))
    }, PROVIDER.name)
  }

  beforeAll(async () => {
    // Answers only chat requests to `/mock/v1`, and records their models.
    server = await startChatMock(['/mock/v1/chat/completions'], async (_req, res, body) => {
      const model = String(JSON.parse(body).model)
      mock.chatModels.push(model)
      const hold = mock.hold
      mock.hold = null
      await sendChatReply(res, model, hold)
    })
    app = await startApp()
    try {
      await seedRawAppState(app.home, {
        customProviders: [{
          id: PROVIDER.id,
          name: PROVIDER.name,
          baseUrl: `${server.url}/mock/v1`,
          fetchModels: false,
          models: [{ id: ALPHA.modelId, name: ALPHA.name }, { id: BETA.modelId, name: BETA.name }, { id: LONG.modelId, name: LONG.name }],
        }],
      })
      await seedConversation(app.home, makeConversation({
        id: 'seeded',
        title: 'Seeded',
        sections: [
          { role: 'user', nodes: [{ kind: 'text', text: 'First question' }] },
          { role: 'agent', nodes: [{ kind: 'text', text: 'Alpha answer' }], model: { providerId: PROVIDER.id, modelId: ALPHA.modelId } },
          { role: 'user', nodes: [{ kind: 'text', text: 'Second question' }] },
          // Saved before agent pills had a model.
          { role: 'agent', nodes: [{ kind: 'text', text: 'Legacy answer' }] },
          { role: 'user', nodes: [{ kind: 'text', text: 'Third question' }] },
          // Its provider was deleted.
          { role: 'agent', nodes: [{ kind: 'text', text: 'Orphan answer' }], model: { providerId: GONE.providerId, modelId: GONE.modelId } },
          { role: 'user', nodes: [{ kind: 'text', text: 'Fourth question' }] },
          { role: 'agent', nodes: [{ kind: 'text', text: 'Long answer' }], model: { providerId: PROVIDER.id, modelId: LONG.modelId } },
        ],
      }))
      // The header `model:` is what the history row shows.
      await seedConversation(app.home, makeConversation({
        id: 'history-custom',
        title: 'Custom provider chat',
        sections: [{ role: 'user', nodes: [{ kind: 'text', text: 'Custom question' }] }],
        activeModel: { providerId: PROVIDER.id, modelId: ALPHA.modelId, modelName: ALPHA.name },
      }))
      await seedConversation(app.home, makeConversation({
        id: 'history-orphan',
        title: 'Deleted provider chat',
        sections: [{ role: 'user', nodes: [{ kind: 'text', text: 'Orphan question' }] }],
        activeModel: { providerId: GONE.providerId, modelId: GONE.modelId, modelName: GONE.modelId },
      }))
      await seedConversation(app.home, makeConversation({
        id: 'history-none',
        title: 'No model chat',
        sections: [{ role: 'user', nodes: [{ kind: 'text', text: 'Plain question' }] }],
      }))
      browser = await createSession(app.binary, app.port)
    } catch (err) {
      await app.stop()
      throw err
    }
    await waitFor(browser, 'header.tab-bar', 60_000)
  })

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

  it('shows the saved model of each response in a saved conversation', async () => {
    await sbpCall(browser, 'dez.model/tabs/openConversation', 'seeded')
    // The legacy pill has no model. The unknown provider has no provider
    // label, and the model id stands in for the model name. Its response
    // follows an Alpha One response, so it shows the switch cue.
    await waitForValue(browser, 'separators', separators, [
      { index: 1, role: 'agent', chip: expectedChip(ALPHA.key, ALPHA.name, PROVIDER.name) },
      { index: 2, role: 'user', chip: null },
      { index: 3, role: 'agent', chip: null },
      { index: 4, role: 'user', chip: null },
      {
        index: 5,
        role: 'agent',
        chip: expectedChip(GONE.key, GONE.modelId, null, { switchedFrom: `${ALPHA.name} (${PROVIDER.name})` }),
      },
      { index: 6, role: 'user', chip: null },
      { index: 7, role: 'agent', chip: expectedChip(LONG.key, LONG.name, PROVIDER.name, { switchedFrom: GONE.modelId }) },
    ])
    // A pill with a model is as tall as one without, so a separator does
    // not move when a stream stamps a model on its pill. The long model
    // name shrinks: it wraps neither the role word nor the name.
    const [first, ...rest] = await rolePillHeights(browser)
    expect(rest).toHaveLength(6)
    for (const height of rest) expect(height).toBeCloseTo(first, 1)
  })

  it('shows the full model name as the tooltip of each picker row', async () => {
    await openPicker(browser)
    // The model button toggles the picker, so the next test's `pickModel`
    // needs it closed even when a check here fails.
    try {
      // The long name does not fit its row, so only its tooltip shows all
      // of it.
      await waitForValue(browser, 'picker rows', pickerRows, [
        { name: ALPHA.name, title: ALPHA.name, clipped: false },
        { name: BETA.name, title: BETA.name, clipped: false },
        { name: LONG.name, title: LONG.name, clipped: true },
      ])
    } finally {
      await click(browser, '.model-selector-btn')
    }
    await waitForValue(browser, 'picker open', () => browser.execute(() => document.querySelector('.model-dropdown') !== null), false)
  })

  it('labels each response with the model that wrote it across a model switch', async () => {
    await newTab(browser)
    await pickModel(browser, PROVIDER.name, ALPHA.name)
    await submit(browser, 'Hello alpha')
    await waitForThread(browser, [
      { role: 'user', text: 'Hello alpha' },
      { role: 'agent', text: replyText(ALPHA.modelId) },
      { role: 'user', text: '' },
    ])
    await pickModel(browser, PROVIDER.name, BETA.name)
    await submit(browser, 'Now beta')
    await waitForThread(browser, [
      { role: 'user', text: 'Hello alpha' },
      { role: 'agent', text: replyText(ALPHA.modelId) },
      { role: 'user', text: 'Now beta' },
      { role: 'agent', text: replyText(BETA.modelId) },
      { role: 'user', text: '' },
    ])
    expect(mock.chatModels).toEqual([ALPHA.modelId, BETA.modelId])

    await waitForValue(browser, 'separators', separators, [
      { index: 1, role: 'agent', chip: expectedChip(ALPHA.key, ALPHA.name, PROVIDER.name) },
      { index: 2, role: 'user', chip: null },
      { index: 3, role: 'agent', chip: expectedChip(BETA.key, BETA.name, PROVIDER.name, { switchedFrom: `${ALPHA.name} (${PROVIDER.name})` }) },
      { index: 4, role: 'user', chip: null },
    ])
    // The editor writes its section data back to the store on every token,
    // so this also shows that the model stamped at stream start survived the
    // stream.
    await waitForValue(browser, 'saved pills', activeTabPillLines, [
      '<dez:pill type="user"/>',
      `<dez:pill type="agent" model="${ALPHA.key}" duration-ms="#"/>`,
      '<dez:pill type="user"/>',
      `<dez:pill type="agent" model="${BETA.key}" duration-ms="#"/>`,
      '<dez:pill type="user"/>',
    ])
  })

  it('keeps the role of a pill that a press lands on', async () => {
    // A press on a pill with no thinking triangle does nothing: no part of
    // a pill changes its role. The handler runs in the press, so a change
    // would show at once.
    await pressRolePill(browser, 1, '.dez-role-separator__model-name')
    await pressRolePill(browser, 2)
    expect(await separators()).toEqual([
      { index: 1, role: 'agent', chip: expectedChip(ALPHA.key, ALPHA.name, PROVIDER.name) },
      { index: 2, role: 'user', chip: null },
      { index: 3, role: 'agent', chip: expectedChip(BETA.key, BETA.name, PROVIDER.name, { switchedFrom: `${ALPHA.name} (${PROVIDER.name})` }) },
      { index: 4, role: 'user', chip: null },
    ])
  })

  it('marks the pill of the streaming response as generating', async () => {
    let release = (): void => {}
    mock.hold = new Promise<void>((resolve) => { release = resolve })
    try {
      await submit(browser, 'Hold on')
      // The mock has sent every token and holds the stream open.
      await waitForValue(browser, 'held reply', async () => (await threadSections(browser))[5]?.text ?? null, replyText(BETA.modelId))
      expect(await activeTabStreaming(browser)).toBe(true)
      await waitForValue(browser, 'separators while streaming', separators, [
        { index: 1, role: 'agent', chip: expectedChip(ALPHA.key, ALPHA.name, PROVIDER.name) },
        { index: 2, role: 'user', chip: null },
        { index: 3, role: 'agent', chip: expectedChip(BETA.key, BETA.name, PROVIDER.name, { switchedFrom: `${ALPHA.name} (${PROVIDER.name})` }) },
        { index: 4, role: 'user', chip: null },
        { index: 5, role: 'agent', chip: expectedChip(BETA.key, BETA.name, PROVIDER.name, { streaming: true }) },
      ])
    } finally {
      release()
    }

    await waitForThread(browser, [
      { role: 'user', text: 'Hello alpha' },
      { role: 'agent', text: replyText(ALPHA.modelId) },
      { role: 'user', text: 'Now beta' },
      { role: 'agent', text: replyText(BETA.modelId) },
      { role: 'user', text: 'Hold on' },
      { role: 'agent', text: replyText(BETA.modelId) },
      { role: 'user', text: '' },
    ])
    await waitForValue(browser, 'separators after the stream', async () => (await separators()).find((separator) => separator.index === 5) ?? null, {
      index: 5,
      role: 'agent',
      chip: expectedChip(BETA.key, BETA.name, PROVIDER.name),
    })
  })

  it('shows provider and model names, never a provider id, in history rows', async () => {
    await openHistoryPanel(browser)
    // The deleted provider has no name, so its row shows only the model id.
    // The title keeps the raw key. A conversation without a header model
    // shows "No model".
    const titles = ['Custom provider chat', 'Deleted provider chat', 'No model chat']
    await waitForValue(browser, 'history rows', () => historyRows(titles), {
      'Custom provider chat': { model: ALPHA.name, provider: PROVIDER.name, key: ALPHA.key, meta: `${ALPHA.name}${PROVIDER.name}1 message` },
      'Deleted provider chat': { model: GONE.modelId, provider: null, key: GONE.key, meta: `${GONE.modelId}1 message` },
      'No model chat': { model: null, provider: null, key: null, meta: 'No model1 message' },
    })

    // A rename updates the open panel.
    const providers = await sbpCall(browser, 'dez.model/customProviders/list') as Array<{ id: string }>
    const config = providers.find((provider) => provider.id === PROVIDER.id)
    await sbpCall(browser, 'dez.controller/providers/save', { ...config, name: 'Renamed Provider' })
    await waitForValue(browser, 'renamed history row', async () => (await historyRows(['Custom provider chat']))['Custom provider chat'], {
      model: ALPHA.name,
      provider: 'Renamed Provider',
      key: ALPHA.key,
      meta: `${ALPHA.name}Renamed Provider1 message`,
    })
    await click(browser, '.history-close')
  })
})
