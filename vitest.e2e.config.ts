import { defineConfig } from "vitest/config";

// E2E specs drive the real Tauri app over WebDriver; they live outside
// `src/` and use the `*.e2e.ts` suffix so the default unit-test include
// pattern (`**/*.{test,spec}.*`) never collects them.
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.e2e.ts"],
    // Binary resolution (and the opt-in DEZ_E2E_BUILD=1 build) happens in
    // globalSetup: a cold debug tauri build takes minutes and would trip
    // hookTimeout if run inside a spec's beforeAll.
    globalSetup: ["tests/e2e/harness/globalSetup.ts"],
    // Launching the real app takes tens of seconds; unit-scale timeouts
    // would kill specs mid-launch.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: "forks",
    // One app instance per tauri-driver port/HOME at a time: parallel files
    // would fight over the driver session. false forces maxWorkers to 1.
    fileParallelism: false,
  },
});
