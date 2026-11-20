import sbp from '@sbp/sbp'
import { appCardFacts, showCall, type AppCardFacts } from '../model/tools/appShow'
import { ToolError } from '../model/tools/types'
import { showTargetOf } from './appsTool'

// What Dez's own UI asks of the apps: the card of an app in a conversation
// (view/editor/apps.ts). The work of the `apps` tool, which a model calls,
// is in appsTool.ts; this module reads the files of an app the same way.

export default sbp('sbp/selectors/register', {
  /** What the card of the app `name` tells the user, from the files of the
   *  app as they are now (`appCardFacts`). It never rejects: a read that
   *  fails gives `unreadable`. */
  async 'dez.controller/apps/card' (name: string): Promise<AppCardFacts> {
    try {
      const call = showCall({ name })
      return appCardFacts(call, await showTargetOf(call))
    } catch (error) {
      // A `ToolError` is a failed read, which appsTool.ts logged.
      if (!(error instanceof ToolError)) console.error(`Failed to read the app ${JSON.stringify(name)} for its card:`, error)
      return { state: 'unreadable' }
    }
  },
})
