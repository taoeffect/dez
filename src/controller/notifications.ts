import sbp from '@sbp/sbp'
import { Channel } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { Tab } from '../model/chat/types'
import type { SettingsSnapshot } from '../model/state'
import type { StreamEndStatus } from '../model/streams/types'

type AlertedStatus = Exclude<StreamEndStatus, 'cancelled'>

const NOTIFICATION_BODY: Record<AlertedStatus, string> = {
  finished: 'Reply finished',
  error: 'Reply failed',
}

// An idle time above this at the reply end means the user is away from the
// computer, so a reply in the active tab of the focused window goes unseen.
const AWAY_IDLE_MS = 60_000

// A failed read counts as "not focused": a needless ding is better than a
// reply that ends unnoticed.
async function windowIsFocused(): Promise<boolean> {
  try {
    return await getCurrentWindow().isFocused()
  } catch (error) {
    console.error('[notifications] Could not read the window focus:', error)
    return false
  }
}

// The idle time is the time since the last input anywhere on the computer
// (src-tauri/src/idle.rs). An unknown idle time (no source on this desktop)
// or a failed read counts as "not away", the opposite of the focus read:
// "unknown" is a normal answer on some desktops, and there "away" would
// give an alert for each reply, which the user does not want.
async function userIsAway(): Promise<boolean> {
  try {
    const idleMs = await sbp('dez.native/userIdleMs') as number | null
    return idleMs !== null && idleMs > AWAY_IDLE_MS
  } catch (error) {
    console.error('[notifications] Could not read the user idle time:', error)
    return false
  }
}

// A click on the notification shows the reply: Rust already brought the
// window to the front, so close the panels that cover the thread, open the
// tab, and give the editor the keys. A tab that closed since then leaves
// the window as it is.
function showReplyTab(tabId: string): void {
  if (!sbp('dez.model/tab', tabId)) return
  sbp('dez.model/settings/close')
  sbp('dez.model/settings/historyClose')
  sbp('dez.model/tabs/switch', tabId)
  sbp('dez.editor/focus')
}

async function showReplyNotification(tab: Tab, status: AlertedStatus): Promise<void> {
  const onClick = new Channel<null>()
  onClick.onmessage = () => showReplyTab(tab.id)
  await sbp('dez.native/showNotification', tab.title, NOTIFICATION_BODY[status], onClick)
}

export default sbp('sbp/selectors/register', {
  // The alerts (Settings › Notifications) for a reply that finished or
  // failed. They come only when the user does not look at the reply: its
  // tab is in the background, the Dez window does not have focus, or the
  // user has been away from the computer for more than AWAY_IDLE_MS. The
  // tab bar's done mark is only for a background tab. The caller does not
  // wait: no failure here reaches the stream code.
  async 'dez.controller/alertReplyEnded' (tabId: string, status: AlertedStatus): Promise<void> {
    // Read now: the user can switch tabs while the focus and idle reads run.
    const inActiveTab = tabId === sbp('dez.model/tabs/activeId')
    // The idle read comes last: it runs only when the other checks would
    // skip the alert.
    if (inActiveTab && await windowIsFocused() && !await userIsAway()) return
    const settings = sbp('dez.model/settings/snapshot') as SettingsSnapshot
    if (settings.doneSound) {
      try {
        sbp('dez.ui/playDoneSound', settings.doneSoundVolume)
      } catch (error) {
        console.error('[notifications] Could not play the reply-done sound:', error)
      }
    }
    const tab = sbp('dez.model/tab', tabId) as Tab | null
    if (settings.doneNotification && tab) {
      try {
        await showReplyNotification(tab, status)
      } catch (error) {
        console.error('[notifications] Could not show the reply notification:', error)
      }
    }
  },
})
