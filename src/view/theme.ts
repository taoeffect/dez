import sbp from '@sbp/sbp'
import type { Theme } from '../model/state/settings'

export default sbp('sbp/selectors/register', {
  'dez.ui/applyTheme' (theme: Theme): void {
    const root = document.documentElement
    if (theme === 'system') {
      root.removeAttribute('data-theme')
    } else {
      root.setAttribute('data-theme', theme)
    }
  },
})
