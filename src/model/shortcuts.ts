import { base, keyName, shift } from 'w3c-keyname'
import { isMacPlatform } from '../utils/platform'

// The editable keyboard shortcuts: the one list of actions with their default
// keys, and the key rules that every binding path shares (the window
// handler, the CodeMirror keymap, the find field, the native menu, and
// Settings › Shortcuts).
//
// A key is a CodeMirror key name with `Mod` resolved for the platform and
// the modifiers in CodeMirror's order, `Shift-Meta-Ctrl-Alt-<key>`: for
// example `Shift-Ctrl-t` on Linux and `Shift-Meta-t` on macOS. CodeMirror
// keymaps take it as is. `Meta` is Cmd on macOS and Super on Linux.

export type ShortcutPlatform = 'mac' | 'linux'

export const currentShortcutPlatform: ShortcutPlatform = isMacPlatform ? 'mac' : 'linux'

/** Where a shortcut's key is handled:
 *  - `app`: the window keydown handler and the native menu;
 *  - `editor`: the CodeMirror keymap, and the native menu through
 *    `dez.editor/runKeyBinding`;
 *  - `findField`: the search field of the find dropdown;
 *  - `menu`: the native menu accelerator only. */
export type ShortcutScope = 'app' | 'editor' | 'findField' | 'menu'

/** The groups of the Shortcuts settings tab, in display order. */
export const SHORTCUT_GROUPS = ['Conversation', 'Editing', 'Find', 'Tabs', 'App'] as const
export type ShortcutGroup = typeof SHORTCUT_GROUPS[number]

interface ShortcutDefinition {
  readonly label: string
  readonly group: ShortcutGroup
  readonly scope: ShortcutScope
  /** The default key, where `Mod` is Cmd on macOS and Ctrl on Linux. A
   *  record names only the platforms that have the action. */
  readonly key: string | Readonly<Partial<Record<ShortcutPlatform, string>>>
  /** Extra default keys. They work only while the action has its default
   *  key, so they never block a key that the user gives another action. */
  readonly aliases?: Readonly<Partial<Record<ShortcutPlatform, readonly string[]>>>
}

const TAB_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const

const goToTabDefinitions = Object.fromEntries(TAB_NUMBERS.map((n) => [
  `goToTab${n}`,
  { label: `Go to tab ${n}`, group: 'Tabs', scope: 'app', key: `Mod-${n}` } satisfies ShortcutDefinition,
])) as Record<`goToTab${typeof TAB_NUMBERS[number]}`, ShortcutDefinition & { readonly scope: 'app' }>

