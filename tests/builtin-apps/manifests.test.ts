import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isAppName, isBuiltInApp, MAX_DESCRIPTION_LENGTH, parseAppManifest } from '../../src/model/tools/appManifest'
import { appsPath } from '../../src/model/tools/appsTool'
import { asksForDecode, manifestDecode } from '../../src/model/tools/inputDecode'
import { CONVERSATION_ID } from '../../src/model/tools/testing'

const FOLDER = new URL('../../src-tauri/builtin-apps/', import.meta.url)
const names = readdirSync(FOLDER)

// Dez lists, reads, and runs each folder of builtin-apps/ as an app of
// /apps/ (`pathOf`, appsTool.ts), and refuses a run of a built-in app
// whose manifest it cannot read.
describe('the built-in apps that Dez ships', () => {
  it.each(names)('%s has a name of a built-in app, a manifest of a script app, a main.ts, and a decode of its inputs', (name) => {
    expect(isAppName(name) && isBuiltInApp(name)).toBe(true)
    const bytes = readFileSync(new URL(`${name}/manifest.json`, FOLDER))
    const manifest = parseAppManifest(new TextDecoder().decode(bytes))
    expect(manifest).toMatchObject({ name, kind: 'script' })
    expect(manifest?.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH)
    expect(existsSync(new URL(`${name}/main.ts`, FOLDER))).toBe(true)
    const decode = manifestDecode(bytes, appsPath(`/apps/${name}/manifest.json`, 'path', CONVERSATION_ID))
    expect(decode !== null && asksForDecode(decode)).toBe(true)
  })
})
