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

// The volume of each sound that played.
let soundPlays: number[] = []
let playDoneSound: (volumePercent: number) => void
let consoleError: MockInstance<typeof console.error>

sbp('sbp/selectors/register', {
  'dez.ui/playDoneSound' (volumePercent: number): void {
    playDoneSound(volumePercent)
  },
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

async function alertReplyEnded(tabId: string): Promise<void> {
  await sbp('dez.controller/alertReplyEnded', tabId)
}

beforeEach(() => {
  setActivePinia(createPinia())
  soundPlays = []
  playDoneSound = (volumePercent) => soundPlays.push(volumePercent)
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

  it('plays nothing for a reply that ends in the active tab of the focused window', async () => {
    await alertReplyEnded(activeTabId())

    expect(soundPlays).toEqual([])
  })

  it('plays the sound for a reply that ends in the active tab while another window has focus', async () => {
    appWindow.isFocused = async () => false

    await alertReplyEnded(activeTabId())

    expect(soundPlays).toEqual([50])
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
  })

  it('logs a sound that fails, and does not throw', async () => {
    playDoneSound = () => {
      throw new Error('no audio device')
    }

    await expect(alertReplyEnded(backgroundTabId())).resolves.toBeUndefined()
    expect(consoleError).toHaveBeenCalled()
  })
})
