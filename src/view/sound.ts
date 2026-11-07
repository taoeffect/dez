import sbp from '@sbp/sbp'
// A data: URL, not a file URL. WebKitGTK cannot play media from the app's
// `tauri://localhost/…` URLs (the element fails with
// MEDIA_ERR_SRC_NOT_SUPPORTED, because GStreamer has no source for that
// scheme), but it plays the same bytes from a data: URL.
import dingDataUrl from '../assets/sounds/ding.mp3?inline'

// One shared player for the reply-done sound, made on first use. A call
// while the sound plays only changes its volume, so two replies that end
// together give one ding.
let doneSoundPlayer: HTMLAudioElement | null = null

export default sbp('sbp/selectors/register', {
  'dez.ui/playDoneSound' (volumePercent: number): void {
    doneSoundPlayer ??= new Audio(dingDataUrl)
    doneSoundPlayer.volume = volumePercent / 100
    if (!doneSoundPlayer.paused) return
    // At the end of the sound `paused` is true again, and `play()` starts it
    // from the beginning.
    doneSoundPlayer.play().catch((error: unknown) => {
      console.error('[sound] Could not play the reply-done sound:', error)
    })
  },
})
