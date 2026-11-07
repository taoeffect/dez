import { spawn } from 'node:child_process'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'notificationServer.py')

/** One `Notify` call that the server got. */
export interface ShownNotification {
  id: number
  appName: string
  summary: string
  body: string
  actions: string[]
}

export interface NotificationServer {
  /** Give it to `startApp`: the app's session bus is then the private bus. */
  env: Record<string, string>
  /** Every notification so far, oldest first. */
  readonly notifications: readonly ShownNotification[]
  /** The user clicks the notification body. With `activationToken`, the
   *  server first sends it as the `ActivationToken` signal. */
  click: (id: number, activationToken?: string) => void
  /** Stops the server and its bus. */
  stop: () => Promise<void>
}

/**
 * Starts the fake desktop notification server (`notificationServer.py`) on
 * a private D-Bus bus. Needs `python3-gi` and `dbus-daemon`. The system
 * python runs it: PyGObject is a distro package, not a pip package in a
 * virtualenv.
 */
export async function startNotificationServer (): Promise<NotificationServer> {
  const server = spawn('/usr/bin/python3', [script], { stdio: ['pipe', 'pipe', 'pipe'] })
  const notifications: ShownNotification[] = []
  let stderr = ''
  server.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  // `'close'`, not `'exit'`: at `'exit'` the stderr pipe can still hold the
  // traceback that the start error below shows.
  const exited = new Promise<void>((resolve) => server.once('close', () => resolve()))

  const address = await new Promise<string>((resolve, reject) => {
    const lines = readline.createInterface({ input: server.stdout })
    lines.on('line', (line) => {
      const event = JSON.parse(line) as { event: string, address?: string } & ShownNotification
      if (event.event === 'ready') resolve(event.address as string)
      else if (event.event === 'notify') {
        const { id, appName, summary, body, actions } = event
        notifications.push({ id, appName, summary, body, actions })
      }
    })
    server.once('error', reject)
    void exited.then(() => reject(new Error(`notificationServer.py exited before it was ready:\n${stderr}`)))
  })

  return {
    env: {
      DBUS_SESSION_BUS_ADDRESS: address,
      // The GTK accessibility bridge asks the session bus for at-spi, which
      // the private bus does not have.
      NO_AT_BRIDGE: '1',
    },
    notifications,
    click (id, activationToken) {
      server.stdin.write(['click', id, activationToken].filter((part) => part !== undefined).join(' ') + '\n')
    },
    // An end of stdin stops the script, and the script stops the bus.
    async stop () {
      if (server.exitCode !== null || server.signalCode !== null) return
      server.stdin.end()
      const stopped = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
      ])
      // The bus gets SIGTERM when the script dies (PR_SET_PDEATHSIG).
      if (!stopped) server.kill('SIGKILL')
    },
  }
}
