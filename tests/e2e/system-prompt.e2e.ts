import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BUILT_IN_SYSTEM_PROMPT, systemPromptErrorText, systemPromptProblem } from '../../src/model/systemPrompt'
import { openAiChatBody, systemPrompt } from './harness/chatBody'
import { click, clickSettingsNav, clickWithText, closeSettings, consoleErrors, pointerClick, promptMessage, resetConsoleErrors, screenshotOnFailure, typeInto, typeKeys, waitFor, waitForValue } from './harness/dom'
import { readAppState } from './harness/fixtures'
import { expectSendRefused, startMockProviderApp, takeRequest, type MockProviderApp } from './harness/mockProviderApp'
import { mockChatPath, replyText, sendChatReply, type MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import { sbpCall, submit, waitForThread } from './harness/thread'

// Settings › System Prompt, through the real app against a mock server in
// this process:
// - the page shows the built-in prompt, locked until the user checks Edit;
// - an edit is saved in app_state.json, and the next chat request sends it
//   with the values of its variables;
// - an empty prompt sends no system prompt, and the page says so;
// - a placeholder that is not a variable shows an error on the page, and a
//   send gets the error as a "Cannot send" toast and makes no request;
// - Preview shows the prompt as the active model gets it, as markdown, with
//   an image reference and a media tag as text;
// - Restore Default asks first, then puts back the built-in prompt.
//
// One app session serves the whole file; each test starts in a new tab with
// the built-in prompt.

const PROVIDER: MockProvider = { id: 'prompter', name: 'Prompt Mock', modelId: 'prompt-model', modelName: 'Prompt Model' }

const RESTORE_PROMPT = 'Are you sure you want to restore the default system prompt? This deletes your own prompt.'

interface PageLook {
  source: string
  readOnly: boolean
  editing: boolean
  restore: boolean
  /** The error text under the prompt. Not named `error`: WebDriver takes
   *  a script result with an `error` key for a failed command. */
  problem: string | null
  blankNote: string | null
}

describe('Settings › System Prompt', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser

  async function pageLook (): Promise<PageLook> {
    return browser.execute(() => {
      const source = document.querySelector<HTMLTextAreaElement>('.system-prompt-source')
      const edit = document.querySelector<HTMLInputElement>('.system-prompt-edit')
      if (!source || !edit) throw new Error('pageLook: the System Prompt page is not open')
      return {
        source: source.value,
        readOnly: source.readOnly,
        editing: edit.checked,
        restore: document.querySelector('.system-prompt-restore') !== null,
        problem: document.querySelector('.system-prompt-error')?.textContent ?? null,
        blankNote: document.querySelector('.system-prompt-blank')?.textContent?.trim() ?? null,
      }
    })
  }

  // The prompt in app_state.json; null for the built-in one.
  async function savedPrompt (): Promise<string | null | undefined> {
    return (await readAppState(setup.app.home))?.systemPrompt
  }

  async function openPage (): Promise<void> {
    await sbpCall(browser, 'dez.model/settings/open', 'systemPrompt')
    await waitFor(browser, '.system-prompt-source')
  }

  // Checks Edit, then puts `text` in place of the whole prompt as typing
  // does: one input event per character.
  async function writePrompt (text: string): Promise<void> {
    if (!(await pageLook()).editing) await click(browser, '.system-prompt-edit')
    await typeInto(browser, '.system-prompt-source', text, { clear: true })
    await waitForValue(browser, 'saved prompt', savedPrompt, text)
  }

  // Sends `text`, checks that the request body is the chat body with the
  // system prompt of `template`, then answers it.
  async function sendAndExpect (text: string, template: string): Promise<void> {
    await submit(browser, text)
    const request = await takeRequest(setup, mockChatPath(PROVIDER), openAiChatBody(PROVIDER, [{ role: 'user', content: text }], template))
    await sendChatReply(request.reply, PROVIDER.modelName)
    await waitForThread(browser, [
      { role: 'user', text },
      { role: 'agent', text: replyText(PROVIDER.modelName) },
      { role: 'user', text: '' },
    ])
  }

  // Clicks the Source or the Preview button of the prompt box.
  async function showMode (label: 'Source' | 'Preview'): Promise<void> {
    await clickWithText(browser, '.system-prompt-mode', label)
  }

  // The lines that the preview's editor draws.
  async function previewLines (): Promise<string[]> {
    return browser.execute(() => Array.from(document.querySelectorAll('.system-prompt-preview .cm-line'), (line) => line.textContent ?? ''))
  }

  beforeAll(async () => {
    setup = await startMockProviderApp(PROVIDER)
    browser = setup.browser
  })

  beforeEach(async () => {
    await sbpCall(browser, 'dez.model/settings/setSystemPrompt', null)
    await sbpCall(browser, 'dez.model/tabs/create')
    await resetConsoleErrors(browser)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    await setup.mock.dropOpenReplies(browser)
    await sbpCall(browser, 'dez.model/settings/close')
    if (ctx.task.result?.state === 'fail') return
    expect(await consoleErrors(browser)).toEqual([])
  })

  afterAll(async () => {
    await setup?.stop()
  })

  it('shows the built-in prompt locked until Edit, and saves and sends an edit', async () => {
    await sbpCall(browser, 'dez.model/settings/open', 'general')
    await waitFor(browser, '.settings-overlay')
    await clickSettingsNav(browser, 'System Prompt')
    await waitFor(browser, '.system-prompt-source')
    expect(await pageLook()).toStrictEqual({ source: BUILT_IN_SYSTEM_PROMPT, readOnly: true, editing: false, restore: false, problem: null, blankNote: null })
    expect(await browser.execute(() => Array.from(
      document.querySelectorAll('.system-prompt-variables code'),
      (code) => code.textContent,
    ))).toStrictEqual(['{{model_id}}', '{{provider_id}}', '{{provider_name}}', '{{tools_list}}'])

    // A key in the locked text changes nothing.
    await pointerClick(browser, '.system-prompt-source')
    await typeKeys(browser, 'x')
    expect((await pageLook()).source).toBe(BUILT_IN_SYSTEM_PROMPT)

    // Edit unlocks it: a key at the end is saved, and Restore Default shows.
    await click(browser, '.system-prompt-edit')
    await browser.execute(() => {
      const source = document.querySelector<HTMLTextAreaElement>('.system-prompt-source')
      if (!source) throw new Error('no prompt text')
      source.focus()
      source.setSelectionRange(source.value.length, source.value.length)
    })
    await typeKeys(browser, '!')
    await waitForValue(browser, 'saved prompt', savedPrompt, `${BUILT_IN_SYSTEM_PROMPT}!`)
    expect(await pageLook()).toStrictEqual({ source: `${BUILT_IN_SYSTEM_PROMPT}!`, readOnly: false, editing: true, restore: true, problem: null, blankNote: null })

    // The request gets the user's prompt with the values of its variables.
    const custom = 'You are {{model_id}} of {{provider_name}} ({{provider_id}}).'
    await writePrompt(custom)
    expect(systemPrompt(PROVIDER, custom)).toBe('You are prompt-model of Prompt Mock (prompter).')
    await closeSettings(browser)
    await sendAndExpect('Hello', custom)

    // The page opens locked again, with the user's prompt.
    await openPage()
    expect(await pageLook()).toStrictEqual({ source: custom, readOnly: true, editing: false, restore: true, problem: null, blankNote: null })
  })

  it('sends no system prompt for an empty prompt, and says so', async () => {
    await openPage()
    await writePrompt('')
    expect(await pageLook()).toStrictEqual({
      source: '',
      readOnly: false,
      editing: true,
      restore: true,
      problem: null,
      blankNote: 'The prompt is empty, so Dez sends no system prompt.',
    })
    await closeSettings(browser)
    await sendAndExpect('No prompt', '')
  })

  it('shows the error of a placeholder that is no variable, and refuses the send', async () => {
    await openPage()
    const template = 'Hi.\n{{foo}}'
    await writePrompt(template)
    const problem = systemPromptProblem(template)
    if (problem === null) throw new Error(`No problem in ${JSON.stringify(template)}`)
    expect((await pageLook()).problem).toBe(problem)
    await showMode('Preview')
    await waitForValue(browser, 'preview note', () => browser.execute(() => document.querySelector('.system-prompt-preview-note')?.textContent ?? null), 'Fix the error in the prompt to see the preview.')
    await closeSettings(browser)

    await submit(browser, 'Refused')
    await expectSendRefused(setup, systemPromptErrorText(problem), [{ role: 'user', text: 'Refused' }])
    await resetConsoleErrors(browser)
  })

  it('previews the prompt as the active model gets it, with an image reference and a media tag as text', async () => {
    await openPage()
    await showMode('Preview')
    await waitFor(browser, '.system-prompt-preview .cm-line')
    const builtIn = systemPrompt(PROVIDER)
    if (builtIn === undefined) throw new Error('The built-in prompt is blank')
    expect((await previewLines())[0]).toBe(builtIn.split('\n')[0])
    expect(await browser.execute(() => document.querySelector('.system-prompt-preview-model')?.textContent?.trim())).toBe(`As ${PROVIDER.modelName} (${PROVIDER.name}) gets it`)

    // Back to Source, an edit, and Preview again: the preview follows.
    await showMode('Source')
    await writePrompt('# {{model_id}}\n\nAn image `![image](id=a)`, ![image](id=a), and a clip `<dez:audio id="b" type="audio/wav"/>`.')
    await showMode('Preview')
    await waitForValue(browser, 'preview lines', previewLines, [
      '# prompt-model',
      '',
      'An image `![image](id=a)`, ![image](id=a), and a clip `<dez:audio id="b" type="audio/wav"/>`.',
    ])
    expect(await browser.execute(() => document.querySelectorAll('.system-prompt-preview :is(img, audio, video, .dez-image, .dez-media)').length)).toBe(0)
  })

  it('restores the default prompt after the user says yes', async () => {
    await openPage()
    await writePrompt('My own prompt')

    // Cancel keeps the user's prompt.
    await pointerClick(browser, '.system-prompt-restore')
    await waitForValue(browser, 'prompt', () => promptMessage(browser), RESTORE_PROMPT)
    await pointerClick(browser, '.confirm-btn--cancel')
    await waitForValue(browser, 'prompt after Cancel', () => promptMessage(browser), null)
    expect((await pageLook()).source).toBe('My own prompt')
    expect(await savedPrompt()).toBe('My own prompt')

    // Restore Default puts back the built-in prompt, and the button goes.
    await pointerClick(browser, '.system-prompt-restore')
    await waitForValue(browser, 'second prompt', () => promptMessage(browser), RESTORE_PROMPT)
    await pointerClick(browser, '.confirm-btn--confirm')
    await waitForValue(browser, 'page after Restore Default', pageLook, { source: BUILT_IN_SYSTEM_PROMPT, readOnly: false, editing: true, restore: false, problem: null, blankNote: null })
    await waitForValue(browser, 'saved prompt', savedPrompt, null)
  })
})
