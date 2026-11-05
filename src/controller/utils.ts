import sbp from '@sbp/sbp'
import { openPath, openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'

export default sbp('sbp/selectors/register', {
  'dez.controller/openUrl' (url: string): void {
    if (!url || typeof url !== 'string') {
      throw Error('sbp("dez.controller/openUrl") failed - "url" is required and must be a string')
    }

    openUrl(url).catch((error) => {
      console.error('Failed to open URL:', error)
    })
  },

  // `get_app_dir` creates ~/.config/dez if it is missing. The capabilities
  // allow `openPath` only on that folder (`opener:allow-open-path` in
  // src-tauri/capabilities/default.json).
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

  // Shows a file in the system file manager. `opener:default` allows
  // `revealItemInDir` on every path. On macOS, Finder selects it. On
  // Linux, the opener plugin asks the org.freedesktop.FileManager1 D-Bus
  // service (Dolphin, Nautilus, …) to select it. Without that service the
  // reveal fails: the plugin's portal fallback (2.5.3) calls the bus name
  // org.freedesktop.portal.OpenURI, which no portal owns. Then the user sees
  // the error toast.
  async 'dez.controller/revealInFileManager' (path: string): Promise<void> {
    try {
      await revealItemInDir(path)
    } catch (error) {
      console.error('Failed to show the file in the file manager:', error)
      sbp('dez.ui/toast', 'app-global', {
        title: 'Could not show the file',
        message: String(error),
        variant: 'error',
      })
    }
  },
})