// One entry per action, in the order of the Shortcuts tab. Not listed, and
// never editable: Cut/Copy/Paste, the macOS app-menu keys, the Linux
// Ctrl+A/Ctrl+E line navigation, the prompt autocomplete keys, the editor
// navigation keys, Enter and Shift+Enter in the find field, and Esc while it
// closes a dropdown, Settings, History, the prompt autocomplete, or find.
const DEFINITIONS = {
  submit: { label: 'Submit thread to LLM', group: 'Conversation', scope: 'editor', key: 'Mod-Enter' },
  // In the editor CodeMirror runs it after the Esc bindings that close the
  // prompt autocomplete and find. The window handler also runs it while the
  // focus is outside the editor.
  stop: { label: 'Stop the response', group: 'Conversation', scope: 'editor', key: 'Escape' },
  newMessage: { label: 'New message', group: 'Conversation', scope: 'editor', key: 'Shift-Enter' },
  addCursorAbove: { label: 'Add cursor on line above', group: 'Conversation', scope: 'editor', key: 'Ctrl-Shift-ArrowUp' },
  addCursorBelow: { label: 'Add cursor on line below', group: 'Conversation', scope: 'editor', key: 'Ctrl-Shift-ArrowDown' },
  saveAs: { label: 'Save conversation as Markdown', group: 'Conversation', scope: 'app', key: 'Mod-s' },
  undo: { label: 'Undo', group: 'Editing', scope: 'editor', key: 'Mod-z' },
  // Linux Ctrl+Y is a redo key of CodeMirror's `historyKeymap`.
  redo: { label: 'Redo', group: 'Editing', scope: 'editor', key: 'Mod-Shift-z', aliases: { linux: ['Ctrl-y'] } },
  // macOS has the predefined Select All item with Cmd+A. On Linux Ctrl+A
  // moves to the line start (`linuxLineNavigationKeymap` in cmEditor.ts), and
  // Super+A also selects all.
  selectAll: { label: 'Select all', group: 'Editing', scope: 'editor', key: { linux: 'Alt-a' }, aliases: { linux: ['Meta-a'] } },
  copyMarkdown: { label: 'Copy Markdown (as Save As Markdown writes it)', group: 'Editing', scope: 'app', key: 'Mod-Shift-c' },
  find: { label: 'Find and replace', group: 'Find', scope: 'app', key: 'Mod-f' },
  findNext: { label: 'Next match', group: 'Find', scope: 'app', key: 'Mod-g' },
  findPrevious: { label: 'Previous match', group: 'Find', scope: 'app', key: 'Mod-Shift-g' },
  olderSearch: { label: 'Older search (in find field)', group: 'Find', scope: 'findField', key: 'ArrowUp' },
  newerSearch: { label: 'Newer search (in find field)', group: 'Find', scope: 'findField', key: 'ArrowDown' },
  newConversation: { label: 'New conversation', group: 'Tabs', scope: 'app', key: 'Mod-n' },
  newTab: { label: 'New tab', group: 'Tabs', scope: 'app', key: 'Mod-t' },
  reopenClosedTab: { label: 'Reopen closed tab', group: 'Tabs', scope: 'app', key: 'Mod-Shift-t' },
  closeTab: { label: 'Close tab', group: 'Tabs', scope: 'app', key: 'Mod-w' },
  previousTab: { label: 'Previous tab', group: 'Tabs', scope: 'app', key: 'Mod-Shift-[' },
  nextTab: { label: 'Next tab', group: 'Tabs', scope: 'app', key: 'Mod-Shift-]' },
  ...goToTabDefinitions,
  // Not Mod-h: on macOS Cmd+H is the predefined Hide item of the app menu.
  history: { label: 'Open history', group: 'App', scope: 'app', key: 'Mod-Shift-h' },
  settings: { label: 'Open settings', group: 'App', scope: 'app', key: 'Mod-,' },
  // `+` too: on a US layout it is Shift+=, and some layouts (German) have a
  // `+` key.
  increaseFontSize: {
    label: 'Increase font size',
    group: 'App',
    scope: 'app',
    key: 'Mod-=',
    aliases: { mac: ['Mod-+'], linux: ['Mod-+'] },
  },
  decreaseFontSize: { label: 'Decrease font size', group: 'App', scope: 'app', key: 'Mod--' },
  // macOS quits with the predefined Quit item of the app menu (Cmd+Q).
  quit: { label: 'Quit', group: 'App', scope: 'menu', key: { linux: 'Ctrl-q' } },
} satisfies Record<string, ShortcutDefinition>

export type ShortcutId = keyof typeof DEFINITIONS

/** The ids of the actions that `scope` handles, so that a binding path can
 *  list a handler for each of them. */
export type ShortcutIdOfScope<S extends ShortcutScope> = {
  [Id in ShortcutId]: (typeof DEFINITIONS)[Id]['scope'] extends S ? Id : never
}[ShortcutId]

/** The user's keys that differ from the defaults, by action. */
export type ShortcutOverrides = Readonly<Partial<Record<ShortcutId, string>>>

/** An action on one platform, with the key it has now. */
export interface Shortcut {
  readonly id: ShortcutId
  readonly label: string
  readonly group: ShortcutGroup
  readonly scope: ShortcutScope
  readonly defaultKey: string
  /** The user's key, else the default key. */
  readonly key: string
  /** `key`, then the default aliases while `key` is the default key. */
  readonly keys: readonly string[]
}

