import sbp from '@sbp/sbp'
import type { SettingsSection, Theme } from '../model/state/settings'

export default sbp('sbp/selectors/register', {
  'dez.controller/openSettings' (section: SettingsSection = 'general'): void {
    sbp('dez.model/settings/open', section)
  },

  'dez.controller/closeSettings' (): void {
    sbp('dez.model/settings/close')
  },

  'dez.controller/openHistory' (): void {
    sbp('dez.model/settings/historyOpen')
  },

  'dez.controller/closeHistory' (): void {
    sbp('dez.model/settings/historyClose')
  },

  'dez.controller/setTheme' (theme: Theme): void {
    sbp('dez.model/settings/setTheme', theme)
  },

  'dez.controller/togglePillSeparators' (): void {
    sbp('dez.model/settings/togglePillSeparators')
  },

  'dez.controller/setCheckForUpdates' (enabled: boolean): void {
    sbp('dez.model/settings/setCheckForUpdates', enabled)
  },
})
