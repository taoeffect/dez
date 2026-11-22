// @ts-check
// dez-media/canvas: the graphics helpers of a script app that draws with
// skia-canvas. Only a Deno run of an app whose manifest has
// `"native": ["skia-canvas"]` can load skia-canvas, which loads a native
// file. So this entry is apart from 'dez-media' (mod.js), which the pages
// of UI apps import too, and the import map of a page does not have it
// (`pageImportMap`, src/model/tools/appTemplates.ts).

import { FontLibrary } from 'skia-canvas'

/**
 * A font that Dez ships, as `dez.fonts` of a run of an app lists it.
 * @typedef {{ file: string, family: string, weight: number, scripts: string, path: string }} ShippedFont
 */

// The shipped family of each generic family that a canvas font can name.
// skia-canvas draws the default font of a context (`10px sans-serif`), and
// a family that it does not know, with `sans-serif`.
const GENERIC_FAMILIES = { 'sans-serif': 'Noto Sans', monospace: 'JetBrains Mono' }

/**
 * Gives skia-canvas the fonts that Dez ships, each under its family, and
 * `sans-serif` and `monospace` as shipped families. A run of an app sees
 * no font of the computer, so a canvas draws no text before this call.
 *
 * Returns every shipped family as one list for `ctx.font`, Noto Sans first:
 * skia-canvas takes each character from the first family of the list that
 * has it, so the list draws each script that the fonts cover
 * (`ctx.font = \`bold 48px ${families}\``). One family alone draws only
 * its own scripts.
 *
 * @param {readonly ShippedFont[]} fonts `dez.fonts`
 * @returns {string}
 */
export function useShippedFonts(fonts) {
  if (!Array.isArray(fonts)) throw new TypeError('useShippedFonts takes the fonts that Dez ships: give it `dez.fonts`.')
  /** @type {Map<string, string[]>} */
  const families = new Map()
  for (const { family, path } of fonts) families.set(family, [...(families.get(family) ?? []), path])
  for (const [family, paths] of families) FontLibrary.use(family, paths)
  for (const [generic, family] of Object.entries(GENERIC_FAMILIES)) {
    const paths = families.get(family)
    if (paths) FontLibrary.use(generic, paths)
  }
  return [...families.keys()].map((family) => `"${family}"`).join(', ')
}
