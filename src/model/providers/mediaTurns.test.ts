import { describe, expect, it } from 'vitest'
import { takeMediaTurn } from './mediaTurns'

// Takes turns of `provider` and records which calls have one, and which
// were told to wait.
function turnTaker(provider: string) {
  const started: string[] = []
  const waited: string[] = []
  const ends = new Map<string, () => void>()
  const take = (name: string, limit: number, signal?: AbortSignal) => takeMediaTurn(provider, limit, signal, () => waited.push(name)).then((end) => {
    started.push(name)
    ends.set(name, end)
  })
  const end = (name: string) => ends.get(name)?.()
  return { take, end, started, waited }
}

// Lets the resolved turns run their `then` callbacks.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('takeMediaTurn', () => {
  it('lets at most the cap of calls of a provider run, and gives the turns that end to the waiting calls in order', async () => {
    const { take, end, started, waited } = turnTaker('cap')
    for (const name of ['a', 'b', 'c', 'd']) void take(name, 2)
    await settle()
    expect([started, waited]).toStrictEqual([['a', 'b'], ['c', 'd']])

    end('b')
    await settle()
    expect(started).toStrictEqual(['a', 'b', 'c'])

    // A second end of the same turn frees no other place.
    end('b')
    await settle()
    expect(started).toStrictEqual(['a', 'b', 'c'])

    end('a')
    await settle()
    expect(started).toStrictEqual(['a', 'b', 'c', 'd'])
  })

  it('counts each provider on its own', async () => {
    const first = turnTaker('one')
    const second = turnTaker('two')
    void first.take('a', 1)
    void first.take('b', 1)
    void second.take('c', 1)
    await settle()
    expect([first.started, second.started]).toStrictEqual([['a'], ['c']])
  })

  it('takes a call that stops while it waits out of the line, and the call after it gets the next turn', async () => {
    const { take, end, started, waited } = turnTaker('stop')
    const stop = new AbortController()
    void take('a', 1)
    const stopped = take('b', 1, stop.signal)
    void take('c', 1)
    stop.abort(new Error('stopped'))
    await expect(stopped).rejects.toThrow('stopped')

    end('a')
    await settle()
    expect([started, waited]).toStrictEqual([['a', 'c'], ['b', 'c']])
  })

  it('rejects a call whose signal aborted before it, with no turn', async () => {
    const { take, started, waited } = turnTaker('aborted')
    const stop = new AbortController()
    stop.abort(new Error('stopped'))
    await expect(take('a', 1, stop.signal)).rejects.toThrow('stopped')
    void take('b', 1)
    await settle()
    expect([started, waited]).toStrictEqual([['b'], []])
  })

  it('follows a cap that changed, from the next call', async () => {
    const { take, end, started } = turnTaker('changed')
    for (const name of ['a', 'b', 'c']) void take(name, 1)
    await settle()
    expect(started).toStrictEqual(['a'])

    // A larger cap gives the calls that wait their turns at once.
    void take('d', 3)
    await settle()
    expect(started).toStrictEqual(['a', 'b', 'c'])

    // A smaller cap gives no new turn until the calls that run are fewer.
    void take('e', 1)
    end('a')
    end('b')
    await settle()
    expect(started).toStrictEqual(['a', 'b', 'c'])
    end('c')
    await settle()
    expect(started).toStrictEqual(['a', 'b', 'c', 'd'])
  })
})
