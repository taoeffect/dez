import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startApp, type RunningApp } from './harness/app'
import { consoleErrors, pointerClick, pointerDrag, resetConsoleErrors, screenshotOnFailure, waitFor, waitForValue } from './harness/dom'
import { readAppState, seedAppState } from './harness/fixtures'
import { startMockProviderApp } from './harness/mockProviderApp'
import { replyText, sendChatReply, type HeldRequest, type HoldingChatMock, type MockProvider } from './harness/mockServer'
import { startNotificationServer, type NotificationServer, type ShownNotification } from './harness/notificationServer'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { focusedArea, sbpCall, submit, waitForThread } from './harness/thread'

// Settings › Notifications: the reply-done sound with its volume slider, and
// the system notification setting. Then the alerts at the end of a reply
// that the user does not look at. The seeded app state has both alerts off
// (`quietAppState` in harness/fixtures.ts), so the spec starts from "off".
//
// The page records each `play()` of a media element and mutes the element
// first (`recordSoundPlays`): the sound still decodes and plays to its end in
// WebKitGTK, but makes no noise on the developer's desktop. A play that fails
// is logged with console.error, which fails the test.

interface SectionState {
  sound: boolean
  volume: number
  volumeDisabled: boolean
  volumeLabel: string
  notification: boolean
}

// Volumes in percent: WebKit keeps a media element's volume as a float, so
// 0.3 reads back as 0.30000001192092896.
interface SoundState {
  /** The volume at each `play()` call since `recordSoundPlays`. */
  plays: number[]
  /** The volume of the last element that played, or null before a play. */
  volume: number | null
  paused: boolean | null
}

async function recordSoundPlays (browser: E2EBrowser): Promise<void> {
  await browser.execute(() => {
    Reflect.set(window, '__e2eSoundPlays', [])
    if (Reflect.get(window, '__e2ePlayWrapped')) return
    Reflect.set(window, '__e2ePlayWrapped', true)
    const originalPlay = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      this.muted = true
      ;(Reflect.get(window, '__e2eSoundPlays') as number[]).push(Math.round(this.volume * 100))
      Reflect.set(window, '__e2eSound', this)
      return originalPlay.call(this)
    }
  })
}

async function soundState (browser: E2EBrowser): Promise<SoundState> {
  return browser.execute(() => {
    const sound = Reflect.get(window, '__e2eSound') as HTMLMediaElement | undefined
    return {
      plays: Reflect.get(window, '__e2eSoundPlays') as number[],
      volume: sound ? Math.round(sound.volume * 100) : null,
      paused: sound?.paused ?? null,
    }
  })
}

async function waitForSoundEnd (browser: E2EBrowser): Promise<void> {
  await waitForValue(browser, 'sound paused', async () => (await soundState(browser)).paused, true)
}

