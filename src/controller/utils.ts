import sbp from '@sbp/sbp'
import { openPath, openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'
import { errorText, rawErrorText } from '../utils/errorText'
import { pathWithTilde } from '../utils/homePath'

// The read of the user's home folder, kept: the folder does not change
// while the app runs. A failed read is not kept.
let homeDirRead: Promise<string> | null = null

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
        message: errorText('The system did not open the Dez folder in a file manager. Open the folder ~/.config/dez by hand.', rawErrorText(error)),
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
      // The path tells the user where to find the file by hand.
      sbp('dez.ui/toast', 'app-global', {
        title: 'Could not show the file',
        message: errorText(`The file manager did not show the file. Find it by hand: it is at ${path}.`, rawErrorText(error)),
        variant: 'error',
      })
    }
  },

  // The absolute path `path` as the UI shows it: `~` in place of the user's
  // home folder (`pathWithTilde`). When the home folder cannot be read, the
  // path comes back as it is.
  async 'dez.controller/displayPath' (path: string): Promise<string> {
    try {
      homeDirRead ??= sbp('dez.native/homeDir') as Promise<string>
      return pathWithTilde(path, await homeDirRead)
    } catch (error) {
      homeDirRead = null
      console.error('Failed to read the home folder:', error)
      return path
    }
  },
})
