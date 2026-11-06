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
  // tab is in the background, or the Dez window does not have focus. The
  // tab bar's done mark has the same rule for the tab. The caller does not
  // wait: no failure here reaches the stream code.
  async 'dez.controller/alertReplyEnded' (tabId: string, status: AlertedStatus): Promise<void> {
    // Read now: the user can switch tabs while the focus read runs.
    const inActiveTab = tabId === sbp('dez.model/tabs/activeId')
    if (inActiveTab && await windowIsFocused()) return
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
