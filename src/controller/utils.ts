import sbp from '@sbp/sbp'
import { openUrl } from '@tauri-apps/plugin-opener'

export default sbp('sbp/selectors/register', {
  'dez.controller/openUrl' (url: string): void {
    if (!url || typeof url !== 'string') {
      throw Error('sbp("dez.controller/openUrl") failed - "url" is required and must be a string')
    }

    openUrl(url).catch((error) => {
      console.error('Failed to open URL:', error)
    })
  },
})
