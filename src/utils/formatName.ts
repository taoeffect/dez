// The name of a file type as people write it, where that is not its
// extension in capitals.
const FORMAT_NAMES: Readonly<Record<string, string>> = {
  jpg: 'JPEG',
  jpeg: 'JPEG',
  webp: 'WebP',
  webm: 'WebM',
  ogg: 'Ogg',
  opus: 'Opus',
}

/** The name of the file type with the extension `extension`: `PNG`,
 *  `JPEG`, `WebM`, `MP3`. Code that names the type of a file from its
 *  extension uses this, so a type has one name in all of Dez. */
export function formatName(extension: string): string {
  const lower = extension.toLowerCase()
  return Object.hasOwn(FORMAT_NAMES, lower) ? FORMAT_NAMES[lower] : lower.toUpperCase()
}
