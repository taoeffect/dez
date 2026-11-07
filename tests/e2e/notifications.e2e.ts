import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startApp, type RunningApp } from './harness/app'
import { consoleErrors, pointerClick, pointerDrag, pointerPress, pointerRelease, resetConsoleErrors, screenshotOnFailure, waitFor, waitForValue } from './harness/dom'
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
  /** The last volume that page code assigned to a media element, or null. */
  lastVolumeSet: number | null
  paused: boolean | null
}

// The spec checks the volume that Dez assigns, not the element's `volume`
// read-back. In WebKitGTK that read-back is the volume that the audio sink
// (PulseAudio) last reported, and the sink reports each change later and in
// its own time: right after quick changes it reads earlier values (a probe
// saw 50 just after a set of 53), and in 2 of 8 runs it stayed at an earlier
// drag value for more than 10 s.
async function recordSoundPlays (browser: E2EBrowser): Promise<void> {
  await browser.execute(() => {
    Reflect.set(window, '__e2eSoundPlays', [])
    Reflect.set(window, '__e2eVolumeSet', null)
    if (Reflect.get(window, '__e2ePlayWrapped')) return
    Reflect.set(window, '__e2ePlayWrapped', true)
    const originalPlay = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      this.muted = true
      ;(Reflect.get(window, '__e2eSoundPlays') as number[]).push(Math.round(this.volume * 100))
      Reflect.set(window, '__e2eSound', this)
      return originalPlay.call(this)
    }
    const volume = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume')!
    Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
      ...volume,
      set (this: HTMLMediaElement, value: number) {
        Reflect.set(window, '__e2eVolumeSet', Math.round(value * 100))
        volume.set!.call(this, value)
      },
    })
  })
}

async function soundState (browser: E2EBrowser): Promise<SoundState> {
  return browser.execute(() => {
    const sound = Reflect.get(window, '__e2eSound') as HTMLMediaElement | undefined
    return {
      plays: Reflect.get(window, '__e2eSoundPlays') as number[],
      lastVolumeSet: Reflect.get(window, '__e2eVolumeSet') as number | null,
      paused: sound?.paused ?? null,
    }
  })
}

async function waitForSoundEnd (browser: E2EBrowser): Promise<void> {
  await waitForValue(browser, 'sound paused', async () => (await soundState(browser)).paused, true)
}

// The alert rule reads the user idle time from the OS (src-tauri/src/idle.rs),
// and WebDriver input does not reset it, so the real reading passes 1 minute
// during a run. The page cannot replace Tauri's `invoke` (a read-only
// property), but on Linux Tauri sends each command as a `fetch` of
// `ipc://localhost/<command>` (scripts/ipc-protocol.js in the tauri crate),
// and `window.fetch` can be wrapped. The wrapper answers `user_idle_ms` with
// `idleMs` (null: no idle source), as Tauri does, and counts the reads.
async function setUserIdleMs (browser: E2EBrowser, idleMs: number | null): Promise<void> {
  await browser.execute((value: number | null) => {
    Reflect.set(window, '__e2eIdleMs', value)
    Reflect.set(window, '__e2eIdleReads', 0)
    if (Reflect.get(window, '__e2eFetchWrapped')) return
    Reflect.set(window, '__e2eFetchWrapped', true)
    const originalFetch = window.fetch
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input)
      if (url !== 'ipc://localhost/user_idle_ms') return originalFetch(input, init)
      Reflect.set(window, '__e2eIdleReads', (Reflect.get(window, '__e2eIdleReads') as number) + 1)
      return new Response(JSON.stringify(Reflect.get(window, '__e2eIdleMs')), {
        headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' },
      })
    }
  }, idleMs)
}