describe('Settings › Notifications', () => {
  let app: RunningApp
  let browser: E2EBrowser
  // The volume that the slider drag chose, for the relaunch check.
  let draggedVolume = 0

  async function openNotifications (): Promise<void> {
    await sbpCall(browser, 'dez.model/settings/open')
    await waitFor(browser, '.settings-nav')
    const found = await browser.execute(() => {
      const button = Array.from(document.querySelectorAll<HTMLElement>('.settings-nav-btn'))
        .find((b) => b.textContent?.trim() === 'Notifications')
      button?.click()
      return button !== undefined
    })
    expect(found).toBe(true)
    await waitFor(browser, '.done-sound-checkbox', 10_000)
  }

  async function sectionState (): Promise<SectionState> {
    return browser.execute(() => {
      const input = (selector: string): HTMLInputElement => {
        const el = document.querySelector<HTMLInputElement>(selector)
        if (!el) throw new Error(`sectionState: element not found: ${selector}`)
        return el
      }
      return {
        sound: input('.done-sound-checkbox').checked,
        volume: Number(input('.done-sound-volume').value),
        volumeDisabled: input('.done-sound-volume').disabled,
        volumeLabel: document.querySelector('.done-sound-volume-value')?.textContent?.trim() ?? '',
        notification: input('.done-notification-checkbox').checked,
      }
    })
  }

  async function savedAlerts (): Promise<{ doneSound?: boolean, doneSoundVolume?: number, doneNotification?: boolean } | null> {
    const state = await readAppState(app.home)
    if (!state) return null
    const { doneSound, doneSoundVolume, doneNotification } = state
    return { doneSound, doneSoundVolume, doneNotification }
  }

  /** Drag the volume slider from its middle to `fraction` of its width. */
  async function dragVolumeTo (fraction: number): Promise<void> {
    const toX = await browser.execute((f: number) => {
      const rect = document.querySelector('.done-sound-volume')!.getBoundingClientRect()
      return Math.round(rect.left + rect.width * f)
    }, fraction)
    await pointerDrag(browser, '.done-sound-volume', toX)
  }

  beforeAll(async () => {
    app = await startApp()
    try {
      await seedAppState(app.home)
      browser = await createSession(app.binary, app.port)
    } catch (err) {
      await app.stop()
      throw err
    }
    await waitFor(browser, 'header.tab-bar', 60_000)
  })

  beforeEach(async () => {
    await resetConsoleErrors(browser)
    await recordSoundPlays(browser)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    if (ctx.task.result?.state === 'fail') return
    expect(await consoleErrors(browser)).toEqual([])
  })

  afterAll(async () => {
    await destroySession(browser)
    await app?.stop()
  })

  // A guard for CI: without Git LFS the checkout has the LFS pointer text in
  // place of src/assets/sounds/ding.mp3, and Vite inlines that with no build
  // error. Without an MP3 decoder (GStreamer's mpg123audiodec, in
  // gst-plugins-good) the real file does not load either. Both give a media
  // error 4 (MEDIA_ERR_SRC_NOT_SUPPORTED) here.
  it('bundles a playable done sound of about 1 s', async () => {
    await sbpCall(browser, 'dez.ui/playDoneSound', 50)
    const loadState = async (): Promise<string> => browser.execute(() => {
      const sound = Reflect.get(window, '__e2eSound') as HTMLMediaElement | undefined
      if (!sound) return 'no play() call'
      if (sound.error) return `media error ${sound.error.code}`
      return sound.readyState >= HTMLMediaElement.HAVE_METADATA ? 'metadata loaded' : 'loading'
    })
    await waitForValue(browser, 'done sound load state', loadState, 'metadata loaded')

    const duration = await browser.execute(() => (Reflect.get(window, '__e2eSound') as HTMLMediaElement).duration)
    expect(duration).toBeGreaterThan(0.9)
    expect(duration).toBeLessThan(1.2)
    await waitForSoundEnd(browser)
  })

  it('disables the volume slider while the sound is off', async () => {
    await openNotifications()
    expect(await sectionState()).toEqual({
      sound: false,
      volume: 50,
      volumeDisabled: true,
      volumeLabel: '50%',
      notification: false,
    })

    await dragVolumeTo(0.9)
    expect((await sectionState()).volume).toBe(50)
    expect((await soundState(browser)).plays).toEqual([])
  })

  it('enables the slider with the sound checkbox, and plays the sound at the volume a drag sets', async () => {
    await pointerClick(browser, '.done-sound-checkbox')
    await waitForValue(browser, 'slider disabled', async () => (await sectionState()).volumeDisabled, false)

    await dragVolumeTo(0.9)
    const state = await sectionState()
    draggedVolume = state.volume
    expect(draggedVolume).toBeGreaterThan(70)
    expect(state.volumeLabel).toBe(`${draggedVolume}%`)
    expect((await soundState(browser)).plays.length).toBeGreaterThan(0)
    // Right after quick volume changes, WebKitGTK can read an older volume
    // for a moment (0.89 after a drag that ended at 94%), so wait for the
    // last one.
    await waitForValue(browser, 'sound volume', async () => (await soundState(browser)).volume, draggedVolume)
    await waitForValue(browser, 'saved alerts', savedAlerts, {
      doneSound: true,
      doneSoundVolume: draggedVolume,
      doneNotification: false,
    })
  })

  it('plays one sound at a time: a call while it plays only changes its volume', async () => {
    await waitForSoundEnd(browser)
    await recordSoundPlays(browser)

    await browser.execute(() => {
      const sbp = Reflect.get(window, 'sbp') as (selector: string, ...args: unknown[]) => unknown
      sbp('dez.ui/playDoneSound', 30)
      sbp('dez.ui/playDoneSound', 70)
    })
    const afterTwoCalls = await soundState(browser)
    expect(afterTwoCalls.plays).toEqual([30])
    expect(afterTwoCalls.paused).toBe(false)
    await waitForValue(browser, 'sound volume', async () => (await soundState(browser)).volume, 70)

    await waitForSoundEnd(browser)
    await sbpCall(browser, 'dez.ui/playDoneSound', 40)
    const afterEnd = await soundState(browser)
    expect(afterEnd.plays).toEqual([30, 40])
    expect(afterEnd.paused).toBe(false)
  })

  it('turns the system notification on with its checkbox', async () => {
    await pointerClick(browser, '.done-notification-checkbox')
    await waitForValue(browser, 'notification checkbox', async () => (await sectionState()).notification, true)
    await waitForValue(browser, 'saved alerts', savedAlerts, {
      doneSound: true,
      doneSoundVolume: draggedVolume,
      doneNotification: true,
    })
  })

  it('keeps the settings after a relaunch', async () => {
    await destroySession(browser)
    browser = await createSession(app.binary, app.port)
    await waitFor(browser, 'header.tab-bar', 60_000)
    // A new page: the records that beforeEach started are gone.
    await resetConsoleErrors(browser)
    await openNotifications()
    expect(await sectionState()).toEqual({
      sound: true,
      volume: draggedVolume,
      volumeDisabled: false,
      volumeLabel: `${draggedVolume}%`,
      notification: true,
    })
  })
})

