import sbp from '@sbp/sbp'
import type { Tab } from '../model/chat/types'
import type { ConversationData } from '../model/persistence/types'
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

  async 'dez.controller/closeTab' (tabId: string): Promise<void> {
    await sbp('dez.stream/stop', tabId)
    sbp('dez.model/tabs/close', tabId)
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
        message: String(error),
        variant: 'error',
      })
    } finally {
      saveDialogOpen = false
    }
  },
})
