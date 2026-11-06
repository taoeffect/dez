import { EditorState } from '@codemirror/state'
import { type EditorView, keymap, runScopeHandlers } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import {
  currentShortcutPlatform,
  eventKeyNames,
  eventShortcutKey,
  keyEventInit,
  matchShortcut,
  normalizeShortcutKey,
  parseShortcutOverrides,
  resolveShortcuts,
  shortcutAccelerator,
  shortcutLabel,
  validateShortcutKey,
  type Shortcut,
  type ShortcutId,
  type ShortcutKeyEvent,
  type ShortcutPlatform,
} from './shortcuts'

const PLATFORMS: ShortcutPlatform[] = ['mac', 'linux']

function press (key: string, keyCode: number, modifiers: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
  return { key, keyCode, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers }
}

// The action that a CodeMirror keymap with every key of `shortcuts` runs for
// this keydown. CodeMirror, like `eventKeyNames`, reads the host platform.
function codeMirrorShortcut (shortcuts: readonly Shortcut[], event: ShortcutKeyEvent): ShortcutId | null {
  const ran: ShortcutId[] = []
  const state = EditorState.create({
    extensions: keymap.of(shortcuts.flatMap((shortcut) => shortcut.keys.map((key) => ({
      key,
      run: () => {
        ran.push(shortcut.id)
        return true
      },
    })))),
  })
  const keydown = { ...event, preventDefault () {}, stopPropagation () {} } as unknown as KeyboardEvent
  runScopeHandlers({ state } as EditorView, keydown, 'editor')
  return ran[0] ?? null
}

// Cmd on a macOS host, Ctrl elsewhere.
const HOST_MOD: Partial<ShortcutKeyEvent> = currentShortcutPlatform === 'mac' ? { metaKey: true } : { ctrlKey: true }

describe('shortcut defaults', () => {
  it.each(PLATFORMS)('give every action its own valid key on %s, so Reset All always works', (platform) => {
    const shortcuts = resolveShortcuts(platform)
    const keys = shortcuts.flatMap((shortcut) => shortcut.keys)
    expect(new Set(keys).size).toBe(keys.length)
    for (const shortcut of shortcuts) {
      expect(validateShortcutKey(platform, shortcut.id, shortcut.defaultKey), shortcut.id).toBeNull()
    }
  })

  it('keep Select all and Quit on Linux only, with Super+A select-all and Ctrl+Y redo as Linux aliases', () => {
    const keysById = (platform: ShortcutPlatform) =>
      Object.fromEntries(resolveShortcuts(platform).map((shortcut) => [shortcut.id, shortcut.keys]))
    const linux = keysById('linux')
    const mac = keysById('mac')
    expect(linux.selectAll).toEqual(['Alt-a', 'Meta-a'])
    expect(linux.quit).toEqual(['Ctrl-q'])
    expect(linux.redo).toEqual(['Shift-Ctrl-z', 'Ctrl-y'])
    expect(mac.selectAll).toBeUndefined()
    expect(mac.quit).toBeUndefined()
    expect(mac.redo).toEqual(['Shift-Meta-z'])
  })
})

