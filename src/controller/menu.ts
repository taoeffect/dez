import sbp from '@sbp/sbp'
import { hide } from '@tauri-apps/api/app'
import { isTauri } from '@tauri-apps/api/core'
import { Image } from '@tauri-apps/api/image'
import { Menu, Submenu, type MenuItemOptions, type PredefinedMenuItemOptions } from '@tauri-apps/api/menu'
import { getCurrentWindow } from '@tauri-apps/api/window'
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

let menuInstalled = false

export default sbp('sbp/selectors/register', {
  // The native menubar, with an item for every app shortcut. Each item calls
  // the same selector as its key handler (`useKeyboardShortcuts.ts` or an
  // editor keymap through `dez.editor/runKeyBinding`), so a key does the
  // same thing whichever path gets it: on Linux a menu accelerator takes the
  // key before the page sees it; on macOS the page sees it first and the
  // menu gets only keys that the page did not handle.
  //
  // Platform differences:
  // - Linux skips the predefined Undo, Redo, Hide, Quit, … items (muda), so
  //   they are custom items there. Select All is a custom Alt+A item,
  //   because Ctrl+A moves to the line start in the Linux editor.
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
    const settings: MenuItemOptions = {
      text: 'Settings…',
      accelerator: 'CmdOrCtrl+,',
      action: () => sbp('dez.model/settings/toggle'),
    }
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
              { text: 'New Conversation', accelerator: 'CmdOrCtrl+N', action: () => sbp('dez.model/tabs/create') },
              { text: 'New Tab', accelerator: 'CmdOrCtrl+T', action: () => sbp('dez.model/tabs/create') },
              SEPARATOR,
              {
                text: 'Save As Markdown…',
                accelerator: 'CmdOrCtrl+S',
                action: () => void sbp('dez.controller/saveConversationAs', sbp('dez.model/tabs/activeId')),
              },
              SEPARATOR,
              {
                text: 'Close Tab',
                accelerator: 'CmdOrCtrl+W',
                action: () => void sbp('dez.controller/closeTab', sbp('dez.model/tabs/activeId')),
              },
              // Closing the last window exits, as the window close button does.
              ...(isMacPlatform
                ? []
                : [SEPARATOR, {
                    text: 'Quit',
                    accelerator: 'Ctrl+Q',
                    action: () => {
                      getCurrentWindow().close().catch((error) => console.error('Failed to close the window:', error))
                    },
                  }]),
            ],
          },
          {
            text: 'Edit',
            items: [
              ...(isMacPlatform
                ? [{ item: 'Undo' }, { item: 'Redo' }] satisfies PredefinedMenuItemOptions[]
                : [
                    { text: 'Undo', accelerator: 'Ctrl+Z', action: () => sbp('dez.editor/runKeyBinding', 'Mod-z', 'undo') },
                    { text: 'Redo', accelerator: 'Ctrl+Shift+Z', action: () => sbp('dez.editor/runKeyBinding', 'Mod-Shift-z', 'redo') },
                  ]),
              SEPARATOR,
              { item: 'Cut' },
              { item: 'Copy' },
              { text: 'Copy Markdown', accelerator: 'CmdOrCtrl+Shift+C', action: () => sbp('dez.editor/copyMarkdown') },
              { item: 'Paste' },
              isMacPlatform
                ? { item: 'SelectAll' }
                : { text: 'Select All', accelerator: 'Alt+A', action: () => sbp('dez.editor/runKeyBinding', 'Alt-a', 'selectAll') },
              SEPARATOR,
              { text: 'Find…', accelerator: 'CmdOrCtrl+F', action: () => sbp('dez.editor/openFind') },
              { text: 'Find Next', accelerator: 'CmdOrCtrl+G', action: () => sbp('dez.editor/selectFindMatch', 'next') },
              { text: 'Find Previous', accelerator: 'CmdOrCtrl+Shift+G', action: () => sbp('dez.editor/selectFindMatch', 'previous') },
              ...(isMacPlatform ? [] : [SEPARATOR, settings]),
            ],
          },
          {
            text: 'Conversation',
            items: [
              { text: 'Send', accelerator: 'CmdOrCtrl+Enter', action: () => sbp('dez.editor/runKeyBinding', 'Mod-Enter') },
              {
                text: 'New Message',
                accelerator: 'Shift+Enter',
                action: () => sbp('dez.editor/runKeyBinding', 'Shift-Enter', 'insertLineBreak'),
              },
              SEPARATOR,
              {
                text: 'Add Cursor Above',
                accelerator: 'Ctrl+Shift+Up',
                action: () => sbp('dez.editor/runKeyBinding', 'Ctrl-Shift-ArrowUp', 'none'),
              },
              {
                text: 'Add Cursor Below',
                accelerator: 'Ctrl+Shift+Down',
                action: () => sbp('dez.editor/runKeyBinding', 'Ctrl-Shift-ArrowDown', 'none'),
              },
            ],
          },
          {
            text: 'View',
            items: [
              { text: 'History', accelerator: 'CmdOrCtrl+H', action: () => sbp('dez.model/settings/historyToggle') },
            ],
          },
          {
            text: 'Window',
            items: [
              ...(isMacPlatform ? [{ item: 'Minimize' }, { item: 'Maximize', text: 'Zoom' }, SEPARATOR] satisfies PredefinedMenuItemOptions[] : []),
              { text: 'Previous Tab', accelerator: 'CmdOrCtrl+Shift+[', action: () => sbp('dez.model/tabs/cycle', -1) },
              { text: 'Next Tab', accelerator: 'CmdOrCtrl+Shift+]', action: () => sbp('dez.model/tabs/cycle', 1) },
              SEPARATOR,
              ...Array.from({ length: 9 }, (_, index): MenuItemOptions => ({
                text: `Tab ${index + 1}`,
                accelerator: `CmdOrCtrl+${index + 1}`,
                action: () => sbp('dez.model/tabs/switchToIndex', index),
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
