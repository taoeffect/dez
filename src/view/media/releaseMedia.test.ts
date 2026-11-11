import { describe, expect, it } from 'vitest'
import { releaseRemovedMedia, type ReleasableMedia } from './releaseMedia'

const NETWORK_EMPTY = 0
const NETWORK_LOADING = 2
const NETWORK_NO_SOURCE = 3
const HAVE_NOTHING = 0
const HAVE_METADATA = 1

/** A media element with a source, in the given state. `calls` is what the
 *  release did to it, and `fire` sends it an event. */
function mediaElement(state: { networkState: number, readyState: number, failed?: boolean }) {
  const calls: string[] = []
  const listeners = new Map<string, Set<() => void>>()
  const element = {
    networkState: state.networkState,
    readyState: state.readyState,
    error: state.failed ? {} as MediaError : null,
    pause: () => { calls.push('pause') },
    removeAttribute: (name: string) => { calls.push(`remove ${name}`) },
    load: () => { calls.push('load') },
    addEventListener: (name: string, listener: () => void) => {
      listeners.set(name, (listeners.get(name) ?? new Set()).add(listener))
    },
    removeEventListener: (name: string, listener: () => void) => {
      listeners.get(name)?.delete(listener)
    },
  } as unknown as ReleasableMedia
  const fire = (name: string): void => {
    for (const listener of [...listeners.get(name) ?? []]) listener()
  }
  return { element, calls, fire }
}

const RELEASED = ['pause', 'remove src', 'load']

describe('releaseRemovedMedia', () => {
  it('releases an element that has its metadata at once', () => {
    const { element, calls } = mediaElement({ networkState: NETWORK_LOADING, readyState: HAVE_METADATA })
    releaseRemovedMedia(element)
    expect(calls).toEqual(RELEASED)
  })

  it('releases an element whose load failed at once', () => {
    const { element, calls } = mediaElement({ networkState: NETWORK_NO_SOURCE, readyState: HAVE_NOTHING, failed: true })
    releaseRemovedMedia(element)
    expect(calls).toEqual(RELEASED)
  })

  it('releases an element whose load did not start yet at once', () => {
    const { element, calls } = mediaElement({ networkState: NETWORK_NO_SOURCE, readyState: HAVE_NOTHING })
    releaseRemovedMedia(element)
    expect(calls).toEqual(RELEASED)
  })

  it('leaves an element that never had a source', () => {
    const { element, calls, fire } = mediaElement({ networkState: NETWORK_EMPTY, readyState: HAVE_NOTHING })
    releaseRemovedMedia(element)
    fire('loadedmetadata')
    expect(calls).toEqual([])
  })

  it('does not touch an element at the start of its load, and releases it once when the metadata is there', () => {
    const { element, calls, fire } = mediaElement({ networkState: NETWORK_LOADING, readyState: HAVE_NOTHING })
    releaseRemovedMedia(element)
    expect(calls).toEqual([])
    fire('loadedmetadata')
    expect(calls).toEqual(RELEASED)
    // The release itself, or a late event, must not release again.
    fire('error')
    fire('loadedmetadata')
    expect(calls).toEqual(RELEASED)
  })

  it('releases an element whose load fails after it left the document', () => {
    const { element, calls, fire } = mediaElement({ networkState: NETWORK_LOADING, readyState: HAVE_NOTHING })
    releaseRemovedMedia(element)
    fire('error')
    expect(calls).toEqual(RELEASED)
  })
})