describe('normalizeShortcutKey', () => {
  it('resolves Mod per platform and puts the modifiers in CodeMirror order', () => {
    expect(normalizeShortcutKey('Mod-Shift-t', 'mac')).toBe('Shift-Meta-t')
    expect(normalizeShortcutKey('Mod-Shift-t', 'linux')).toBe('Shift-Ctrl-t')
    expect(normalizeShortcutKey('alt-ctrl-shift-cmd-k', 'linux')).toBe('Shift-Meta-Ctrl-Alt-k')
    expect(normalizeShortcutKey('Ctrl-Shift-ArrowUp', 'mac')).toBe('Shift-Ctrl-ArrowUp')
    expect(normalizeShortcutKey('Mod--', 'linux')).toBe('Ctrl--')
  })

  it('spells each key press one way', () => {
    expect(normalizeShortcutKey('Ctrl-A', 'linux')).toBe('Shift-Ctrl-a')
    expect(normalizeShortcutKey('Ctrl- ', 'linux')).toBe('Ctrl-Space')
    expect(normalizeShortcutKey('ctrl-space', 'linux')).toBe('Ctrl-Space')
    expect(normalizeShortcutKey('shift-enter', 'linux')).toBe('Shift-Enter')
    expect(normalizeShortcutKey('f5', 'linux')).toBe('F5')
  })

  it('rejects what is not a key name', () => {
    for (const name of ['', 'Ctrl-', 'Hyper-a', 'Ctrl-Unidentified', 'Ctrl-k Ctrl-s', 'Ctrl-foo', 'Ctrl-\t']) {
      expect(normalizeShortcutKey(name, 'linux'), name).toBeNull()
    }
  })
})

describe('key matching', () => {
  it('picks the action that CodeMirror picks for every default key', () => {
    const shortcuts = resolveShortcuts(currentShortcutPlatform)
    for (const shortcut of shortcuts) {
      for (const key of shortcut.keys) {
        const event = keyEventInit(key)
        expect(codeMirrorShortcut(shortcuts, event), key).toBe(shortcut.id)
        expect(matchShortcut(shortcuts, event)?.id, key).toBe(shortcut.id)
      }
    }
  })

  it.each<[string, ShortcutKeyEvent, ShortcutId | null]>([
    ['US Shift+= types +', press('+', 187, { ...HOST_MOD, shiftKey: true }), 'increaseFontSize'],
    ['German + key', press('+', 187, HOST_MOD), 'increaseFontSize'],
    ['Shift+[ types {', press('{', 219, { ...HOST_MOD, shiftKey: true }), 'previousTab'],
    ['Cyrillic layout, T key', press('е', 84, HOST_MOD), 'newTab'],
    ['T key with Shift', press('T', 84, { ...HOST_MOD, shiftKey: true }), 'reopenClosedTab'],
    ['T key', press('t', 84, HOST_MOD), 'newTab'],
    ['an extra modifier', press('1', 49, { ...HOST_MOD, altKey: true }), null],
    ['Ctrl+Shift+Up', press('ArrowUp', 38, { ctrlKey: true, shiftKey: true }), 'addCursorAbove'],
  ])('agrees with CodeMirror: %s', (_, event, expected) => {
    const shortcuts = resolveShortcuts(currentShortcutPlatform)
    expect(codeMirrorShortcut(shortcuts, event)).toBe(expected)
    expect(matchShortcut(shortcuts, event)?.id ?? null).toBe(expected)
  })

  it('follows a rebound key, and drops the aliases of the old key', () => {
    const platform = currentShortcutPlatform
    const shortcuts = resolveShortcuts(platform, { increaseFontSize: normalizeShortcutKey('Mod-i', platform) ?? '' })
    expect(matchShortcut(shortcuts, press('i', 73, HOST_MOD))?.id).toBe('increaseFontSize')
    expect(matchShortcut(shortcuts, press('=', 187, HOST_MOD))).toBeNull()
    expect(matchShortcut(shortcuts, press('+', 187, { ...HOST_MOD, shiftKey: true }))).toBeNull()
  })
})

