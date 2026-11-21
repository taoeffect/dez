import sbp from '@sbp/sbp'
import type { Section } from '../model/chat/types'
import { conversationAssets } from '../model/streams/mediaRequest'
import { AppCallError, SaveNotStoredError, unknownAssetText, type SavedAppFile, type SavedAssetAnswer } from '../model/tools/appBridge'
import { inputOf, type SaveCount } from '../model/tools/appInvoke'
import { appCardFacts, showCall, type AppCardFacts } from '../model/tools/appShow'
import { appNamed } from '../model/tools/appsTool'
import { ToolError } from '../model/tools/types'
import { errorText, ExplainedError, rawErrorText } from '../utils/errorText'
import { assetBlob, storeSave, type StoredSave } from './appBridge'
import { appTreeOf, factsOf, showTargetOf } from './appsTool'
import { discardMadeAssets } from './jobs'

// What Dez's own UI asks of the apps: the card of an app in a conversation
// (view/editor/apps.ts), the bar of an app that runs
// (view/apps/appFrameHost.ts), and the calls of the page of a shown app
// (the frame bridge, model/tools/appBridge.ts). The work of the `apps`
// tool, which a model calls, is in appsTool.ts; this module reads the
// files of an app the same way.

export default sbp('sbp/selectors/register', {
  /** What the card of the app `name` tells the user, from the files of the
   *  app as they are now (`appCardFacts`). It never rejects: a read that
   *  fails gives `unreadable`. */
  async 'dez.controller/apps/card' (name: string): Promise<AppCardFacts> {
    try {
      const call = showCall({ name })
      const [target, tree] = await Promise.all([showTargetOf(call), appTreeOf(call.app)])
      return appCardFacts(call, target, tree)
    } catch (error) {
      // A `ToolError` is a failed read, which appsTool.ts logged.
      if (!(error instanceof ToolError)) console.error(`Failed to read the app ${JSON.stringify(name)} for its card:`, error)
      return { state: 'unreadable' }
    }
  },

  /** Deletes the app `name`: its folder with all that is in it. An app
   *  that is gone already is not an error. A failure is logged, shows an
   *  error toast, and rejects, so that the caller keeps the card of the
   *  app. */
  async 'dez.controller/apps/delete' (name: string): Promise<void> {
    try {
      const app = appNamed(name)
      const { kind } = await factsOf(app)
      // A file, a link, or a special file at the place of the folder is not
      // the work of the `apps` tool. It goes as a file; the native side
      // refuses a link.
      if (kind !== 'missing') await sbp('dez.native/deleteAppFile', app.file, 'app', { folder: kind === 'folder' })
    } catch (error) {
      console.error(`Failed to delete the app ${JSON.stringify(name)}:`, error)
      sbp('dez.ui/toast', 'app-global', {
        title: `Could not delete the app ${name}`,
        message: errorText(
          'The system did not let Dez delete the folder of the app. The details tell why (for example, Dez has no permission to change the folder, or a link is at the place of the folder). Fix that, and try again.',
          // The explanation of a `ToolError` is a text for a model.
          error instanceof ExplainedError ? error.details : rawErrorText(error),
        ),
        variant: 'error',
      })
      throw error
    }
  },

  /** Shows the context menu of the app `name` at the pointer
   *  (`dez.controller/menu/popupAsset`): its "Reveal in File Manager" shows
   *  the folder of the app in the folder of the apps. The item is disabled
   *  for an app that is gone, and when Dez cannot tell. It never rejects. */
  async 'dez.controller/apps/popupMenu' (name: string): Promise<void> {
    let folder: string | null = null
    try {
      const app = appNamed(name)
      if ((await factsOf(app)).kind !== 'missing') folder = `${await sbp('dez.native/getAppDir') as string}/${app.file}`
    } catch (error) {
      // A `ToolError` is a failed read, which appsTool.ts logged.
      if (!(error instanceof ToolError)) console.error(`Failed to find the folder of the app ${JSON.stringify(name)}:`, error)
    }
    await sbp('dez.controller/menu/popupAsset', folder)
  },

  /** The bytes of the image or the clip with the id `id` of a conversation
   *  with the sections `sections`, for the page of a shown app: a Blob with
   *  no file name and no path, also of a linked file. A shown app reads
   *  every image and clip of the conversation that shows it, as its user
   *  sees them all. Throws an `AppCallError`, whose text the page gets, for
   *  an id of no image and no clip, and for a file that Dez cannot read. */
  async 'dez.controller/apps/readAsset' (id: string, sections: readonly Section[]): Promise<Blob> {
    const assets = conversationAssets(sections)
    const input = inputOf(id, assets)
    if (input === null) throw new AppCallError(unknownAssetText(id, assets))
    return await assetBlob(input)
  },

  /** Puts the save `blob` of the page of a shown app into its
   *  conversation: stores it as a new file of a generated folder, after
   *  its checks (`storeSave`; `saves` counts the saves of the run of the
   *  app), and gives the file to `insert`, which puts it into the text and
   *  gives its new id. The store is async, so `insert` checks again that
   *  the conversation can take the file: when it throws, the file is
   *  deleted. Gives the answer for the page.
   *
   *  Throws an `AppCallError`, whose text the page gets, for a save that
   *  Dez or `insert` refuses. A write that failed is logged, shows an
   *  error toast, and rejects with a `SaveNotStoredError`. */
  async 'dez.controller/apps/saveAsset' (blob: Blob, saves: SaveCount, insert: (file: SavedAppFile) => string): Promise<SavedAssetAnswer> {
    let stored: StoredSave
    try {
      stored = await storeSave(blob, saves)
    } catch (error) {
      if (error instanceof SaveNotStoredError) {
        sbp('dez.ui/toast', 'app-global', {
          title: 'Could not save the file of the app',
          message: errorText('The system did not let Dez write the file that the app saved. The details tell why (for example, the disk is full). Fix that, and save in the app again.', rawErrorText(error.cause)),
          variant: 'error',
        })
      }
      throw error
    }
    const { kind, type } = stored.type
    try {
      return { id: insert({ path: stored.path, kind, type }), kind, type }
    } catch (error) {
      // No text names the file.
      await discardMadeAssets([stored.asset])
      throw error
    }
  },
})
