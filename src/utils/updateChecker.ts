import { watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import sbp from './ui'
import type { useSettingsStore } from '../stores/settingsStore'

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const CHECK_INTERVAL_MS = 60 * 60 * 1000

interface LatestRelease {
  version: string
  url: string
}

type SettingsStore = ReturnType<typeof useSettingsStore>

let checkPromise: Promise<void> | null = null

export function startUpdateChecker(settings: SettingsStore): () => void {
  const interval = window.setInterval(() => {
    checkForUpdatesIfDue(settings)
  }, CHECK_INTERVAL_MS)

  const stopWatch = watch(
    () => settings.checkForUpdates,
    (enabled) => {
      if (enabled) {
        checkForUpdatesIfDue(settings)
      }
    },
    { immediate: true },
  )

  return () => {
    window.clearInterval(interval)
    stopWatch()
  }
}

async function checkForUpdatesIfDue(settings: SettingsStore): Promise<void> {
  if (!settings.checkForUpdates) return
  if (checkPromise) {
    await checkPromise
    return
  }

  const now = Date.now()
  const lastCheckedAt = settings.lastUpdateCheckAt
  if (typeof lastCheckedAt === 'number' && now - lastCheckedAt < ONE_DAY_MS) return

  settings.setLastUpdateCheckAt(now)
  checkPromise = runUpdateCheck()

  try {
    await checkPromise
  } finally {
    checkPromise = null
  }
}

async function runUpdateCheck(): Promise<void> {
  try {
    const latestRelease = await invoke<LatestRelease>('get_latest_release')
    if (isNewerVersion(latestRelease.version, __APP_VERSION__)) {
      sbp('dez.ui/toast', 'app-global', {
        title: 'Update available',
        message: `Dez ${latestRelease.version} is available.`,
        variant: 'default',
        actionLabel: 'View latest release',
        sbpInvocation: ['dez.ui/openUrl', latestRelease.url],
      })
    }
  } catch (error) {
    console.warn('Update check failed', error)
  }
}

function isNewerVersion(candidate: string, current: string): boolean {
  const candidateVersion = parseVersion(candidate)
  const currentVersion = parseVersion(current)

  for (let index = 0; index < 3; index += 1) {
    if (candidateVersion.parts[index] > currentVersion.parts[index]) return true
    if (candidateVersion.parts[index] < currentVersion.parts[index]) return false
  }

  if (!candidateVersion.prerelease && currentVersion.prerelease) return true
  if (candidateVersion.prerelease && !currentVersion.prerelease) return false

  return false
}

function parseVersion(version: string): { parts: [number, number, number], prerelease: string | null } {
  const normalized = version.trim().replace(/^v/i, '')
  const [withoutBuild] = normalized.split('+', 1)
  const [main, prerelease = null] = withoutBuild.split('-', 2)
  const parts = main.split('.').map((part) => Number.parseInt(part, 10))

  return {
    parts: [parts[0] || 0, parts[1] || 0, parts[2] || 0],
    prerelease,
  }
}
