/** A count of bytes as a short text: `512 B`, `12 KB`, `48.3 MB`, `1.2 GB`
 *  (1 KB is 1024 B). Kilobytes are whole numbers; megabytes and gigabytes
 *  have one decimal. Code that puts a byte count into a text for the user
 *  or a model uses this, so all of them read the same. */
export function byteSizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kilobytes = Math.round(bytes / 1024)
  if (kilobytes < 1024) return `${kilobytes} KB`
  // The rounded number picks the unit, so that 1023.96 MB reads `1.0 GB` and
  // not `1024.0 MB`.
  const megabytes = (bytes / 1024 ** 2).toFixed(1)
  if (Number(megabytes) < 1024) return `${megabytes} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}
