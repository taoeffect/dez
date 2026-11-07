import sbp from '@sbp/sbp'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
// Side-effect imports: register the dez.model/* selectors and the selector
// under test.
import '../model/state/index'
import './notifications'

// The Dez window as the alert rule sees it. Set by each test.
const appWindow = vi.hoisted(() => ({ isFocused: async (): Promise<boolean> => true }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => appWindow }))
// The real Channel registers its callback with the Tauri webview.
vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    onmessage: (message: null) => void = () => {}
  },
}))

interface ShownNotification {
  title: string
  body: string
  onClick: { onmessage: (message: null) => void }
}

// What the editor focus call saw: it does nothing while a panel is open.
interface EditorFocus {
  activeTabId: string
  panelOpen: boolean
}

// The volume of each sound that played.
let soundPlays: number[] = []
let playDoneSound: (volumePercent: number) => void
let notifications: ShownNotification[] = []
let showNotification: (notification: ShownNotification) => Promise<void>
// The user idle time that the alert rule reads, in ms (null: unknown).
let userIdleMs: () => Promise<number | null>
let editorFocuses: EditorFocus[] = []
let consoleError: MockInstance<typeof console.error>

sbp('sbp/selectors/register', {
  'dez.ui/playDoneSound' (volumePercent: number): void {
    playDoneSound(volumePercent)
  },
  'dez.native/showNotification' (title: string, body: string, onClick: ShownNotification['onClick']): Promise<void> {
    return showNotification({ title, body, onClick })
  },
  'dez.native/userIdleMs' (): Promise<number | null> {
    return userIdleMs()
  },
  'dez.editor/focus' (): boolean {
    editorFocuses.push({
      activeTabId: activeTabId(),
      panelOpen: (sbp('dez.model/settings/isOpen') as boolean) || (sbp('dez.model/settings/isHistoryOpen') as boolean),
    })
    return true
  },
  // A closed empty tab deletes its conversation file.
  async 'dez.persistence/deleteConversation' (): Promise<void> {},
})

function activeTabId(): string {
  return sbp('dez.model/tabs/activeId') as string
}

// A tab whose reply ends while another tab is active.
function backgroundTabId(): string {
  const tabId = activeTabId()
  sbp('dez.model/tabs/create')
  return tabId
}

async function alertReplyEnded(tabId: string, status: 'finished' | 'error' = 'finished'): Promise<void> {
  await sbp('dez.controller/alertReplyEnded', tabId, status)
}

function clickNotification(): void {
  expect(notifications).toHaveLength(1)
  notifications[0].onClick.onmessage(null)
}

beforeEach(() => {
  setActivePinia(createPinia())
  soundPlays = []
  playDoneSound = (volumePercent) => soundPlays.push(volumePercent)
  notifications = []
  showNotification = async (notification) => {
    notifications.push(notification)
  }
  userIdleMs = async () => 0
  editorFocuses = []
  appWindow.isFocused = async () => true
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleError.mockRestore()
})

