import { describe, expect, it } from 'vitest'
import { keptToasts, overflowToasts, toastShows, type TabToast } from './tabToasts'

type Toast = TabToast & { id: string }

const ids = (toasts: readonly Toast[]): string[] => toasts.map((toast) => toast.id)

describe('toastShows', () => {
  it('shows a toast with no tab in every tab, and a toast of a tab only while that tab is active', () => {
    expect([toastShows({}, 'a'), toastShows({}, 'b')]).toStrictEqual([true, true])
    expect([toastShows({ tabId: 'a' }, 'a'), toastShows({ tabId: 'a' }, 'b')]).toStrictEqual([true, false])
  })
})

describe('keptToasts', () => {
  it('drops the toasts of a tab that is not open, and keeps those of a tab in the background', () => {
    const toasts: Toast[] = [{ id: 'app' }, { id: 'open', tabId: 'b' }, { id: 'closed', tabId: 'gone' }]

    expect(ids(keptToasts(toasts, 'a', ['a', 'b']))).toStrictEqual(['app', 'open'])
  })

  it('drops a closing toast that does not show, and keeps one that shows', () => {
    const toasts: Toast[] = [
      { id: 'hidden', tabId: 'b', closing: true },
      { id: 'shown', tabId: 'a', closing: true },
      { id: 'app', closing: true },
    ]

    expect(ids(keptToasts(toasts, 'a', ['a', 'b']))).toStrictEqual(['shown', 'app'])
  })
})

describe('overflowToasts', () => {
  it('closes the oldest toasts that show, over the limit', () => {
    const toasts: Toast[] = [{ id: '1' }, { id: '2', tabId: 'a' }, { id: '3' }, { id: '4' }]

    expect(ids(overflowToasts(toasts, 'a', 2))).toStrictEqual(['1', '2'])
  })

  it('counts no toast that waits for its tab and no toast that closes', () => {
    const toasts: Toast[] = [{ id: 'waits', tabId: 'b' }, { id: 'closes', closing: true }, { id: '1' }, { id: '2', tabId: 'a' }]

    expect(overflowToasts(toasts, 'a', 2)).toStrictEqual([])
    expect(ids(overflowToasts(toasts, 'b', 1))).toStrictEqual(['waits'])
  })
})
