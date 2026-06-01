import sbp from '@sbp/sbp'
import { parseAppStateJson, serializeAppStateJson } from './appState'
import { parseConversation, serializeConversation } from './conversationFormat'
import { parsePromptsJson, serializePromptsJson } from './prompts'
import { conversationSummary, sortConversationSummaries } from './summaries'
import type { AppStatePayload, ConversationData, ConversationFile, ConversationSummary, PromptData } from './types'

// File names under ~/.config/dez/ passed to the generic native app-file I/O.
const APP_STATE_FILE = 'app_state.json'
const PROMPTS_FILE = 'prompts.json'

export default sbp('sbp/selectors/register', {
  async 'dez.persistence/saveConversation' (data: ConversationData): Promise<void> {
    try {
      await sbp('dez.native/saveConversationFile', data.id, serializeConversation(data))
    } catch (error) {
      console.error('Failed to save conversation:', error)
      throw error
    }
  },

  async 'dez.persistence/loadConversation' (id: string): Promise<ConversationData> {
    try {
      const content = await sbp('dez.native/loadConversationFile', id) as string
      return parseConversation(id, content)
    } catch (error) {
      console.error('Failed to load conversation:', error)
      throw error
    }
  },

  async 'dez.persistence/listConversations' (): Promise<ConversationSummary[]> {
    try {
      const files = await sbp('dez.native/listConversationFiles') as ConversationFile[]
      const summaries = files.map((file) => {
        const data = parseConversation(file.id, file.content)
        return conversationSummary(data, file.updatedAt)
      })
      return sortConversationSummaries(summaries)
    } catch (error) {
      console.error('Failed to list conversations:', error)
      throw error
    }
  },

  async 'dez.persistence/deleteConversation' (id: string): Promise<void> {
    try {
      await sbp('dez.native/deleteConversationFile', id)
    } catch (error) {
      console.error('Failed to delete conversation:', error)
      throw error
    }
  },

  async 'dez.persistence/saveAppState' (state: AppStatePayload): Promise<void> {
    try {
      await sbp('dez.native/saveAppFile', APP_STATE_FILE, serializeAppStateJson(state))
    } catch (error) {
      console.error('Failed to save app state:', error)
      throw error
    }
  },

  async 'dez.persistence/loadAppState' (): Promise<AppStatePayload> {
    try {
      const content = await sbp('dez.native/loadAppFile', APP_STATE_FILE) as string
      return parseAppStateJson(content)
    } catch (error) {
      console.error('Failed to load app state:', error)
      throw error
    }
  },

  async 'dez.persistence/savePrompts' (prompts: PromptData[]): Promise<void> {
    try {
      const snapshot = serializePromptsJson(prompts)
      await sbp('okTurtles.eventQueue/queueEvent', 'dez.persistence/prompts', ['dez.native/saveAppFile', PROMPTS_FILE, snapshot])
    } catch (error) {
      console.error('Failed to save prompts:', error)
      throw error
    }
  },

  async 'dez.persistence/loadPrompts' (): Promise<PromptData[]> {
    try {
      const content = await sbp('dez.native/loadAppFile', PROMPTS_FILE) as string
      return parsePromptsJson(content)
    } catch (error) {
      console.error('Failed to load prompts:', error)
      throw error
    }
  },
})
