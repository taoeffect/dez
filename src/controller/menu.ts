import sbp from '@sbp/sbp'
import { hide } from '@tauri-apps/api/app'
import { isTauri } from '@tauri-apps/api/core'
import { Image } from '@tauri-apps/api/image'
import { Menu, Submenu, type MenuItemOptions, type PredefinedMenuItemOptions } from '@tauri-apps/api/menu'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { currentShortcutPlatform, findShortcut, resolveShortcuts, shortcutAccelerator, type Shortcut, type ShortcutId } from '../model/shortcuts'
import { isMacPlatform } from '../utils/platform'
import { DEZ_REPO_URL } from './updates'
import dezIconUrl from '../../src-tauri/icons/128x128.png'

const SEPARATOR: PredefinedMenuItemOptions = { item: 'Separator' }

// The GTK About dialog (muda) shows a "missing image" icon unless the About
// metadata has an icon. Tauri decodes PNG bytes only with its `image-png`
// Cargo feature, which Dez does not enable, so the webview decodes the
// bundle icon and passes raw RGBA. 128 px is the usual GTK About logo size.
async function loadAboutIcon (): Promise<Image> {
  const img = document.createElement('img')
  img.src = dezIconUrl
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('No 2D canvas context')
  context.drawImage(img, 0, 0)
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
  // Tauri IPC sends a `Uint8Array` as bytes, but not a `Uint8ClampedArray`.
  return Image.new(new Uint8Array(data.buffer), canvas.width, canvas.height)
}

// A menu item that runs an editable shortcut, with the shortcut's key as its
// accelerator. A key that a menu cannot take gets none (see
// `shortcutAccelerator`): bare Esc, for example, stops the stream on the
// page, but on Linux GTK would take it before the page, so Esc could no
// longer close find, the dropdowns or the modals.
function shortcutMenuItem (shortcuts: readonly Shortcut[], id: ShortcutId, item: Omit<MenuItemOptions, 'accelerator'>): MenuItemOptions {
  const accelerator = shortcutAccelerator(findShortcut(shortcuts, id).key, currentShortcutPlatform)
  return accelerator ? { ...item, accelerator } : item
}

let menuInstalled = false

