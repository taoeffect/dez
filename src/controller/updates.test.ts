import sbp from '@sbp/sbp'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { UpdatesSnapshot } from '../model/state'
import type { ToastData } from '../view/toast/selectors'
import type { NativeHttpResponse } from '../utils/protocol/nativeHttp'
import type { UpdateCheckReport } from './updates'
// Side-effect imports: register the dez.model/* selectors and the selectors
// under test.
import '../model/state/index'
import './updates'

// What the stub GitHub request answers; set by each test.
let answer: () => Promise<NativeHttpResponse>
let requests = 0
let toasts: ToastData[] = []
let consoleError: MockInstance<typeof console.error>

sbp('sbp/selectors/register', {
  'dez.native/httpRequest' (): Promise<NativeHttpResponse> {
    requests++
    return answer()
  },
  'dez.ui/toast' (_area: string, data: ToastData): void {
    toasts.push(data)
  },
})

// GitHub's release list with one published release per version. The running
// version is package.json's (`__APP_VERSION__`), so 99.0.0 is newer and
// 0.0.1 is older.
function releaseList(...versions: string[]): NativeHttpResponse {
  const releases = versions.map((version) => ({
    tag_name: `v${version}`,
    html_url: `https://github.com/taoeffect/dez/releases/tag/v${version}`,
    draft: false,
    prerelease: false,
    published_at: '2026-11-01T12:00:00Z',
    body: null,
    assets: [],
  }))
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