interface PlatformDefault extends Omit<Shortcut, 'key' | 'keys'> {
  readonly aliases: readonly string[]
}

const defaultsByPlatform = new Map<ShortcutPlatform, readonly PlatformDefault[]>()

function normalizeDefinitionKey (id: string, key: string, platform: ShortcutPlatform): string {
  const normalized = normalizeShortcutKey(key, platform)
  if (normalized) return normalized
  const error = new Error(`Shortcut "${id}" has a bad default key "${key}"`)
  console.error(error)
  throw error
}

function platformDefaults (platform: ShortcutPlatform): readonly PlatformDefault[] {
  const cached = defaultsByPlatform.get(platform)
  if (cached) return cached
  const defaults: PlatformDefault[] = []
  for (const [id, definition] of Object.entries(DEFINITIONS) as Array<[ShortcutId, ShortcutDefinition]>) {
    const key = typeof definition.key === 'string' ? definition.key : definition.key[platform]
    if (!key) continue
    defaults.push({
      id,
      label: definition.label,
      group: definition.group,
      scope: definition.scope,
      defaultKey: normalizeDefinitionKey(id, key, platform),
      aliases: (definition.aliases?.[platform] ?? []).map((alias) => normalizeDefinitionKey(id, alias, platform)),
    })
  }
  defaultsByPlatform.set(platform, defaults)
  return defaults
}

/** Every action of the platform, in display order, with the overrides
 *  applied. The overrides must be normalized keys that passed
 *  `validateShortcutKey`; ids that the platform lacks are ignored. */
export function resolveShortcuts (platform: ShortcutPlatform, overrides: ShortcutOverrides = {}): Shortcut[] {
  return platformDefaults(platform).map(({ aliases, ...shortcut }) => {
    const key = overrides[shortcut.id] ?? shortcut.defaultKey
    return { ...shortcut, key, keys: key === shortcut.defaultKey ? [key, ...aliases] : [key] }
  })
}

/** Action `id` of `shortcuts`, for a binding path that has it on this
 *  platform. Throws when the platform lacks it. */
export function findShortcut (shortcuts: readonly Shortcut[], id: ShortcutId): Shortcut {
  const shortcut = shortcuts.find((candidate) => candidate.id === id)
  if (shortcut) return shortcut
  const error = new Error(`No "${id}" shortcut on this platform`)
  console.error(error)
  throw error
}

interface KeyParts {
  key: string
  shift: boolean
  meta: boolean
  ctrl: boolean
  alt: boolean
}

// W3C modifier key values: pressed alone, they are not a shortcut.
const MODIFIER_KEYS: Readonly<Record<string, true>> = {
  Alt: true, AltGraph: true, CapsLock: true, Control: true, Fn: true, FnLock: true, Hyper: true, Meta: true,
  NumLock: true, OS: true, ScrollLock: true, Shift: true, Super: true, Symbol: true, SymbolLock: true,
}

// The named keys of w3c-keyname, by lowercase name, so that a hand-edited
// `enter` or `pageup` gets CodeMirror's spelling.
const NAMED_KEYS = new Map(Object.values(base).filter((name) => name.length > 1).map((name) => [name.toLowerCase(), name]))

// Old key names, by lowercase name: `keyName` rewrites them to these W3C
// names, so no key press gives them, and a hand-edited `Ctrl-Up` must
// become `Ctrl-ArrowUp` to ever run.
const LEGACY_KEY_NAMES = new Map([
  ['esc', 'Escape'], ['del', 'Delete'], ['up', 'ArrowUp'], ['down', 'ArrowDown'], ['left', 'ArrowLeft'],
  ['right', 'ArrowRight'],
])

