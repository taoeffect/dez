/** Runs `start` and waits for its work until `signal` aborts; then rejects
 *  at once with the reason of the abort. The work itself goes on: a
 *  model-list check still updates the model cache, and a price request
 *  still fills the quote cache. Nothing starts after an abort, so a stopped
 *  caller sends no request, and no work that nobody waits for can reject
 *  unhandled. */
export function untilAborted<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  const work = start()
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
    // `start` runs before the listener is added, and a stop in it (a selector
    // that stops the reply before its first await) fires no event any more.
    if (signal.aborted) onAbort()
  })
}
