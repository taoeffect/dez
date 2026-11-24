import { fileNameOf, safeFileName } from '../../utils/fileName'
import { isImagePath } from './images'
import { mediaFileExtension } from './mediaFiles'

/** Where the Export of an image or a clip (`dez.controller/exportAsset`)
 *  takes its bytes: a file of this computer (`linked`: a linked file of
 *  the user, linkedFiles.ts), or the http or https URL that a clip plays
 *  from, with the clip's media type (null: not known). */
export type AssetExportSource =
  | { kind: 'file', path: string, linked: boolean }
  | { kind: 'url', url: string, type: string | null }

/** An image or a clip to export. `id` is its id in its conversation; null
 *  for an old image reference with none. */
export interface AssetExport {
  id: string | null
  kind: 'image' | 'audio' | 'video'
  source: AssetExportSource
}

/** The Export of the image file at `path`, with the id `id`. A path that
 *  is not a stored one is a linked file, by the rule of the image
 *  references (`findImageReferences`). */
export function imageExport(path: string, id: string | null): AssetExport {
  return { id, kind: 'image', source: { kind: 'file', path, linked: !isImagePath(path) } }
}

/** The file name that the save dialog of an Export proposes. A linked file
 *  keeps its own name. Else the name is the title of the conversation
 *  (`title`; null for a tab with no title), or the kind of the asset, then
 *  its id, with the extension of its file, or for a URL the extension of
 *  the clip's type (none when Dez does not know the type). A stored file
 *  has a random name, which tells the user nothing. */
export function exportFileName(asset: AssetExport, title: string | null): string {
  const { source } = asset
  if (source.kind === 'file' && source.linked) return fileNameOf(source.path)
  const extension = source.kind === 'file'
    ? /\.([A-Za-z0-9]+)$/.exec(fileNameOf(source.path))?.[1] ?? null
    : mediaFileExtension(source.type ?? '', source.url)
  const stem = safeFileName([safeFileName(title ?? '', asset.kind), asset.id ?? ''].join(' '), asset.kind)
  return extension === null ? stem : `${stem}.${extension}`
}
