import type { E2EBrowser } from './session'

// The record of the native context menus that the page asks for.
// WebDriver cannot drive a native menu, so an SBP filter stops each
// `dez.controller/menu/popupAsset` call and records its file
// (`src/controller/menu.test.ts` covers the menu that the selector builds).

/** What the page did for the context clicks since the last reset. */
export interface MenuRecord {
  /** The file of each `popupAsset` call; null for a call with no file (the
   *  item of the menu is disabled). */
  files: Array<string | null>
  /** For each `contextmenu` event of Dez's page, whether a listener of the
   *  page canceled the menu of the webview. An event in the page of an app
   *  frame is not in this list. */
  canceled: boolean[]
}

/** Starts the record: no native menu opens after this. Call it once per
 *  app start. */
export async function recordAssetMenus (browser: E2EBrowser): Promise<void> {
  // A filter that returns false stops the selector call. The window
  // listener runs after every listener of the page, so it sees whether one
  // of them canceled the webview's menu.
  await browser.execute(() => {
    const sbp = Reflect.get(window, 'sbp') as (selector: string, ...args: unknown[]) => unknown
    const files: Array<string | null> = []
    const canceled: boolean[] = []
    Reflect.set(window, '__e2eAssetMenus', files)
    Reflect.set(window, '__e2eContextMenus', canceled)
    sbp('sbp/filters/selector/add', 'dez.controller/menu/popupAsset', (_domain: string, _selector: string, data: unknown[]) => {
      files.push(data[0] as string | null)
      return false
    })
    window.addEventListener('contextmenu', (event) => canceled.push(event.defaultPrevented))
  })
}

/** The record since `recordAssetMenus` or the last `resetMenuRecord`. */
export async function menuRecord (browser: E2EBrowser): Promise<MenuRecord> {
  return browser.execute(() => ({
    files: [...Reflect.get(window, '__e2eAssetMenus') as Array<string | null>],
    canceled: [...Reflect.get(window, '__e2eContextMenus') as boolean[]],
  }))
}

export async function resetMenuRecord (browser: E2EBrowser): Promise<void> {
  await browser.execute(() => {
    (Reflect.get(window, '__e2eAssetMenus') as unknown[]).length = 0;
    (Reflect.get(window, '__e2eContextMenus') as unknown[]).length = 0
  })
}
