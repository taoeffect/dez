import sbp from '@sbp/sbp'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { UpdatesSnapshot } from '../model/state'
import { cancelStreamSession, startStreamSession, streamIsStreaming } from '../model/state/streams'
import type { ToastData } from '../view/toast/selectors'
import type { NativeHttpRequest, NativeHttpResponse } from '../utils/protocol/nativeHttp'
import type { UpdateDownloadProgress } from './nativeTypes'
import type { UpdateCheckReport } from './updates'
// Side-effect imports: register the dez.model/* and dez.persistence/*
// selectors and the selectors under test.
import '../model/state/index'
import '../model/persistence/index'
import './updates'

// The install runs only on macOS; the tests run on every platform.
vi.mock('../utils/platform', () => ({ isMacPlatform: true }))
// The real Channel registers its callback with the Tauri webview.
vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    onmessage: (message: UpdateDownloadProgress) => void = () => {}
  },
}))

interface ProgressChannel {
  onmessage: (message: UpdateDownloadProgress) => void
}

const APP_DIR = '/Users/someone/.config/dez'
// The `.minisig` text that the stub GitHub serves for every release.
const SIGNATURE = 'untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i5\n'

// What the stub GitHub request answers; set by each test.
let answer: () => Promise<NativeHttpResponse>
let requests = 0
let toasts: ToastData[] = []
let consoleError: MockInstance<typeof console.error>
// The app folder: relative path → text.
const files = new Map<string, string>()
// The install steps that ran, in order.
let calls: string[] = []
// What the stub Rust download, install, and install check do; set by each
// test.
let download: (progress: ProgressChannel) => Promise<void>
let install: () => Promise<void>
let blockedReason: () => Promise<string | null>
let downloadedSignature: string | null
let saveError: unknown
let confirmAnswer: boolean
let confirms = 0

sbp('sbp/selectors/register', {
  'dez.native/httpRequest' (request: NativeHttpRequest): Promise<NativeHttpResponse> {
    if (request.url.endsWith('.minisig')) {
      return Promise.resolve({ status: 200, headers: {}, body: [...new TextEncoder().encode(SIGNATURE)] })
    }
    requests++
    return answer()
  },
  'dez.ui/toast' (_area: string, data: ToastData): void {
    toasts.push(data)
  },
  'dez.native/canInstallUpdate' (): Promise<string | null> {
    return blockedReason()
  },
  'dez.native/downloadUpdate' (version: string, signature: string, progress: ProgressChannel): Promise<void> {
    calls.push(`download ${version}`)
    downloadedSignature = signature
    return download(progress)
  },
  'dez.native/installUpdate' (version: string): Promise<void> {
    calls.push(`install ${version}`)
    return install()
  },
  async 'dez.native/relaunchAfterUpdate' (): Promise<void> {
    calls.push('relaunch')
  },
  async 'dez.native/getAppDir' (): Promise<string> {
    return APP_DIR
  },
  async 'dez.native/loadAppFile' (path: string): Promise<string> {
    return files.get(path) ?? ''
  },
  async 'dez.native/saveAppFile' (path: string, content: string): Promise<void> {
    calls.push(`save ${path}`)
    if (saveError) throw saveError
    files.set(path, content)
  },
  async 'dez.native/deleteAppFile' (path: string): Promise<void> {
    files.delete(path)
  },
  async 'dez.native/saveConversationFile' (): Promise<void> {
    calls.push('save conversation')
  },
  async 'dez.ui/confirm' (): Promise<boolean> {
    confirms++
    return confirmAnswer
  },
  async 'dez.stream/stop' (tabId: string): Promise<void> {
    calls.push('stop reply')
    cancelStreamSession(tabId)
  },
  async 'dez.controller/window/flushGeometry' (): Promise<void> {
    calls.push('save window')
  },
})

// GitHub's release list with one published release per version, each with
// the DMG and signature that the install downloads. The running version is
// package.json's (`__APP_VERSION__`), so 99.0.0 is newer and 0.0.1 is older.
function releaseList(...versions: string[]): NativeHttpResponse {
  const releases = versions.map((version) => {
    const dmg = `Dez_${version}_aarch64.dmg`
    return {
      tag_name: `v${version}`,
      html_url: `https://github.com/taoeffect/dez/releases/tag/v${version}`,
      draft: false,
      prerelease: false,
      published_at: '2026-11-01T12:00:00Z',
      body: null,
      assets: [dmg, `${dmg}.minisig`].map((name) => ({
        name,
        browser_download_url: `https://github.com/taoeffect/dez/releases/download/v${version}/${name}`,
      })),
    }
  })
  return { status: 200, headers: {}, body: [...new TextEncoder().encode(JSON.stringify(releases))] }
}

