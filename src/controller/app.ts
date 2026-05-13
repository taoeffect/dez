import sbp from '@sbp/sbp'
import { watch, type WatchStopHandle } from 'vue'
import type { ModelSnapshot } from '../model/snapshot'

let initialized = false
let stopUpdateChecker: (() => void) | null = null
let stopAppStateWatch: WatchStopHandle | null = null

export default sbp('sbp/selectors/register', {
  async 'dez.controller/app/init' (): Promise<void> {
    if (initialized) return
    initialized = true

    const state = await sbp('dez.model/settings/init', () => {
      void sbp('dez.model/appState/save')
    })

    await sbp('dez.model/prompts/init')

    if (state && Array.isArray((state as { tabs?: unknown[] }).tabs)) {
      await sbp('dez.model/appState/restore', state)
    }

    stopUpdateChecker = sbp('dez.controller/startUpdateChecker') as () => void

    stopAppStateWatch = watch(
      () => {
        const tabs = sbp('dez.model/tabs/list') as ModelSnapshot['tabs']
        return [
          tabs.map((tab) => `${tab.id}:${tab.title}:${tab.conversationId}:${tab.activeModel?.providerId ?? ''}/${tab.activeModel?.modelId ?? ''}`).join('|'),
          sbp('dez.model/tabs/activeId') as string,
        ]
      },
      () => {
        void sbp('dez.model/appState/save')
      },
    )
  },

  'dez.controller/app/cleanup' (): void {
    stopUpdateChecker?.()
    stopUpdateChecker = null
    stopAppStateWatch?.()
    stopAppStateWatch = null
    initialized = false
  },
})
