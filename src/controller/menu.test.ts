import sbp from '@sbp/sbp'
import '@sbp/okturtles.eventqueue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MenuItemOptions } from '@tauri-apps/api/menu'
// Side-effect import: registers the selectors under test.
import './menu'

// The native menus that the code made, in order, with what was done to them.
const native = vi.hoisted(() => ({
  tauri: true,
  menus: [] as Array<{ items: MenuItemOptions[], popups: number, closed: boolean }>,
}))

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => native.tauri }))
vi.mock('@tauri-apps/api/menu', () => {
  class Menu {
    private readonly record: (typeof native.menus)[number]

    private constructor (items: MenuItemOptions[]) {
      this.record = { items, popups: 0, closed: false }
      native.menus.push(this.record)
    }

    static async new ({ items }: { items: MenuItemOptions[] }): Promise<Menu> {
      return new Menu(items)
    }

    async popup (): Promise<void> {
      this.record.popups++
    }

    async close (): Promise<void> {
      this.record.closed = true
    }
  }
  return { Menu, MenuItem: class {}, Submenu: class {} }
})

// The files that the menu items revealed. The stub stands for the selector
// of `controller/utils.ts`, so no file manager opens.
const revealed: string[] = []
sbp('sbp/selectors/register', {
  'dez.controller/revealInFileManager' (path: string): void {
    revealed.push(path)
  },
})

describe('dez.controller/menu/popupAsset', () => {
  beforeEach(() => {
    native.tauri = true
    native.menus.length = 0
    revealed.length = 0
  })

  it('pops up one item that reveals the file of the asset', async () => {
    await sbp('dez.controller/menu/popupAsset', '/home/ann/.config/dez/assets/images/a.png')

    expect(native.menus).toHaveLength(1)
    const [menu] = native.menus
    expect(menu.popups).toBe(1)
    expect(menu.items).toHaveLength(1)
    const [item] = menu.items
    expect(item.text).toBe('Reveal in File Manager')
    expect(item.enabled ?? true).toBe(true)

    expect(revealed).toEqual([])
    item.action?.('reveal')
    expect(revealed).toEqual(['/home/ann/.config/dez/assets/images/a.png'])
  })

  it('disables the item for an asset with no file on this computer', async () => {
    await sbp('dez.controller/menu/popupAsset', null)

    const [menu] = native.menus
    expect(menu.popups).toBe(1)
    expect(menu.items.map(({ text, enabled }) => ({ text, enabled }))).toEqual([
      { text: 'Reveal in File Manager', enabled: false },
    ])
  })

  it('closes the menu of the popup before, and each item reveals the file of its own popup', async () => {
    await sbp('dez.controller/menu/popupAsset', '/files/first.wav')
    expect(native.menus.map(({ closed }) => closed)).toEqual([false])

    await sbp('dez.controller/menu/popupAsset', '/files/second.webm')
    expect(native.menus.map(({ closed }) => closed)).toEqual([true, false])

    native.menus[1].items[0].action?.('reveal')
    expect(revealed).toEqual(['/files/second.webm'])
  })

  it('shows no menu outside the desktop app', async () => {
    native.tauri = false
    await sbp('dez.controller/menu/popupAsset', '/files/first.wav')
    expect(native.menus).toEqual([])
  })
})
