import sbp from '@sbp/sbp'
import { appCardFacts, showCall, type AppCardFacts } from '../model/tools/appShow'
import { appNamed } from '../model/tools/appsTool'
import { ToolError } from '../model/tools/types'
import { errorText, ExplainedError, rawErrorText } from '../utils/errorText'
import { appTreeOf, factsOf, showTargetOf } from './appsTool'

// What Dez's own UI asks of the apps: the card of an app in a conversation
// (view/editor/apps.ts) and the bar of an app that runs
// (view/apps/appFrameHost.ts). The work of the `apps` tool, which a model
// calls, is in appsTool.ts; this module reads the files of an app the same
// way.

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
})
