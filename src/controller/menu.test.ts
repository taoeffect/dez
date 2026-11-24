import sbp from '@sbp/sbp'
import '@sbp/okturtles.eventqueue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MenuItemOptions } from '@tauri-apps/api/menu'
import type { AssetExport } from '../model/chat/assetExport'
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

// The files that the menu items revealed, and the assets that they
// exported. The stubs stand for the selectors of `controller/utils.ts` and
// `controller/exportAsset.ts`, so no file manager and no dialog opens.
const revealed: string[] = []
const exported: AssetExport[] = []
sbp('sbp/selectors/register', {
  'dez.controller/revealInFileManager' (path: string): void {
    revealed.push(path)
  },
  'dez.controller/exportAsset' (asset: AssetExport): void {
    exported.push(asset)
  },
})

const IMAGE = '/home/ann/.config/dez/assets/images/a.png'
const IMAGE_EXPORT: AssetExport = { id: 'a', kind: 'image', source: { kind: 'file', path: IMAGE, linked: false } }

describe('dez.controller/menu/popupAsset', () => {
  beforeEach(() => {
    native.tauri = true
    native.menus.length = 0
    revealed.length = 0
    exported.length = 0
  })

  it('pops up an item that reveals the file of the asset, and one that exports the asset', async () => {
    await sbp('dez.controller/menu/popupAsset', { file: IMAGE, export: IMAGE_EXPORT })

    expect(native.menus).toHaveLength(1)
    const [menu] = native.menus
    expect(menu.popups).toBe(1)
    expect(menu.items.map(({ text, enabled }) => ({ text, enabled: enabled ?? true }))).toEqual([
      { text: 'Reveal in File Manager', enabled: true },
      { text: 'Export…', enabled: true },
    ])

    menu.items[0].action?.('reveal')
    expect(revealed).toEqual([IMAGE])
    expect(exported).toEqual([])
    menu.items[1].action?.('export')
    expect(exported).toEqual([IMAGE_EXPORT])
  })

  it('exports a clip that plays from its URL, which has no file to reveal', async () => {
    const clip: AssetExport = { id: 'b', kind: 'video', source: { kind: 'url', url: 'https://cdn.example/v.mp4', type: 'video/mp4' } }
    await sbp('dez.controller/menu/popupAsset', { file: null, export: clip })

    const [menu] = native.menus
    expect(menu.items.map(({ text, enabled }) => ({ text, enabled: enabled ?? true }))).toEqual([
      { text: 'Reveal in File Manager', enabled: false },
      { text: 'Export…', enabled: true },
    ])
    menu.items[1].action?.('export')
    expect(exported).toEqual([clip])
  })

  it('disables both items for an asset whose bytes are gone', async () => {
    await sbp('dez.controller/menu/popupAsset', { file: null, export: null })

    const [menu] = native.menus
    expect(menu.popups).toBe(1)
    expect(menu.items.map(({ text, enabled }) => ({ text, enabled }))).toEqual([
      { text: 'Reveal in File Manager', enabled: false },
      { text: 'Export…', enabled: false },
    ])
  })

  it('has no Export item for a menu with no export (an app)', async () => {
    await sbp('dez.controller/menu/popupAsset', { file: '/home/ann/.config/dez/apps/clock' })

    expect(native.menus[0].items.map(({ text }) => text)).toEqual(['Reveal in File Manager'])
  })

  it('closes the menu of the popup before, and each item reveals the file of its own popup', async () => {
    await sbp('dez.controller/menu/popupAsset', { file: '/files/first.wav', export: null })
    expect(native.menus.map(({ closed }) => closed)).toEqual([false])

    await sbp('dez.controller/menu/popupAsset', { file: '/files/second.webm', export: null })
    expect(native.menus.map(({ closed }) => closed)).toEqual([true, false])

    native.menus[1].items[0].action?.('reveal')
    expect(revealed).toEqual(['/files/second.webm'])
  })

  it('shows no menu outside the desktop app', async () => {
    native.tauri = false
    await sbp('dez.controller/menu/popupAsset', { file: '/files/first.wav', export: null })
    expect(native.menus).toEqual([])
  })
})
