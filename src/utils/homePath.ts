/** `path` as the user reads it: `~` in place of the home folder `home`, when
 *  the path is that folder or a path inside it. Both are absolute paths
 *  with `/` between the names (Dez runs on Linux and macOS). */
export function pathWithTilde(path: string, home: string): string {
  const folder = home.replace(/\/+$/, '')
  // A home folder of `/` (or none) would give every path a `~`.
  if (folder === '') return path
  if (path === folder) return '~'
  // The `/` keeps `/home/annabel` out of `/home/anna`.
  return path.startsWith(`${folder}/`) ? `~${path.slice(folder.length)}` : path
}
