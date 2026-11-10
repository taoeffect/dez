import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// tests/e2e/harness/app.ts -> repo root is three levels up.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

export interface RunningApp {
  /** Per-run temp HOME; the app reads/writes $HOME/.config/dez only. */
  home: string
  /** Absolute path of the app binary under test. */
  binary: string
  /** tauri-driver port; point webdriverio at 127.0.0.1:<port>. */
  port: number
  /** Kill the driver process group (driver -> WebKitWebDriver -> app) and
   * remove the temp HOME. Safe to call after deleteSession. */
  stop: () => Promise<void>
}

/**
 * Locate the app binary for tests. Precedence:
 * 1. `DEZ_E2E_BINARY` env override (absolute or cwd-relative path).
 * 2. `src-tauri/target/debug/dez` if it exists. It is used as is, even when
 *    it is older than the source: after source changes, rebuild it with
 *    `npm run tauri build -- --debug --no-bundle`, or the suite tests stale
 *    code.
 * 3. Build it with `npm run tauri build -- --debug --no-bundle` when
 *    `DEZ_E2E_BUILD=1` (opt-in because the build is slow).
 *
 * The binary must be the self-contained `tauri build --debug --no-bundle`
 * output (frontend embedded). A plain `cargo build` binary uses devUrl and
 * would require a Vite server on port 1420, which e2e does not manage. So
 * does the binary of `npm run tauri dev`, which writes this same path: after
 * a `tauri dev` run every spec fails with "the app window did not show
 * within 60 s" until the binary is rebuilt.
 */
export function resolveBinary (): string {
  const override = process.env.DEZ_E2E_BINARY
  if (override) {
    const resolved = path.resolve(override)
    if (!fs.existsSync(resolved)) {
      throw new Error(`DEZ_E2E_BINARY points at a missing file: ${resolved}`)
    }
    return resolved
  }

  const defaultBinary = path.join(repoRoot, 'src-tauri/target/debug/dez')
  if (fs.existsSync(defaultBinary)) return defaultBinary

  if (process.env.DEZ_E2E_BUILD === '1') {
    console.log('[e2e] debug binary missing; building (npm run tauri build -- --debug --no-bundle)...')
    const result = spawnSync(
      'npm',
      ['run', 'tauri', 'build', '--', '--debug', '--no-bundle'],
      { cwd: repoRoot, stdio: 'inherit' }
    )
    if (result.status !== 0) {
      throw new Error('DEZ_E2E_BUILD=1 but `npm run tauri build -- --debug --no-bundle` failed')
    }
    if (!fs.existsSync(defaultBinary)) {
      throw new Error(`tauri build succeeded but ${defaultBinary} is still missing`)
    }
    return defaultBinary
  }

  throw new Error(
    `Dez debug binary not found at ${defaultBinary}.\n` +
    'Build it with `npm run tauri build -- --debug --no-bundle`, ' +
    'or set DEZ_E2E_BUILD=1 to let the harness build it, ' +
    'or point DEZ_E2E_BINARY at an existing binary.'
  )
}

/** Ask the kernel for a free TCP port on loopback. */
async function findFreePort (): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address == null || typeof address === 'string') {
        server.close()
        reject(new Error('failed to obtain a free port'))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

/** Poll until something accepts TCP connections on 127.0.0.1:port. */
async function waitForPort (port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host: '127.0.0.1' })
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => { socket.destroy(); resolve(false) })
    })
    if (open) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`tauri-driver did not open port ${port} within ${timeoutMs}ms`)
}

/**
 * SIGTERM the driver's whole process group, escalating to SIGKILL.
 * tauri-driver is spawned detached so it leads its own group containing
 * itself, the WebKitWebDriver it spawns, and the app under test; killing
 * the group prevents orphaned app windows surviving teardown.
 */
async function killProcessGroup (child: ChildProcess): Promise<void> {
  if (child.pid == null) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    return // group already gone
  }
  // If the leader already exited, 'exit' has already fired and won't fire
  // again — skip the race and fall straight through to the SIGKILL
  // escalation, which is a harmless no-op on an empty group.
  const exited = child.exitCode !== null || await Promise.race([
    new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000))
  ])
  if (!exited) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // group exited between the race and the escalation; fine
    }
  }
}

export interface AppOptions {
  /** Extra variables for the driver and the app it launches. */
  env?: Record<string, string>
}

/**
 * Start tauri-driver wired to a fully isolated app instance:
 * - fresh temp HOME so the app's ~/.config/dez data can never touch the
 *   real user profile (Rust derives the config dir from $HOME);
 * - XDG_CONFIG_HOME set to the temp HOME's `.config` too: GLib and GTK read
 *   it before $HOME/.config, and GitHub's Ubuntu runners set it to the
 *   runner's own ~/.config, so GTK settings seeded in the temp HOME would be
 *   ignored and GLib would write into the runner's profile;
 * - XDG_CACHE_HOME set to the temp HOME's `.cache`, for the same reason: the
 *   app keeps the temp copies of clips in `<cache>/dez/media`, and deletes
 *   the old ones there when it starts, so a run must never get the real
 *   cache folder;
 * - TAURI_WEBVIEW_AUTOMATION=true inherited down the spawn chain
 *   (tauri-driver -> WebKitWebDriver -> app) to enable wry's automation
 *   session — without it, new-session requests hang forever;
 * - unique free ports for both the proxy and the native driver so runs
 *   never collide with a stray driver or with each other;
 * - `options.env`: extra variables for the driver and the app it launches.
 */
export async function startApp (options: AppOptions = {}): Promise<RunningApp> {
  const binary = resolveBinary()
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dez-e2e-'))
  const port = await findFreePort()
  let nativePort = await findFreePort()
  // The kernel may re-issue the just-released port; the two listeners must differ.
  while (nativePort === port) nativePort = await findFreePort()

  const args = ['--port', String(port), '--native-port', String(nativePort)]
  // CI may install WebKitWebDriver somewhere not on tauri-driver's search path;
  // allow pinning the native driver explicitly.
  if (process.env.DEZ_E2E_NATIVE_DRIVER) {
    args.push('--native-driver', process.env.DEZ_E2E_NATIVE_DRIVER)
  }

  const driver = spawn('tauri-driver', args, {
    cwd: repoRoot,
    detached: true,
    env: {
      ...process.env,
      ...options.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_CACHE_HOME: path.join(home, '.cache'),
      TAURI_WEBVIEW_AUTOMATION: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  // Keep recent driver output around so startup failures are diagnosable.
  // Capped at ~64 KB so a chatty driver can't grow this without bound.
  const MAX_DRIVER_OUTPUT = 64 * 1024
  let driverOutput = ''
  const appendDriverOutput = (chunk: Buffer): void => {
    driverOutput += chunk.toString()
    if (driverOutput.length > MAX_DRIVER_OUTPUT) {
      driverOutput = driverOutput.slice(-MAX_DRIVER_OUTPUT)
    }
  }
  driver.stdout?.on('data', appendDriverOutput)
  driver.stderr?.on('data', appendDriverOutput)

  const cleanup = async (): Promise<void> => {
    await killProcessGroup(driver)
    await fs.promises.rm(home, { recursive: true, force: true })
  }

  try {
    await waitForPort(port)
  } catch (err) {
    await cleanup()
    console.error('[e2e] tauri-driver failed to start; driver output:\n' + driverOutput)
    throw err
  }

  return {
    home,
    binary,
    port,
    stop: cleanup
  }
}
