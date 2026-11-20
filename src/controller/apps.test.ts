import sbp from '@sbp/sbp'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { AppCardFacts } from '../model/tools/appShow'
import { APP_DIR, appFiles, fakeAppFiles, failureOf, native, resetNative } from './testing'
// Side-effect import: registers the selectors under test.
import './apps'

interface Toast {
  title?: string
  message: string
  variant?: string
}

let toasts: Toast[] = []
// The file of each context menu that the code showed; null for a menu whose
// item is disabled.
let menus: Array<string | null> = []
let consoleError: MockInstance<typeof console.error>

sbp('sbp/selectors/register', {
  'dez.ui/toast' (_area: string, toast: Toast): void {
    toasts.push(toast)
  },
  async 'dez.controller/menu/popupAsset' (file: string | null): Promise<void> {
    menus.push(file)
  },
})

function card(name: string): Promise<AppCardFacts> {
  return sbp('dez.controller/apps/card', name) as Promise<AppCardFacts>
}

function deleteApp(name: string): Promise<void> {
  return sbp('dez.controller/apps/delete', name) as Promise<void>
}

async function menuOf(name: string): Promise<string | null> {
  menus = []
  await sbp('dez.controller/apps/popupMenu', name)
  expect(menus).toHaveLength(1)
  return menus[0]
}

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  resetNative()
  toasts = []
  menus = []
})

afterEach(() => {
  consoleError.mockRestore()
})

describe('dez.controller/apps/card', () => {
  it('reads the facts of each app from its own files', async () => {
    const files = fakeAppFiles({
      ...appFiles('notes', { 'index.html': '<p>Notes</p>\n', 'data/a.txt': 'abc' }, 'ui'),
      ...appFiles('bare', {}, 'ui'),
      ...appFiles('sum', { 'main.ts': 'export default () => 1\n' }),
    })
    const bytesOf = (name: string) => [...files].reduce((bytes, [path, content]) => bytes + (path.startsWith(`apps/${name}/`) ? content?.length ?? 0 : 0), 0)

    expect(await card('notes')).toStrictEqual({ state: 'ready', description: 'The notes app.', size: { bytes: bytesOf('notes'), more: false } })
    expect(await card('bare')).toStrictEqual({ state: 'broken', size: { bytes: bytesOf('bare'), more: false } })
    expect(await card('sum')).toStrictEqual({ state: 'broken', size: { bytes: bytesOf('sum'), more: false } })
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

describe('dez.controller/apps/delete', () => {
  it('deletes the folder of the app with all that is in it, and no other app', async () => {
    const files = fakeAppFiles({
      ...appFiles('notes', { 'index.html': '<p>Notes</p>\n', 'data/a.txt': 'abc' }, 'ui'),
      ...appFiles('notes-2', { 'index.html': '<p>More</p>\n' }, 'ui'),
    })

    await deleteApp('notes')

    expect([...files.keys()].sort()).toStrictEqual(['apps', 'apps/notes-2', 'apps/notes-2/index.html', 'apps/notes-2/manifest.json'])
    expect(toasts).toStrictEqual([])
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('passes for an app that is gone already, and deletes nothing', async () => {
    fakeAppFiles(appFiles('notes', {}, 'ui'))

    await deleteApp('gone')

    expect(native.deletedFiles).toStrictEqual([])
    expect(toasts).toStrictEqual([])
  })

  it('deletes a file at the place of the folder as a file', async () => {
    const files = fakeAppFiles({ 'apps/notes': 'no folder' })

    await deleteApp('notes')

    expect(files.has('apps/notes')).toBe(false)
  })

  it('logs, shows an error toast with the raw text last, and rejects when the delete fails', async () => {
    const files = fakeAppFiles(appFiles('notes', {}, 'ui'))
    native.deleteAppFile = async () => { throw new Error('Failed to delete apps/notes: Permission denied (os error 13)') }

    const error = await failureOf(deleteApp('notes'))

    expect(error).toBeInstanceOf(Error)
    expect(files.has('apps/notes/manifest.json')).toBe(true)
    expect(consoleError).toHaveBeenCalledWith('Failed to delete the app "notes":', error)
    expect(toasts).toStrictEqual([{
      title: 'Could not delete the app notes',
      message: 'The system did not let Dez delete the folder of the app. The details tell why (for example, Dez has no permission to change the folder, or a link is at the place of the folder). Fix that, and try again.\n\nDetails: Failed to delete apps/notes: Permission denied (os error 13)',
      variant: 'error',
    }])
  })

  // The text of a failed listing is one for a model ("try it again, and
  // tell the user"): the toast must not show it to the user.
  it('shows only the raw text of a listing that failed', async () => {
    native.fileTree = () => { throw new Error('Failed to list apps/notes: Permission denied (os error 13)') }

    await failureOf(deleteApp('notes'))

    expect(toasts).toHaveLength(1)
    expect(toasts[0].message).toMatch(/^The system did not let Dez delete the folder of the app\..*\n\nDetails: Failed to list apps\/notes: Permission denied \(os error 13\)$/s)
    expect(native.deletedFiles).toStrictEqual([])
  })
})

describe('dez.controller/apps/popupMenu', () => {
  it('shows the menu with the folder of the app', async () => {
    fakeAppFiles(appFiles('notes', {}, 'ui'))

    expect(await menuOf('notes')).toBe(`${APP_DIR}/apps/notes`)
  })

  it('shows the menu with no file for an app that is gone, and when the read fails', async () => {
    fakeAppFiles(appFiles('notes', {}, 'ui'))
    expect(await menuOf('gone')).toBeNull()

    native.fileTree = () => { throw new Error('Failed to list apps/notes: Permission denied (os error 13)') }
    expect(await menuOf('notes')).toBeNull()
  })
})
