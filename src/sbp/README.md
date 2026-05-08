# SBP boundaries

`src/sbp/` is the frontend application API. Vue components and Pinia stores should call selectors for cross-cutting app behavior instead of reaching into native APIs, provider transports, or low-level persistence details directly.

Import the live SBP function only from the package:

```ts
import sbp from '@sbp/sbp'
```

Import `src/sbp` once during application startup so selector modules register themselves.

## Selector domains

| Domain | File | Responsibility |
| --- | --- | --- |
| `dez.controller/*` | `controller.ts` | User-facing workflows and view actions: tab actions, settings actions, submit/stop, provider settings, Copilot sign-in, and update checking. Components should prefer this domain for multi-step UI actions. |
| `dez.model/*` | `model.ts` | Snapshot reads and focused store-backed model mutations. Return cloned data when exposing mutable store state. |
| `dez.stream/*` | `stream.ts` | Stream lifecycle orchestration across provider streaming, HTTP cancellation, editor updates, and stream store state. |
| `dez.editor/*` | `editor.ts` | Active CodeMirror view bridge, visible-editor token patching, scroll-follow behavior, and editor stream-finished events. |
| `dez.provider/*` | `provider.ts` | Provider metadata, configured provider status, model listing, provider request construction, secrets retrieval, Copilot chat-token refresh, and provider stream parsing. |
| `dez.http/*` | `http.ts` | Native HTTP request/stream bridge, byte-stream assembly, stream cancellation, and Tauri Channel ownership. |
| `dez.persistence/*` | `persistence.ts` | TypeScript persistence parsing/serialization and raw file routing for conversations, app state, and prompts. |
| `dez.native/*` | `native.ts` | The only frontend layer that calls Tauri `invoke()` directly. Keep command names and raw IPC payload shape here. |
| `dez.ui/*` | `ui.ts` | UI services that are useful across the app, such as toasts and opening external URLs. |
| `dez.diagnostics/*` | `diagnostics.ts` | Development/support diagnostics. This may cross provider/native/http boundaries for probes, but output must be sanitized and it should not become a normal component/store dependency. |

## Boundary rules

- Components should call `dez.controller/*` for workflows and view actions, `dez.ui/*` for UI services, and high-level data domains only when they need direct data reads.
- Stores should not import Tauri APIs, call `invoke()`, perform runtime `fetch()`, or know raw native command names.
- `invoke()` belongs only in `src/sbp/native.ts`.
- Native HTTP transport details belong behind `dez.http/*`; provider modules should call `dez.http/*`, not Tauri commands directly.
- Provider endpoint URLs and provider-specific request/response mapping belong under `src/core/providers/**` and provider service selectors.
- Persistence format parsing and serialization belongs in `src/core/persistence/**`; raw file command routing belongs behind `dez.persistence/*` and `dez.native/*`.
- Update version comparison belongs in portable core code under `src/core/update/**`; update-check lifecycle belongs behind controller selectors.
- Do not add automatic global selector logging without a deliberate redaction policy. Selector payloads can include provider secrets, Copilot tokens, HTTP payloads, conversation contents, prompt contents, and streamed tokens.

## Selector implementation style

Register selector behavior directly in the selector function body:

```ts
export default sbp('sbp/selectors/register', {
  'dez.example/doThing' (id: string): void {
    // behavior lives here
  },
})
```

Avoid selectors that only delegate to same-file helper functions with the same parameters. Module-level constants, module state, types, and reusable pure/core helpers are fine, but selectors should be readable as the boundary behavior they implement.

Avoid wrapper selectors that only rename another selector with identical parameters. A controller or core selector should add meaningful boundary behavior such as orchestration, normalization, error handling, state refresh, lifecycle management, cloning, or validation.

## Expected grep exceptions

- `@tauri-apps/api/core` and `invoke(` should appear in `src/sbp/native.ts`; `src/sbp/http.ts` may import Tauri `Channel` for the native streaming bridge.
- Runtime `fetch(` should not appear in app call sites; type members or core protocol conversion helpers may mention fetch-shaped data.
- `https://` is expected in provider endpoint constants under `src/core/providers/**`, SVG/XML namespace attributes, and data URLs in markup/styles.
- `dez.native/*` calls are expected inside service/boundary selectors such as provider, persistence, HTTP, controller workflows, and diagnostics, but not in components or stores.
- Diagnostic selectors may access provider secrets only through secret wrappers and must sanitize output before printing or returning errors.
