import sbp from '@sbp/sbp'
import { watch } from 'vue'
import {
  settingsCheckForUpdates,
  settingsLastUpdateCheckAt,
  setSettingsLastUpdateCheckAt,
} from '../model/state'
import { parseReleaseList, type Release } from '../model/updates/releases'
import { nativeResponseText, type NativeHttpResponse } from '../utils/protocol/nativeHttp'
import { sanitizeErrorText } from '../utils/protocol/errors'

// How a check shows its outcome. Every check writes it to the updates store,
// which Settings › General shows; on top of that:
// - `auto`: the daily check. A newer release gives a toast whose action
//   opens the update window. It never opens the window uninvited.
// - `menu`: "Check for Updates…". A newer release opens the window; "up to
//   date" and a failure give a toast.
// - `settings`: the Settings button. A newer release opens the window; the
//   other outcomes show next to the button.
// - `quiet`: nothing more (Settings › General fills its status on open).
export type UpdateCheckReport = 'auto' | 'menu' | 'settings' | 'quiet'

interface UpdateCheckOptions {
  report: UpdateCheckReport
  // Check only when the setting is on and a day has passed since the last
  // due check.
  onlyIfDue?: boolean
}

// The outcome of one release fetch; every caller that waited for it
// reports it.
type UpdateCheckOutcome = { releases: Release[] } | { error: string }

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const CHECK_INTERVAL_MS = 60 * 60 * 1000
const RELEASE_CHECK_TIMEOUT_MS = 30_000

export const DEZ_REPO_URL = 'https://github.com/taoeffect/dez'
// GitHub lists releases newest first; an install that is more than 30
// releases behind sees only the newest 30, which is enough to update.
const RELEASES_API_URL = 'https://api.github.com/repos/taoeffect/dez/releases?per_page=30'

// The running check, shared by the callers that come while it runs.
let runningCheck: Promise<UpdateCheckOutcome> | null = null
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

// Fetches the newer releases and writes the outcome to the updates store.
async function checkReleases(): Promise<UpdateCheckOutcome> {
  sbp('dez.model/updates/setChecking')
  try {
    const releases = await fetchNewerReleases()
    sbp('dez.model/updates/setReleases', releases)
    return { releases }
  } catch (error) {
    console.error('Update check failed', error)
    const message = sanitizeErrorText(error)
    sbp('dez.model/updates/setFailed', message)
    return { error: message }
  }
}

// Shows the outcome of a check the way `report` asks for (UpdateCheckReport).
function reportOutcome(outcome: UpdateCheckOutcome, report: UpdateCheckReport): void {
  if ('error' in outcome) {
    if (report === 'menu') {
      sbp('dez.ui/toast', 'app-global', {
        title: 'Update check failed',
        message: outcome.error,
        variant: 'error',
      })
    }
    return
  }

  const [newest] = outcome.releases
  if (!newest) {
    if (report === 'menu') {
      sbp('dez.ui/toast', 'app-global', {
        message: "No updates, you're running the latest version.",
        variant: 'default',
        duration: 5000,
      })
    }
  } else if (report === 'auto') {
    // `closeOnClick`: the persistent toast sits above every modal and would
    // cover the footer of the window that its action opens.
    sbp('dez.ui/toast', 'app-global', {
      title: 'Update available',
      message: `Dez ${newest.version} is available.`,
      variant: 'default',
      actionLabel: 'View changes',
      sbpInvocation: ['dez.model/updates/openWindow'],
      closeOnClick: true,
    })
  } else if (report === 'menu' || report === 'settings') {
    sbp('dez.model/updates/openWindow')
  }
}

export default sbp('sbp/selectors/register', {
  'dez.controller/startUpdateChecker' (): () => void {
    stopUpdateChecker?.()

    const interval = window.setInterval(() => {
      void sbp('dez.controller/checkForUpdates', { onlyIfDue: true, report: 'auto' })
    }, CHECK_INTERVAL_MS)

    const stopWatch = watch(
      () => settingsCheckForUpdates(),
      (enabled) => {
        if (enabled) {
          void sbp('dez.controller/checkForUpdates', { onlyIfDue: true, report: 'auto' })
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

  async 'dez.controller/checkForUpdates' ({ report, onlyIfDue = false }: UpdateCheckOptions): Promise<void> {
    if (onlyIfDue) {
      if (!settingsCheckForUpdates()) return
      const now = Date.now()
      const lastCheckedAt = settingsLastUpdateCheckAt()
      if (typeof lastCheckedAt === 'number' && now - lastCheckedAt < ONE_DAY_MS) return
      setSettingsLastUpdateCheckAt(now)
    }

    runningCheck ??= checkReleases().finally(() => {
      runningCheck = null
    })
    reportOutcome(await runningCheck, report)
  },
})
