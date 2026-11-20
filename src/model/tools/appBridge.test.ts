import { describe, expect, it } from 'vitest'
import { conversationAssets } from '../streams/mediaRequest'
import {
  APP_READ_ASSET,
  APP_SAVE_ASSET,
  appCall,
  AppCallError,
  clipNotReadText,
  imageNotReadText,
  notAnInputText,
  unknownAssetText,
} from './appBridge'
import { CONVERSATION } from './testing'

// The text of the `AppCallError` that `work` throws.
function refused(work: () => unknown): string {
  try {
    work()
  } catch (error) {
    if (error instanceof AppCallError) return error.message
    throw error
  }
  throw new Error('The call was not refused.')
}

describe('appCall', () => {
  it('takes a read of an id, with or without the @', () => {
    for (const [given, id] of [['a', 'a'], ['@a', 'a'], [' @bc ', 'bc']]) {
      expect(appCall(APP_READ_ASSET, [given]), given).toStrictEqual({ selector: APP_READ_ASSET, id })
    }
  })

  it('refuses a read of a text that is no id, and a read with no text', () => {
    for (const given of ['A', 'a b', '@', '', '../red.jpg', '/home/u/red.jpg', 4, null, undefined, { id: 'a' }]) {
      expect(refused(() => appCall(APP_READ_ASSET, [given])), String(given)).toContain(`dez.sbp('${APP_READ_ASSET}', 'a')`)
    }
    expect(refused(() => appCall(APP_READ_ASSET, []))).toContain(APP_READ_ASSET)
  })

  it('takes a save of a Blob, as it is', () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    const call = appCall(APP_SAVE_ASSET, [blob, 'chart.png'])

    expect(call.selector).toBe(APP_SAVE_ASSET)
    expect(call.selector === APP_SAVE_ASSET && call.blob).toBe(blob)
  })

  it('takes a save of an ArrayBuffer or of a typed array as a Blob of the same bytes', async () => {
    const whole = new Uint8Array([9, 1, 2, 3, 9])

    for (const [given, bytes] of [[whole.buffer, [9, 1, 2, 3, 9]], [whole.subarray(1, 4), [1, 2, 3]], [new DataView(whole.buffer, 3), [3, 9]]] as const) {
      const call = appCall(APP_SAVE_ASSET, [given])

      expect(call.selector === APP_SAVE_ASSET && Array.from(new Uint8Array(await call.blob.arrayBuffer()))).toStrictEqual(bytes)
    }
  })

  it('refuses a save of a value that holds no bytes', () => {
    for (const given of ['iVBORw0KGgo=', [137, 80, 78, 71], { size: 3, type: 'image/png' }, null, undefined]) {
      expect(refused(() => appCall(APP_SAVE_ASSET, [given]))).toContain('a Blob, an ArrayBuffer, or a typed array')
    }
  })

  it('refuses every other selector, and names the two that an app has', () => {
    for (const selector of ['dez.tools/image', 'dez.app/deleteAsset', 'dez.model/tabs/activeId', 'sbp/selectors/register', '']) {
      const text = refused(() => appCall(selector, [{}]))

      expect(text, selector).toContain(JSON.stringify(selector))
      expect(text).toContain(APP_READ_ASSET)
      expect(text).toContain(APP_SAVE_ASSET)
    }
  })
})

describe('the texts of a refused read', () => {
  it('tells a run which inputs it has', () => {
    expect(notAnInputText('c', [{ id: 'a', kind: 'image' }, { id: 'b', kind: 'audio' }]))
      .toBe('Dez gave no bytes for @c: it is no input of this run. The inputs of this run are the image @a, the audio clip @b.')
    expect(notAnInputText('c', [])).toContain('this run has no input')
  })

  it('tells a shown app which images and clips the conversation has', () => {
    expect(unknownAssetText('z', conversationAssets(CONVERSATION)))
      .toBe('Dez gave no bytes for @z: it names no image and no clip of this conversation. '
        + 'The conversation has the image @a, the image @e, the image @f, the audio clip @b, the video clip @c, the video clip @d.')
    expect(unknownAssetText('z', conversationAssets([]))).toContain('this conversation has no image and no clip')
  })

  // The page can show the text to the user, so it tells no one what to do.
  it('names an image or a clip that Dez could not read by its id only, for each problem', () => {
    const texts = [
      imageNotReadText('a'),
      ...(['deleted', 'expired', 'unreadable'] as const).map((problem) => clipNotReadText({ id: 'c', kind: 'video' }, problem)),
    ]

    expect(texts[0]).toContain('the image @a')
    for (const text of texts.slice(1)) expect(text).toContain('the video clip @c')
    expect(new Set(texts).size).toBe(4)
    for (const text of texts) expect(text).not.toMatch(/Tell the user|call the|\//)
  })
})
