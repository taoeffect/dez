import fs from 'node:fs'
import path from 'node:path'
import { serializeConversation } from '../../../src/model/persistence/conversationFormat'
import { defaultAppState, serializeAppStateJson } from '../../../src/model/persistence/appState'
import type { AppStatePayload, ConversationData } from '../../../src/model/persistence/types'

// Fixture seeding for the isolated per-run HOME created by `startApp()`.
//
// Seeding window: seed AFTER `startApp()` (which creates the temp HOME) and
// BEFORE `createSession()` — tauri-driver only launches the app binary when
// the WebDriver session is requested, so `app_state.json` (with
// `checkForUpdates: false`) and the conversation files are already on disk
// when the app boots and reads them.
//
// Reset boundary (decided in TODO-4): the tauri-driver process, temp HOME,
// and app session are per spec FILE (beforeAll/afterAll) because app launch
// dominates cost. Fixture resets are per TEST where a scenario needs a clean
// slate: `resetConversationFixtures()` wipes and re-seeds conversation files
// in milliseconds, then the spec clicks the history panel's Refresh button
// so the running app re-lists/re-indexes. `app_state.json` is seeded once
// pre-launch and is never reset mid-run — the app keeps settings in memory
// and would overwrite the file from its debounced persistence watcher.

/** Mirrors Rust's `sanitize_id` (src-tauri/src/persistence.rs): keep only
 * ASCII alphanumerics, `-`, and `_`. The fixture file name must match what
 * the app computes from a conversation id or specs would assert on the
 * wrong path. */
function sanitizeId (id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '')
}

function configDir (home: string): string {
  return path.join(home, '.config', 'dez')
}

function conversationsDir (home: string): string {
  return path.join(configDir(home), 'conversations')
}

/** Absolute path of the on-disk conversation file for an id, e.g.
 * `<home>/.config/dez/conversations/<sanitized-id>.md`. Specs use it to
 * assert file deletion (delete flow) and to append text (mtime re-index). */
export function conversationFilePath (home: string, id: string): string {
  return path.join(conversationsDir(home), `${sanitizeId(id)}.md`)
}

/** Minimal `ConversationData` factory so specs can seed uniquely-worded
 * conversations without repeating every required field. */
export function makeConversation (overrides: Partial<ConversationData> = {}): ConversationData {
  return {
    id: overrides.id ?? `conv-${Math.random().toString(36).slice(2, 10)}`,
    title: overrides.title ?? 'Untitled',
    sections: overrides.sections ?? [{ role: 'user', nodes: [{ kind: 'text', text: 'hello' }] }],
    activeModel: overrides.activeModel ?? null,
    created_at: overrides.created_at ?? Date.now()
  }
}

export interface SeedConversationOptions {
  /** Set the file's atime/mtime after writing. The history panel's `recent`
   * sort orders by file mtime (Rust `file_updated_at`, millisecond
   * resolution), so deterministic ordering needs explicit mtimes rather
   * than relying on write order. */
  mtime?: Date | number
}

/**
 * Serialize a conversation with the app's real `serializeConversation`
 * (fixtures can never drift from the on-disk format) and write it to
 * `<home>/.config/dez/conversations/<sanitized-id>.md`. Returns the file
 * path.
 */
export async function seedConversation (
  home: string,
  data: ConversationData,
  options: SeedConversationOptions = {}
): Promise<string> {
  const sanitized = sanitizeId(data.id)
  if (sanitized.length === 0) {
    throw new Error(`seedConversation: id sanitizes to an empty file name: ${JSON.stringify(data.id)}`)
  }
  const filePath = conversationFilePath(home, data.id)
  await fs.promises.mkdir(conversationsDir(home), { recursive: true })
  await fs.promises.writeFile(filePath, serializeConversation(data), 'utf8')
  if (options.mtime !== undefined) {
    // Node treats *numeric* utimes args as SECONDS since the epoch; convert
    // ms numbers to Date so both option forms mean milliseconds.
    const when = typeof options.mtime === 'number' ? new Date(options.mtime) : options.mtime
    await fs.promises.utimes(filePath, when, when)
  }
  return filePath
}

async function writeAppStateFile (home: string, content: string): Promise<string> {
  const filePath = path.join(configDir(home), 'app_state.json')
  await fs.promises.mkdir(configDir(home), { recursive: true })
  await fs.promises.writeFile(filePath, content, 'utf8')
  return filePath
}

/** `<home>/.config/dez/app_state.json` as the app saved it, or null while
 *  it is missing or half written. */
export async function readAppState (home: string): Promise<AppStatePayload | null> {
  try {
    return JSON.parse(await fs.promises.readFile(path.join(configDir(home), 'app_state.json'), 'utf8')) as AppStatePayload
  } catch {
    return null
  }
}

/**
 * Seed `<home>/.config/dez/app_state.json` from the app's real
 * `defaultAppState()` + `serializeAppStateJson()`, with `checkForUpdates`
 * forced to `false` by default: startup otherwise fires an immediate
 * GitHub release fetch (network + possible toast overlay) via
 * `dez.controller/startUpdateChecker`. Call before `createSession()`.
 */
export async function seedAppState (
  home: string,
  overrides: Partial<AppStatePayload> = {}
): Promise<string> {
  const payload: AppStatePayload = {
    ...defaultAppState(),
    checkForUpdates: false,
    ...overrides
  }
  return writeAppStateFile(home, serializeAppStateJson(payload))
}

/**
 * Like `seedAppState()`, but writes `raw` as plain JSON over the defaults,
 * without the app's serializer or types. Use it for data that the app must
 * drop or rewrite on start, e.g. invalid `customProviders` entries or a
 * hand-added `apiKey`. Call before `createSession()`.
 */
export async function seedRawAppState (
  home: string,
  raw: Record<string, unknown>
): Promise<string> {
  return writeAppStateFile(home, JSON.stringify({ ...defaultAppState(), checkForUpdates: false, ...raw }, null, 2))
}

/**
 * Per-test reset: delete every file in the temp HOME's conversations
 * directory (keeping the directory itself), then seed the given
 * conversations. The running app is unaffected until the spec triggers a
 * history Refresh (the panel lists on mount/refresh; search is mtime-driven).
 */
export async function resetConversationFixtures (
  home: string,
  seed: ConversationData[] = []
): Promise<void> {
  const dir = conversationsDir(home)
  await fs.promises.mkdir(dir, { recursive: true })
  const entries = await fs.promises.readdir(dir)
  await Promise.all(entries.map((name) => fs.promises.rm(path.join(dir, name), { force: true })))
  for (const data of seed) {
    await seedConversation(home, data)
  }
}