// The sound and the system notification at the end of a reply. The app's
// session bus is a private bus with a fake notification server on it
// (harness/notificationServer.py), which records each notification and
// sends the click.
describe('reply-end alerts', () => {
  const PROVIDER: MockProvider = { id: 'alerts', name: 'Alerts Mock', modelId: 'alerts-model', modelName: 'Alerts Model' }
  const VOLUME = 40
  let browser: E2EBrowser
  let mock: HoldingChatMock
  let stopApp: (() => Promise<void>) | undefined
  let server: NotificationServer | undefined
  // The notifications from before the test.
  let shownBefore = 0

  function newNotifications (): ShownNotification[] {
    return (server as NotificationServer).notifications.slice(shownBefore)
  }

  async function waitForNotifications (expected: Omit<ShownNotification, 'id'>[]): Promise<ShownNotification[]> {
    await waitForValue(browser, 'notifications', async () => newNotifications().map(({ id: _id, ...rest }) => rest), expected)
    return newNotifications()
  }

  // Calls `plugin:window|is_focused` for the main window; the capability
  // file allows it.
  async function windowIsFocused (): Promise<boolean> {
    return await browser.execute(async () => {
      const internals = Reflect.get(window, '__TAURI_INTERNALS__') as {
        invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>
      }
      return internals.invoke('plugin:window|is_focused', { label: 'main' })
    }) === true
  }

  async function activeTabId (): Promise<string> {
    return await sbpCall(browser, 'dez.model/tabs/activeId') as string
  }

  // Sends `question` in a new tab, opens another tab, and returns the first
  // tab's id and the reply's request.
  async function askInBackgroundTab (question: string): Promise<{ tabId: string, request: HeldRequest }> {
    const tabId = await activeTabId()
    await submit(browser, question)
    const request = await mock.waitForRequest(browser)
    await sbpCall(browser, 'dez.model/tabs/create')
    return { tabId, request }
  }

  beforeAll(async () => {
    server = await startNotificationServer()
    ;({ browser, mock, stop: stopApp } = await startMockProviderApp(PROVIDER, {}, { env: server.env }))
    await sbpCall(browser, 'dez.model/settings/setDoneSound', true)
    await sbpCall(browser, 'dez.model/settings/setDoneSoundVolume', VOLUME)
    await sbpCall(browser, 'dez.model/settings/setDoneNotification', true)
  })

  beforeEach(async () => {
    // A new tab gets the last used model, which startMockProviderApp picked.
    await sbpCall(browser, 'dez.model/tabs/create')
    await resetConsoleErrors(browser)
    await recordSoundPlays(browser)
    shownBefore = server?.notifications.length ?? 0
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    await mock.dropOpenReplies(browser)
    if (ctx.task.result?.state === 'fail') return
    expect(await consoleErrors(browser)).toEqual([])
  })

  afterAll(async () => {
    await stopApp?.()
    await server?.stop()
  })

  it('plays the sound and shows a notification when a reply ends in a background tab', async () => {
    const { request } = await askInBackgroundTab('Background question')

    await sendChatReply(request.reply, 'the background')

    await waitForValue(browser, 'sound plays', async () => (await soundState(browser)).plays, [VOLUME])
    await waitForNotifications([{ appName: 'Dez', summary: 'Background question', body: 'Reply finished', actions: ['default', 'Open'] }])
  })

  it('a click on the notification closes Settings, opens the tab, and focuses the editor', async () => {
    const { tabId, request } = await askInBackgroundTab('Click question')
    await sbpCall(browser, 'dez.model/settings/open')
    await sendChatReply(request.reply, 'the click')
    const [notification] = await waitForNotifications([{ appName: 'Dez', summary: 'Click question', body: 'Reply finished', actions: ['default', 'Open'] }])

    server?.click(notification.id)

    await waitForValue(browser, 'active tab', activeTabId, tabId)
    expect(await sbpCall(browser, 'dez.model/settings/isOpen')).toBe(false)
    await waitForValue(browser, 'focused area', async () => focusedArea(browser), 'editor')
  })

  it('gives no alert when a reply ends in the active tab of the focused window', async () => {
    expect(await windowIsFocused()).toBe(true)
    // A sound that still plays takes no new play() (dez.ui/playDoneSound), so
    // a wrong alert would not show.
    await waitForValue(browser, 'no sound playing', async () => (await soundState(browser)).paused !== false, true)
    await submit(browser, 'Foreground question')
    const request = await mock.waitForRequest(browser)

    await sendChatReply(request.reply, 'the foreground')

    await waitForThread(browser, [
      { role: 'user', text: 'Foreground question' },
      { role: 'agent', text: replyText('the foreground') },
      { role: 'user', text: '' },
    ])
    // The alert reads the window focus first, an IPC call. Give a wrong
    // alert time to start.
    await browser.pause(500)
    expect((await soundState(browser)).plays).toEqual([])
    expect(newNotifications()).toEqual([])
  })

  // The fake server sends no activation token, so Dez asks for the focus
  // with `gtk_window_present`, which headless KWin grants. A real session's
  // click comes with a token (a manual check).
  it('a click on the notification brings the minimized window back', async (ctx) => {
    const { request } = await askInBackgroundTab('Minimized question')
    await browser.minimizeWindow()
    try {
      const lostFocus = await browser.waitUntil(async () => !await windowIsFocused(), { timeout: 3_000, interval: 50 }).catch(() => false)
      // Xvfb in CI has no window manager, so a minimize does nothing there.
      if (!lostFocus) {
        ctx.skip('The minimize needs a window manager, such as headless KWin')
        return
      }
      await sendChatReply(request.reply, 'the minimized window')
      const [notification] = await waitForNotifications([{ appName: 'Dez', summary: 'Minimized question', body: 'Reply finished', actions: ['default', 'Open'] }])

      server?.click(notification.id)

      await waitForValue(browser, 'window focused', windowIsFocused, true)
    } finally {
      // On Wayland a screenshot of a minimized window never returns, and
      // afterEach takes one after a failure. `set_focus` does not restore a
      // minimized window there, but WebDriver Set Window Rect does.
      if (!await windowIsFocused()) {
        const { x, y, width, height } = await browser.getWindowRect()
        await browser.setWindowRect(x, y, width, height)
      }
    }
  })
})
