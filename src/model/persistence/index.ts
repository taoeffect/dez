import sbp from '@sbp/sbp'
import { parseAppStateJson, serializeAppStateJson } from './appState'
import { parseConversation, serializeConversation, serializeConversationAsMarkdown } from './conversationFormat'
import { parseModelCacheJson, serializeModelCacheJson } from './modelCache'
import { parsePendingUpdateJson, serializePendingUpdateJson } from './pendingUpdate'
import { parsePromptsJson, serializePromptsJson } from './prompts'
import { searchConversationFiles, staleConversationIds } from './search'
import type { AppStatePayload, ConversationData, ConversationFile, ConversationSearchOutcome, ModelCache, PromptData } from './types'

// File names under ~/.config/dez/ passed to the generic native app-file I/O.
const APP_STATE_FILE = 'app_state.json'
const PROMPTS_FILE = 'prompts.json'
const MODEL_CACHE_FILE = 'model_cache.json'
const PENDING_UPDATE_FILE = 'updates/pending.json'

// App code reads and writes the files under ~/.config/dez/ only through
// these selectors, which own the file formats. They reach the disk only
// through `dez.native/*` (src/controller/native.ts), the one frontend layer
// that calls the raw Tauri file commands.
export default sbp('sbp/selectors/register', {
  async 'dez.persistence/saveConversation' (data: ConversationData): Promise<void> {
    try {
      await sbp('dez.native/saveConversationFile', data.id, serializeConversation(data))
    } catch (error) {
      console.error('Failed to save conversation:', error)
      throw error
    }
  },

  // Writes the conversation as plain Markdown. `path` must be the exact path
  // that the save dialog returned; the fs scope allows no other path.
  async 'dez.persistence/exportConversation' (data: ConversationData, path: string): Promise<void> {
    try {
      await sbp('dez.native/writeTextFile', path, serializeConversationAsMarkdown(data))
    } catch (error) {
      console.error('Failed to export conversation:', error)
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

  // Full-text search over saved conversations. An empty/whitespace query
  // returns every conversation (this replaces the old plain listing), so the
  // panel uses one selector for both listing and searching. Parse work is
  // cached per file mtime inside searchConversationFiles; file contents are
  // fetched only for files the cache considers stale, so repeated panel
  // opens/keystrokes cost O(changed files) in file I/O. `total` is the
  // query-independent conversation count, taken from the listing already in
  // hand so the history header stays correct while results are filtered.
  async 'dez.persistence/searchConversations' (query: string): Promise<ConversationSearchOutcome> {
    try {
      let files = await sbp('dez.native/listConversationFiles', false) as ConversationFile[]
      const stale = new Set(staleConversationIds(files))
      if (files.length > 0 && stale.size === files.length) {
        // Cold start (nothing usable cached): one full-content listing beats
        // N per-file invoke round-trips.
        files = await sbp('dez.native/listConversationFiles', true) as ConversationFile[]
      } else if (stale.size > 0) {
        const loaded = await Promise.all([...stale].map(async (id): Promise<[string, string] | null> => {
          try {
            return [id, await sbp('dez.native/loadConversationFile', id) as string]
          } catch (error) {
            // File vanished between listing and load (e.g. deleted); skip it
            // this round — the next listing simply won't include it.
            console.error('Failed to load conversation for search:', id, error)
            return null
          }
        }))
        const contentById = new Map(loaded.filter((entry): entry is [string, string] => entry !== null))
        files = files.flatMap((file) => {
          if (!stale.has(file.id)) return [file]
          const content = contentById.get(file.id)
          return content === undefined ? [] : [{ ...file, content }]
        })
      }
      return { total: files.length, results: searchConversationFiles(files, query) }
    } catch (error) {
      console.error('Failed to search conversations:', error)
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

  async 'dez.persistence/saveModelCache' (cache: ModelCache): Promise<void> {
    try {
      const snapshot = serializeModelCacheJson(cache)
      await sbp('okTurtles.eventQueue/queueEvent', 'dez.persistence/modelCache', ['dez.native/saveAppFile', MODEL_CACHE_FILE, snapshot])
    } catch (error) {
      console.error('Failed to save model cache:', error)
      throw error
    }
  },

  async 'dez.persistence/loadModelCache' (): Promise<ModelCache> {
    try {
      const content = await sbp('dez.native/loadAppFile', MODEL_CACHE_FILE) as string
      return parseModelCacheJson(content)
    } catch (error) {
      console.error('Failed to load model cache:', error)
      throw error
    }
  },

  async 'dez.persistence/savePendingUpdate' (version: string): Promise<void> {
    try {
      await sbp('dez.native/saveAppFile', PENDING_UPDATE_FILE, serializePendingUpdateJson(version))
    } catch (error) {
      console.error('Failed to save the pending update:', error)
      throw error
    }
  },

  // Reads and deletes the pending-update file, so each install is reported
  // once. Gives its version, or null when there is no file or it is
  // malformed. When the delete fails, it rejects and gives no version: a
  // report at every startup would be worse than none.
  async 'dez.persistence/takePendingUpdate' (): Promise<string | null> {
    try {
      const content = await sbp('dez.native/loadAppFile', PENDING_UPDATE_FILE) as string
      if (!content) return null
      await sbp('dez.native/deleteAppFile', PENDING_UPDATE_FILE)
      return parsePendingUpdateJson(content)
    } catch (error) {
      console.error('Failed to read the pending update:', error)
      throw error
    }
  },
})
