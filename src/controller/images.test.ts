import sbp from '@sbp/sbp'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { findImageReferences, imageMarkdown, type ImageMediaType } from '../model/chat/images'
import './images'

interface SavedFile {
  path: string
  content: Uint8Array
}

interface Toast {
  title?: string
  message: string
  variant?: string
}

let appDir: string
let savedFiles: SavedFile[] = []
let saveAppFile: (file: SavedFile) => Promise<void>
let toasts: Toast[] = []
let consoleError: MockInstance<typeof console.error>

sbp('sbp/selectors/register', {
  async 'dez.native/getAppDir' (): Promise<string> {
    return appDir
  },
  'dez.native/saveAppFile' (path: string, content: Uint8Array): Promise<void> {
    return saveAppFile({ path, content })
  },
  'dez.ui/toast' (_area: string, toast: Toast): void {
    toasts.push(toast)
  },
})

function save(bytes: Uint8Array, mediaType: ImageMediaType): Promise<string> {
  return sbp('dez.controller/images/save', bytes, mediaType) as Promise<string>
}

beforeEach(() => {
  appDir = '/home/ann/.config/dez'
  savedFiles = []
  saveAppFile = async (file) => {
    savedFiles.push(file)
  }
  toasts = []
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleError.mockRestore()
})

describe('dez.controller/images/save', () => {
  it('writes the bytes to a new file in the image folder and returns its absolute path', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71])

    const first = await save(bytes, 'image/png')
    const second = await save(bytes, 'image/jpeg')

    expect(savedFiles.map((file) => file.content)).toEqual([bytes, bytes])
    expect(savedFiles.map((file) => `${appDir}/${file.path}`)).toEqual([first, second])
    expect(first).toMatch(/^\/home\/ann\/\.config\/dez\/assets\/images\/[0-9a-f-]{36}\.png$/)
    expect(second).toMatch(/^\/home\/ann\/\.config\/dez\/assets\/images\/[0-9a-f-]{36}\.jpg$/)
    expect(first.slice(0, -4)).not.toBe(second.slice(0, -4))
    expect(findImageReferences(imageMarkdown(first)).map((ref) => ref.path)).toEqual([first])
    expect(toasts).toEqual([])
  })

  it('logs, shows an error toast, and rejects when the write fails', async () => {
    saveAppFile = async () => {
      throw 'Write error: No space left on device'
    }

    await expect(save(new Uint8Array([1]), 'image/png')).rejects.toBe('Write error: No space left on device')

    expect(consoleError).toHaveBeenCalledWith('Failed to save the image:', 'Write error: No space left on device')
    expect(toasts).toEqual([{
      title: 'Could not save the image',
      message: 'Write error: No space left on device',
      variant: 'error',
    }])
  })

  it.each([
    ['a relative Dez folder ($HOME not set)', './.config/dez'],
    ['a Dez folder with a bracket', '/home/a]b/.config/dez'],
  ])('writes no file and rejects for %s, whose references would not render', async (_case, dir) => {
    appDir = dir

    await expect(save(new Uint8Array([1]), 'image/png')).rejects.toThrow(dir)

    expect(savedFiles).toEqual([])
    expect(toasts).toMatchObject([{ title: 'Could not save the image', variant: 'error' }])
  })
})
