import sbp from '@sbp/sbp'
import type { Tab } from '../model/chat/types'

export default sbp('sbp/selectors/register', {
  'dez.controller/openConversationInNewTab' (id: string): Promise<Tab | null> {
    return sbp('dez.model/tabs/openConversation', id) as Promise<Tab | null>
  },

  'dez.controller/deleteConversation' (id: string): Promise<void> {
    return sbp('dez.model/tabs/deleteConversation', id) as Promise<void>
  },
})
