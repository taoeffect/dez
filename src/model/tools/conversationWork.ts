// The work folder of a conversation: one folder of `work/` in the app root
// for each conversation, which the code of its runs reads and changes
// (a `js_eval` run, the run of a script app). Its files stay from one run
// to the next, and they go with the conversation (`dez.controller/
// deleteConversation`, `dez.controller/closeTab`); Delete Unreferenced
// Files deletes the folder of a conversation that is gone
// (controller/unusedFiles.ts), and a compaction keeps an asset that one of
// its files names (controller/compactionApps.ts). A model names it `/work`
// (`WORK_VIRTUAL_ROOT`, `textForModel` in jsEval.ts), so no text for it
// holds a path of the computer. Rust makes the folder, and lets a run of
// Deno open it (`conversation_folder`, src-tauri/src/bundled_tools.rs).
//
// It is not a work folder of the cache root (workFolders.ts): that one is
// the folder of one call, which a model knows as `/run`.

/** The folder of the app root that holds the work folders of the
 *  conversations, one folder each (`CONVERSATION_WORK_FOLDERS` in
 *  src-tauri/src/persistence.rs). */
export const CONVERSATION_WORK_ROOT = 'work'

/** What a model reads for the work folder of its conversation in every
 *  path. */
export const WORK_VIRTUAL_ROOT = '/work'

// A conversation id that can name a folder: the characters of the stem of
// a conversation file (`CONVERSATION_FILE_STEM`, persistence/index.ts), and
// not empty. Dez makes each id with `crypto.randomUUID()`; only a hand
// edit of app_state.json gives a tab another id.
const WORK_FOLDER_NAME = /^[A-Za-z0-9_-]+$/

/** The path from the app root of the work folder of the conversation
 *  `conversationId`; null for an id that can name no folder, whose
 *  conversation has none. */
export function conversationWorkFolder(conversationId: string): string | null {
  return WORK_FOLDER_NAME.test(conversationId) ? `${CONVERSATION_WORK_ROOT}/${conversationId}` : null
}
