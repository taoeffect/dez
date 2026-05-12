import sbp from '@sbp/sbp'
import { useSettingsStore, type SettingsSection, type Theme } from '../model/state/settings'

export default sbp('sbp/selectors/register', {
  'dez.controller/openSettings' (section: SettingsSection = 'general'): void {
    useSettingsStore().openSettings(section)
  },

  'dez.controller/closeSettings' (): void {
    useSettingsStore().closeSettings()
  },

  'dez.controller/openHistory' (): void {
    useSettingsStore().openHistory()
  },

  'dez.controller/closeHistory' (): void {
    useSettingsStore().closeHistory()
  },

  'dez.controller/setTheme' (theme: Theme): void {
    useSettingsStore().setTheme(theme)
  },

  'dez.controller/togglePillSeparators' (): void {
    useSettingsStore().togglePillSeparators()
  },

  'dez.controller/setCheckForUpdates' (enabled: boolean): void {
    useSettingsStore().setCheckForUpdates(enabled)
  },
})
