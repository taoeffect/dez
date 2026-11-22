import sbp from '@sbp/sbp'
import type { NotesApp } from '../model/chat/compactionNotes'
import type { Section } from '../model/chat/types'
import { appMentionFolder, carriedAppLines, compactionApp, fileMentions, mentionFiles, sectionAppNames, type MentionFile, type MentionFolder } from '../model/streams/compactionApps'
import { MANIFEST_FILE } from '../model/tools/appManifest'
import { APPS_MAX_ENTRIES, APPS_ROOT, hasReadableManifest, pathIn, type AppsPath, type ListedApp } from '../model/tools/appsTool'
import { conversationWorkFolder, WORK_VIRTUAL_ROOT } from '../model/tools/conversationWork'
import type { FileTree } from './nativeTypes'

// The file reads of a compaction for the apps of its conversation and for
// its work folder (model/streams/compactionApps.ts, which tells why a
// compaction reads them). It registers no selector.
//
// It calls the native side directly, not through the helpers of the `apps`
// tool (appsTool.ts): those throw a text for a model that made a call. No
// read here fails the compaction. A compaction cannot be undone, so an app
// whose folder Dez cannot read keeps its line (Delete Unreferenced Apps
// must not delete it for one failed read), and a file or a work folder
// that Dez cannot read only names no asset.

/** What a compaction reads of the apps and of the work folder of its
 *  conversation. */
export interface CompactionApps {
  /** The line of each app for the notes and for the request, by name. */
  apps: NotesApp[]
  /** The ids of the assets that a file of one of the apps or of the work
   *  folder names with `@id`. */
  fileInputs: Set<string>
}

function fileBytes(path: MentionFile): Promise<Uint8Array> {
  return sbp('dez.native/loadAppFileBytes', path.file, path.root) as Promise<Uint8Array>
}

// What Dez reads of the app at `app` now: the listing of its folder, with
// as many entries as an app can have, and its manifest. `missing` for a
// name with no folder: an app that is gone, or a text that only looks
// like the name of an app (`namedApps`). `notRead` for a read that failed.
async function listedApp(name: string, app: AppsPath): Promise<ListedApp | 'missing' | 'notRead'> {
  try {
    const tree = await sbp('dez.native/listFileTree', app.file, APPS_MAX_ENTRIES, app.root) as FileTree
    if (tree.kind !== 'folder') return 'missing'
    return { name, tree, manifest: hasReadableManifest(tree) ? await fileBytes(pathIn(app, MANIFEST_FILE)) : null }
  } catch (error) {
    console.error(`compaction: Dez could not read the app ${app.virtual}:`, error)
    return 'notRead'
  }
}

// The work folder of the conversation `conversationId`, with its listing,
// as a folder for `mentionFiles`; null for a conversation with no folder,
// or a folder that Dez could not read. A run makes the folder
// (controller/programRuns.ts): a conversation with no run has none.
async function workMentionFolder(conversationId: string): Promise<MentionFolder | null> {
  const file = conversationWorkFolder(conversationId)
  if (file === null) return null
  try {
    const tree = await sbp('dez.native/listFileTree', file, APPS_MAX_ENTRIES, 'app') as FileTree
    return tree.kind === 'folder' ? { folder: { root: 'app', file, virtual: WORK_VIRTUAL_ROOT }, tree } : null
  } catch (error) {
    console.error(`compaction: Dez could not read the work folder ${WORK_VIRTUAL_ROOT}:`, error)
    return null
  }
}

/** The apps of a compaction that replaces `sections` (the sections before
 *  `CompactionScope.end`) of the conversation `conversationId`, whose
 *  assets have the ids `assetIds`: the apps that the text of the sections
 *  names and that have a folder now, and the ids of `assetIds` that the
 *  files of these apps and of the work folder of the conversation name.
 *  An app that the user deleted leaves the notes here. Rejects only for a
 *  stop of `signal`. */
export async function readCompactionApps(sections: readonly Section[], assetIds: ReadonlySet<string>, conversationId: string, signal: AbortSignal): Promise<CompactionApps> {
  const carried = carriedAppLines(sections)
  const apps: NotesApp[] = []
  const listed: ListedApp[] = []
  for (const name of sectionAppNames(sections)) {
    signal.throwIfAborted()
    const app = await listedApp(name, pathIn(APPS_ROOT, name))
    if (app === 'missing') continue
    if (app !== 'notRead') listed.push(app)
    apps.push(compactionApp(name, app === 'notRead' ? null : app, carried.get(name)))
  }

  const fileInputs = new Set<string>()
  // A conversation with no asset has no id that a file could name.
  if (assetIds.size === 0) return { apps, fileInputs }
  signal.throwIfAborted()
  const work = await workMentionFolder(conversationId)
  const folders = [...listed.map(appMentionFolder), ...(work ? [work] : [])]
  for (const path of mentionFiles(folders)) {
    // Every asset is guarded: the other files can add nothing.
    if (fileInputs.size === assetIds.size) break
    signal.throwIfAborted()
    try {
      for (const id of fileMentions(await fileBytes(path))) if (assetIds.has(id)) fileInputs.add(id)
    } catch (error) {
      console.error(`compaction: Dez could not read the file ${path.virtual}:`, error)
    }
  }
  return { apps, fileInputs }
}