/** The `user_idle_ms` calls since the last `setUserIdleMs`. */
async function userIdleReads (browser: E2EBrowser): Promise<number> {
  return browser.execute(() => Reflect.get(window, '__e2eIdleReads') as number)
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

  /** The viewport point at `fraction` of the volume slider's width. */
  async function volumeSliderPoint (fraction: number): Promise<{ x: number, y: number }> {
    return browser.execute((f: number) => {
      const rect = document.querySelector('.done-sound-volume')!.getBoundingClientRect()
      return { x: Math.round(rect.left + rect.width * f), y: Math.round(rect.top + rect.height / 2) }
    }, fraction)
  }

  /** Drag the volume slider from its middle to `fraction` of its width. */
  async function dragVolumeTo (fraction: number, options: { release?: boolean } = {}): Promise<void> {
    const { x } = await volumeSliderPoint(fraction)
    await pointerDrag(browser, '.done-sound-volume', x, options)
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

  it('enables the slider with the sound checkbox, and plays the sound once when a click on it ends', async () => {
    await pointerClick(browser, '.done-sound-checkbox')
    await waitForValue(browser, 'slider disabled', async () => (await sectionState()).volumeDisabled, false)

    // The press moves the thumb to the click point at once; the sound waits
    // for the release.
    const point = await volumeSliderPoint(0.2)
    await pointerPress(browser, point.x, point.y)
    const pressed = await sectionState()
    expect(pressed.volume).toBeLessThan(35)
    expect(pressed.volumeLabel).toBe(`${pressed.volume}%`)
    expect((await soundState(browser)).plays).toEqual([])

    await pointerRelease(browser)
    await waitForValue(browser, 'sound plays', async () => (await soundState(browser)).plays, [pressed.volume])
  })

  it('plays no sound during a slider drag, and plays it once at the volume where the drag ends', async () => {
    await waitForSoundEnd(browser)

    await dragVolumeTo(0.9, { release: false })
    const state = await sectionState()
    draggedVolume = state.volume
    expect(draggedVolume).toBeGreaterThan(70)
    expect(state.volumeLabel).toBe(`${draggedVolume}%`)
    expect((await soundState(browser)).plays).toEqual([])

    await pointerRelease(browser)
    await waitForValue(browser, 'sound plays', async () => (await soundState(browser)).plays, [draggedVolume])
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
    expect(afterTwoCalls.lastVolumeSet).toBe(70)
    expect(afterTwoCalls.paused).toBe(false)

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
// sends the click. Each test starts with a user who is not away
// (`setUserIdleMs`).
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
    // A sound that still plays takes no new play() (dez.ui/playDoneSound),
    // so an alert in this test would not show.
    await waitForValue(browser, 'no sound playing', async () => (await soundState(browser)).paused !== false, true)
    await recordSoundPlays(browser)
    await setUserIdleMs(browser, 0)
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
    await waitFor(browser, '.settings-nav-btn')
    // `submit` left the focus in the editor, and opening Settings keeps it
    // there. Move it out, so that the focus check after the click sees the
    // focus that the click gives.
    await pointerClick(browser, '.settings-nav-btn')
    await waitForValue(browser, 'focus in Settings', async () => focusedArea(browser), 'button')
    await sendChatReply(request.reply, 'the click')
    const [notification] = await waitForNotifications([{ appName: 'Dez', summary: 'Click question', body: 'Reply finished', actions: ['default', 'Open'] }])

    server?.click(notification.id)

    await waitForValue(browser, 'active tab', activeTabId, tabId)
    expect(await sbpCall(browser, 'dez.model/settings/isOpen')).toBe(false)
    await waitForValue(browser, 'focused area', async () => focusedArea(browser), 'editor')
  })

  // Dez waits for the click of each notification in its own task
  // (`wait_for_click` in src-tauri/src/notification.rs), and the wait ends
  // when the server closes that notification. A real server sends no click
  // after a close; here the click shows whether the wait for the closed
  // notification still runs. The click on the other notification shows that
  // the close did not end its wait. A tab loses its done mark when it
  // becomes active, so the closed notification's tab keeps the mark only if
  // it never opened, whichever click Dez handles first.
  it('a click on a closed notification opens no tab, and the close does not end the wait of another notification', async () => {
    const closedAlert = { appName: 'Dez', summary: 'Closed question', body: 'Reply finished', actions: ['default', 'Open'] }
    const openAlert = { appName: 'Dez', summary: 'Open question', body: 'Reply finished', actions: ['default', 'Open'] }
    const closed = await askInBackgroundTab('Closed question')
    await sendChatReply(closed.request.reply, 'the closed notification')
    await waitForNotifications([closedAlert])
    const open = await askInBackgroundTab('Open question')
    await sendChatReply(open.request.reply, 'the open notification')
    const [closedNotification, openNotification] = await waitForNotifications([closedAlert, openAlert])

    server?.close(closedNotification.id)
    server?.click(closedNotification.id)
    server?.click(openNotification.id)

    await waitForValue(browser, 'active tab', activeTabId, open.tabId)
    // A wrong click on the closed notification can come after the other one.
    await browser.pause(300)
    expect(await activeTabId()).toBe(open.tabId)
    const activity = await sbpCall(browser, 'dez.model/tabs/activity') as Record<string, string>
    expect(activity[closed.tabId]).toBe('done')
  })

  it('gives no alert when a reply ends in the active tab of the focused window while the user is not away', async () => {
    expect(await windowIsFocused()).toBe(true)
    await submit(browser, 'Foreground question')
    const request = await mock.waitForRequest(browser)

    await sendChatReply(request.reply, 'the foreground')

    await waitForThread(browser, [
      { role: 'user', text: 'Foreground question' },
      { role: 'agent', text: replyText('the foreground') },
      { role: 'user', text: '' },
    ])
    // The idle time is the alert rule's last read. Give a wrong alert time
    // to start after it.
    await waitForValue(browser, 'idle time reads', async () => userIdleReads(browser), 1)
    await browser.pause(300)
    expect((await soundState(browser)).plays).toEqual([])
    expect(newNotifications()).toEqual([])
  })

  it('plays the sound and shows a notification when a reply ends in the active tab after more than 1 minute with no user input', async () => {
    expect(await windowIsFocused()).toBe(true)
    await setUserIdleMs(browser, 61_000)
    await submit(browser, 'Away question')
    const request = await mock.waitForRequest(browser)

    await sendChatReply(request.reply, 'the away user')

    await waitForValue(browser, 'sound plays', async () => (await soundState(browser)).plays, [VOLUME])
    await waitForNotifications([{ appName: 'Dez', summary: 'Away question', body: 'Reply finished', actions: ['default', 'Open'] }])
    expect(await userIdleReads(browser)).toBe(1)
  })

  // The user is not away, so only the lost window focus gives the alert. The
  // fake server sends no activation token, so Dez asks for the focus with
  // `gtk_window_present`, which headless KWin grants. A real session's click
  // comes with a token (a manual check).
  it('alerts for a reply in the active tab of the minimized window, and a click on the notification brings the window back', async (ctx) => {
    await submit(browser, 'Minimized question')
    const request = await mock.waitForRequest(browser)
    await browser.minimizeWindow()
    try {
      const lostFocus = await browser.waitUntil(async () => !await windowIsFocused(), { timeout: 3_000, interval: 50 }).catch(() => false)
      // Xvfb in CI has no window manager, so a minimize does nothing there.
      if (!lostFocus) {
        ctx.skip('The minimize needs a window manager, such as headless KWin')
        return
      }
      await sendChatReply(request.reply, 'the minimized window')
      await waitForValue(browser, 'sound plays', async () => (await soundState(browser)).plays, [VOLUME])
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
