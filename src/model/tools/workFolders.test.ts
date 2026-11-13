import { describe, expect, it } from 'vitest'
import { WORK_FOLDER_LIFETIME_MS, oldWorkFolders, workFolderPath } from './workFolders'

describe('oldWorkFolders', () => {
  const now = Date.UTC(2026, 10, 13, 12)

  it('gives the paths of the folders whose last change is the lifetime ago or more', () => {
    const folders = [
      { name: 'over', updatedAt: now - WORK_FOLDER_LIFETIME_MS - 1 },
      { name: 'at-the-end', updatedAt: now - WORK_FOLDER_LIFETIME_MS },
      { name: 'one-ms-left', updatedAt: now - WORK_FOLDER_LIFETIME_MS + 1 },
      { name: 'new', updatedAt: now },
    ]

    expect(oldWorkFolders(folders, now)).toStrictEqual([workFolderPath('over'), workFolderPath('at-the-end')])
  })

  it('keeps a folder whose time is after now (the clock of the computer went back)', () => {
    expect(oldWorkFolders([{ name: 'ahead', updatedAt: now + 60_000 }], now)).toStrictEqual([])
  })
})
