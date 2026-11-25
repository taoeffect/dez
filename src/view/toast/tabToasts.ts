// The tab rule of the toasts (`ToastData.tabId`): which toasts of a
// container show, which it drops, and which it closes for room. A toast of
// a tab in the background waits in the container, with no card, until the
// user goes to its tab. Its timer is the animation of its card, so a timed
// toast starts its time again each time that its tab shows.

/** The part of a toast that the tab rule reads (`ToastItem`). */
export interface TabToast {
  tabId?: string
  closing?: boolean
}

/** A toast with no tab shows in every tab; a toast of a tab shows only while
 *  that tab is active. */
export function toastShows(toast: TabToast, activeTabId: string): boolean {
  return toast.tabId === undefined || toast.tabId === activeTabId
}

/** The toasts that a container keeps. It drops the toasts of a tab that is
 *  not open: no tab gets that id again (a reopened tab gets a new id). It
 *  also drops a closing toast that does not show, as its card, whose leave
 *  animation would remove it, is gone. */
export function keptToasts<T extends TabToast>(toasts: readonly T[], activeTabId: string, openTabIds: readonly string[]): T[] {
  return toasts.filter((toast) => (toast.tabId === undefined || openTabIds.includes(toast.tabId))
    && (!toast.closing || toastShows(toast, activeTabId)))
}

/** The toasts that a container closes so that at most `max` show, oldest
 *  first. A toast that waits for its tab does not count, so it pushes out
 *  no toast that the user sees. */
export function overflowToasts<T extends TabToast>(toasts: readonly T[], activeTabId: string, max: number): T[] {
  const open = toasts.filter((toast) => !toast.closing && toastShows(toast, activeTabId))
  return open.slice(0, Math.max(0, open.length - max))
}