export default sbp('sbp/selectors/register', {
  // The native menubar, with an item for every app shortcut. Each item calls
  // the same selector as its key handler (`useKeyboardShortcuts.ts` or an
  // editor keymap through `dez.editor/runKeyBinding`), so a key does the
  // same thing whichever path gets it: on Linux a menu accelerator takes the
  // key before the page sees it; on macOS the page sees it first and the
  // menu gets only keys that the page did not handle (not yet tested on a
  // Mac). The keys come from `src/model/shortcuts.ts`; a new shortcut also
  // needs a row in Settings › General (`shortcuts` in SettingsView.vue).
  //
  // Platform differences:
  // - Undo and Redo are custom items, because predefined items have fixed
  //   keys, and Linux skips the predefined Undo, Redo, Hide, Quit, … items
  //   (muda). Select All is a custom Alt+A item on Linux, because Ctrl+A
  //   moves to the line start in the Linux editor.
  // - On Linux the predefined Cut/Copy/Paste only show their keys, and the
  //   keys reach the page as before. Clicking them does nothing, because
  //   that needs Tauri's `linux-libxdo` feature, which works on X11 only.
  // - macOS has a fixed Cmd+H on the predefined Hide, which Dez uses for
  //   History, so "Hide Dez" is a custom item without a key.
  // - GTK never matches Shift+[ / Shift+] (the key arrives as `{` / `}`),
  //   so on Linux the page handles Previous/Next Tab keys.
  async 'dez.controller/menu/install' (): Promise<void> {
    // `npm run dev` runs in a plain browser, which has no native menu.
    if (menuInstalled || !isTauri()) return
    menuInstalled = true
    const shortcuts = resolveShortcuts(currentShortcutPlatform)
    const settings = shortcutMenuItem(shortcuts, 'settings', {
      text: 'Settings…',
      action: () => sbp('dez.model/settings/toggle'),
    })
    const checkForUpdates: MenuItemOptions = {
      text: 'Check for Updates…',
      action: () => void sbp('dez.controller/checkForUpdates'),
    }
    // macOS gets no icon: AppKit's About panel shows the app icon by itself.
    const aboutIcon = isMacPlatform
      ? undefined
      : await loadAboutIcon().catch((error: unknown) => {
        console.error('Failed to load the About Dez icon:', error)
        return undefined
      })
    const about: PredefinedMenuItemOptions = {
      text: 'About Dez',
      item: {
        About: {
          name: 'Dez',
          version: __APP_VERSION__,
          website: DEZ_REPO_URL,
          websiteLabel: 'Dez on GitHub',
          icon: aboutIcon,
        },
      },
    }

    try {
      const help = await Submenu.new({
        text: 'Help',
        items: [
          { text: 'Keyboard Shortcuts', action: () => sbp('dez.model/settings/open', 'general') },
          { text: 'Dez on GitHub', action: () => sbp('dez.controller/openUrl', DEZ_REPO_URL) },
          SEPARATOR,
          {
            text: 'Developer Console',
            action: () => {
              sbp('dez.native/openDevtools').catch((error: unknown) => console.error('Failed to open the developer console:', error))
            },
          },
          ...(isMacPlatform ? [] : [SEPARATOR, checkForUpdates, about]),
        ],
      })
      const menu = await Menu.new({
        items: [
          ...(isMacPlatform
            ? [{
                text: 'Dez',
                items: [
                  about,
                  checkForUpdates,
                  SEPARATOR,
                  settings,
                  SEPARATOR,
                  { item: 'Services' },
                  SEPARATOR,
                  {
                    text: 'Hide Dez',
                    action: () => {
                      hide().catch((error) => console.error('Failed to hide Dez:', error))
                    },
                  },
                  { item: 'HideOthers' },
                  { item: 'ShowAll' },
                  SEPARATOR,
                  { item: 'Quit', text: 'Quit Dez' },
                ] satisfies Array<MenuItemOptions | PredefinedMenuItemOptions>,
              }]
            : []),
          {
            text: 'File',
            items: [
              shortcutMenuItem(shortcuts, 'newConversation', { text: 'New Conversation', action: () => sbp('dez.model/tabs/create') }),
              shortcutMenuItem(shortcuts, 'newTab', { text: 'New Tab', action: () => sbp('dez.model/tabs/create') }),
              shortcutMenuItem(shortcuts, 'reopenClosedTab', { text: 'Reopen Closed Tab', action: () => sbp('dez.model/tabs/reopenClosed') }),
              SEPARATOR,
              shortcutMenuItem(shortcuts, 'saveAs', {
                text: 'Save As Markdown…',
                action: () => void sbp('dez.controller/saveConversationAs', sbp('dez.model/tabs/activeId')),
              }),
              SEPARATOR,
              shortcutMenuItem(shortcuts, 'closeTab', {
                text: 'Close Tab',
                action: () => void sbp('dez.controller/closeTab', sbp('dez.model/tabs/activeId')),
              }),
              // Closing the last window exits, as the window close button does.
              ...(isMacPlatform
                ? []
                : [SEPARATOR, shortcutMenuItem(shortcuts, 'quit', {
                    text: 'Quit',
                    action: () => {
                      getCurrentWindow().close().catch((error) => console.error('Failed to close the window:', error))
                    },
                  })]),
            ],
          },
          {
            text: 'Edit',
            items: [
              shortcutMenuItem(shortcuts, 'undo', { text: 'Undo', action: () => sbp('dez.editor/runKeyBinding', 'undo', 'undo') }),
              shortcutMenuItem(shortcuts, 'redo', { text: 'Redo', action: () => sbp('dez.editor/runKeyBinding', 'redo', 'redo') }),
              SEPARATOR,
              { item: 'Cut' },
              { item: 'Copy' },
              shortcutMenuItem(shortcuts, 'copyMarkdown', { text: 'Copy Markdown', action: () => sbp('dez.editor/copyMarkdown') }),
              { item: 'Paste' },
              isMacPlatform
                ? { item: 'SelectAll' }
                : shortcutMenuItem(shortcuts, 'selectAll', {
                    text: 'Select All',
                    action: () => sbp('dez.editor/runKeyBinding', 'selectAll', 'selectAll'),
                  }),
              SEPARATOR,
              shortcutMenuItem(shortcuts, 'find', { text: 'Find…', action: () => sbp('dez.editor/openFind') }),
              shortcutMenuItem(shortcuts, 'findNext', { text: 'Find Next', action: () => sbp('dez.editor/selectFindMatch', 'next') }),
              shortcutMenuItem(shortcuts, 'findPrevious', { text: 'Find Previous', action: () => sbp('dez.editor/selectFindMatch', 'previous') }),
              ...(isMacPlatform ? [] : [SEPARATOR, settings]),
            ],
          },
          {
            text: 'Conversation',
            items: [
              shortcutMenuItem(shortcuts, 'submit', { text: 'Send', action: () => sbp('dez.editor/runKeyBinding', 'submit') }),
              shortcutMenuItem(shortcuts, 'stop', { text: 'Stop', action: () => sbp('dez.stream/stop', sbp('dez.model/tabs/activeId')) }),
              shortcutMenuItem(shortcuts, 'newMessage', {
                text: 'New Message',
                action: () => sbp('dez.editor/runKeyBinding', 'newMessage', 'insertLineBreak'),
              }),
              SEPARATOR,
              shortcutMenuItem(shortcuts, 'addCursorAbove', {
                text: 'Add Cursor Above',
                action: () => sbp('dez.editor/runKeyBinding', 'addCursorAbove', 'none'),
              }),
              shortcutMenuItem(shortcuts, 'addCursorBelow', {
                text: 'Add Cursor Below',
                action: () => sbp('dez.editor/runKeyBinding', 'addCursorBelow', 'none'),
              }),
            ],
          },
          {
            text: 'View',
            items: [
              shortcutMenuItem(shortcuts, 'history', { text: 'History', action: () => sbp('dez.model/settings/historyToggle') }),
              SEPARATOR,
              shortcutMenuItem(shortcuts, 'increaseFontSize', {
                text: 'Increase Font Size',
                action: () => sbp('dez.model/settings/changeEditorFontSize', 1),
              }),
              shortcutMenuItem(shortcuts, 'decreaseFontSize', {
                text: 'Decrease Font Size',
                action: () => sbp('dez.model/settings/changeEditorFontSize', -1),
              }),
            ],
          },
          {
            text: 'Window',
            items: [
              ...(isMacPlatform ? [{ item: 'Minimize' }, { item: 'Maximize', text: 'Zoom' }, SEPARATOR] satisfies PredefinedMenuItemOptions[] : []),
              shortcutMenuItem(shortcuts, 'previousTab', { text: 'Previous Tab', action: () => sbp('dez.model/tabs/cycle', -1) }),
              shortcutMenuItem(shortcuts, 'nextTab', { text: 'Next Tab', action: () => sbp('dez.model/tabs/cycle', 1) }),
              SEPARATOR,
              ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((n) => shortcutMenuItem(shortcuts, `goToTab${n}`, {
                text: `Tab ${n}`,
                action: () => sbp('dez.model/tabs/switchToIndex', n - 1),
              })),
            ],
          },
          help,
        ],
      })
      await menu.setAsAppMenu()
      // Tauri 2.10.3's `set_as_windows_menu_for_nsapp` command sets the help
      // menu instead (menu/plugin.rs), so the Window menu is not registered.
      if (isMacPlatform) await help.setAsHelpMenuForNSApp()
    } catch (error) {
      menuInstalled = false
      console.error('Failed to install the app menu:', error)
    }
  },
})
