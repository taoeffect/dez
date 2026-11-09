import sbp from '@sbp/sbp'
import { Channel } from '@tauri-apps/api/core'
import { watch } from 'vue'
import {
  settingsCheckForUpdates,
  settingsLastUpdateCheckAt,
  setSettingsLastUpdateCheckAt,
  type TabActivity,
  type UpdatesSnapshot,
} from '../model/state'
import { parseReleaseList, type Release } from '../model/updates/releases'
import { isMacPlatform } from '../utils/platform'
import { nativeResponseText, type NativeHttpResponse } from '../utils/protocol/nativeHttp'
import { responseOk, sanitizeErrorText } from '../utils/protocol/errors'
import { isNewerVersion } from '../utils/version'
import type { UpdateDownloadProgress } from './nativeTypes'

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
const GITHUB_TIMEOUT_MS = 30_000

// The relaunch helper's log, relative to the app folder (`UPDATE_LOG` in
// src-tauri/src/updater/mod.rs).
const UPDATE_LOG_FILE = 'updates/update.log'

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

// GETs `url` (GitHub, or the smoke-test server) and returns the body text.
// `what` names the request in the error of a non-2xx answer.
async function fetchGitHubText(url: string, what: string, headers: Record<string, string> = {}): Promise<string> {
  const response = await sbp('dez.native/httpRequest', {
    method: 'GET',
    url,
    // GitHub's API refuses requests without a User-Agent.
    headers: { ...headers, 'User-Agent': 'dez-update-checker' },
    timeoutMs: GITHUB_TIMEOUT_MS,
  }) as NativeHttpResponse
  if (!responseOk(response)) throw new Error(`GitHub answered ${what} with HTTP ${response.status}`)
  return nativeResponseText(response)
}

// Returns the Dez releases that are newer than the running one, newest first.
// A smoke-test build sets VITE_DEZ_RELEASES_API_URL to a local server, and
// then takes that server's asset URLs. That is harmless: the Rust installer
// builds the download URL itself and checks the signature with its own key.
async function fetchNewerReleases(): Promise<Release[]> {
  const apiOverride = import.meta.env.VITE_DEZ_RELEASES_API_URL
  const body = await fetchGitHubText(apiOverride || RELEASES_API_URL, 'the update check', {
    Accept: 'application/vnd.github+json',
  })
  return parseReleaseList(body, {
    currentVersion: __APP_VERSION__,
    releaseUrlPrefix: `${DEZ_REPO_URL}/releases/`,
    assetUrlPrefix: apiOverride ? `${new URL(apiOverride).origin}/` : `${DEZ_REPO_URL}/releases/download/`,
  })
}

// Why this Dez cannot install an update by itself, or null when it can.
// Only macOS installs updates; elsewhere the window offers the release page
// and gives no reason.
async function installBlockedReason(): Promise<string | null> {
  if (!isMacPlatform) return null
  try {
    return await sbp('dez.native/canInstallUpdate') as string | null
  } catch (error) {
    console.error('Could not check whether Dez can install updates', error)
    return `Dez could not check whether it can install updates: ${sanitizeErrorText(error)}`
  }
}

// Fetches the newer releases and writes the outcome to the updates store.
async function checkReleases(): Promise<UpdateCheckOutcome> {
  sbp('dez.model/updates/setChecking')
  try {
    const releases = await fetchNewerReleases()
    // Before the releases, which can open the window: it shows the right
    // button at once.
    if (releases.length) sbp('dez.model/updates/setInstallBlockedReason', await installBlockedReason())
    sbp('dez.model/updates/setReleases', releases)
    return { releases }
  } catch (error) {
    console.error('Update check failed', error)
    const message = sanitizeErrorText(error)
    sbp('dez.model/updates/setFailed', message)
    return { error: message }
  }
}

// The tabs whose replies are streaming.
function streamingTabIds(): string[] {
  const activity = sbp('dez.model/tabs/activity') as Record<string, TabActivity>
  return Object.keys(activity).filter((tabId) => activity[tabId] === 'busy')
}

// Asks before an install stops the replies in progress. True when none
// streams, or the user agrees.
async function confirmStoppingReplies(): Promise<boolean> {
  const count = streamingTabIds().length
  if (!count) return true
  return await sbp('dez.ui/confirm', {
    message: count === 1
      ? 'A reply is in progress. Installing the update stops it and restarts Dez.'
      : `${count} replies are in progress. Installing the update stops them and restarts Dez.`,
    confirmLabel: 'Stop and Install',
    cancelLabel: 'Cancel',
  }) as boolean
}

