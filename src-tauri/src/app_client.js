// Dez's client script of the page of an app. The scheme of the app frames
// serves it as `~dez.js` in the folder of each app (app_frames.rs), and a
// page loads it before its own scripts: `<script src="~dez.js"></script>`.
// It is the half of the frame messages (src/view/apps/appFrame.ts) that
// runs in the frame. A frame takes its keys and its clicks for itself: none
// of them reaches Dez's page. So this script tells Dez of the key and of
// the click that are for Dez, and runs the edit commands that Dez's menu
// took from the page.
//
// Each message is an object whose `dez` field is its type. The page of an
// app has no origin (the sandbox), so a post has the target `*`, and each
// side trusts a message only by its `source`.
(() => {
  'use strict'
  const host = window.parent
  // A page that is in no frame (a new window of the webview).
  if (host === window) return

  // Escape gives the keyboard back to Dez, unless the page took the key
  // for itself with `preventDefault`, or the key ends an IME composition.
  // This listener runs before those of the page (the capture phase of the
  // window), and its timer reads the event after all of them ran.
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing) return
    setTimeout(() => {
      if (!event.defaultPrevented) host.postMessage({ dez: 'escape' }, '*')
    })
  }, true)

  // A context click shows Dez's menu of the app in place of the menu of the
  // webview, whose items are for a web page (Reload would end the app).
  // The page keeps the click when it cancels the event, for a menu of its
  // own. The webview keeps its menu where it has a use: in a text field and
  // on selected text (copy, paste).
  const showDezMenu = (event) => {
    if (event.defaultPrevented || !(event.target instanceof Element)) return
    const inTextField = event.target.isContentEditable || event.target.closest('input, textarea, select') !== null
    if (inTextField || !window.getSelection().isCollapsed) return
    event.preventDefault()
    host.postMessage({ dez: 'menu' }, '*')
  }
  // `showDezMenu` must run after every listener of the page, to read
  // whether one of them canceled the event. The listeners of one target run
  // in the order in which they were added, so this capture listener, the
  // first one of each click, puts `showDezMenu` at the end of the bubble
  // listeners of the window again.
  window.addEventListener('contextmenu', () => {
    window.removeEventListener('contextmenu', showDezMenu)
    window.addEventListener('contextmenu', showDezMenu)
  }, true)

  // On Linux the menu of Dez takes the keys of its items before a page
  // sees them (Undo, Redo, Select All, a line break). Dez sends such a
  // command to the app that has the keyboard, and it runs where the focus
  // is in this page, as the key would. `execCommand` is deprecated, but it
  // is the only way for a script to run the edit commands of a text field
  // (its undo history, a line break).
  const EDIT_COMMANDS = ['undo', 'redo', 'selectAll', 'insertLineBreak']
  window.addEventListener('message', (event) => {
    const message = event.data
    if (event.source !== host || message === null || typeof message !== 'object') return
    if (message.dez === 'edit' && EDIT_COMMANDS.includes(message.command)) document.execCommand(message.command)
  })
})()
