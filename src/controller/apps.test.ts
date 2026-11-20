import sbp from '@sbp/sbp'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { ClipReadError } from '../model/chat/mediaFiles'
import type { Section } from '../model/chat/types'
import { conversationAssets } from '../model/streams/mediaRequest'
import { user } from '../model/streams/testing'
import { AppCallError, clipNotReadText, imageNotReadText, SaveNotStoredError, unknownAssetText, type SavedAppFile, type SavedAssetAnswer } from '../model/tools/appBridge'
import { SaveCount } from '../model/tools/appInvoke'
import type { AppCardFacts } from '../model/tools/appShow'
import { APP_RUN_MAX_OUTPUT_FILES } from '../model/tools/appsTool'
import { CONVERSATION, PNG_BYTES, SONG, textBytes, WAV_BYTES } from '../model/tools/testing'
import { APP_DIR, appFiles, fakeAppFiles, failureOf, FILE_ID, native, resetNative } from './testing'
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
// The paths of the images that Dez read and deleted, and the sources of
// the clips.
let readImages: string[] = []
let deletedImages: string[] = []
let deletedClips: string[] = []
// The error of each read of a file; null for a read that gives the bytes.
let readFailure: Error | null = null

sbp('sbp/selectors/register', {
  'dez.ui/toast' (_area: string, toast: Toast): void {
    toasts.push(toast)
  },
  async 'dez.controller/menu/popupAsset' (file: string | null): Promise<void> {
    menus.push(file)
  },
  // The read gives a file with the name of the user's file, as the real
  // one does.
  async 'dez.controller/images/readFile' (path: string): Promise<File> {
    readImages.push(path)
    if (readFailure) throw readFailure
    return new File([PNG_BYTES], path.slice(path.lastIndexOf('/') + 1), { type: 'image/png' })
  },
  async 'dez.controller/media/readClip' (clip: { type: string }): Promise<Blob> {
    if (readFailure) throw readFailure
    return new Blob([WAV_BYTES], { type: clip.type })
  },
  async 'dez.controller/images/delete' (path: string): Promise<void> {
    deletedImages.push(path)
  },
  async 'dez.controller/media/delete' (path: string): Promise<void> {
    deletedClips.push(path)
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
  readImages = []
  deletedImages = []
  deletedClips = []
  readFailure = null
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

describe('dez.controller/apps/readAsset', () => {
  function readAsset(id: string, sections: readonly Section[] = CONVERSATION): Promise<Blob> {
    return sbp('dez.controller/apps/readAsset', id, sections) as Promise<Blob>
  }

  // A linked file is outside the Dez folders: the page gets its bytes, and
  // not its name.
  it('gives the bytes of an image of the conversation as a Blob with no name, also of a linked file', async () => {
    const linked = '/home/u/Pictures/private-name.png'

    const blob = await readAsset('a', [user('u1', `![id=a](${linked})`)])

    expect(readImages).toStrictEqual([linked])
    expect(blob).not.toBeInstanceOf(File)
    expect(blob.type).toBe('image/png')
    expect(new Uint8Array(await blob.arrayBuffer())).toStrictEqual(PNG_BYTES)
  })

  it('gives the bytes of a clip with the type of the clip', async () => {
    const blob = await readAsset('b')

    expect(blob.type).toBe('audio/wav')
    expect(new Uint8Array(await blob.arrayBuffer())).toStrictEqual(WAV_BYTES)
  })

  it('refuses an id of no image and no clip, and names the ones that the conversation has', async () => {
    const error = await failureOf(readAsset('zz'))

    expect(error).toBeInstanceOf(AppCallError)
    expect((error as Error).message).toBe(unknownAssetText('zz', conversationAssets(CONVERSATION)))
    expect((error as Error).message).toContain('the image @a')
    expect((error as Error).message).not.toContain('/home/u')
    expect(readImages).toStrictEqual([])
  })

  it('tells the page of a file that Dez could not read, with no path, and logs the read', async () => {
    readFailure = new Error('The file cannot be read (HTTP 404).')
    const image = await failureOf(readAsset('a'))
    readFailure = new ClipReadError('deleted')
    const clip = await failureOf(readAsset('b'))

    expect(image).toBeInstanceOf(AppCallError)
    expect((image as Error).message).toBe(imageNotReadText('a'))
    expect(clip).toBeInstanceOf(AppCallError)
    expect((clip as Error).message).toBe(clipNotReadText(SONG, 'deleted'))
    expect(consoleError).toHaveBeenCalledWith('Failed to read @a for an app:', expect.any(Error))
    expect(consoleError).toHaveBeenCalledWith('Failed to read @b for an app:', readFailure)
  })
})

describe('dez.controller/apps/saveAsset', () => {
  // The files that the conversation got, and the id that it gives each.
  let inserted: SavedAppFile[] = []
  // What the insert does in place of that; null for an insert that works.
  let insertFailure: Error | null = null

  function saveAsset(bytes: Uint8Array, saves = new SaveCount()): Promise<SavedAssetAnswer> {
    return sbp('dez.controller/apps/saveAsset', new Blob([bytes], { type: 'text/plain' }), saves, (file: SavedAppFile) => {
      if (insertFailure) throw insertFailure
      inserted.push(file)
      return 'g'
    }) as Promise<SavedAssetAnswer>
  }

  const storedPaths = () => native.savedFiles.map(({ file }) => `${APP_DIR}/${file.path}`)

  beforeEach(() => {
    inserted = []
    insertFailure = null
  })

  // The type is the one that the bytes tell, and not the type of the Blob.
  it('stores the bytes under the type that they tell, gives the file to the conversation, and its id to the page', async () => {
    const image = await saveAsset(PNG_BYTES)
    const clip = await saveAsset(WAV_BYTES)

    expect(native.savedFiles.map(({ file, content }) => [file.path.replace(FILE_ID, '<id>'), content])).toStrictEqual([
      ['assets/generated/images/<id>.png', PNG_BYTES],
      ['assets/generated/audio/<id>.wav', WAV_BYTES],
    ])
    const [first, second] = storedPaths()
    expect(inserted).toStrictEqual([{ path: first, kind: 'image', type: 'image/png' }, { path: second, kind: 'audio', type: 'audio/wav' }])
    // The answer for the page holds no path.
    expect(image).toStrictEqual({ id: 'g', kind: 'image', type: 'image/png' })
    expect(clip).toStrictEqual({ id: 'g', kind: 'audio', type: 'audio/wav' })
    expect(toasts).toStrictEqual([])
  })

  // No text names the file, so only Delete Unreferenced Files would find it.
  it('deletes the stored file when the conversation cannot take it, and rejects with the reason', async () => {
    insertFailure = new AppCallError('The app stopped.')

    const image = await failureOf(saveAsset(PNG_BYTES))
    const clip = await failureOf(saveAsset(WAV_BYTES))

    expect(image).toBe(insertFailure)
    expect(clip).toBe(insertFailure)
    const [first, second] = storedPaths()
    expect(deletedImages).toStrictEqual([first])
    expect(deletedClips).toStrictEqual([second])
    expect(toasts).toStrictEqual([])
  })

  it('writes no file and shows no toast for a save that Dez refuses', async () => {
    const error = await failureOf(saveAsset(textBytes('Just some notes.\n')))

    expect(error).toBeInstanceOf(AppCallError)
    expect((error as Error).message).toContain('no file of a type that Dez stores')
    expect(native.savedFiles).toStrictEqual([])
    expect(inserted).toStrictEqual([])
    expect(toasts).toStrictEqual([])
  })

  it('refuses the save after the most saves of a run of the app', async () => {
    const saves = new SaveCount()
    for (let count = 0; count < APP_RUN_MAX_OUTPUT_FILES; count += 1) saves.take()

    const error = await failureOf(saveAsset(PNG_BYTES, saves))

    expect(error).toBeInstanceOf(AppCallError)
    expect((error as Error).message).toContain('this run has used them')
    expect(native.savedFiles).toStrictEqual([])
  })

  it('logs, shows an error toast with the raw text last, and rejects with a text with no path when the write fails', async () => {
    const failure = new Error(`Failed to write ${APP_DIR}/assets/generated/images/x.png: No space left on device (os error 28)`)
    native.saveAppFile = async () => { throw failure }

    const error = await failureOf(saveAsset(PNG_BYTES))

    expect(error).toBeInstanceOf(SaveNotStoredError)
    expect((error as Error).message).not.toContain('/home/u')
    expect(inserted).toStrictEqual([])
    expect(consoleError).toHaveBeenCalledWith('Failed to store a file that an app saved:', failure)
    expect(toasts).toStrictEqual([{
      title: 'Could not save the file of the app',
      message: `The system did not let Dez write the file that the app saved. The details tell why (for example, the disk is full). Fix that, and save in the app again.\n\nDetails: ${failure.message}`,
      variant: 'error',
    }])
  })
})
