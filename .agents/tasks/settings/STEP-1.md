# Step 1: Install plugin-store and create settingsStore

Status: COMPLETED

## Sub tasks

1. [x] Install `@tauri-apps/plugin-store` npm package
2. [x] Create `src/stores/settingsStore.ts` with tauri-plugin-store persistence
3. [x] Verify type-check passes

## NOTES

- Store uses `load('settings.json', { defaults: {}, autoSave: true })` — the `defaults` field is required by StoreOptions type.
- Settings persisted as a single key `'settings'` in the store file.
- Theme application uses `data-theme` attribute on `<html>`, removes it for `system` mode.
- `showPillSeparators` lives here now (will migrate from threadStore in step 4).
