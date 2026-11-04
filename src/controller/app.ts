import sbp from '@sbp/sbp'
import { watch, type WatchStopHandle } from 'vue'
import type { AppStatePayload } from '../model/persistence/types'
import type { ProviderConfig } from '../model/providers'
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

// A hand-edited customProviders entry in app_state.json can hold a plain-text
// `apiKey`. Keys belong only in provider_keys.json, so each one is saved
// there, and app state is then saved once, which drops the keys from
// app_state.json (the serializer never writes them). This save also drops a
// key that could not be saved (any later save would drop it too), so a toast
// asks the user to enter that key in Settings.
async function importCustomProviderApiKeys(apiKeys: Record<string, string>): Promise<void> {
  const entries = Object.entries(apiKeys)
  if (entries.length === 0) return
  const failedIds: string[] = []
  for (const [providerId, apiKey] of entries) {
    try {
      await sbp('dez.native/saveProviderSecret', providerId, apiKey)
    } catch (error) {
      console.error(`Failed to save the API key of custom provider ${providerId}:`, error)
      failedIds.push(providerId)
    }
  }
  await sbp('dez.model/appState/save')
  if (failedIds.length === 0) return
  const configs = sbp('dez.model/customProviders/list') as ProviderConfig[]
  const names = failedIds.map((id) => configs.find((config) => config.id === id)?.name ?? id)
  const plural = names.length > 1
  sbp('dez.ui/toast', 'app-global', {
    title: plural ? 'Could not save API keys' : 'Could not save an API key',
    message: `The ${plural ? 'API keys' : 'API key'} for ${names.join(', ')} in app_state.json could not be saved to provider_keys.json and ${plural ? 'were' : 'was'} removed. Enter ${plural ? 'them' : 'it'} again in Settings › Providers.`,
    variant: 'error',
    actionLabel: 'Open Settings',
    sbpInvocation: ['dez.model/settings/open', 'providers'],
  })
}

export default sbp('sbp/selectors/register', {
  // App startup can be retried after a failed async init, but concurrent Vue
  // lifecycle calls must share the same in-flight orchestration promise.
  async 'dez.controller/app/init' (): Promise<void> {
    if (initialized) return
    if (initPromise) return initPromise

    initPromise = (async () => {
      const state = await sbp('dez.model/settings/init') as AppStatePayload
      await sbp('dez.model/prompts/init')
      await sbp('dez.model/modelCache/init')

      if (Array.isArray(state.tabs)) {
        await sbp('dez.model/appState/restore', state)
      }
      // After restore: before it, the tab store holds only the boot tab, and
      // the app-state save in here would overwrite the user's saved tabs.
      // Before the first model refresh, so keyed providers are checked with
      // their key.
      await importCustomProviderApiKeys(state.customProviderApiKeys ?? {})

      sbp('dez.model/settings/startPersistence')
      sbp('dez.model/prompts/startPersistence')
      sbp('dez.model/modelCache/startPersistence')
      sbp('dez.controller/startUpdateChecker')
      startAppStateWatcher()
      initialized = true
      void sbp('dez.controller/menu/install')
      // Warm the cache against real availability in the background so the model
      // selector reconciles after startup without blocking init.
      void sbp('dez.controller/modelCache/refresh')
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
    sbp('dez.model/modelCache/stopPersistence')
    initialized = false
  },
})