function check(report: UpdateCheckReport): Promise<void> {
  return sbp('dez.controller/checkForUpdates', { report }) as Promise<void>
}

function updates(): UpdatesSnapshot {
  return sbp('dez.model/updates/snapshot') as UpdatesSnapshot
}

beforeEach(() => {
  setActivePinia(createPinia())
  answer = async () => releaseList('0.0.1')
  requests = 0
  toasts = []
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  files.clear()
  calls = []
  download = async () => {}
  install = async () => {}
  blockedReason = async () => null
  downloadedSignature = null
  saveError = null
  confirmAnswer = true
  confirms = 0
})

afterEach(() => {
  consoleError.mockRestore()
})

describe('dez.controller/checkForUpdates', () => {
  // The daily check never opens a window uninvited.
  it('auto: a newer release gives a toast whose action opens the update window', async () => {
    answer = async () => releaseList('0.0.1', '99.0.0')

    await check('auto')

    expect(updates().status).toBe('available')
    expect(updates().windowOpen).toBe(false)
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatchObject({ message: 'Dez 99.0.0 is available.', actionLabel: 'View changes' })

    const [selector, ...args] = toasts[0].sbpInvocation as [string, ...unknown[]]
    sbp(selector, ...args)

    expect(updates().windowOpen).toBe(true)
    expect(updates().releases.map((release) => release.version)).toEqual(['99.0.0'])
  })

  it.each(['menu', 'settings'] as const)('%s: a newer release opens the update window, with no toast', async (report) => {
    answer = async () => releaseList('99.0.0')

    await check(report)

    expect(updates().windowOpen).toBe(true)
    expect(toasts).toEqual([])
  })

  it('quiet: a newer release only sets the status', async () => {
    answer = async () => releaseList('99.0.0')

    await check('quiet')

    expect(updates()).toMatchObject({ status: 'available', error: null, windowOpen: false })
    expect(toasts).toEqual([])
  })

  it.each([
    { report: 'menu', toastCount: 1 },
    { report: 'auto', toastCount: 0 },
    { report: 'settings', toastCount: 0 },
    { report: 'quiet', toastCount: 0 },
  ] as const)('$report: with no newer release, the status is "up to date" and $toastCount toast shows', async ({ report, toastCount }) => {
    await check(report)

    expect(updates()).toMatchObject({ status: 'upToDate', releases: [], windowOpen: false })
    expect(toasts).toHaveLength(toastCount)
  })

  it.each([
    { report: 'menu', toastCount: 1 },
    { report: 'auto', toastCount: 0 },
    { report: 'settings', toastCount: 0 },
    { report: 'quiet', toastCount: 0 },
  ] as const)('$report: a failed check sets the status and the message, logs it, and shows $toastCount error toast', async ({ report, toastCount }) => {
    answer = async () => ({ status: 403, headers: {}, body: [] })

    await check(report)

    expect(updates()).toMatchObject({ status: 'failed', error: 'GitHub answered the update check with HTTP 403' })
    expect(consoleError).toHaveBeenCalled()
    expect(toasts).toHaveLength(toastCount)
    if (toastCount) {
      expect(toasts[0]).toMatchObject({ variant: 'error', message: 'GitHub answered the update check with HTTP 403' })
    }
  })

  it('a native request error shows its text', async () => {
    answer = async () => {
      throw 'error sending request for url (https://api.github.com/repos/taoeffect/dez/releases?per_page=30)'
    }

    await check('settings')

    expect(updates().error).toBe('error sending request for url (https://api.github.com/repos/taoeffect/dez/releases?per_page=30)')
  })

  // A "Check for Updates…" click during the startup check still opens the
  // window, and the startup check still shows its toast.
  it('a check that starts while another runs shares its request, and each reports its own way', async () => {
    let respond!: (response: NativeHttpResponse) => void
    answer = () => new Promise((resolve) => {
      respond = resolve
    })

    const auto = check('auto')
    const menu = check('menu')
    expect(updates().status).toBe('checking')
    respond(releaseList('99.0.0'))
    await Promise.all([auto, menu])

    expect(requests).toBe(1)
    expect(toasts.map((toast) => toast.actionLabel)).toEqual(['View changes'])
    expect(updates().windowOpen).toBe(true)

    // A check after it ended is a new request.
    answer = async () => releaseList('99.0.0')
    await check('quiet')
    expect(requests).toBe(2)
  })

  it('a later check with no newer release closes the open window', async () => {
    answer = async () => releaseList('99.0.0')
    await check('menu')

    answer = async () => releaseList('0.0.1')
    await check('quiet')

    expect(updates()).toMatchObject({ status: 'upToDate', releases: [], windowOpen: false })
  })

  // The releases are still newer than the running version.
  it('a later failed check keeps the releases and the open window', async () => {
    answer = async () => releaseList('99.0.0')
    await check('menu')

    answer = async () => ({ status: 500, headers: {}, body: [] })
    await check('quiet')

    expect(updates().status).toBe('failed')
    expect(updates().windowOpen).toBe(true)
    expect(updates().releases.map((release) => release.version)).toEqual(['99.0.0'])
  })
})

