import sbp from '@sbp/sbp'
import type { Tab } from '../model/chat/types'

export default sbp('sbp/selectors/register', {
  'dez.controller/selectModelForActiveTab' (providerId: string, modelId: string, modelName: string): void {
    sbp('dez.model/setActiveModel', providerId, modelId, modelName)
  },

  'dez.controller/createTab' (): Tab {
    return sbp('dez.model/tabs/create') as Tab
  },

  async 'dez.controller/closeTab' (tabId: string): Promise<void> {
    await sbp('dez.controller/stopTab', tabId)
    sbp('dez.model/tabs/close', tabId)
  },

  'dez.controller/switchTab' (tabId: string): void {
    sbp('dez.model/tabs/switch', tabId)
  },

  'dez.controller/switchToIndex' (index: number): void {
    sbp('dez.model/tabs/switchToIndex', index)
  },

  'dez.controller/cycleTab' (direction: 1 | -1): void {
    sbp('dez.model/tabs/cycle', direction)
  },
})
