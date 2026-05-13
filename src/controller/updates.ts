import sbp from '@sbp/sbp'
import { watch } from 'vue'
import { isNewerVersion } from '../utils/version'
import type { LatestRelease } from './nativeTypes'

interface LatestReleaseStatus {
  latestRelease: LatestRelease
  hasUpdate: boolean
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

function showAvailableUpdateToast(latestRelease: LatestRelease): void {
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

    const checkIfDue = async (): Promise<void> => {
      if (!sbp('dez.model/settings/checkForUpdates')) return
      if (updateCheckPromise) {
        await updateCheckPromise
        return
      }

      const now = Date.now()
      const lastCheckedAt = sbp('dez.model/settings/lastUpdateCheckAt') as number | null
      if (typeof lastCheckedAt === 'number' && now - lastCheckedAt < ONE_DAY_MS) return

      sbp('dez.model/settings/setLastUpdateCheckAt', now)
      updateCheckPromise = (async () => {
        try {
          const { latestRelease, hasUpdate } = await latestReleaseStatus()
          if (hasUpdate) {
            showAvailableUpdateToast(latestRelease)
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
    }

    const interval = window.setInterval(() => {
      void checkIfDue()
    }, CHECK_INTERVAL_MS)

    const stopWatch = watch(
      () => sbp('dez.model/settings/checkForUpdates') as boolean,
      (enabled) => {
        if (enabled) {
          void checkIfDue()
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

  async 'dez.controller/checkForUpdatesNow' (): Promise<void> {
    if (updateCheckPromise) {
      await updateCheckPromise
      return
    }

    updateCheckPromise = (async () => {
      try {
        const { latestRelease, hasUpdate } = await latestReleaseStatus()
        if (hasUpdate) {
          showAvailableUpdateToast(latestRelease)
        } else {
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