// Key values that name no real key: `keyName` gives them for a key it cannot
// name, a dead key, or an IME composition.
const UNUSABLE_KEYS: Readonly<Record<string, true>> = { Unidentified: true, Dead: true, Process: true }

// A key part is one character or a capitalized W3C name, so it never names
// an `Object.prototype` property: the lookup tables below can be plain
// records.
function normalizeKeyPart (key: string): string | null {
  if (key === ' ' || key.toLowerCase() === 'space') return 'Space'
  if ([...key].length === 1) return /[\s\p{C}]/u.test(key) ? null : key
  const named = NAMED_KEYS.get(key.toLowerCase()) ?? LEGACY_KEY_NAMES.get(key.toLowerCase())
  if (named) return named
  // Other W3C key values, such as `ContextMenu`, that a key press can give.
  return /^[A-Z][A-Za-z0-9]+$/.test(key) && !Object.hasOwn(UNUSABLE_KEYS, key) ? key : null
}

// Splits a key name into its key and modifiers. It takes the modifier names
// of CodeMirror's `normalizeKeyName`, in any case; `Mod` is Cmd on macOS and
// Ctrl on Linux.
function parseKeyName (name: string, platform: ShortcutPlatform): KeyParts | null {
  const parts = name.split(/-(?!$)/)
  const key = normalizeKeyPart(parts.pop() ?? '')
  if (!key) return null
  const result: KeyParts = { key, shift: false, meta: false, ctrl: false, alt: false }
  for (const modifier of parts) {
    if (/^(cmd|meta|m)$/i.test(modifier)) result.meta = true
    else if (/^a(lt)?$/i.test(modifier)) result.alt = true
    else if (/^(c|ctrl|control)$/i.test(modifier)) result.ctrl = true
    else if (/^s(hift)?$/i.test(modifier)) result.shift = true
    else if (/^mod$/i.test(modifier)) result[platform === 'mac' ? 'meta' : 'ctrl'] = true
    else return null
  }
  // CodeMirror matches `Ctrl-A` and `Shift-Ctrl-a` to the same key press, so
  // there is one spelling, the one that the key recorder gives.
  if (/^[A-Z]$/.test(result.key)) {
    result.key = result.key.toLowerCase()
    result.shift = true
  }
  return result
}

function formatKeyName ({ key, shift, meta, ctrl, alt }: KeyParts): string {
  return `${shift ? 'Shift-' : ''}${meta ? 'Meta-' : ''}${ctrl ? 'Ctrl-' : ''}${alt ? 'Alt-' : ''}${key}`
}

/** The one spelling of a key name (`Mod` resolved, CodeMirror's modifier
 *  order, `Space`, one letter case), or null when it is not a key name. */
export function normalizeShortcutKey (name: string, platform: ShortcutPlatform): string | null {
  const parts = parseKeyName(name, platform)
  return parts ? formatKeyName(parts) : null
}

/** The fields of a keydown event that key matching reads. */
export type ShortcutKeyEvent = Pick<KeyboardEvent, 'key' | 'keyCode' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>

function withModifiers (name: string, event: ShortcutKeyEvent, withShift: boolean): string {
  return formatKeyName({
    key: name === ' ' ? 'Space' : name,
    shift: withShift && event.shiftKey,
    meta: event.metaKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
  })
}

/** The key names that a CodeMirror keymap tries for this keydown, in its
 *  order (`runHandlers` in @codemirror/view 6.41), so that the window
 *  handler and the find field pick the same binding as the editor:
 *  1. `keyName(event)` with the modifiers; Shift only for a key that types
 *     no character, because a character already shows Shift (`T`, `{`);
 *  2. for a character typed with Ctrl, Cmd, or Alt: the key's unshifted US
 *     name with Shift (Ctrl+Shift+[ types `{` and matches `Shift-Ctrl-[`;
 *     a Cyrillic letter matches its Latin key), then its shifted US name;
 *  3. else, for a character typed with Shift: the name with Shift.
 *  macOS Option without Ctrl or Cmd types a character, so it skips step 2.
 *  Like w3c-keyname and CodeMirror, this reads the platform that the app
 *  runs on. CodeMirror's Windows rule is left out (Dez has no Windows
 *  build). */
