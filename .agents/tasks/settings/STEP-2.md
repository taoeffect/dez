# Step 2: Create SettingsView.vue modal

Status: COMPLETED

## Sub tasks

1. [x] Create `src/components/SettingsView.vue` with three sections (Providers, Appearance, General)
2. [x] Providers section: list providers, API key input, default model selector per provider
3. [x] Appearance section: theme toggle (system/light/dark), pill separator toggle
4. [x] General section: default new-tab model selector, keyboard shortcut reference table
5. [x] Verify type-check passes

## NOTES

- Modal uses overlay pattern with click-outside-to-close.
- Providers are fetched via `invoke('get_configured_providers')` on mount.
- Models loaded for configured providers; default model per provider stored in settingsStore.
- Theme uses button group (not dropdown) for quick switching.
- Pill separators use a toggle switch component.
- Shortcut table is read-only.