describe('eventShortcutKey', () => {
  it.each<[string, ShortcutKeyEvent, string]>([
    ['Ctrl+Shift+A', press('A', 65, { ctrlKey: true, shiftKey: true }), 'Shift-Ctrl-a'],
    ['Ctrl+Shift+[', press('{', 219, { ctrlKey: true, shiftKey: true }), 'Shift-Ctrl-['],
    ['Ctrl+T on a Cyrillic layout', press('е', 84, { ctrlKey: true }), 'Ctrl-t'],
    ['Ctrl+Space', press(' ', 32, { ctrlKey: true }), 'Ctrl-Space'],
    ['Shift+Up', press('ArrowUp', 38, { shiftKey: true }), 'Shift-ArrowUp'],
    ['F5', press('F5', 116), 'F5'],
  ])('records %s as a key that the same press matches', (_, event, expected) => {
    expect(eventShortcutKey(event)).toBe(expected)
    expect(eventKeyNames(event)).toContain(expected)
  })

  it('waits for a key while only a modifier is down', () => {
    expect(eventShortcutKey(press('Control', 17, { ctrlKey: true }))).toBeNull()
    expect(eventShortcutKey(press('Shift', 16, { shiftKey: true }))).toBeNull()
  })
})

describe('validateShortcutKey', () => {
  it('needs Ctrl, Cmd, or Alt, except for F-keys, Shift with a non-text key, Esc for Stop, and arrows in the find field', () => {
    expect(validateShortcutKey('linux', 'closeTab', 'Ctrl-Control')).toBe('A modifier key alone is not a shortcut')
    expect(validateShortcutKey('linux', 'closeTab', 'Shift-k')).toBe('This key needs Ctrl, Alt, or Super')
    expect(validateShortcutKey('mac', 'closeTab', 'k')).toBe('This key needs ⌘, ⌥, or ⌃')
    expect(validateShortcutKey('linux', 'closeTab', 'Alt-k')).toBeNull()
    expect(validateShortcutKey('linux', 'closeTab', 'F5')).toBeNull()
    expect(validateShortcutKey('linux', 'closeTab', 'Shift-PageDown')).toBeNull()
    expect(validateShortcutKey('linux', 'closeTab', 'Shift-Space')).toBe('This key needs Ctrl, Alt, or Super')
    expect(validateShortcutKey('linux', 'closeTab', 'Escape')).toBe('This key needs Ctrl, Alt, or Super')
    expect(validateShortcutKey('linux', 'stop', 'Escape', { stop: 'Ctrl-.' })).toBeNull()
    expect(validateShortcutKey('linux', 'olderSearch', 'ArrowLeft')).toBeNull()
    expect(validateShortcutKey('linux', 'olderSearch', 'Home')).toBe('This key needs Ctrl, Alt, or Super')
    expect(validateShortcutKey('linux', 'closeTab', 'ArrowLeft')).toBe('This key needs Ctrl, Alt, or Super')
    expect(validateShortcutKey('linux', 'closeTab', 'Hyper-k')).toBe('Not a valid key')
    expect(validateShortcutKey('mac', 'selectAll', 'Alt-a')).toBe('Not available on this platform')
  })

  it('refuses the reserved keys of each platform', () => {
    expect(validateShortcutKey('linux', 'closeTab', 'Mod-c')).toBe('Reserved for Copy')
    expect(validateShortcutKey('linux', 'closeTab', 'Ctrl-a')).toBe('Reserved for moving to the line start')
    expect(validateShortcutKey('linux', 'closeTab', 'Ctrl-Shift-I')).toBe('Reserved for the developer console')
    expect(validateShortcutKey('linux', 'closeTab', 'Shift-Tab')).toBe('Reserved for moving the focus')
    expect(validateShortcutKey('mac', 'closeTab', 'Mod-q')).toBe('Reserved for Quit Dez')
    expect(validateShortcutKey('mac', 'history', 'Mod-h')).toBe('Reserved for Hide Dez')
    expect(validateShortcutKey('mac', 'closeTab', 'Cmd-Alt-i')).toBe('Reserved for the developer console')
    expect(validateShortcutKey('mac', 'closeTab', 'Ctrl-a')).toBeNull()
  })

  it('refuses a key or an active alias of another action', () => {
    expect(validateShortcutKey('linux', 'closeTab', 'Ctrl-t')).toBe('Used by New tab')
    expect(validateShortcutKey('linux', 'closeTab', 'Ctrl-+')).toBe('Used by Increase font size')
    expect(validateShortcutKey('linux', 'closeTab', 'Ctrl-+', { increaseFontSize: 'Ctrl-i' })).toBeNull()
    expect(validateShortcutKey('linux', 'closeTab', 'Ctrl-w')).toBeNull()
  })

  it('refuses a reset when another action now has the default key or alias', () => {
    expect(validateShortcutKey('linux', 'closeTab', 'Ctrl-w', { closeTab: 'Ctrl-k', newTab: 'Ctrl-w' }))
      .toBe('Used by New tab')
    expect(validateShortcutKey('linux', 'increaseFontSize', 'Ctrl-=', { increaseFontSize: 'Ctrl-i', newTab: 'Ctrl-+' }))
      .toBe('Used by New tab')
  })

  // On a US layout Ctrl+Shift+= has two key names, `Ctrl-+` and
  // `Shift-Ctrl-=`, and the press runs the action that has `Ctrl-+`.
  it('refuses a key whose press runs another action', () => {
    expect(validateShortcutKey('linux', 'newTab', 'Shift-Ctrl-=')).toBe('Used by Increase font size')
    expect(validateShortcutKey('mac', 'submit', 'Shift-Meta-=')).toBe('Used by Increase font size')
    expect(validateShortcutKey('linux', 'newTab', 'Shift-Ctrl-=', { increaseFontSize: 'Ctrl-i' })).toBeNull()
    expect(validateShortcutKey('linux', 'increaseFontSize', 'Ctrl-=', { increaseFontSize: 'Ctrl-i', newTab: 'Shift-Ctrl-=' }))
      .toBe('Used by New tab')
    expect(validateShortcutKey('linux', 'closeTab', 'Ctrl-+', { increaseFontSize: 'Ctrl-i', newTab: 'Shift-Ctrl-=' }))
      .toBe('Used by New tab')
  })
})

