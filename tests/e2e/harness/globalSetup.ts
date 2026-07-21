import { resolveBinary } from './app'

// Resolve — and, with DEZ_E2E_BUILD=1, build — the app binary once before
// any spec runs. A cold `tauri build --debug --no-bundle` takes many
// minutes, far beyond the 120 s hookTimeout bounding every beforeAll, and
// Vitest fails a hook that exceeds its timeout even when the work
// succeeded (the blocked timer fires at the hook's next await, and the
// runner also re-checks elapsed wall-clock time on resolve). globalSetup
// runs in the main process outside any test/hook timeout, so the opt-in
// build path can complete here; specs then hit resolveBinary() in
// startApp() only as a cheap existence check. A missing binary without
// DEZ_E2E_BUILD also fails fast here with one clear error instead of
// failing per spec file.
export default function setup (): void {
  resolveBinary()
}