export function eventKeyNames (event: ShortcutKeyEvent): string[] {
  const name = keyName(event as unknown as Event)
  const isChar = [...name].length === 1 && name !== ' '
  const names = [withModifiers(name, event, !isChar)]
  const baseName = base[event.keyCode]
  if (isChar && (event.altKey || event.metaKey || event.ctrlKey) &&
    !(isMacPlatform && event.altKey && !(event.ctrlKey || event.metaKey)) &&
    baseName && baseName !== name) {
    names.push(withModifiers(baseName, event, true))
    const shiftName = shift[event.keyCode]
    if (event.shiftKey && shiftName !== name && shiftName !== baseName) names.push(withModifiers(shiftName, event, false))
  } else if (isChar && event.shiftKey) {
    names.push(withModifiers(name, event, true))
  }
  return names
}

/** The shortcut that this keydown runs: the first of its key names, in
 *  CodeMirror's order, that one of `shortcuts` has. */
export function matchShortcut (shortcuts: readonly Shortcut[], event: ShortcutKeyEvent): Shortcut | null {
  for (const name of eventKeyNames(event)) {
    const match = shortcuts.find((shortcut) => shortcut.keys.includes(name))
    if (match) return match
  }
  return null
}

/** The key that the Shortcuts tab records for this keydown, or null for a
 *  modifier pressed alone or a key with no name (the recorder then waits
 *  for the next key). It is the second key name when there is one: for a
 *  character with Shift or Ctrl/Cmd/Alt, that names the physical key with
 *  Shift, so the same press matches it later on any layout. */
export function eventShortcutKey (event: ShortcutKeyEvent): string | null {
  if (Object.hasOwn(MODIFIER_KEYS, event.key)) return null
  const names = eventKeyNames(event)
  return normalizeShortcutKey(names[1] ?? names[0], currentShortcutPlatform)
}

// Key codes by name, for synthetic events. WebKit sends the main-keyboard
// codes, so this skips Gecko's codes (59 `;`, 61 `=`, 173 `-`), the old
// Enter code 10, and the numpad (96-111).
const mainKeyCodes = Object.keys(base).map(Number)
  .filter((code) => code !== 10 && code !== 59 && code !== 61 && code !== 173 && (code < 96 || code > 111))
const KEY_CODES = new Map<string, number>()
const SHIFTED_KEY_CODES = new Map<string, number>()
for (const code of mainKeyCodes) {
  if (!KEY_CODES.has(base[code])) KEY_CODES.set(base[code], code)
  if (shift[code] !== base[code] && !SHIFTED_KEY_CODES.has(shift[code])) SHIFTED_KEY_CODES.set(shift[code], code)
}

/** A keydown that a press of `key` gives on a US layout (`Shift-Ctrl-[`
 *  types `{`), for `new KeyboardEvent('keydown', …)`. CodeMirror keymaps and
 *  `eventKeyNames` match it to `key`. */
export function keyEventInit (key: string, platform: ShortcutPlatform = currentShortcutPlatform): ShortcutKeyEvent {
  const parts = parseKeyName(key, platform)
  if (!parts) {
    const error = new Error(`Not a key name: "${key}"`)
    console.error(error)
    throw error
  }
  const modifiers = { altKey: parts.alt, ctrlKey: parts.ctrl, metaKey: parts.meta, shiftKey: parts.shift }
  if (parts.key === 'Space') return { key: ' ', keyCode: 32, ...modifiers }
  const keyCode = KEY_CODES.get(parts.key)
  if (keyCode !== undefined) {
    const typed = parts.shift && [...parts.key].length === 1 ? shift[keyCode] : parts.key
    return { key: typed, keyCode, ...modifiers }
  }
  return { key: parts.key, keyCode: SHIFTED_KEY_CODES.get(parts.key) ?? 0, ...modifiers }
}

