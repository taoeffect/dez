// The cap of the media requests of each provider (`mediaApi.maxRequestsAtOnce`):
// at most that many `dez.provider/generateMedia` calls of one provider send
// their requests at one time, of all tabs together, and the others wait for
// their turn, in the order of their calls. A provider limits the requests of
// one API key, and the code of a script can start many clip jobs at once.
// The turns are of this module, not of a tab: the limit is the provider's.

/** The cap of a provider whose config tells none. */
export const DEFAULT_MEDIA_REQUESTS_AT_ONCE = 4

interface ProviderTurns {
  // The calls that have their turn.
  running: number
  // The cap that the newest call gave: a config can change while calls run.
  limit: number
  // The calls that wait, first in first out: each gets its turn with `go`.
  waiting: Array<{ go: () => void }>
}

const turns = new Map<string, ProviderTurns>()

// Gives the next calls that wait their turns, while the provider has room.
function admit(providerId: string, entry: ProviderTurns): void {
  while (entry.waiting.length > 0 && entry.running < entry.limit) {
    entry.running++
    entry.waiting.shift()?.go()
  }
  if (entry.running === 0 && entry.waiting.length === 0) turns.delete(providerId)
}

/** Waits for a turn of the provider `providerId`, whose cap is `limit`, and
 *  resolves with the end of that turn, which the caller must call once,
 *  when its request ended (in a `finally`). `onWait` runs once, at once,
 *  when the call must wait. Rejects with the reason of `signal` when it
 *  aborts before the turn comes; the call then has no turn to end. The
 *  order of the turns is the order of the calls: the function takes its
 *  place in the tick of its call. */
export async function takeMediaTurn(providerId: string, limit: number, signal: AbortSignal | undefined, onWait: () => void): Promise<() => void> {
  signal?.throwIfAborted()
  const entry = turns.get(providerId) ?? { running: 0, limit, waiting: [] }
  turns.set(providerId, entry)
  entry.limit = limit
  // A larger cap of a changed config gives turns to the calls that wait.
  if (entry.waiting.length > 0) admit(providerId, entry)
  let ended = false
  const end = () => {
    if (ended) return
    ended = true
    entry.running--
    admit(providerId, entry)
  }
  if (entry.waiting.length === 0 && entry.running < limit) {
    entry.running++
    return end
  }
  onWait()
  return await new Promise((resolve, reject) => {
    const waiter = {
      go: () => {
        signal?.removeEventListener('abort', onAbort)
        resolve(end)
      },
    }
    const onAbort = () => {
      const index = entry.waiting.indexOf(waiter)
      if (index !== -1) entry.waiting.splice(index, 1)
      admit(providerId, entry)
      reject(signal?.reason)
    }
    entry.waiting.push(waiter)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
