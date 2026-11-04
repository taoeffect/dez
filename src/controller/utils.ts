import sbp from '@sbp/sbp'
import { openPath, openUrl } from '@tauri-apps/plugin-opener'

export default sbp('sbp/selectors/register', {
  'dez.controller/openUrl' (url: string): void {
    if (!url || typeof url !== 'string') {
      throw Error('sbp("dez.controller/openUrl") failed - "url" is required and must be a string')
    }

    openUrl(url).catch((error) => {
      console.error('Failed to open URL:', error)
    })
  },

  async 'dez.controller/openAppFolder' (): Promise<void> {
    try {
      const dir = await sbp('dez.native/getAppDir') as string
      await openPath(dir)
    } catch (error) {
      console.error('Failed to open the Dez folder:', error)
      sbp('dez.ui/toast', 'app-global', {
        title: 'Could not open the Dez folder',
        message: String(error),
        variant: 'error',
      })
    }
  },
})
