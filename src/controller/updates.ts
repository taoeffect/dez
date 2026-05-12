import sbp from '@sbp/sbp'
import { watch } from 'vue'
import { useSettingsStore } from '../model/state/settings'
import { isNewerVersion } from '../utils/version'
import type { LatestRelease } from './nativeTypes'

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const CHECK_INTERVAL_MS = 60 * 60 * 1000

let updateCheckPromise: Promise<void> | null = null
let stopUpdateChecker: (() => void) | null = null

export default sbp('sbp/selectors/register', {
  'dez.controller/startUpdateChecker' (): () => void {
    stopUpdateChecker?.()

    const settings = useSettingsStore()
    const checkIfDue = async (): Promise<void> => {
      if (!settings.checkForUpdates) return
      if (updateCheckPromise) {
        await updateCheckPromise
        return
      }

      const now = Date.now()
      const lastCheckedAt = settings.lastUpdateCheckAt
      if (typeof lastCheckedAt === 'number' && now - lastCheckedAt < ONE_DAY_MS) return

      settings.setLastUpdateCheckAt(now)
      updateCheckPromise = (async () => {
        try {
          const latestRelease = await sbp('dez.native/getLatestRelease') as LatestRelease
          if (isNewerVersion(latestRelease.version, __APP_VERSION__)) {
            sbp('dez.ui/toast', 'app-global', {
              title: 'Update available',
              message: `Dez ${latestRelease.version} is available.`,
              variant: 'default',
              actionLabel: 'View latest release',
              sbpInvocation: ['dez.controller/openUrl', latestRelease.url],
            })
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
      () => settings.checkForUpdates,
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

  'dez.controller/stopUpdateChecker' (): void {
    stopUpdateChecker?.()
  },

  async 'dez.controller/checkForUpdatesNow' (): Promise<void> {
    if (updateCheckPromise) {
      await updateCheckPromise
      return
    }

    updateCheckPromise = (async () => {
      try {
        const latestRelease = await sbp('dez.native/getLatestRelease') as LatestRelease
        if (isNewerVersion(latestRelease.version, __APP_VERSION__)) {
          sbp('dez.ui/toast', 'app-global', {
            title: 'Update available',
            message: `Dez ${latestRelease.version} is available.`,
            variant: 'default',
            actionLabel: 'View latest release',
            sbpInvocation: ['dez.controller/openUrl', latestRelease.url],
          })
        } else {
          sbp('dez.ui/toast', 'app-global', {
            message: "No updates, you're running the latest version.",
            variant: 'default',
            duration: 5000,
          })
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