describe('dez.controller/alertReplyEnded', () => {
  it('plays the sound at the set volume for a reply that ends in a background tab', async () => {
    sbp('dez.model/settings/setDoneSoundVolume', 30)

    await alertReplyEnded(backgroundTabId())

    expect(soundPlays).toEqual([30])
  })

  it('gives no alert for a reply that ends in the active tab of the focused window while the user is not away', async () => {
    await alertReplyEnded(activeTabId())

    expect(soundPlays).toEqual([])
    expect(notifications).toEqual([])
  })

  it('plays the sound and shows a notification for a reply that ends in the active tab while another window has focus', async () => {
    appWindow.isFocused = async () => false

    await alertReplyEnded(activeTabId())

    expect(soundPlays).toEqual([50])
    expect(notifications).toHaveLength(1)
  })

  it('plays the sound and shows a notification for a reply that ends in the active tab after more than 1 minute with no user input', async () => {
    userIdleMs = async () => 60_001

    await alertReplyEnded(activeTabId())

    expect(soundPlays).toEqual([50])
    expect(notifications).toHaveLength(1)
  })

  // On a desktop with no idle source an "away" guess would alert for each
  // reply.
  it.each([
    { idleMs: 60_000, label: 'exactly 1 minute' },
    { idleMs: null, label: 'unknown' },
  ])('gives no alert for a reply that ends in the active tab of the focused window when the idle time is $label', async ({ idleMs }) => {
    userIdleMs = async () => idleMs

    await alertReplyEnded(activeTabId())

    expect(soundPlays).toEqual([])
    expect(notifications).toEqual([])
  })

  it('counts a failed idle time read as "not away", and logs it', async () => {
    userIdleMs = async () => {
      throw new Error('no idle source')
    }

    await alertReplyEnded(activeTabId())

    expect(soundPlays).toEqual([])
    expect(notifications).toEqual([])
    expect(consoleError).toHaveBeenCalled()
  })

  it('counts a failed focus read as "not focused"', async () => {
    appWindow.isFocused = async () => {
      throw new Error('window gone')
    }

    await alertReplyEnded(activeTabId())

    expect(soundPlays).toEqual([50])
    expect(consoleError).toHaveBeenCalled()
  })

  // The user can switch to the tab while the focus read runs; the reply
  // still ended where the user did not look.
  it('uses the active tab at the end of the reply, not after the focus read', async () => {
    const tabId = backgroundTabId()
    appWindow.isFocused = async () => {
      sbp('dez.model/tabs/switch', tabId)
      return true
    }

    await alertReplyEnded(tabId)

    expect(soundPlays).toEqual([50])
  })

  it('plays nothing while the sound is off', async () => {
    sbp('dez.model/settings/setDoneSound', false)

    await alertReplyEnded(backgroundTabId())

    expect(soundPlays).toEqual([])
    expect(notifications).toHaveLength(1)
  })

  // The sound and the notification fail on their own.
  it('logs a sound that fails, shows the notification, and does not throw', async () => {
    playDoneSound = () => {
      throw new Error('no audio device')
    }

    await expect(alertReplyEnded(backgroundTabId())).resolves.toBeUndefined()
    expect(consoleError).toHaveBeenCalled()
    expect(notifications).toHaveLength(1)
  })

  it.each([
    { status: 'finished', body: 'Reply finished' },
    { status: 'error', body: 'Reply failed' },
  ] as const)('shows a notification with the tab title and "$body" for a $status reply', async ({ status, body }) => {
    const tabId = backgroundTabId()
    sbp('dez.model/tabs/replaceSections', tabId, [{ id: 'u1', role: 'user', content: [{ kind: 'text', text: 'Plan the trip' }] }])

    await alertReplyEnded(tabId, status)

    expect(notifications.map(({ title, body }) => ({ title, body }))).toEqual([{ title: 'Plan the trip', body }])
  })

  it('shows no notification while the notification setting is off', async () => {
    sbp('dez.model/settings/setDoneNotification', false)

    await alertReplyEnded(backgroundTabId())

    expect(notifications).toEqual([])
    expect(soundPlays).toEqual([50])
  })

  // Both reads are native calls; with no alert on, nothing uses them.
  it('reads neither the window focus nor the idle time while both alerts are off', async () => {
    sbp('dez.model/settings/setDoneSound', false)
    sbp('dez.model/settings/setDoneNotification', false)
    let nativeReads = 0
    appWindow.isFocused = async () => {
      nativeReads++
      return true
    }
    userIdleMs = async () => {
      nativeReads++
      return 0
    }

    await alertReplyEnded(activeTabId())

    expect(nativeReads).toBe(0)
  })

  it('shows no notification for a tab that closed before the reply end', async () => {
    const tabId = backgroundTabId()
    sbp('dez.model/tabs/close', tabId)

    await alertReplyEnded(tabId)

    expect(notifications).toEqual([])
  })

  it('logs a notification that fails, and does not throw', async () => {
    showNotification = async () => {
      throw new Error('no notification server')
    }

    await expect(alertReplyEnded(backgroundTabId())).resolves.toBeUndefined()
    expect(consoleError).toHaveBeenCalled()
    expect(soundPlays).toEqual([50])
  })

  // The editor takes no focus while a panel covers it.
  it.each(['dez.model/settings/open', 'dez.model/settings/historyOpen'])('a click closes the panel of %s, opens the tab, and then focuses the editor', async (openPanel) => {
    const tabId = backgroundTabId()
    await alertReplyEnded(tabId)
    sbp(openPanel)

    clickNotification()

    expect(activeTabId()).toBe(tabId)
    expect(sbp('dez.model/settings/isOpen')).toBe(false)
    expect(sbp('dez.model/settings/isHistoryOpen')).toBe(false)
    expect(editorFocuses).toEqual([{ activeTabId: tabId, panelOpen: false }])
  })

  it('a click after the tab closed changes nothing', async () => {
    const tabId = backgroundTabId()
    await alertReplyEnded(tabId)
    const otherTabId = activeTabId()
    sbp('dez.model/tabs/close', tabId)
    sbp('dez.model/settings/open')

    clickNotification()

    expect(activeTabId()).toBe(otherTabId)
    expect(sbp('dez.model/settings/isOpen')).toBe(true)
    expect(editorFocuses).toEqual([])
  })
})
