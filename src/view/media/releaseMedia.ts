// The numbers of `HTMLMediaElement.readyState` and `networkState` (the unit
// tests run with no DOM, so the constants of the class are not there).
const HAVE_METADATA = 1
const NETWORK_EMPTY = 0
const NETWORK_NO_SOURCE = 3

/** The parts of a media element that the release reads and calls. */
export type ReleasableMedia = Pick<
  HTMLMediaElement,
  'readyState' | 'networkState' | 'error' | 'pause' | 'removeAttribute' | 'load' | 'addEventListener' | 'removeEventListener'
>

// The events that tell that a load is past its start.
const SETTLED_EVENTS = ['loadedmetadata', 'error'] as const

/**
 * Frees the player of a media element that left the document (its decoder,
 * its threads, its connection to the sound server, and the bytes of the
 * clip that it holds), and stops its sound.
 *
 * Why this is needed: WebKit never frees a removed media element that has a
 * player and event listeners (Vue leaves its listeners on the element), and
 * it frees other removed elements only after some garbage collections. On
 * WebKitGTK each such element keeps a GStreamer pipeline with a connection
 * to the sound server, and the server refuses new connections after about
 * 120: then no clip loads until the app starts again.
 *
 * Why the release waits for a load that just started: WebKitGTK (2.54.2)
 * can stop for ever when a player goes at the start of its load. A thread
 * of the pipeline holds a lock while it waits for the main thread (the
 * stream collection message), and the main thread waits for that lock to
 * stop the pipeline. After the metadata or an error, that message is over.
 * https://github.com/block/buzz-app/pull/1143 (the same two waits, there
 * from WebKit's own stop of a muted video that left the view)
 */
export function releaseRemovedMedia(element: ReleasableMedia): void {
  // The element never had a source: it has no player.
  if (element.networkState === NETWORK_EMPTY) return
  if (loadIsPastItsStart(element)) {
    release(element)
    return
  }
  const onSettled = (): void => {
    for (const name of SETTLED_EVENTS) element.removeEventListener(name, onSettled)
    release(element)
  }
  for (const name of SETTLED_EVENTS) element.addEventListener(name, onSettled)
}

// `NETWORK_NO_SOURCE` with no error: the element got its source in this
// task, and the load did not start yet, so there is no pipeline.
function loadIsPastItsStart(element: ReleasableMedia): boolean {
  return element.readyState >= HAVE_METADATA || element.error !== null || element.networkState === NETWORK_NO_SOURCE
}

// With no `src`, `load()` gives up the player of the element at once.
function release(element: ReleasableMedia): void {
  element.pause()
  element.removeAttribute('src')
  element.load()
}
