import sbp from '@sbp/sbp'
import { useTabStore } from '../model/state/tabs'
import { useThreadStore } from '../model/state/thread'
import type { Tab } from '../model/chat/types'

export default sbp('sbp/selectors/register', {
  'dez.controller/selectModelForActiveTab' (providerId: string, modelId: string, modelName: string): void {
    useThreadStore().setActiveModel(providerId, modelId, modelName)
  },

  'dez.controller/createTab' (): Tab {
    return useTabStore().createTab()
  },

  async 'dez.controller/closeTab' (tabId: string): Promise<void> {
    await sbp('dez.controller/stopTab', tabId)
    useTabStore().closeTab(tabId)
  },

  'dez.controller/switchTab' (tabId: string): void {
    useTabStore().switchTab(tabId)
  },

  'dez.controller/switchToIndex' (index: number): void {
    useTabStore().switchToIndex(index)
  },

  'dez.controller/cycleTab' (direction: 1 | -1): void {
    useTabStore().cycleTab(direction)
  },
})