// Downloads the DMG of `release`, checks its signature, and puts the new
// app in place (or stages its files for the relaunch helper). The download
// progress goes to the update window.
async function downloadAndInstall(release: Release): Promise<void> {
  if (!release.dmgAsset || !release.signatureAsset) {
    throw new Error(`Dez ${release.version} has no signed macOS download. Get it from GitHub.`)
  }
  // The text of the release's `.minisig` file. The release parser already
  // checked that its URL is on GitHub's release download path.
  const signature = await fetchGitHubText(release.signatureAsset.url, 'the download of the update signature')
  const onProgress = new Channel<UpdateDownloadProgress>()
  onProgress.onmessage = ({ received, total }) => {
    sbp('dez.model/updates/setInstall', { phase: 'downloading', received, total })
  }
  try {
    await sbp('dez.native/downloadUpdate', release.version, signature, onProgress)
  } finally {
    // A message that comes after the download ended must not move the
    // window back to the download.
    onProgress.onmessage = () => {}
  }
  sbp('dez.model/updates/setInstall', { phase: 'installing' })
  await sbp('dez.native/installUpdate', release.version)
}

// The absolute path of the relaunch helper's log, or null when the app
// folder is unknown.
async function updateLogPath(): Promise<string | null> {
  try {
    return `${await sbp('dez.native/getAppDir') as string}/${UPDATE_LOG_FILE}`
  } catch (error) {
    console.error('Could not read the Dez folder', error)
    return null
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
    // The window shows the install that runs; a check would change the
    // releases under it.
    if ((sbp('dez.model/updates/snapshot') as UpdatesSnapshot).installBusy) return
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

  // "Download and Install" in the update window: installs the newest
  // release and relaunches Dez. The window shows each step
  // (dez.model/updates/setInstall), or the message of a failure. After a
  // failed download or install the running app is as it was, and a retry
  // downloads again: Rust keeps nothing of either. After the install, Rust
  // refuses a new download until Dez restarts, so a failed relaunch offers
  // no retry; its message says what to do. Replies in progress stop, after
  // the user agrees, once the new app is in place: a failed download or
  // install stops none.
  async 'dez.controller/updates/install' (): Promise<void> {
    const ready = (): Release | null => {
      const { releases, windowOpen, installBusy } = sbp('dez.model/updates/snapshot') as UpdatesSnapshot
      return windowOpen && !installBusy ? releases[0] ?? null : null
    }
    if (!ready() || !await confirmStoppingReplies()) return
    // Again after the prompt: a notification click can close the window
    // under it, and the steps would then show nowhere.
    const release = ready()
    if (!release) return
    sbp('dez.model/updates/setInstall', { phase: 'downloading', received: 0, total: null })
    let installed = false
    try {
      await downloadAndInstall(release)
      installed = true
      await Promise.all(streamingTabIds().map((tabId) => sbp('dez.stream/stop', tabId) as Promise<void>))
      // The file only feeds the report at the next startup
      // (dez.controller/updates/reportLastInstall), so a failed write
      // (logged by the selector) does not stop the relaunch.
      await (sbp('dez.persistence/savePendingUpdate', release.version) as Promise<void>).catch(() => {})
      // After the install, which takes seconds: a window move or a setting
      // change in that time is saved too. The saves go to ~/.config/dez,
      // which the swap does not touch, and take milliseconds, so Dez still
      // quits right after the swap: macOS privacy lookups fail for a
      // process whose app bundle moved.
      await sbp('dez.controller/window/flushGeometry')
      await sbp('dez.model/persistence/flush')
      sbp('dez.model/updates/setInstall', { phase: 'relaunching' })
      await sbp('dez.native/relaunchAfterUpdate')
    } catch (error) {
      console.error('Update install failed', error)
      sbp('dez.model/updates/setInstall', { phase: 'failed', error: sanitizeErrorText(error), retry: !installed })
    }
  },

  // At startup, tells the user how the last update install ended, from the
  // version that it relaunched Dez into (dez.persistence/takePendingUpdate):
  // - That version runs: the update finished.
  // - An older one runs: the relaunch helper failed (macOS can deny it the
  //   app; its log has why), or the user opened the old app some other way.
  // - A newer one runs: it came some other way, so there is nothing to say.
  async 'dez.controller/updates/reportLastInstall' (): Promise<void> {
    let version: string | null
    try {
      version = await sbp('dez.persistence/takePendingUpdate') as string | null
    } catch {
      // Logged by the selector.
      return
    }
    if (!version) return
    if (version === __APP_VERSION__) {
      sbp('dez.ui/toast', 'app-global', {
        title: 'Dez updated',
        message: `Dez is now version ${version}.`,
        variant: 'success',
        duration: 5000,
      })
      return
    }
    if (!isNewerVersion(version, __APP_VERSION__)) return
    const log = await updateLogPath()
    sbp('dez.ui/toast', 'app-global', {
      title: 'Update not finished',
      message: `Dez could not finish the update to Dez ${version}, so this is still Dez ${__APP_VERSION__}. ` +
        'If macOS blocked it, allow Dez in System Settings › Privacy & Security › App Management, ' +
        `then install the update again. The log is ${log ?? `~/.config/dez/${UPDATE_LOG_FILE}`}.`,
      variant: 'error',
      ...(log && { actionLabel: 'Show Log', sbpInvocation: ['dez.controller/revealInFileManager', log] }),
    })
  },
})
