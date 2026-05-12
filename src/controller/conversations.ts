import sbp from '@sbp/sbp'
import { useTabStore } from '../model/state/tabs'
import type { Tab } from '../model/chat/types'

export default sbp('sbp/selectors/register', {
  'dez.controller/openConversationInNewTab' (id: string): Promise<Tab | null> {
    return useTabStore().openConversationInNewTab(id)
  },

  'dez.controller/deleteConversation' (id: string): Promise<void> {
    return useTabStore().deleteConversationById(id)
  },
})
