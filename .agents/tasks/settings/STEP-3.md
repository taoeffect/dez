# Step 3: Integrate settings into AppLayout

Status: COMPLETED

## Sub tasks

1. [x] Add settings button (gear icon) to tab-bar-actions in AppLayout
2. [x] Render `<SettingsView>` conditionally when `settingsStore.settingsOpen`
3. [x] Switch pill separator toggle in AppLayout from threadStore to settingsStore
4. [x] Remove unused threadStore import from AppLayout
5. [x] Init settingsStore in App.vue onMounted
6. [x] Update App.vue CSS: support `data-theme="dark"` and `data-theme="light"` alongside system media query
7. [x] Add Cmd/Ctrl+, shortcut to toggle settings, Escape to close
8. [x] Verify type-check passes

## NOTES

- Theme CSS logic: `data-theme="dark"` forces dark; `data-theme="light"` forces light; no attribute = system (media query applies but excluded when `data-theme="light"` is set).
- Keyboard shortcuts updated in `useKeyboardShortcuts.ts` — now imports settingsStore.
