import sbp from '@sbp/sbp'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { AssetExport } from '../model/chat/assetExport'
import type { Tab } from '../model/chat/types'
import type { NativeDownloadRule, NativeHttpDownload, NativeHttpRequest } from '../utils/protocol/nativeHttp'
import type { AppFileRef } from './nativeTypes'
import './exportAsset'

interface Toast {
  title?: string
  message: string
  variant?: string
  sbpInvocation?: unknown[]
}

const CACHE_DIR = '/home/ann/.cache/dez'
const IMAGE = '/home/ann/.config/dez/assets/images/0c4e7a51.png'
const CLIP_URL = 'https://cdn.example/out/v.mp4?sig=1'
const SAVED: NativeHttpDownload = { status: 200, statusText: 'OK', headers: {}, saved: true, body: [] }

let tabTitle: string
let dialogs: Array<{ defaultPath?: string }> = []
let pickTarget: () => Promise<string | null>
let copies: Array<{ source: string, target: string }> = []
let exportFile: () => Promise<void>
let downloads: Array<{ request: NativeHttpRequest, file: AppFileRef }> = []
let downloadAppFile: () => Promise<NativeHttpDownload>
let deletedFiles: AppFileRef[] = []
let toasts: Toast[] = []
let consoleError: MockInstance<typeof console.error>

sbp('sbp/selectors/register', {
  'dez.model/tabs/activeId' (): string {
    return 'tab-1'
  },
  'dez.model/tab' (tabId: string): Partial<Tab> | null {
    return tabId === 'tab-1' ? { id: tabId, title: tabTitle } : null
  },
  async 'dez.native/showSaveDialog' (options: { defaultPath?: string }): Promise<string | null> {
    dialogs.push(options)
    return pickTarget()
  },
  async 'dez.native/exportFile' (source: string, target: string): Promise<void> {
    copies.push({ source, target })
    await exportFile()
  },
  async 'dez.native/getAppDir' (root = 'app'): Promise<string> {
    return root === 'cache' ? CACHE_DIR : '/home/ann/.config/dez'
  },
  async 'dez.native/downloadAppFile' (request: NativeHttpRequest, _requestId: string, file: AppFileRef, _rule: NativeDownloadRule): Promise<NativeHttpDownload> {
    downloads.push({ request, file })
    return downloadAppFile()
  },
  async 'dez.native/deleteAppFile' (path: string, root = 'app'): Promise<void> {
    deletedFiles.push({ root, path } as AppFileRef)
  },
  'dez.ui/toast' (_area: string, toast: Toast): void {
    toasts.push(toast)
  },
})

function exportAsset (asset: AssetExport): Promise<void> {
  return sbp('dez.controller/exportAsset', asset) as Promise<void>
}

const IMAGE_ASSET: AssetExport = { id: 'a', kind: 'image', source: { kind: 'file', path: IMAGE, linked: false } }
const URL_CLIP: AssetExport = { id: 'b', kind: 'video', source: { kind: 'url', url: CLIP_URL, type: 'video/mp4' } }

beforeEach(() => {
  tabTitle = 'A red fox'
  dialogs = []
  pickTarget = async () => '/home/ann/Pictures/fox.png'
  copies = []
  exportFile = async () => {}
  downloads = []
  downloadAppFile = async () => SAVED
  deletedFiles = []
  toasts = []
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleError.mockRestore()
})

describe('dez.controller/exportAsset', () => {
  it('copies the file to the path that the user picks, and the toast shows the new file', async () => {
    await exportAsset(IMAGE_ASSET)

    expect(dialogs).toStrictEqual([{ defaultPath: 'A red fox a.png' }])
    expect(copies).toStrictEqual([{ source: IMAGE, target: '/home/ann/Pictures/fox.png' }])
    expect(toasts).toMatchObject([{
      title: 'Image exported',
      message: '/home/ann/Pictures/fox.png',
      variant: 'success',
      sbpInvocation: ['dez.controller/revealInFileManager', '/home/ann/Pictures/fox.png'],
    }])
  })

  it('proposes the kind of the asset as the name in a new tab', async () => {
    tabTitle = 'New Tab'
    await exportAsset(IMAGE_ASSET)
    expect(dialogs).toStrictEqual([{ defaultPath: 'image a.png' }])
  })

  it('copies nothing when the user cancels the dialog', async () => {
    pickTarget = async () => null
    await exportAsset(IMAGE_ASSET)
    expect(copies).toStrictEqual([])
    expect(toasts).toStrictEqual([])
  })

  it('opens one dialog at a time, and the next export after it opens its own', async () => {
    let pick: (path: string | null) => void = () => {}
    pickTarget = () => new Promise((resolve) => { pick = resolve })
    const first = exportAsset(IMAGE_ASSET)
    await exportAsset(URL_CLIP)
    expect(dialogs).toHaveLength(1)
    pick(null)
    await first

    pickTarget = async () => null
    await exportAsset(URL_CLIP)
    expect(dialogs).toHaveLength(2)
  })

  it('downloads a URL clip with no provider header into a part file of the cache, copies it, and deletes it', async () => {
    pickTarget = async () => '/home/ann/Videos/b.mp4'
    await exportAsset(URL_CLIP)

    expect(downloads).toHaveLength(1)
    const [{ request, file }] = downloads
    expect(request.url).toBe(CLIP_URL)
    expect(request.headers).toBeUndefined()
    expect(file.root).toBe('cache')
    expect(file.path).toMatch(/^media\/[0-9a-f-]+\.part$/)
    expect(copies).toStrictEqual([{ source: `${CACHE_DIR}/${file.path}`, target: '/home/ann/Videos/b.mp4' }])
    expect(deletedFiles).toStrictEqual([file])
    expect(toasts).toMatchObject([{ title: 'Clip exported', variant: 'success' }])
  })

  it('tells that the link of a URL clip is gone, and deletes the part file', async () => {
    downloadAppFile = async () => ({ ...SAVED, status: 410, statusText: 'Gone', saved: false })
    await exportAsset(URL_CLIP)

    expect(copies).toStrictEqual([])
    expect(deletedFiles).toStrictEqual([downloads[0].file])
    expect(toasts).toStrictEqual([{
      title: 'Could not export the clip',
      message: 'The clip is not on its server any more: its link has expired, or the provider deleted it. Make the clip again.\n\nDetails: HTTP 410',
      variant: 'error',
    }])
    expect(consoleError).toHaveBeenCalled()
  })

  it('tells why a copy failed, with the raw error last', async () => {
    exportFile = async () => {
      throw 'Write error: Permission denied (os error 13)'
    }
    await exportAsset(IMAGE_ASSET)

    expect(toasts).toStrictEqual([{
      title: 'Could not export the image',
      message: 'The system did not let Dez copy the file. The details tell why (for example, the file is gone, or Dez has no permission to write to that folder). Fix that, or pick another folder, and try again.\n\nDetails: Write error: Permission denied (os error 13)',
      variant: 'error',
    }])
    expect(consoleError).toHaveBeenCalled()
  })

  it('tells that the dialog did not open', async () => {
    pickTarget = async () => {
      throw new Error('no portal')
    }
    await exportAsset(IMAGE_ASSET)

    expect(copies).toStrictEqual([])
    expect(toasts).toMatchObject([{ title: 'Could not export the image', variant: 'error' }])
    expect(toasts[0].message).toContain('Details: no portal')
  })
})
