import sbp from '@sbp/sbp'
import { watch } from 'vue'
import {
  settingsCheckForUpdates,
  settingsLastUpdateCheckAt,
  setSettingsLastUpdateCheckAt,
} from '../model/state'
import { parseReleaseList, type Release } from '../model/updates/releases'
import { nativeResponseText, type NativeHttpResponse } from '../utils/protocol/nativeHttp'

interface UpdateCheckOptions {
  notifyWhenCurrent?: boolean
  onlyIfDue?: boolean
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const CHECK_INTERVAL_MS = 60 * 60 * 1000
const RELEASE_CHECK_TIMEOUT_MS = 30_000

export const DEZ_REPO_URL = 'https://github.com/taoeffect/dez'
// GitHub lists releases newest first; an install that is more than 30
// releases behind sees only the newest 30, which is enough to update.
const RELEASES_API_URL = 'https://api.github.com/repos/taoeffect/dez/releases?per_page=30'

let updateCheckPromise: Promise<void> | null = null
let stopUpdateChecker: (() => void) | null = null


export function stopUpdateCheckerService(): void {
  stopUpdateChecker?.()
}

// Returns the Dez releases that are newer than the running one, newest first.
// A smoke-test build sets VITE_DEZ_RELEASES_API_URL to a local server, and
// then takes that server's asset URLs. That is harmless: the Rust installer
// builds the download URL itself and checks the signature with its own key.
async function fetchNewerReleases(): Promise<Release[]> {
  const apiOverride = import.meta.env.VITE_DEZ_RELEASES_API_URL
  const response = await sbp('dez.native/httpRequest', {
    method: 'GET',
    url: apiOverride || RELEASES_API_URL,
    headers: {
      Accept: 'application/vnd.github+json',
      // GitHub's API refuses requests without a User-Agent.
      'User-Agent': 'dez-update-checker',
    },
    timeoutMs: RELEASE_CHECK_TIMEOUT_MS,
  }) as NativeHttpResponse
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`GitHub answered the update check with HTTP ${response.status}`)
  }
  return parseReleaseList(nativeResponseText(response), {
    currentVersion: __APP_VERSION__,
    releaseUrlPrefix: `${DEZ_REPO_URL}/releases/`,
    assetUrlPrefix: apiOverride ? `${new URL(apiOverride).origin}/` : `${DEZ_REPO_URL}/releases/download/`,
  })
}

function showAvailableUpdateToast(release: Release): void {
  sbp('dez.ui/toast', 'app-global', {
    title: 'Update available',
    message: `Dez ${release.version} is available.`,
    variant: 'default',
    actionLabel: 'View latest release',
    sbpInvocation: ['dez.controller/openUrl', release.url],
  })
}

function showUpToDateToast(): void {
  sbp('dez.ui/toast', 'app-global', {
    message: "No updates, you're running the latest version.",
    variant: 'default',
    duration: 5000,
  })
}

export default sbp('sbp/selectors/register', {
  'dez.controller/startUpdateChecker' (): () => void {
    stopUpdateChecker?.()

    const interval = window.setInterval(() => {
      void sbp('dez.controller/checkForUpdates', { onlyIfDue: true, notifyWhenCurrent: false })
    }, CHECK_INTERVAL_MS)

    const stopWatch = watch(
      () => settingsCheckForUpdates(),
      (enabled) => {
        if (enabled) {
          void sbp('dez.controller/checkForUpdates', { onlyIfDue: true, notifyWhenCurrent: false })
        }
      },
      { immediate: true },
    )

    stopUpdateChecker = () => {
      window.clearInterval(interval)
      stopWatch()
      stopUpdateChecker = null
    }

    return stopUpdateChecker
  },

  async 'dez.controller/checkForUpdates' (options: UpdateCheckOptions = {}): Promise<void> {
    const notifyWhenCurrent = options.notifyWhenCurrent ?? true

    if (options.onlyIfDue) {
      if (!settingsCheckForUpdates()) return
      const now = Date.now()
      const lastCheckedAt = settingsLastUpdateCheckAt()
      if (typeof lastCheckedAt === 'number' && now - lastCheckedAt < ONE_DAY_MS) return
      setSettingsLastUpdateCheckAt(now)
    }

    if (updateCheckPromise) {
      await updateCheckPromise
      return
    }

    updateCheckPromise = (async () => {
      try {
        const [newest] = await fetchNewerReleases()
        if (newest) {
          showAvailableUpdateToast(newest)
        } else if (notifyWhenCurrent) {
          showUpToDateToast()
        }
      } catch (error) {
        console.error('Update check failed', error)
      }
    })()

    try {
      await updateCheckPromise
    } finally {
      updateCheckPromise = null
    }
  },
})