const FUNCTION_KEY = /^F([1-9]|1\d|2[0-4])$/
const ARROW_KEYS: Readonly<Record<string, true>> = { ArrowUp: true, ArrowDown: true, ArrowLeft: true, ArrowRight: true }
// Keys that type no text, so Shift alone makes them a shortcut.
const SHIFT_KEYS: Readonly<Record<string, true>> = {
  ...ARROW_KEYS, Enter: true, Home: true, End: true, PageUp: true, PageDown: true, Backspace: true, Delete: true,
}

// Keys that no action may take: the standard edit keys, focus moves, the
// macOS app-menu items with fixed keys (`src/controller/menu.ts`), and the
// Linux editor's line navigation (`linuxLineNavigationKeymap` in
// cmEditor.ts). `validateShortcutKey` also reserves the developer console keys.
const FOCUS_MOVE = 'moving the focus'
const RESERVED_KEYS: Record<ShortcutPlatform, Readonly<Partial<Record<string, string>>>> = {
  mac: {
    'Meta-x': 'Cut', 'Meta-c': 'Copy', 'Meta-v': 'Paste', Tab: FOCUS_MOVE, 'Shift-Tab': FOCUS_MOVE,
    'Meta-a': 'Select All', 'Meta-q': 'Quit Dez', 'Meta-m': 'Minimize', 'Meta-h': 'Hide Dez', 'Meta-Alt-h': 'Hide Others',
  },
  linux: {
    'Ctrl-x': 'Cut', 'Ctrl-c': 'Copy', 'Ctrl-v': 'Paste', Tab: FOCUS_MOVE, 'Shift-Tab': FOCUS_MOVE,
    'Ctrl-a': 'moving to the line start', 'Ctrl-e': 'moving to the line end',
  },
}

// A key without Ctrl, Cmd, or Alt types text or does an editing move, so
// only these work alone or with Shift alone.
function worksWithoutCommandModifier ({ key, shift }: KeyParts, shortcut: Shortcut): boolean {
  if (FUNCTION_KEY.test(key)) return true
  if (shift) return Object.hasOwn(SHIFT_KEYS, key)
  // Esc keeps its fixed closing jobs first; only Stop runs after them.
  if (key === 'Escape') return shortcut.id === 'stop'
  return shortcut.scope === 'findField' && Object.hasOwn(ARROW_KEYS, key)
}

/** Why action `id` cannot take `key` with these overrides, as text for the
 *  Shortcuts tab, or null when it can. `key` is any key name. A per-row
 *  reset passes the default key, which brings back the default aliases, so
 *  they are checked too. */