describe('dez.model/updates/openWindow', () => {
  it('does nothing before a check has found a newer release', async () => {
    sbp('dez.model/updates/openWindow')
    expect(updates().windowOpen).toBe(false)

    await check('quiet')
    sbp('dez.model/updates/openWindow')
    expect(updates().windowOpen).toBe(false)
  })
})

describe('the install check', () => {
  it('a failed install check becomes the reason, and the update check still opens the window', async () => {
    blockedReason = async () => {
      throw 'Dez could not find its app bundle'
    }
    answer = async () => releaseList('99.0.0')

    await check('menu')

    expect(updates()).toMatchObject({
      status: 'available',
      windowOpen: true,
      installBlockedReason: 'Dez could not check whether it can install updates: Dez could not find its app bundle',
    })
  })
})

describe('dez.controller/updates/install', () => {
  const PENDING_FILE = 'updates/pending.json'

  function installUpdate(): Promise<void> {
    return sbp('dez.controller/updates/install') as Promise<void>
  }

  // The update window, open on releases 98.0.0 and 99.0.0.
  async function openWindow(): Promise<void> {
    answer = async () => releaseList('98.0.0', '99.0.0')
    await check('menu')
  }

  // A reply that streams in the active tab; returns the tab's id.
  function startReply(): string {
    const tabId = sbp('dez.model/tabs/activeId') as string
    startStreamSession({ tabId, sectionId: 'a1', model: { providerId: 'p', modelId: 'm', modelName: 'M' }, messages: [] })
    return tabId
  }

  it('installs the newest release with its signature, then saves everything, then relaunches', async () => {
    await openWindow()
    // A draft that only the tab store has: the editor's debounced save may
    // not have written it yet.
    sbp('dez.model/tabs/replaceSections', sbp('dez.model/tabs/activeId'), [
      { id: 'u1', role: 'user', content: [{ kind: 'text', text: 'Draft' }] },
    ])
    const phases: UpdatesSnapshot['install'][] = []
    let progress!: ProgressChannel
    download = async (channel) => {
      progress = channel
      phases.push(updates().install)
      channel.onmessage({ received: 4_200_000, total: 9_500_000 })
      phases.push(updates().install)
    }
    install = async () => {
      // A progress message that arrives after the download ended.
      progress.onmessage({ received: 9_500_000, total: 9_500_000 })
      phases.push(updates().install)
    }

    await installUpdate()

    expect(confirms).toBe(0)
    expect(downloadedSignature).toBe(SIGNATURE)
    expect(phases).toEqual([
      { phase: 'downloading', received: 0, total: null },
      { phase: 'downloading', received: 4_200_000, total: 9_500_000 },
      { phase: 'installing' },
    ])
    expect(calls).toEqual([
      'download 99.0.0',
      'install 99.0.0',
      `save ${PENDING_FILE}`,
      'save window',
      'save conversation',
      'relaunch',
    ])
    expect(JSON.parse(files.get(PENDING_FILE) ?? '')).toEqual({ version: '99.0.0' })
    expect(updates()).toMatchObject({ install: { phase: 'relaunching' }, installBusy: true, windowOpen: true })
  })

  it('with a reply in progress, asks first, and Cancel changes nothing', async () => {
    await openWindow()
    const tabId = startReply()
    confirmAnswer = false

    await installUpdate()

    expect(confirms).toBe(1)
    expect(calls).toEqual([])
    expect(updates().install).toEqual({ phase: 'idle' })
    expect(streamIsStreaming(tabId)).toBe(true)
  })

  it('with a reply in progress, stops it once the new app is in place', async () => {
    await openWindow()
    const tabId = startReply()

    await installUpdate()

    expect(confirms).toBe(1)
    expect(calls).toEqual([
      'download 99.0.0',
      'install 99.0.0',
      'stop reply',
      `save ${PENDING_FILE}`,
      'save window',
      'relaunch',
    ])
    expect(streamIsStreaming(tabId)).toBe(false)
  })

  // Rust rejects with its message as a string.
  it.each([
    {
      step: 'download',
      fail: () => {
        download = async () => {
          throw 'The download does not match its signature.'
        }
      },
      steps: ['download 99.0.0'],
      error: 'The download does not match its signature.',
    },
    {
      step: 'install',
      fail: () => {
        install = async () => {
          throw 'Dez could not replace /Applications/Dez.app: Operation not permitted'
        }
      },
      steps: ['download 99.0.0', 'install 99.0.0'],
      error: 'Dez could not replace /Applications/Dez.app: Operation not permitted',
    },
  ])('a failed $step shows its message in the open window, stops no reply, and saves no pending update', async ({ fail, steps, error }) => {
    await openWindow()
    const tabId = startReply()
    fail()

    await installUpdate()

    expect(calls).toEqual(steps)
    expect(updates()).toMatchObject({ install: { phase: 'failed', error }, installBusy: false, windowOpen: true })
    expect(streamIsStreaming(tabId)).toBe(true)
    expect(files.has(PENDING_FILE)).toBe(false)
    expect(consoleError).toHaveBeenCalled()
  })

  it('after a failure, Try Again downloads again', async () => {
    await openWindow()
    download = async () => {
      throw 'error sending request for url'
    }
    await installUpdate()
    download = async () => {}

    await installUpdate()

    expect(calls).toEqual([
      'download 99.0.0',
      'download 99.0.0',
      'install 99.0.0',
      `save ${PENDING_FILE}`,
      'save window',
      'relaunch',
    ])
  })

  it('after a failure, closing the window clears the error', async () => {
    await openWindow()
    download = async () => {
      throw 'error sending request for url'
    }
    await installUpdate()

    sbp('dez.model/updates/closeWindow')
    expect(updates().windowOpen).toBe(false)
    sbp('dez.model/updates/openWindow')

    expect(updates()).toMatchObject({ windowOpen: true, install: { phase: 'idle' } })
  })

  // The file only feeds the report at the next startup.
  it('relaunches when the pending update cannot be saved', async () => {
    await openWindow()
    saveError = 'Failed to write updates/pending.json: disk full'

    await installUpdate()

    expect(calls.at(-1)).toBe('relaunch')
    expect(updates().install).toEqual({ phase: 'relaunching' })
  })

  it('while it runs, the window stays open, and update checks and a second install do nothing', async () => {
    await openWindow()
    let finishDownload!: () => void
    download = () => new Promise((resolve) => {
      finishDownload = resolve
    })
    const running = installUpdate()
    await vi.waitFor(() => expect(calls).toEqual(['download 99.0.0']))

    sbp('dez.model/updates/closeWindow')
    answer = async () => releaseList('0.0.1')
    await check('menu')
    await installUpdate()

    expect(updates()).toMatchObject({ windowOpen: true, installBusy: true })
    expect(updates().releases.map((release) => release.version)).toEqual(['99.0.0', '98.0.0'])
    expect(requests).toBe(1)
    expect(toasts).toEqual([])
    expect(calls).toEqual(['download 99.0.0'])

    finishDownload()
    await running
    expect(calls.at(-1)).toBe('relaunch')
  })
})

