// Local file paths in data that Dez passes on from one provider to another.
// The `model_info` tool sends a model's entry of its provider's model list to
// the chat model, and the entry of a local or custom server can hold a file
// path (vLLM's `root`, llama.cpp's `path`) that shows a user name or a
// project name. Dez sends no such path on its own: each one goes as a
// stand-in that still reads as a path, its known start and `…` (`/home/…`).
//
// A path is hidden only when it starts with one of the known starts below.
// "Starts with `/`" alone is never the test: entries also hold API routes
// (`/v1/images/generations`), which must stay.

/** Stands for the hidden rest of a path. */
const HIDDEN = '…'

// Folders of Linux and macOS under which users keep their own files, so that
// the next folder names can be a user name or a project name: home folders,
// the mount points of other disks, site and add-on data, temp folders, and
// the data folders that ML hosts use by convention. Folders that hold system
// files only (`/usr`, `/etc`, `/Library`) are not here. Neither are names
// that often start an API route (`/models`, `/users`, `/app`): the cost of a
// wrong match there is a route that the model cannot read.
const LOCAL_ROOTS = [
  'home', 'Users', 'root',
  'mnt', 'media', 'run/media', 'run/user', 'Volumes',
  'srv', 'opt', 'var', 'tmp', 'private/tmp', 'private/var',
  'data', 'workspace', 'workspaces', 'scratch',
]

// What comes before a path: the start of a line, or a character that a path
// or a URL cannot have before a `/`. So a folder in the middle of a relative
// path (`models/home/x`), of an API route (`/v1/data/x`), or of a URL
// (`https://host/home/x`) starts no match. A path after `=`, `:`, or a quote
// does (`--model=/home/x`, and also `?file=/home/x` in a URL).
const PATH_START = String.raw`(^|[^\p{L}\p{N}_.~/\\-])`

// The start of a `file:` URL, with or without a host: `file:/home/x`,
// `file:///home/x`, `file://localhost/home/x`.
const FILE_URL = String.raw`(?:file:(?://[^/\s]*)?)?`

// The starts of a local path; the text that each one matches is the part of
// the path that stays. The ones that end in a lookahead keep less than they
// test, so that no name stays. The first that matches wins, so a listed
// folder comes before the rule for other folders.
//
// There is no rule for the home folder of a named user (`~alice/x`), on
// purpose: OpenRouter has model ids of that form (`~openai/gpt-mini-latest`).
const KNOWN_STARTS = [
  // A folder of the list: `/home/`, `/run/media/`.
  `/(?:${LOCAL_ROOTS.join('|')})/`,
  // A Windows drive, with either slash. `Users` stays, to show that the path
  // was in a home folder. A `file:` URL has a `/` before the drive letter.
  String.raw`/?[A-Za-z]:[\\/](?:Users[\\/])?`,
  // A Windows network path (`\\server\share`, `\\?\C:\x`): only `\\` stays.
  String.raw`\\\\(?=[^\\/\s]+\\[^\\/\s])`,
  // The home folder of the current user.
  '~/',
  // A home folder under folders that are not in the list (`/nfs/home/alice`,
  // `/System/Volumes/Data/Users/alice`): only `/` stays, because the folders
  // before it can hold a host name or a project name. An API route with a
  // `home` folder after its first folder is hidden too; none is known. The
  // limit of 4 folders also keeps the work for each `/` small on a long text.
  String.raw`/(?=(?:[^/\s]+/){1,4}(?:home|Users)/)`,
]

// A local path: group 1 is what comes before it, group 2 its start that
// stays, and the rest runs to the end of the line. A path can hold spaces, so
// no earlier end is safe: the text after a path on the same line is hidden
// with it (`-m /home/x --port 80` gives `-m /home/…`). A start with nothing
// after it (`/home/`, `~/`) shows no name and is no match.
const LOCAL_PATH = new RegExp(`${PATH_START}(${FILE_URL}(?:${KNOWN_STARTS.join('|')}))[^\\r\\n]+`, 'gmu')

/** `text` with a stand-in in place of each local file path that can show a
 *  user name or a project name: the path's known start, then `…` (`/home/…`,
 *  `~/…`, `C:\Users\…`, `file:///mnt/…`). API routes, http(s) URLs, relative
 *  paths, and system folders stay. */
export function withoutLocalPaths(text: string): string {
  return text.replace(LOCAL_PATH, `$1$2${HIDDEN}`)
}

/** A copy of a JSON value with `withoutLocalPaths` applied to every string in
 *  it: the string values at any depth, and the object keys. Two keys that get
 *  the same stand-in become one field, with the value of the later key. */
export function jsonWithoutLocalPaths(value: unknown): unknown {
  if (typeof value === 'string') return withoutLocalPaths(value)
  if (Array.isArray(value)) return value.map(jsonWithoutLocalPaths)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [withoutLocalPaths(key), jsonWithoutLocalPaths(item)]))
}
