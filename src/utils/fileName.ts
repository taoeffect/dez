// Characters that Windows forbids in file names, plus control characters.
// Linux allows all but `/`, and macOS Finder shows `:` as `/`, so this set
// gives a name that is safe on every platform.
const UNSAFE_FILE_NAME_CHARS = /[/\\:*?"<>|\u0000-\u001F\u007F]/g

// Makes `name` usable as a file name (without extension). Unsafe characters
// become spaces, so "2/3" does not turn into "23". Leading dots are removed,
// because they hide the file on Linux and macOS. Trailing dots are removed,
// because the caller appends an extension.
export function safeFileName(name: string, fallback: string): string {
  const safe = name
    .replace(UNSAFE_FILE_NAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
  return safe || fallback
}
