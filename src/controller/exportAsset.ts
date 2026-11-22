import sbp from '@sbp/sbp'
import { exportFileName, type AssetExport } from '../model/chat/assetExport'
import { MEDIA_CACHE_FOLDER } from '../model/chat/mediaTags'
import type { Tab } from '../model/chat/types'
import { NEW_TAB_TITLE } from '../model/state/tabs'
import { ExplainedError, explainedError, rawErrorText } from '../utils/errorText'
import { downloadClip, explainedDownloadError } from './clipSources'

// True while the save dialog of an Export is open: a second Export (a
// context click on another asset) must not open a second dialog.
let exportDialogOpen = false

// The path that the user picks for the copy of `asset` in the native save
// dialog; null when the user cancels.
async function pickTarget (asset: AssetExport): Promise<string | null> {
  exportDialogOpen = true
  try {
    const tab = sbp('dez.model/tab', sbp('dez.model/tabs/activeId')) as Tab | null
    const title = tab === null || tab.title === NEW_TAB_TITLE ? null : tab.title
    return await sbp('dez.native/showSaveDialog', { defaultPath: exportFileName(asset, title) }).catch((error: unknown) => {
      throw new ExplainedError('The system did not open the save dialog. The details tell why. Fix that, and try again.', rawErrorText(error), { cause: error })
    }) as string | null
  } finally {
    exportDialogOpen = false
  }
}

async function copyFile (source: string, target: string): Promise<void> {
  await sbp('dez.native/exportFile', source, target).catch((error: unknown) => {
    throw new ExplainedError(
      'The system did not let Dez copy the file. The details tell why (for example, the file is gone, or Dez has no permission to write to that folder). Fix that, or pick another folder, and try again.',
      rawErrorText(error),
      { cause: error },
    )
  })
}

// The copy of a clip that plays from its URL: the clip downloads into a
// part file of the cache media folder (`downloadClip`, which sends no
// provider header), which is copied to `target` and then deleted. A delete
// that fails leaves the part file to the cleanup of the temp copies.
async function copyUrl (url: string, target: string): Promise<void> {
  const part = `${MEDIA_CACHE_FOLDER}/${crypto.randomUUID()}.part`
  try {
    await downloadClip(url, { root: 'cache', path: part }, undefined).catch((error: unknown) => {
      throw explainedDownloadError(error)
    })
    await copyFile(`${await sbp('dez.native/getAppDir', 'cache') as string}/${part}`, target)
  } finally {
    await sbp('dez.native/deleteAppFile', part, 'cache').catch((error: unknown) => {
      console.error('Failed to delete the part file of a clip download:', error)
    })
  }
}

export default sbp('sbp/selectors/register', {
  // The Export… item of the asset menu (`dez.controller/menu/popupAsset`):
  // a copy of an image or a clip into a file that the user picks in the
  // native save dialog, which proposes a name (`exportFileName`). The
  // asset stays as it is. A success toast names the new file, and a click
  // on it shows the file in the file manager. A failure is logged, and
  // shows an error toast.
  async 'dez.controller/exportAsset' (asset: AssetExport): Promise<void> {
    if (exportDialogOpen) return
    const noun = asset.kind === 'image' ? 'image' : 'clip'
    try {
      const target = await pickTarget(asset)
      if (target === null) return
      if (asset.source.kind === 'file') await copyFile(asset.source.path, target)
      else await copyUrl(asset.source.url, target)
      sbp('dez.ui/toast', 'app-global', {
        title: asset.kind === 'image' ? 'Image exported' : 'Clip exported',
        message: target,
        variant: 'success',
        duration: 5000,
        sbpInvocation: ['dez.controller/revealInFileManager', target],
      })
    } catch (error) {
      console.error(`Failed to export the ${noun}:`, error)
      sbp('dez.ui/toast', 'app-global', {
        title: `Could not export the ${noun}`,
        message: explainedError(error).message,
        variant: 'error',
      })
    }
  },
})
