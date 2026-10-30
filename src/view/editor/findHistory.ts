/** How many searches the find history keeps. */
export const FIND_HISTORY_LIMIT = 50

/** Search history for ArrowUp/ArrowDown in the find field. It is kept in
 *  memory only. Entries are unique and ordered oldest first. `older()` and
 *  `newer()` walk the entries. Going newer past the newest entry gives back
 *  the draft: the field text from when browsing started. */
export class FindHistory {
  private readonly entries: string[] = []
  /** Index of the entry shown in the field, or `null` when not browsing. */
  private index: number | null = null
  /** Newest index that browsing reaches. When the draft equals the newest
   *  entry (the usual case right after a search), browsing starts one
   *  older, so the first ArrowUp always changes the field. */
  private top = -1
  private draft = ''

  /** Add a search as the newest entry. An existing equal entry moves to the
   *  newest position. Empty searches are not kept. Ends browsing. */
  commit(search: string): void {
    this.index = null
    if (search === '') return
    const existing = this.entries.indexOf(search)
    if (existing !== -1) this.entries.splice(existing, 1)
    this.entries.push(search)
    if (this.entries.length > FIND_HISTORY_LIMIT) {
      this.entries.splice(0, this.entries.length - FIND_HISTORY_LIMIT)
    }
  }

  /** The next older entry, or `null` when there is none. The first call
   *  starts browsing and keeps `fieldText` as the draft. */
  older(fieldText: string): string | null {
    if (this.index === null) {
      const newest = this.entries.length - 1
      const top = this.entries[newest] === fieldText ? newest - 1 : newest
      if (top < 0) return null
      this.draft = fieldText
      this.top = top
      this.index = top
    } else if (this.index > 0) {
      this.index--
    } else {
      return null
    }
    return this.entries[this.index]
  }

  /** The next newer entry, the draft after the newest entry, or `null` when
   *  not browsing. */
  newer(): string | null {
    if (this.index === null) return null
    if (this.index < this.top) {
      this.index++
      return this.entries[this.index]
    }
    this.index = null
    return this.draft
  }

  /** Stop browsing, e.g. when the user types. The next `older()` takes a
   *  new draft. */
  resetBrowse(): void {
    this.index = null
  }
}

/** The app's find history, shared by all tabs. */
export const findHistory = new FindHistory()
