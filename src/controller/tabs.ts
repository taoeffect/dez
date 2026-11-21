import sbp from '@sbp/sbp'
import type { Tab } from '../model/chat/types'
import type { ConversationData } from '../model/persistence/types'
import { ExplainedError, errorText, rawErrorText } from '../utils/errorText'
import { safeFileName } from '../utils/fileName'

// True while the save dialog is open. A second Save request (for example the
// key and a menu item for the same shortcut) must not open a second dialog.
let saveDialogOpen = false

// The notices of `dez.controller/turnOnIncognito`. The e2e spec reads them,
// so a change of their wording breaks no spec.
export const INCOGNITO_STAYS_ON = 'Incognito stays on in this tab. If it went off, the next request would send the whole conversation, also the messages that went in incognito, with the system prompt and the tools of Dez, so the provider could tie all of it to Dez. To go on without incognito, copy the conversation and paste it into a new tab.'
export const INCOGNITO_TOO_LATE = 'Incognito can go on only in a tab that has sent no message and has no reply, as the provider can already tie this conversation to Dez. To start an incognito conversation, open a new tab and turn incognito on before you send your first message.'

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

  // The tab keys (Previous Tab, Next Tab, Tab 1–9) and their menu items
  // call this, so the keys after a switch (Home, End, Page Up, Page Down)
  // move in the doc of the tab, not in the page. As with `newTab`, the
  // Linux menu accelerator takes the key before the page key handler, so
  // the focus must be here. A focused text field outside the editor (the
  // find field) keeps the focus, so a search can go on in the next tab. A
  // click on a tab does not come here: it leaves the focus out of the
  // editor.
  'dez.controller/goToTab' (target: { step: 1 | -1 } | { index: number }): void {
    if ('step' in target) sbp('dez.model/tabs/cycle', target.step)
    else sbp('dez.model/tabs/switchToIndex', target.index)
    sbp('dez.editor/focus', { keepTextFieldFocus: true })
  },

  // The mask of the bottom bar. Turns incognito on in the tab when its rule
  // allows it (`canTurnOnIncognito`), with no prompt: the tab has sent
  // nothing yet, and a new tab is never incognito. Else a notice with one
  // OK button tells why the click changes nothing: incognito never goes
  // off, and it goes on only before the first message of a tab.
  async 'dez.controller/turnOnIncognito' (tabId: string): Promise<void> {
    if (sbp('dez.model/tabs/turnOnIncognito', tabId)) return
    if (!sbp('dez.model/tab', tabId)) return
    const on = sbp('dez.model/tabs/incognito', tabId) as boolean
    await sbp('dez.ui/confirm', { message: on ? INCOGNITO_STAYS_ON : INCOGNITO_TOO_LATE, confirmLabel: 'OK', cancelLabel: null })
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
