import { describe, expect, it } from 'vitest'
import { assetPlaces } from '../chat/assetOrigins'
import { compactionTagText } from '../chat/compaction'
import { imageMarkdown } from '../chat/images'
import type { ShownPicture } from '../chat/shownPictures'
import { HIDDEN_CLIP_PATH, HIDDEN_IMAGE_PATH, hiddenClip, hiddenImage } from '../chat/testing'
import { toolBlockText } from '../chat/toolBlocks'
import type { Section } from '../chat/types'
import { RED, SKY } from '../tools/testing'
import { compactionAssets, type CompactionAsset } from './compactionAssets'
import { compactionLeftFiles } from './compactionFiles'
import { conversationAssets } from './mediaRequest'
import { reply, user } from './testing'

const picture = (file: string): ShownPicture => ({ file, label: 'A frame sheet', width: 800, height: 200, bytes: 3000 })
const viewBlock = (id: string, files: string[]) => toolBlockText({ id, name: 'asset_view', status: 'success', arguments: { assets: '@b' }, result: 'ok', pictures: files.map(picture) })

// Every image and clip of `sections`, as a compaction reads them.
function assetsOf(sections: readonly Section[]): CompactionAsset[] {
  const found = [...conversationAssets(sections).found.values()]
  return compactionAssets(sections, found, assetPlaces(sections, found), new Map())
}

describe('compactionLeftFiles', () => {
  it('gives the files of the dropped intermediate assets only', () => {
    const sections = [
      user('u1', `Like this: ${imageMarkdown(RED, [{ key: 'id', value: 'a' }])}`),
      reply('a1', `${hiddenImage('j-aaaa', 'b')}\n${hiddenClip('j-aaaa', 'c')}\n${imageMarkdown(SKY, [{ key: 'id', value: 'd' }])}`),
      user('u2', 'More'),
      reply('b', ''),
    ]

    const left = compactionLeftFiles({ sections, replySectionId: 'b', dropped: assetsOf(sections), kept: [] })

    // Not the image `a` of the user, and not the image `d`, which the user
    // saw in the reply.
    expect(left).toStrictEqual({ sources: [HIDDEN_IMAGE_PATH, HIDDEN_CLIP_PATH], pictures: [] })
  })

  it('leaves out an intermediate asset in a section of the user, and a clip with no source', () => {
    // The user pasted the text of an intermediate image into a message.
    const pasted = [user('u1', hiddenImage('j-aaaa', 'b')), reply('b', '')]
    const sections = [user('u1', 'Hi'), reply('a1', hiddenClip('j-aaaa', 'c')), reply('b', '')]
    const [clip] = assetsOf(sections)
    const gone: CompactionAsset = { ...clip, asset: { ...clip.asset, kind: 'clip', clip: { kind: 'audio', id: 'c', type: 'audio/wav', src: null, url: null, expires: null } } as CompactionAsset['asset'] }

    expect(compactionLeftFiles({ sections: pasted, replySectionId: 'b', dropped: assetsOf(pasted), kept: [] }).sources).toStrictEqual([])
    expect(compactionLeftFiles({ sections, replySectionId: 'b', dropped: [gone], kept: [] }).sources).toStrictEqual([])
  })

  it('gives the picture copies of the old tag and of the replaced tool blocks, each one time, but not the ones that the new tag keeps', () => {
    const sections = [
      reply('notes', `${compactionTagText({ count: 1, lastId: 'b', pictures: [picture('old-tag.jpg'), picture('carried.jpg')] })}\nThe notes.`),
      // A block in a message of the user is plain text.
      user('u1', `Look:\n${viewBlock('call_0', ['typed.jpg'])}`),
      reply('a1', `${viewBlock('call_1', ['one.jpg', 'two.jpg'])}\n${viewBlock('call_2', ['one.jpg'])}`),
      user('u2', 'More'),
      reply('b', viewBlock('call_3', ['three.jpg'])),
      // After the reply that runs: the compaction does not replace it.
      user('u3', 'Typed'),
      reply('a3', viewBlock('call_4', ['later.jpg'])),
    ]

    const left = compactionLeftFiles({ sections, replySectionId: 'b', dropped: [], kept: [picture('carried.jpg'), picture('new.jpg')] })

    expect(left).toStrictEqual({ sources: [], pictures: ['old-tag.jpg', 'one.jpg', 'two.jpg', 'three.jpg'] })
  })
})