export function validateShortcutKey (
  platform: ShortcutPlatform,
  id: ShortcutId,
  key: string,
  overrides: ShortcutOverrides = {},
): string | null {
  const shortcuts = resolveShortcuts(platform, overrides)
  const shortcut = shortcuts.find((candidate) => candidate.id === id)
  if (!shortcut) return 'Not available on this platform'
  const parts = parseKeyName(key, platform)
  if (!parts) return 'Not a valid key'
  if (Object.hasOwn(MODIFIER_KEYS, parts.key)) return 'A modifier key alone is not a shortcut'
  const name = formatKeyName(parts)
  const reserved = RESERVED_KEYS[platform][name]
  if (reserved) return `Reserved for ${reserved}`
  // The toggle key that Tauri's `devtools` feature adds (toggle-devtools.js
  // in the tauri crate, a `document` keydown listener) checks only Cmd+Option
  // on macOS or Ctrl+Shift elsewhere, and ignores the other modifiers. So
  // Shift+Cmd+Option+I also toggles the inspector, and an action on that key
  // would run with it.
  if (parts.key === 'i' && (platform === 'mac' ? parts.meta && parts.alt : parts.ctrl && parts.shift)) {
    return 'Reserved for the developer console'
  }
  if (!parts.ctrl && !parts.meta && !parts.alt && !worksWithoutCommandModifier(parts, shortcut)) {
    return platform === 'mac' ? 'This key needs ⌘, ⌥, or ⌃' : 'This key needs Ctrl, Alt, or Super'
  }
  // A menu-only action (Quit) has no page handler: it needs a key that the
  // native menu can take.
  if (shortcut.scope === 'menu' && shortcutAccelerator(name, platform) === null) {
    return 'The menu cannot use this key'
  }
  const aliases = platformDefaults(platform).find((candidate) => candidate.id === id)?.aliases ?? []
  for (const candidateKey of name === shortcut.defaultKey ? [name, ...aliases] : [name]) {
    const owner = shortcuts.find((other) => other.id !== id && other.keys.includes(candidateKey))
    if (owner) return `Used by ${owner.label}`
  }
  // One press can have two key names (on a US layout Ctrl+Shift+= is
  // `Ctrl-+` and `Shift-Ctrl-=`), and it runs the action of the first name
  // that some action has (`matchShortcut`, CodeMirror). So with the new key
  // in place, a US-layout press of every key must still run its own action.
  // Only a clash with action `id` counts: a clash between two other actions
  // in a saved set must not refuse every key, or `parseShortcutOverrides`
  // would drop all the entries, not only those two. Other layouts can still
  // have such pairs.
  const next = resolveShortcuts(platform, { ...overrides, [id]: name })
  for (const other of next) {
    for (const otherKey of other.keys) {
      const runs = matchShortcut(next, keyEventInit(otherKey, platform))
      if (runs && runs.id !== other.id && (runs.id === id || other.id === id)) {
        return `Used by ${(runs.id === id ? other : runs).label}`
      }
    }
  }
  return null
}

/** The overrides in a `shortcuts` value of app_state.json, which a user can
 *  edit by hand: keys normalized, and only the entries that `platform` can
 *  use. It drops unknown ids, ids that the platform lacks, values that are
 *  not key names, default keys (no override), and keys that
 *  `validateShortcutKey` refuses. */
export function parseShortcutOverrides (value: unknown, platform: ShortcutPlatform): ShortcutOverrides {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const defaultKeys = new Map(platformDefaults(platform).map((shortcut) => [shortcut.id as string, shortcut.defaultKey]))
  let overrides: Partial<Record<ShortcutId, string>> = {}
  for (const [id, key] of Object.entries(value)) {
    const defaultKey = defaultKeys.get(id)
    const normalized = typeof key === 'string' ? normalizeShortcutKey(key, platform) : null
    if (defaultKey && normalized && normalized !== defaultKey) overrides[id as ShortcutId] = normalized
  }
  // Each entry is checked against all the others, not only the ones before
  // it: a saved set where action A took action B's default key after B moved
  // away is valid in any order. A dropped entry brings back its default key,
  // which can clash with an entry that passed, so check again until nothing
  // more drops. Two entries with the same key both drop.
  for (;;) {
    const kept = Object.fromEntries(Object.entries(overrides).filter(([id, key]) =>
      validateShortcutKey(platform, id as ShortcutId, key, overrides) === null))
    if (Object.keys(kept).length === Object.keys(overrides).length) return kept
    overrides = kept
  }
}

/** `keycap`: what a keycap shows (`⇧⌘T`, `Ctrl+↩`). `text`: words for a
 *  title or an aria-label (`Cmd+Enter`, `Ctrl+Up`). */
export type ShortcutLabelStyle = 'keycap' | 'text'