describe('parseShortcutOverrides', () => {
  it('keeps the normalized keys that the platform can use, and drops the rest', () => {
    expect(parseShortcutOverrides({
      closeTab: 'ctrl-K',
      newTab: 'Mod-t',
      bogus: 'Ctrl-j',
      history: 42,
      find: 'Hyper-f',
      saveAs: 'Ctrl-c',
      settings: 'k',
    }, 'linux')).toEqual({ closeTab: 'Shift-Ctrl-k' })
    expect(parseShortcutOverrides({ selectAll: 'Cmd-Shift-a', quit: 'Cmd-Alt-q', newTab: 'Mod-Alt-t' }, 'mac'))
      .toEqual({ newTab: 'Meta-Alt-t' })
    for (const value of [null, [], 'Ctrl-k', 7]) expect(parseShortcutOverrides(value, 'linux')).toEqual({})
  })

  it('keeps a key that another entry frees, in any order', () => {
    const swapped = { closeTab: 'Ctrl-t', newTab: 'Ctrl-w' }
    expect(parseShortcutOverrides(swapped, 'linux')).toEqual(swapped)
    expect(parseShortcutOverrides({ newTab: 'Ctrl-w', closeTab: 'Ctrl-t' }, 'linux')).toEqual(swapped)
    expect(parseShortcutOverrides({ newTab: 'Ctrl-+' }, 'linux')).toEqual({})
    expect(parseShortcutOverrides({ newTab: 'Ctrl-+', increaseFontSize: 'Ctrl-i' }, 'linux'))
      .toEqual({ newTab: 'Ctrl-+', increaseFontSize: 'Ctrl-i' })
  })

  it('drops clashing entries, and then the entries that clash with the defaults they bring back', () => {
    expect(parseShortcutOverrides({ closeTab: 'Ctrl-k', newTab: 'Ctrl-k', history: 'Ctrl-w', find: 'Alt-f' }, 'linux'))
      .toEqual({ find: 'Alt-f' })
  })

  it('drops a saved key whose press runs another action, and keeps the other entries', () => {
    expect(parseShortcutOverrides({ newTab: 'Shift-Ctrl-=', find: 'Alt-f' }, 'linux')).toEqual({ find: 'Alt-f' })
  })
})

