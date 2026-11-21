import sbp from '@sbp/sbp'
import { watch } from 'vue'
import type { MediaTagKind } from '../../model/chat/mediaTags'
import type { ClipVolume } from '../../model/clipVolume'

/**
 * Makes the media element of a clip player play at the remembered volume of
 * its kind (`dez.model/settings/clipVolume`), now and at each change of it,
 * and remembers each volume and mute that the player's controls set on the
 * element. Call the returned function when the element goes.
 *
 * Why the sets of the controls, and not `volumechange`: in WebKitGTK the
 * `volume` and `muted` of a media element read back what the sound server
 * last reported, late and in its own time. During a drag of the slider it
 * reports earlier values of the drag, and it can stay at one of them for
 * seconds (`recordSoundPlays`, tests/e2e/notifications.e2e.ts). A
 * `volumechange` carries such a value too. A player that remembered it
 * would give every player a volume that the user never chose, and two
 * players could give each other the late values of their sound servers,
 * again and again. The value that the controls (video.js) assign is what
 * the user chose. So the element gets an own `volume` and `muted` property,
 * which calls the element's setter and then remembers the value. Dez's own
 * puts call the element's setter directly, so they remember nothing.
 */
export function followClipVolume(element: HTMLMediaElement, kind: MediaTagKind): () => void {
  const volume = mediaProperty('volume')
  const muted = mediaProperty('muted')
  Object.defineProperty(element, 'volume', {
    configurable: true,
    get: () => volume.get.call(element),
    set: (value: number) => {
      // A value out of range throws here, so it is not remembered.
      volume.set.call(element, value)
      sbp('dez.model/settings/setClipVolume', kind, { volume: value * 100 })
    },
  })
  Object.defineProperty(element, 'muted', {
    configurable: true,
    get: () => muted.get.call(element),
    set: (value: boolean) => {
      muted.set.call(element, value)
      sbp('dez.model/settings/setClipVolume', kind, { muted: value })
    },
  })
  const stop = watch(
    () => sbp('dez.model/settings/clipVolume', kind) as ClipVolume,
    (remembered) => {
      volume.set.call(element, remembered.volume / 100)
      muted.set.call(element, remembered.muted)
    },
    { immediate: true },
  )
  return () => {
    stop()
    // A control of a player that went changes no remembered volume.
    Reflect.deleteProperty(element, 'volume')
    Reflect.deleteProperty(element, 'muted')
  }
}

// The accessor of `HTMLMediaElement`. Read at each call, not once for the
// module, so that a setter that an e2e spec put on the prototype (to see
// what Dez assigns) is the one that Dez calls.
function mediaProperty(name: 'volume' | 'muted'): { get: () => unknown, set: (value: unknown) => void } {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, name)
  if (!descriptor?.get || !descriptor.set) {
    const error = new Error(`HTMLMediaElement has no ${name} accessor`)
    console.error('[clipVolume]', error)
    throw error
  }
  return { get: descriptor.get, set: descriptor.set }
}
