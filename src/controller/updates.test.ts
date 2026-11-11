import sbp from '@sbp/sbp'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import './updates'

interface Toast {
  title?: string
  message: string
  variant?: string
}

const CHECK_ERROR = 'Failed to check for updates: error sending request'

let toasts: Toast[] = []
let consoleError: MockInstance<typeof console.error>

sbp('sbp/selectors/register', {
  async 'dez.native/getLatestRelease' (): Promise<never> {
    throw CHECK_ERROR
  },
  'dez.ui/toast' (_area: string, toast: Toast): void {
    toasts.push(toast)
  },
})

beforeEach(() => {
  toasts = []
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleError.mockRestore()
})

describe('dez.controller/checkForUpdates', () => {
  it('tells why a check that the user asked for failed', async () => {
    await sbp('dez.controller/checkForUpdates')

    expect(consoleError).toHaveBeenCalledWith('Update check failed', CHECK_ERROR)
    expect(toasts).toStrictEqual([{
      title: 'Update check failed',
      message: 'Dez could not get the latest version from GitHub. The network or GitHub failed: the details tell which. '
        + `Try again later, or look for a new version at https://github.com/taoeffect/dez/releases.\n\nDetails: ${CHECK_ERROR}`,
      variant: 'error',
    }])
  })

  // A background check runs again later by itself; a toast each time the
  // computer is offline would only disturb the user.
  it('only logs the failure of a check in the background', async () => {
    await sbp('dez.controller/checkForUpdates', { notifyWhenCurrent: false })

    expect(consoleError).toHaveBeenCalledWith('Update check failed', CHECK_ERROR)
    expect(toasts).toStrictEqual([])
  })
})
