import sbp from '@sbp/sbp'
import { sectionPlainText } from '../model/chat/content'
import { dataFileText, nextDataFileName, type DataFileExtension } from '../model/chat/dataFiles'
import type { Tab } from '../model/chat/types'
import { conversationWorkFolder } from '../model/tools/conversationWork'
import { ExplainedError, errorText, rawErrorText } from '../utils/errorText'
import type { AppFileEntry } from './nativeTypes'

// The copies of the data files that the user pastes or drops
// (model/chat/dataFiles.ts) in the work folders of the conversations.

// One queue for all saves: a save reads the names of the work folder and
// then writes a new name, so two saves at once could take the same name.
const SAVES = 'dez.controller/dataFiles/save'

export default sbp('sbp/selectors/register', {
  // Copies the bytes of a data file that the user pasted or dropped into the
  // tab `tabId` into the work folder of its conversation, under a new
  // neutral name (`nextDataFileName`), and returns the text of the copy for
  // the conversation (`/work/data-1.csv`). A failure is logged, shows an
  // error toast, and rejects, so the caller inserts no text.
  async 'dez.controller/dataFiles/save' (tabId: string, bytes: Uint8Array, extension: DataFileExtension): Promise<string> {
    try {
      return await sbp('okTurtles.eventQueue/queueEvent', SAVES, async (): Promise<string> => {
        // The tab now: the read of the file took time.
        const tab = sbp('dez.model/tab', tabId) as Tab | null
        if (!tab) throw new ExplainedError('The tab was closed before Dez could copy the file, so Dez did not keep it. Drop or paste it again in another tab.')
        const folder = conversationWorkFolder(tab.conversationId)
        if (folder === null) {
          throw new ExplainedError('This conversation has no work folder, as its id can name no folder (app_state.json was changed by hand). Open a new tab, and add the file there.')
        }
        // The folders too: a file cannot take the name of a folder.
        const entries = await Promise.all([false, true].map((folders) => sbp('dez.native/listAppFiles', folder, 'app', { folders }) as Promise<AppFileEntry[]>))
        const name = nextDataFileName(extension, entries.flat().map((entry) => entry.name), tab.sections.map(sectionPlainText))
        // Only the user can open the folder; a save makes a missing folder
        // with the default mode.
        await sbp('dez.native/createFolder', folder, 'app')
        await sbp('dez.native/saveAppFile', `${folder}/${name}`, bytes, 'app')
        return dataFileText(name)
      }) as string
    } catch (error) {
      console.error('Failed to copy a data file into the work folder of its conversation:', error)
      sbp('dez.ui/toast', 'app-global', {
        title: 'Could not add the data file',
        message: error instanceof ExplainedError
          ? error.message
          : errorText('The system did not let Dez write the copy of the file. The details tell why (for example, the disk is full). Fix that, and try again.', rawErrorText(error)),
        variant: 'error',
      })
      throw error
    }
  },
})