describe('shortcutLabel', () => {
  it('uses Apple symbols and the ⌃⌥⇧⌘ order on macOS keycaps', () => {
    expect(shortcutLabel('Shift-Meta-Ctrl-Alt-z', 'mac')).toBe('⌃⌥⇧⌘Z')
    expect(shortcutLabel('Meta-Enter', 'mac')).toBe('⌘↩')
    expect(shortcutLabel('Escape', 'mac')).toBe('⎋')
    expect(shortcutLabel('Shift-Ctrl-ArrowUp', 'mac')).toBe('⌃⇧↑')
    expect(shortcutLabel('Meta-Backspace', 'mac')).toBe('⌘⌫')
    expect(shortcutLabel('Meta-Delete', 'mac')).toBe('⌘⌦')
  })

  it('spells out the modifiers in Ctrl+Alt+Shift+Super order on Linux keycaps', () => {
    expect(shortcutLabel('Shift-Meta-Ctrl-Alt-k', 'linux')).toBe('Ctrl+Alt+Shift+Super+K')
    expect(shortcutLabel('Ctrl-Enter', 'linux')).toBe('Ctrl+↩')
    expect(shortcutLabel('Escape', 'linux')).toBe('Esc')
    expect(shortcutLabel('Shift-Ctrl-ArrowDown', 'linux')).toBe('Ctrl+Shift+↓')
    expect(shortcutLabel('Shift-Ctrl-[', 'linux')).toBe('Ctrl+Shift+[')
  })

  it('uses words for titles and aria-labels', () => {
    expect(shortcutLabel('Meta-Enter', 'mac', 'text')).toBe('Cmd+Enter')
    expect(shortcutLabel('Shift-Meta-Ctrl-Alt-PageUp', 'mac', 'text')).toBe('Ctrl+Option+Shift+Cmd+Page Up')
    expect(shortcutLabel('Ctrl-Enter', 'linux', 'text')).toBe('Ctrl+Enter')
    expect(shortcutLabel('Escape', 'linux', 'text')).toBe('Esc')
    expect(shortcutLabel('Shift-Ctrl-ArrowUp', 'linux', 'text')).toBe('Ctrl+Shift+Up')
  })
})

describe('shortcutAccelerator', () => {
  it('gives Tauri accelerator names', () => {
    expect(shortcutAccelerator('Shift-Ctrl-t', 'linux')).toBe('Ctrl+Shift+T')
    expect(shortcutAccelerator('Meta-k', 'linux')).toBe('Super+K')
    expect(shortcutAccelerator('Shift-Meta-[', 'mac')).toBe('Shift+Cmd+[')
    expect(shortcutAccelerator('Shift-Ctrl-ArrowUp', 'linux')).toBe('Ctrl+Shift+Up')
    expect(shortcutAccelerator('Shift-Enter', 'linux')).toBe('Shift+Enter')
    expect(shortcutAccelerator('Ctrl-Space', 'linux')).toBe('Ctrl+Space')
    expect(shortcutAccelerator('Ctrl--', 'linux')).toBe('Ctrl+-')
    expect(shortcutAccelerator('F5', 'linux')).toBe('F5')
    expect(shortcutAccelerator('Ctrl-Escape', 'linux')).toBe('Ctrl+Escape')
  })

  it('gives none for a bare Esc or a key that Tauri cannot parse', () => {
    expect(shortcutAccelerator('Escape', 'linux')).toBeNull()
    expect(shortcutAccelerator('Ctrl-+', 'linux')).toBeNull()
    expect(shortcutAccelerator('Alt-å', 'mac')).toBeNull()
  })
})