const TEXT_KEY_NAMES: Readonly<Partial<Record<string, string>>> = {
  Escape: 'Esc', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  PageUp: 'Page Up', PageDown: 'Page Down',
}
const ARROW_SYMBOLS = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' }
const KEYCAP_KEY_NAMES: Record<ShortcutPlatform, Readonly<Partial<Record<string, string>>>> = {
  // Apple's menu symbols.
  mac: { ...ARROW_SYMBOLS, Enter: '↩', Escape: '⎋', Backspace: '⌫', Delete: '⌦' },
  linux: { ...ARROW_SYMBOLS, Enter: '↩', Escape: 'Esc' },
}

/** How a key is shown: macOS keycaps use Apple's symbols and modifier
 *  order `⌃⌥⇧⌘`; everything else uses `Ctrl+Alt+Shift+Super+K` (on macOS
 *  `Ctrl+Option+Shift+Cmd+K`). */
export function shortcutLabel (key: string, platform: ShortcutPlatform, style: ShortcutLabelStyle = 'keycap'): string {
  const parts = parseKeyName(key, platform)
  if (!parts) return key
  const keyText = (style === 'keycap' ? KEYCAP_KEY_NAMES[platform][parts.key] : undefined) ??
    TEXT_KEY_NAMES[parts.key] ??
    ([...parts.key].length === 1 ? parts.key.toUpperCase() : parts.key)
  if (platform === 'mac' && style === 'keycap') {
    return `${parts.ctrl ? '⌃' : ''}${parts.alt ? '⌥' : ''}${parts.shift ? '⇧' : ''}${parts.meta ? '⌘' : ''}${keyText}`
  }
  const modifiers = platform === 'mac'
    ? [parts.ctrl && 'Ctrl', parts.alt && 'Option', parts.shift && 'Shift', parts.meta && 'Cmd']
    : [parts.ctrl && 'Ctrl', parts.alt && 'Alt', parts.shift && 'Shift', parts.meta && 'Super']
  return [...modifiers.filter((modifier) => modifier), keyText].join('+')
}

/** The `text` label of the key that action `id` has now, for a button title
 *  such as "New tab (Ctrl+T)", so that the title follows a key change. */
export function shortcutKeyText (shortcuts: readonly Shortcut[], id: ShortcutId): string {
  return shortcutLabel(findShortcut(shortcuts, id).key, currentShortcutPlatform, 'text')
}

// Key names that Tauri's accelerator parser (muda `parse_key`) accepts as
// they are. It splits the accelerator on `+`, so the `+` key has none.
const ACCELERATOR_NAMED_KEYS: Readonly<Record<string, true>> = {
  Enter: true, Space: true, Tab: true, Backspace: true, Delete: true, Home: true, End: true, PageUp: true,
  PageDown: true, Insert: true, Escape: true, PrintScreen: true,
}
const ACCELERATOR_ARROWS: Readonly<Partial<Record<string, string>>> = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
}

function acceleratorKey (key: string): string | null {
  if (/^[a-z]$/.test(key)) return key.toUpperCase()
  if (/^[0-9`\\[\],=\-.';/]$/.test(key) || FUNCTION_KEY.test(key) || Object.hasOwn(ACCELERATOR_NAMED_KEYS, key)) return key
  return ACCELERATOR_ARROWS[key] ?? null
}

/** The native menu accelerator for a key (`Ctrl+Shift+T`, `Cmd+Up`), or
 *  null when the menu item must have none. */
export function shortcutAccelerator (key: string, platform: ShortcutPlatform): string | null {
  const parts = parseKeyName(key, platform)
  if (!parts) return null
  // On Linux GTK takes an accelerator before the page, so a bare Esc
  // accelerator would stop Esc from closing find, the dropdowns, and the
  // modals.
  if (parts.key === 'Escape' && !parts.shift && !parts.meta && !parts.ctrl && !parts.alt) return null
  const name = acceleratorKey(parts.key)
  if (!name) return null
  const modifiers = [parts.ctrl && 'Ctrl', parts.alt && 'Alt', parts.shift && 'Shift', parts.meta && (platform === 'mac' ? 'Cmd' : 'Super')]
  return [...modifiers.filter((modifier) => modifier), name].join('+')
}