describe('dez.controller/updates/reportLastInstall', () => {
  const PENDING_FILE = 'updates/pending.json'

  function report(): Promise<void> {
    return sbp('dez.controller/updates/reportLastInstall') as Promise<void>
  }

  it('after an install into the running version, says once that Dez updated', async () => {
    files.set(PENDING_FILE, JSON.stringify({ version: __APP_VERSION__ }))

    await report()
    await report()

    expect(toasts).toMatchObject([{ title: 'Dez updated', variant: 'success' }])
    expect(files.has(PENDING_FILE)).toBe(false)
  })

  // The relaunch helper failed, e.g. macOS denied it the app.
  it('when the installed version is newer than the running one, says that the update did not finish, with its log', async () => {
    files.set(PENDING_FILE, JSON.stringify({ version: '99.0.0' }))

    await report()

    expect(toasts).toMatchObject([{
      title: 'Update not finished',
      variant: 'error',
      actionLabel: 'Show Log',
      sbpInvocation: ['dez.controller/revealInFileManager', `${APP_DIR}/updates/update.log`],
    }])
    // It stays until the user closes it.
    expect(toasts[0].duration).toBeUndefined()
    expect(files.has(PENDING_FILE)).toBe(false)
  })

  it.each([
    { file: 'an older version', content: JSON.stringify({ version: '0.0.1' }) },
    { file: 'a malformed file', content: '{"version":' },
    { file: 'no version', content: JSON.stringify({}) },
  ])('$file: no report, and the file is gone', async ({ content }) => {
    files.set(PENDING_FILE, content)

    await report()

    expect(toasts).toEqual([])
    expect(files.has(PENDING_FILE)).toBe(false)
  })
})
