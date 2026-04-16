# Settings Task — Current Design

## Relevant Codebase

### Frontend

- **`src/App.vue`** — Root component, renders `AppLayout`. Defines CSS custom properties for theming (light default, dark via `prefers-color-scheme` media query). Variables: `--color-bg`, `--color-text`, `--color-tab-bar`, `--color-border`.
- **`src/components/AppLayout.vue`** — Main layout with tab bar (actions: toggle pill separators) and `<ThreadEditor />` in main content area.
- **`src/stores/threadStore.ts`** — Pinia store. Has `showPillSeparators` ref and `togglePillSeparators()`. No settings persistence.
- **`src/types/chat.ts`** — `Role` ('user' | 'agent'), `Section` (id, role, content).

### Backend (Rust)

- **`src-tauri/src/lib.rs`** — Registers `tauri_plugin_store`, `tauri_plugin_opener`, manages `Mutex<ProviderRegistry>`, registers commands: `get_configured_providers`, `list_models`, `set_api_key`.
- **`src-tauri/src/commands.rs`** — Three commands for provider management (get list, list models, set API key).
- **`src-tauri/src/providers/mod.rs`** — `LlmProvider` trait, `ProviderRegistry` (holds Vec of boxed providers), `ProviderInfo`, `ModelInfo`, `ProviderError`.
- **`src-tauri/capabilities/default.json`** — Permissions: `core:default`, `opener:default`, `store:default`.

### Key Observations

1. `tauri-plugin-store` is already added in Cargo.toml, registered in lib.rs, and has capability permissions — ready for use.
2. No `@tauri-apps/plugin-store` JS package installed yet — needs `npm install`.
3. Theme is currently CSS-only via `prefers-color-scheme` media query — no manual toggle.
4. `showPillSeparators` lives in threadStore but is not persisted.
5. No settings store or settings UI exists yet.
