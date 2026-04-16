# Settings Task — Plan

## Overview

Create a settings system with a Pinia store backed by `tauri-plugin-store` for persistence, and a `SettingsView.vue` rendered as a modal overlay. Settings changes are reactive and take effect immediately.

## Architecture Decisions

- **Persistence**: Use `tauri-plugin-store` (already configured in Rust). Install `@tauri-apps/plugin-store` JS package.
- **Settings UI**: Modal overlay (not a new tab type) — simpler, avoids tab system complexity before step 8.
- **Store**: New `src/stores/settingsStore.ts` Pinia store that loads/saves to tauri-plugin-store.
- **Theme**: Add `data-theme` attribute on `<html>` element. Support `light`, `dark`, `system`. Replace media query approach with explicit class-based theming.

## Sections

### Providers
- List all providers (from `get_configured_providers` command)
- For each: show name, configured status, input to set API key
- Default model selector per provider (from `list_models`)

### Appearance
- Toggle pill separators (move from threadStore to settingsStore)
- Theme selector: light / dark / system

### General
- Default model for new tabs (provider + model ID)
- Keyboard shortcut reference (read-only table)

## Data Shape

```ts
interface Settings {
  // Providers — API keys stored via set_api_key command, not in settings store
  defaultModels: Record<string, string>  // providerId -> modelId

  // Appearance
  showPillSeparators: boolean
  theme: 'light' | 'dark' | 'system'

  // General
  defaultNewTabModel: { providerId: string; modelId: string } | null
}
```

## File Changes

1. Install `@tauri-apps/plugin-store`
2. Create `src/stores/settingsStore.ts` — Pinia store with tauri-plugin-store persistence
3. Create `src/components/SettingsView.vue` — Modal with three sections
4. Update `src/components/AppLayout.vue` — Add settings button, render modal
5. Update `src/App.vue` — Theme application via `data-theme` attribute
6. Update `src/stores/threadStore.ts` — Remove `showPillSeparators` (moved to settingsStore)
7. Update `src/components/ThreadEditor.vue` — Read `showPillSeparators` from settingsStore
