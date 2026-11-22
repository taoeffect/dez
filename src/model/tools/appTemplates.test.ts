import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import shippedImportMap from '../../../src-tauri/libs/import_map.json'
import { UI_IMPORT_MAP_TAG, UI_LIBS_ROUTE } from './appTemplates'

describe('the import map of the page of a UI app', () => {
  // A name of the map that names no shipped file fails only when a page
  // imports it, and skia-canvas, with its native file, loads in no page.
  // `bundle.resources` ships the libs folder as it is: the vendored files
  // that manifest.json pins, and Dez's own libraries (dez-media).
  it('names each shipped library but skia-canvas, at a file that Dez ships', () => {
    const map = UI_IMPORT_MAP_TAG.slice('<script type="importmap">'.length, -'</script>'.length)
    const imports: Record<string, string> = JSON.parse(map).imports

    expect(Object.keys(imports)).toStrictEqual(Object.keys(shippedImportMap.imports).filter((name) => name !== 'skia-canvas'))
    const route = `./${UI_LIBS_ROUTE}/`
    for (const [name, target] of Object.entries(imports)) {
      expect(target.startsWith(route), `${name}: ${target}`).toBe(true)
      const path = target.slice(route.length)
      expect(existsSync(new URL(`../../../src-tauri/libs/${path}`, import.meta.url)), `${name}: ${path}`).toBe(true)
    }
  })
})
