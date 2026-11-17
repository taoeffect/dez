import sbp from '@sbp/sbp'
import type { Tab } from '../model/chat/types'
import type { ConversationData } from '../model/persistence/types'
import { ExplainedError, errorText, rawErrorText } from '../utils/errorText'
import { safeFileName } from '../utils/fileName'

// True while the save dialog is open. A second Save request (for example the
// key and a menu item for the same shortcut) must not open a second dialog.
let saveDialogOpen = false

export default sbp('sbp/selectors/register', {
  // Every "new tab" path (the `+` button, the keys, the File menu) calls
  // this, so the user can type in the new tab at once. On Linux the menu
  // accelerator takes the key before the page key handler, so the focus
  // must be here and not in a key handler.
  'dez.controller/newTab' (): Tab {
    const tab = sbp('dez.model/tabs/create') as Tab
    sbp('dez.editor/focus')
    return tab
  },

  // A close ends the reply of the tab and its jobs (`endJobs`): no later
  // reply of the tab could take their results. The last tab does not
  // close (`dez.model/tabs/close`), so it keeps its jobs.
  async 'dez.controller/closeTab' (tabId: string): Promise<void> {
    const closes = (sbp('dez.model/tabs/list') as Tab[]).length > 1
    await sbp('dez.stream/stop', tabId, { endJobs: closes })
    sbp('dez.model/tabs/close', tabId)
  },

  // Deletes a saved conversation (History), and closes its tabs. The reply
  // and the jobs of each tab that goes end too. The stop comes after the
  // delete: the save of a stopped reply could otherwise write the file
  // again while the delete runs, and a stop of a tab that is gone saves
  // nothing. A delete that failed keeps the tabs, and their jobs.
  async 'dez.controller/deleteConversation' (id: string): Promise<void> {
    const tabIds = (sbp('dez.model/tabs/list') as Tab[]).filter((tab) => tab.conversationId === id).map((tab) => tab.id)
    await sbp('dez.model/tabs/deleteConversation', id)
    for (const tabId of tabIds) {
      if (!sbp('dez.model/tab', tabId)) await sbp('dez.stream/stop', tabId, { endJobs: true })
    }
  },

  // Saves the conversation to a Markdown file that the user picks in the
  // native save dialog.
  async 'dez.controller/saveConversationAs' (tabId: string): Promise<void> {
    if (saveDialogOpen) return
    const data = sbp('dez.model/tabs/conversationData', tabId) as ConversationData | null
    if (!data) {
      sbp('dez.ui/toast', 'app-global', {
        message: 'There is nothing to save in this conversation yet.',
        duration: 4000,
      })
      return
    }

    saveDialogOpen = true
    try {
      const path = await sbp('dez.native/showSaveDialog', {
        defaultPath: `${safeFileName(data.title, 'Conversation')}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      }).catch((error: unknown) => {
        throw new ExplainedError('The system did not open the save dialog. The details tell why. Fix that, and try again.', rawErrorText(error), { cause: error })
      }) as string | null
      if (!path) return
      // A response can stream into the tab while the dialog is open. Save
      // what the tab holds now, or the first copy if the tab is gone.
      const latest = sbp('dez.model/tabs/conversationData', tabId) as ConversationData | null
      await sbp('dez.persistence/exportConversation', latest ?? data, path)
      // A click on the toast shows the saved file in the file manager.
      sbp('dez.ui/toast', 'app-global', {
        title: 'Conversation saved',
        message: path,
        variant: 'success',
        duration: 5000,
        sbpInvocation: ['dez.controller/revealInFileManager', path],
      })
    } catch (error) {
      console.error('Failed to save the conversation as Markdown:', error)
      sbp('dez.ui/toast', 'app-global', {
        title: 'Could not save the conversation',
        message: error instanceof ExplainedError
          ? error.message
          : errorText('The system did not let Dez write the file. The details tell why (for example, Dez has no permission to write to that folder). Fix that, or pick another folder, and try again.', rawErrorText(error)),
        variant: 'error',
      })
    } finally {
      saveDialogOpen = false
    }
  },
})
