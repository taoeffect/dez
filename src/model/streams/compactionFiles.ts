import { sectionCompactionBlock, sectionTextParts } from '../chat/compaction'
import type { ShownPicture } from '../chat/shownPictures'
import { findToolBlocks } from '../chat/toolBlocks'
import type { Section } from '../chat/types'
import { compactionScope, type CompactionAsset } from './compactionAssets'

// The files that a compaction leaves with no text that names them. A
// compaction takes text out of a conversation, and the editor cannot bring
// that text back (the tab gets a new editor state, with no undo history).
// So Dez deletes these files at once, and not at the next Delete
// Unreferenced Files:
//
// - The file of a dropped asset that a call made as a part of its work
//   (`CompactionAsset.intermediate`). The user saw it only in the panel of
//   that call, and the compaction removes the call.
// - The copy of each picture that the replaced text showed a model: the
//   pictures of its `asset_view` blocks, and the pictures of the compaction
//   tag before. No request reads them again.
//
// The file of any other dropped asset stays: the user saw that asset in
// the conversation, and can still have a use for its file. Delete
// Unreferenced Files finds it.
//
// This list is only what the compaction itself tells. Another text (a
// second conversation, a saved prompt) can still name one of the files, so
// the delete checks every text first
// (`dez.controller/unusedFiles/deleteUnnamed`).

/** The files of a compaction that no text of its conversation names any
 *  more. A file can be in a list more than one time: the delete takes each
 *  file one time. */
export interface CompactionLeftFiles {
  /** The source of each dropped intermediate asset: the path of its image,
   *  or the `src` of its clip (a saved file, a temp copy, or a URL). */
  sources: string[]
  /** The name of each picture copy of the replaced text, in the views
   *  folder (`ShownPicture.file`). */
  pictures: string[]
}

/** The files that the compaction of `sections` in the reply whose section
 *  has the id `replySectionId` left with no use. `dropped` are the assets
 *  that it dropped (`Compaction.dropped`), and `keptPictures` the pictures
 *  of its new tag (`Compaction.pictures`), whose copies stay. */
export function compactionLeftFiles({ sections, replySectionId, dropped, keptPictures }: {
  sections: readonly Section[]
  replySectionId: string
  dropped: readonly CompactionAsset[]
  keptPictures: readonly ShownPicture[]
}): CompactionLeftFiles {
  const sources = dropped.flatMap(({ asset, intermediate, fromUser }) => {
    if (!intermediate || fromUser) return []
    const source = asset.kind === 'image' ? asset.reference.path : asset.clip.src
    return source === null ? [] : [source]
  })
  const keptFiles = new Set(keptPictures.map((picture) => picture.file))
  const replaced = sections.slice(0, compactionScope(sections, replySectionId).end)
  const shown = [
    ...(replaced.length > 0 ? sectionCompactionBlock(replaced[0])?.pictures ?? [] : []),
    // A tool block counts only in the text of an agent section.
    ...replaced.flatMap((section, index) => (section.role === 'agent' ? findToolBlocks(sectionTextParts(section, index).text).flatMap((block) => block.pictures ?? []) : [])),
  ]
  const pictures = shown.map((picture) => picture.file).filter((file) => !keptFiles.has(file))
  return { sources, pictures }
}
