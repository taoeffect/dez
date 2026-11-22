import { namedApps } from '../chat/appNames'
import { sectionCompactionBlock } from '../chat/compaction'
import { notesAppLines, type NotesApp } from '../chat/compactionNotes'
import { sectionPlainText } from '../chat/content'
import { findAssetMentions } from '../chat/imageMentions'
import type { Section } from '../chat/types'
import { isBuiltInApp, UNKNOWN_APP_KIND } from '../tools/appManifest'
import { APPS_ROOT, manifestColumns, pathIn, type AppsPath, type AppsTree, type ListedApp } from '../tools/appsTool'

// The apps of a conversation at a compaction (tools/appsTool.ts): the apps
// that the text that the compaction replaces names (`namedApps`,
// chat/appNames.ts), and that have a folder. An app is no asset, and the
// model decides nothing about it: Dez keeps each one as a line of the
// notes (chat/compactionNotes.ts), and the compaction request lists them
// (compactionRequest.ts). The compaction removes the calls and the tags
// that named these apps. Without the lines, no text of the conversation
// would name them, and Delete Unreferenced Apps would delete them.
//
// A file of an app can name an image or a clip of the conversation with
// its @id: a page that reads an asset over its bridge, or a list of the
// inputs of a script. The compaction keeps such an asset, as it keeps an
// input of an open job (`CompactionAsset.appInput`, compactionAssets.ts):
// else the id in the file would name nothing. An id belongs to one
// conversation and an app serves many, so a file can mean an asset of
// another conversation with the same id. Then the compaction keeps an
// asset with no need, which is the safe side.
//
// All pure; controller/compactionApps.ts reads the folders and the files.

/** The names of the apps that the text of `sections` names, in the order
 *  of the names: of the sections that a compaction replaces, with the
 *  block of the compaction before, whose notes list the apps of that
 *  time. An app with such a name need not be there. A built-in app is
 *  left out: it is a part of Dez, which no cleanup deletes, and the
 *  conversation wrote none of its files. */
export function sectionAppNames(sections: readonly Section[]): string[] {
  const names = new Set<string>()
  for (const section of sections) {
    for (const name of namedApps(sectionPlainText(section))) if (!isBuiltInApp(name)) names.add(name)
  }
  return [...names].sort()
}

/** The app lines of the notes of the compaction before, which the first
 *  section of `sections` holds (`notesAppLines`), by the name of the app;
 *  none for a conversation with no compaction. */
export function carriedAppLines(sections: readonly Section[]): Map<string, NotesApp> {
  const block = sections.length > 0 ? sectionCompactionBlock(sections[0]) : null
  return block ? notesAppLines(block.notes) : new Map()
}

// The description of an app whose folder Dez could not read, and that the
// notes before do not tell.
const NOT_READ_DESCRIPTION = '(Dez could not read the folder of this app at this compaction)'

/** The line of the app `name` in the notes of a compaction. `listed` is
 *  what Dez read of its folder now, and its manifest tells the kind and
 *  the description (`manifestColumns`). It is null for a folder that Dez
 *  could not read: the app then keeps `carried`, its line in the notes of
 *  the compaction before, when it has one. */
export function compactionApp(name: string, listed: ListedApp | null, carried: NotesApp | undefined): NotesApp {
  if (listed === null) return carried ?? { name, kind: UNKNOWN_APP_KIND, description: NOT_READ_DESCRIPTION }
  const [kind, description] = manifestColumns(listed)
  return { name, kind, description }
}

/** The limits of the files of the apps that a compaction reads for `@id`
 *  mentions: the most bytes of one file, and the most files and bytes of
 *  one compaction. A compaction runs while the user waits for a reply,
 *  and the texts are in the webview as a whole. A source file is small:
 *  a larger file is data, or code of a library, which names no asset. */
export const APP_MENTION_FILE_BYTES = 256 * 1024
export const APP_MENTION_MAX_FILES = 200
export const APP_MENTION_MAX_BYTES = 4 * 1024 * 1024

/** The files of the apps `apps` (each with the listing of its folder) that
 *  a compaction reads for `@id` mentions (`appFileMentions`): the plain
 *  files of at most `APP_MENTION_FILE_BYTES`, while their count and their
 *  bytes are in the limits. The files nearest to the folder of their app
 *  come first, then the order of the apps, then the order of the paths:
 *  the files that a model wrote for an app are at the top of its folder,
 *  so each app gets those read before a deep folder of one app uses up
 *  the limits. A file that the rest of the bytes cannot hold is left out,
 *  and a smaller one after it can still be read. */
export function appMentionFiles(apps: readonly { name: string, tree: AppsTree }[]): AppsPath[] {
  const candidates = apps.flatMap(({ name, tree }, app) => tree.entries
    .filter((entry) => entry.kind === 'file' && entry.size > 0 && entry.size <= APP_MENTION_FILE_BYTES)
    .map((entry) => {
      const names = entry.path.split('/')
      return { app, depth: names.length, size: entry.size, path: names.reduce(pathIn, pathIn(APPS_ROOT, name)) }
    }))
  candidates.sort((a, b) => a.depth - b.depth || a.app - b.app || (a.path.file < b.path.file ? -1 : a.path.file > b.path.file ? 1 : 0))
  const files: AppsPath[] = []
  let bytes = 0
  for (const { size, path } of candidates) {
    if (files.length >= APP_MENTION_MAX_FILES) break
    if (bytes + size > APP_MENTION_MAX_BYTES) continue
    bytes += size
    files.push(path)
  }
  return files
}

/** The ids that the file of an app with the bytes `bytes` names in the
 *  form of a mention (`findAssetMentions`), each one time; none for a file
 *  that is no text (it holds a zero byte). Bytes that are no UTF-8 fail
 *  nothing: a mention next to them still counts. */
export function appFileMentions(bytes: Uint8Array): Set<string> {
  if (bytes.includes(0)) return new Set()
  return new Set(findAssetMentions(new TextDecoder().decode(bytes)).map((mention) => mention.id))
}
