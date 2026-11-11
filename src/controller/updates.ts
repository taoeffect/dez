import sbp from '@sbp/sbp'
import { watch } from 'vue'
import { errorText, rawErrorText } from '../utils/errorText'
import { isNewerVersion } from '../utils/version'
import {
  settingsCheckForUpdates,
  settingsLastUpdateCheckAt,
  setSettingsLastUpdateCheckAt,
} from '../model/state'
import type { LatestRelease } from './nativeTypes'

interface LatestReleaseStatus {
  latestRelease: LatestRelease
  hasUpdate: boolean
}

interface UpdateCheckOptions {
  notifyWhenCurrent?: boolean
  onlyIfDue?: boolean
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const CHECK_INTERVAL_MS = 60 * 60 * 1000

let updateCheckPromise: Promise<void> | null = null
let stopUpdateChecker: (() => void) | null = null


export function stopUpdateCheckerService(): void {
  stopUpdateChecker?.()
}

async function latestReleaseStatus(): Promise<LatestReleaseStatus> {
  const latestRelease = await sbp('dez.native/getLatestRelease') as LatestRelease
  return {
    latestRelease,
    hasUpdate: isNewerVersion(latestRelease.version, __APP_VERSION__),
  }
}

export const DEZ_REPO_URL = 'https://github.com/taoeffect/dez'

function isValidReleaseUrl(url: string): boolean {
  return url.startsWith(DEZ_REPO_URL)
}

function showAvailableUpdateToast(latestRelease: LatestRelease): void {
  if (!isValidReleaseUrl(latestRelease.url)) {
    console.error('GitHub API returned corrupt release URL:', latestRelease.url)
    sbp('dez.ui/toast', 'app-global', {
      title: 'Update check error',
      message: `The GitHub API named a release page outside the Dez repository ("${latestRelease.url}"), so Dez does not open it. Get the new version from ${DEZ_REPO_URL}/releases.`,
      variant: 'error',
    })
    return
  }
  sbp('dez.ui/toast', 'app-global', {
    title: 'Update available',
    message: `Dez ${latestRelease.version} is available.`,
    variant: 'default',
    actionLabel: 'View latest release',
    sbpInvocation: ['dez.controller/openUrl', latestRelease.url],
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
        const { latestRelease, hasUpdate } = await latestReleaseStatus()
        if (hasUpdate) {
          showAvailableUpdateToast(latestRelease)
        } else if (notifyWhenCurrent) {
          showUpToDateToast()
        }
      } catch (error) {
        console.error('Update check failed', error)
        // Only a check that the user asked for tells its failure: a check
        // in the background runs again later by itself.
        if (notifyWhenCurrent) {
          sbp('dez.ui/toast', 'app-global', {
            title: 'Update check failed',
            message: errorText(`Dez could not get the latest version from GitHub. The network or GitHub failed: the details tell which. Try again later, or look for a new version at ${DEZ_REPO_URL}/releases.`, rawErrorText(error)),
            variant: 'error',
          })
        }
      }
    })()

    try {
      await updateCheckPromise
    } finally {
      updateCheckPromise = null
    }
  },
})
