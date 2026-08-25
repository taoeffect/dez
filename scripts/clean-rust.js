import { spawnSync } from 'node:child_process';

// Best-effort cleanup of old Rust build artifacts in src-tauri/target so the
// directory does not grow unboundedly across months of debug builds.
// cargo-sweep is an optional dev tool: without it, builds still work and we
// simply skip the cleanup instead of failing.
const probe = spawnSync('cargo', ['sweep', '--version'], { stdio: 'ignore' });

if (probe.error || probe.status !== 0) {
  console.log('cargo-sweep not installed; skipping Rust artifact cleanup.');
  console.log('Optional, keeps src-tauri/target small: cargo install cargo-sweep');
  process.exit(0);
}

const result = spawnSync('cargo', ['sweep', '-t', '14', 'src-tauri'], { stdio: 'inherit' });

if (result.error || result.status !== 0) {
  // Cleanup must never block a build; surface the failure and continue.
  console.error('cargo sweep failed; continuing without Rust artifact cleanup.');
}
