import sbp from '@sbp/sbp'
import { watch } from 'vue'
import { isNewerVersion } from '../utils/version'
import { useSettingsStore, type SettingsSection, type Theme } from '../stores/settingsStore'
import { useStreamStore } from '../stores/streamStore'
import { useTabStore } from '../stores/tabStore'
import { useThreadStore } from '../stores/threadStore'
import type { Tab } from '../model/chat/types'
import type { ModelInfo, ProviderId, ProviderInfo } from '../model/providers'
import type { CopilotDeviceFlowResponse, LatestRelease } from '../model/types'

interface ProviderSettingsData {
  providers: ProviderInfo[]
  providerModels: Record<string, ModelInfo[]>
}

interface CopilotDeviceFlowViewState {
  userCode: string
  verificationUri: string
}

interface CopilotSignInOptions {
  onDeviceFlow?(flow: CopilotDeviceFlowViewState): void | Promise<void>
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const CHECK_INTERVAL_MS = 60 * 60 * 1000

let updateCheckPromise: Promise<void> | null = null
let stopUpdateChecker: (() => void) | null = null

export default sbp('sbp/selectors/register', {
  async 'dez.controller/submitActiveTab' (): Promise<void> {
    const tabStore = useTabStore()
    await sbp('dez.controller/submitTab', tabStore.activeTabId)
  },

  async 'dez.controller/submitTab' (tabId: string): Promise<void> {
    const tabStore = useTabStore()
    const streamStore = useStreamStore()
    if (!tabStore.tabById(tabId)) return

    const model = tabStore.activeModelForTab(tabId)
    if (!model) {
      streamStore.setError(tabId, 'No model selected')
      return
    }

    const messages = tabStore.streamMessagesForTab(tabId)
    if (messages.length === 0) return

    const agentSection = tabStore.ensureTrailingAgentSectionForTab(tabId)
    if (!agentSection) return

    streamStore.clearError(tabId)
    await sbp('dez.stream/start', {
      tabId,
      sectionId: agentSection.id,
      model,
      messages,
    })
  },

  async 'dez.controller/stopActiveTab' (): Promise<void> {
    const tabStore = useTabStore()
    await sbp('dez.controller/stopTab', tabStore.activeTabId)
  },

  async 'dez.controller/stopTab' (tabId: string): Promise<void> {
    await sbp('dez.stream/stop', tabId)
  },

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

  'dez.controller/openConversationInNewTab' (id: string): Promise<Tab | null> {
    return useTabStore().openConversationInNewTab(id)
  },

  'dez.controller/deleteConversation' (id: string): Promise<void> {
    return useTabStore().deleteConversationById(id)
  },

  'dez.controller/openSettings' (section: SettingsSection = 'general'): void {
    useSettingsStore().openSettings(section)
  },

  'dez.controller/closeSettings' (): void {
    useSettingsStore().closeSettings()
  },

  'dez.controller/openHistory' (): void {
    useSettingsStore().openHistory()
  },

  'dez.controller/closeHistory' (): void {
    useSettingsStore().closeHistory()
  },

  'dez.controller/setTheme' (theme: Theme): void {
    useSettingsStore().setTheme(theme)
  },

  'dez.controller/togglePillSeparators' (): void {
    useSettingsStore().togglePillSeparators()
  },

  'dez.controller/setCheckForUpdates' (enabled: boolean): void {
    useSettingsStore().setCheckForUpdates(enabled)
  },

  'dez.controller/startUpdateChecker' (): () => void {
    stopUpdateChecker?.()

    const settings = useSettingsStore()
    const checkIfDue = async (): Promise<void> => {
      if (!settings.checkForUpdates) return
      if (updateCheckPromise) {
        await updateCheckPromise
        return
      }

      const now = Date.now()
      const lastCheckedAt = settings.lastUpdateCheckAt
      if (typeof lastCheckedAt === 'number' && now - lastCheckedAt < ONE_DAY_MS) return

      settings.setLastUpdateCheckAt(now)
      updateCheckPromise = (async () => {
        try {
          const latestRelease = await sbp('dez.native/getLatestRelease') as LatestRelease
          if (isNewerVersion(latestRelease.version, __APP_VERSION__)) {
            sbp('dez.ui/toast', 'app-global', {
              title: 'Update available',
              message: `Dez ${latestRelease.version} is available.`,
              variant: 'default',
              actionLabel: 'View latest release',
              sbpInvocation: ['dez.ui/openUrl', latestRelease.url],
            })
          }
        } catch (error) {
          console.error('Update check failed', error)
        }
      })()

      try {
        await updateCheckPromise
      } finally {
        updateCheckPromise = null
      }
    }

    const interval = window.setInterval(() => {
      void checkIfDue()
    }, CHECK_INTERVAL_MS)

    const stopWatch = watch(
      () => settings.checkForUpdates,
      (enabled) => {
        if (enabled) {
          void checkIfDue()
        }
      },
      { immediate: true },
    )

    stopUpdateChecker = () => {
      window.clearInterval(interval)
      stopWatch()
      stopUpdateChecker = null
    }

    return stopUpdateChecker
  },

  'dez.controller/stopUpdateChecker' (): void {
    stopUpdateChecker?.()
  },

  async 'dez.controller/checkForUpdatesNow' (): Promise<void> {
    if (updateCheckPromise) {
      await updateCheckPromise
      return
    }

    updateCheckPromise = (async () => {
      try {
        const latestRelease = await sbp('dez.native/getLatestRelease') as LatestRelease
        if (isNewerVersion(latestRelease.version, __APP_VERSION__)) {
          sbp('dez.ui/toast', 'app-global', {
            title: 'Update available',
            message: `Dez ${latestRelease.version} is available.`,
            variant: 'default',
            actionLabel: 'View latest release',
            sbpInvocation: ['dez.ui/openUrl', latestRelease.url],
          })
        } else {
          sbp('dez.ui/toast', 'app-global', {
            message: "No updates, you're running the latest version.",
            variant: 'default',
            duration: 5000,
          })
        }
      } catch (error) {
        console.error('Update check failed', error)
      }
    })()

    try {
      await updateCheckPromise
    } finally {
      updateCheckPromise = null
    }
  },

  async 'dez.controller/loadProviderSettings' (): Promise<ProviderSettingsData> {
    const providers = await sbp('dez.provider/infos') as ProviderInfo[]
    const providerModels: Record<string, ModelInfo[]> = {}

    for (const provider of providers) {
      if (!provider.configured) continue

      try {
        providerModels[provider.id] = await sbp('dez.provider/listModels', provider.id) as ModelInfo[]
      } catch (error) {
        console.error(`Failed to load models for ${provider.id}`, error)
        providerModels[provider.id] = []
      }
    }

    return { providers, providerModels }
  },

  async 'dez.controller/saveProviderSecret' (providerId: ProviderId, value: string): Promise<ProviderSettingsData> {
    await sbp('dez.native/saveProviderSecret', providerId, value)

    const providers = await sbp('dez.provider/infos') as ProviderInfo[]
    const providerModels: Record<string, ModelInfo[]> = {}

    for (const provider of providers) {
      if (!provider.configured) continue

      try {
        providerModels[provider.id] = await sbp('dez.provider/listModels', provider.id) as ModelInfo[]
      } catch (error) {
        console.error(`Failed to load models for ${provider.id}`, error)
        providerModels[provider.id] = []
      }
    }

    return { providers, providerModels }
  },

  async 'dez.controller/signInWithCopilot' (options: CopilotSignInOptions = {}): Promise<ProviderSettingsData> {
    const flow = await sbp('dez.native/copilotStartDeviceFlow') as CopilotDeviceFlowResponse
    const viewState = {
      userCode: flow.user_code,
      verificationUri: flow.verification_uri,
    }

    await options.onDeviceFlow?.(viewState)
    await navigator.clipboard.writeText(viewState.userCode).catch(() => undefined)
    sbp('dez.ui/openUrl', viewState.verificationUri)

    for (let i = 0; i < 60; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 5000))
      const done = await sbp('dez.native/copilotPollDeviceFlow', flow.device_code) as boolean
      if (done) {
        const providers = await sbp('dez.provider/infos') as ProviderInfo[]
        const providerModels: Record<string, ModelInfo[]> = {}

        for (const provider of providers) {
          if (!provider.configured) continue

          try {
            providerModels[provider.id] = await sbp('dez.provider/listModels', provider.id) as ModelInfo[]
          } catch (error) {
            console.error(`Failed to load models for ${provider.id}`, error)
            providerModels[provider.id] = []
          }
        }

        return { providers, providerModels }
      }
    }

    throw new Error('Copilot sign-in timed out. Please try again.')
  },
})
