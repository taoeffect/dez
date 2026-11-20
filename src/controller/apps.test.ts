import sbp from '@sbp/sbp'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { AppCardFacts } from '../model/tools/appShow'
import { APP_DIR, appFiles, fakeAppFiles, native, resetNative } from './testing'
// Side-effect import: registers the selector under test.
import './apps'

function card(name: string): Promise<AppCardFacts> {
  return sbp('dez.controller/apps/card', name) as Promise<AppCardFacts>
}

let consoleError: MockInstance<typeof console.error>

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  resetNative()
})

afterEach(() => {
  consoleError.mockRestore()
})

describe('dez.controller/apps/card', () => {
  it('reads the facts of each app from its own files', async () => {
    fakeAppFiles({
      ...appFiles('notes', { 'index.html': '<p>Notes</p>\n' }, 'ui'),
      ...appFiles('bare', {}, 'ui'),
      ...appFiles('sum', { 'main.ts': 'export default () => 1\n' }),
    })

    expect(await card('notes')).toStrictEqual({ state: 'ready', description: 'The notes app.' })
    expect(await card('bare')).toStrictEqual({ state: 'broken' })
    expect(await card('sum')).toStrictEqual({ state: 'broken' })
    expect(await card('gone')).toStrictEqual({ state: 'missing' })
    expect(consoleError).not.toHaveBeenCalled()
  })

  // The card must not take a failed read for an app that is gone: the user
  // would think that the files of the app are deleted.
  it('tells of a read that failed, and does not reject', async () => {
    fakeAppFiles(appFiles('notes', { 'index.html': '<p>Notes</p>\n' }, 'ui'))
    native.fileBytes = () => { throw new Error(`Failed to read ${APP_DIR}/apps/notes/manifest.json: Permission denied (os error 13)`) }

    expect(await card('notes')).toStrictEqual({ state: 'unreadable' })
    expect(consoleError).toHaveBeenCalled()
  })
})
