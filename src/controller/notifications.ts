import sbp from '@sbp/sbp'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { SettingsSnapshot } from '../model/state'

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

export default sbp('sbp/selectors/register', {
  // The alerts (Settings › Notifications) for a reply that finished or
  // failed. They come only when the user does not look at the reply: its
  // tab is in the background, or the Dez window does not have focus. The
  // tab bar's done mark has the same rule for the tab. The caller does not
  // wait: no failure here reaches the stream code.
  async 'dez.controller/alertReplyEnded' (tabId: string): Promise<void> {
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
  },
})
