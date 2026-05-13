import sbp from '@sbp/sbp'
import { watch, type WatchStopHandle } from 'vue'
import type { ModelSnapshot } from '../model/snapshot'
import { stopUpdateCheckerService } from './updates'

let initialized = false
let initPromise: Promise<void> | null = null
let stopAppStateWatch: WatchStopHandle | null = null

function startAppStateWatcher(): void {
  stopAppStateWatch?.()
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
}

export default sbp('sbp/selectors/register', {
  // App startup can be retried after a failed async init, but concurrent Vue
  // lifecycle calls must share the same in-flight orchestration promise.
  async 'dez.controller/app/init' (): Promise<void> {
    if (initialized) return
    if (initPromise) return initPromise

    initPromise = (async () => {
      const state = await sbp('dez.model/settings/init')
      await sbp('dez.model/prompts/init')

      if (state && Array.isArray((state as { tabs?: unknown[] }).tabs)) {
        await sbp('dez.model/appState/restore', state)
      }

      sbp('dez.model/settings/startPersistence')
      sbp('dez.model/prompts/startPersistence')
      sbp('dez.controller/startUpdateChecker')
      startAppStateWatcher()
      initialized = true
    })()

    try {
      await initPromise
    } catch (error) {
      console.error('App initialization failed', error)
      sbp('dez.controller/app/cleanup')
    } finally {
      initPromise = null
    }
  },


  'dez.controller/app/cleanup' (): void {
    stopUpdateCheckerService()
    stopAppStateWatch?.()
    stopAppStateWatch = null
    sbp('dez.model/settings/stopPersistence')
    sbp('dez.model/prompts/stopPersistence')
    initialized = false
  },
})
