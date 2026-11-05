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

  // `dezTheme` (cmEditor.ts) scales every size in the thread editor from
  // this variable. The open editor measures its text again by itself
  // (ThreadEditor.vue watches the setting).
  'dez.ui/applyEditorFontSize' (px: number): void {
    document.documentElement.style.setProperty('--dez-editor-font-size', `${px}px`)
  },
})
