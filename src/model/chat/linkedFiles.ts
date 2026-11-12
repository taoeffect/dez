import { fileNameOf } from '../../utils/fileName'

// A dropped image or clip file is linked: the conversation names the file
// by its absolute path where it is, and Dez stores no copy of it. A file
// can be deleted or moved after the drop, so Dez copies a dropped file only
// when it is in a temp folder of the OS or in a folder of Dez's own (the
// app folder, the cache root): there it would go away by itself, or Dez
// could delete it. A paste always copies, as a pasted file has no path.
//
// A linked path counts only in a user section (`isLinkedImagePath` in
// images.ts, `isLinkedMediaPath` in mediaTags.ts): a model must not choose a
// file of this computer that Dez then reads. Dez never deletes a linked
// file; its trash removes only the reference or the tag. Providers get no
// linked path (`withoutStoredFilePaths`, storedFilePaths.ts), and the
// unused-files scan lists only the files that Dez stores.

/** True when the absolute path `path` is the folder `folder` or a path in
 *  it. Both must be canonical (`dez.native/canonicalPath`), as a link or a
 *  `..` in either would hide a match. */
export function isInFolder(path: string, folder: string): boolean {
  const base = folder.replace(/\/+$/, '')
  return path === base || path.startsWith(`${base}/`)
}

/** True when a drop must copy the file at `canonicalPath`, as it is in one
 *  of `copyFolders` (canonical too): a temp folder or a folder of Dez. */
export function dropCopiesFile(canonicalPath: string, copyFolders: readonly string[]): boolean {
  return copyFolders.some((folder) => isInFolder(canonicalPath, folder))
}

/** A dropped `File` as a drop event gives it: no path, only a name and a
 *  size. */
export interface DroppedFileFacts {
  name: string
  size: number
}

/** A path of the files that the user drags, with the size of its file
 *  (null: not known). */
export interface DraggedPath {
  path: string
  size: number | null
}

/** The path of each dropped file, in the order of `files`; null for a file
 *  with no path of `dragged`. An HTML5 drop (macOS) gives `File` objects
 *  with no path, and the drag pasteboard gives the paths with no file, so
 *  a file and a path pair up by file name (in NFC: macOS can give either
 *  form) and size. A file that two or more paths fit, or that fits a path
 *  that another file fits too, gets null, so a drop never links a file of
 *  the same name and size from another folder: Dez then copies it. */
export function pairDroppedFiles(files: readonly DroppedFileFacts[], dragged: readonly DraggedPath[]): (string | null)[] {
  const fits = (file: DroppedFileFacts, path: DraggedPath) =>
    path.size === file.size && fileNameOf(path.path).normalize('NFC') === file.name.normalize('NFC')
  return files.map((file) => {
    const paths = dragged.filter((path) => fits(file, path))
    if (paths.length !== 1) return null
    return files.filter((other) => fits(other, paths[0])).length === 1 ? paths[0].path : null
  })
}
