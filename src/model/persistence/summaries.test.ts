import { describe, expect, it } from 'vitest'
import { compactionBlockText, compactionTagText } from '../chat/compaction'
import { HIDDEN_IMAGE_PATH, idImage } from '../chat/testing'
import { toolBlockText } from '../chat/toolBlocks'
import { conversationPreview, messageCount } from './summaries'
import type { ContentNodeData, SectionData } from './types'

function textNode(text: string): ContentNodeData {
  return { kind: 'text', text }
}

function section(role: SectionData['role'], nodes: ContentNodeData[]): SectionData {
  return { role, nodes }
}

describe('conversation summaries', () => {
  it('counts visible messages and builds a normalized preview from text and prompt nodes', () => {
    const sections = [
      section('user', [textNode('   ')]),
      section('user', [textNode('Hello\nthere')]),
      section('agent', [{ kind: 'prompt', id: 'p1', promptId: null, name: 'summary', body: 'Prompt body\nwith spacing', expanded: false }]),
    ]

    expect(messageCount(sections)).toBe(2)
    expect(conversationPreview(sections)).toBe('Hello there Prompt body with spacing')
  })

  it('leaves the tool blocks of agent text out of the preview and keeps the same text in user text', () => {
    const block = toolBlockText({ id: 'call_1', name: 'model_list', status: 'success', arguments: {}, result: '12 models' })
    const sections = [
      section('user', [textNode(`Like:\n${block}`)]),
      section('agent', [textNode(`${block}\nThere are 12.`)]),
    ]

    expect(conversationPreview(sections))
      .toBe('Like: <dez:tool id="call_1" name="model_list"> 12 models </dez:tool> There are 12.')
  })

  it('shows the media tags of agent and user text as labels', () => {
    const video = '<dez:video id="b" type="video/mp4" src="/home/u/.config/dez/assets/generated/video/v1.mp4" url="https://cdn.example/v.mp4"/>'
    const audio = '<dez:audio id="c" type="audio/mpeg"/>'
    const pasted = '<dez:video id="d" type="video/mp4" src="/home/u/.config/dez/assets/video/v2.mp4"/>'
    const sections = [
      section('user', [textNode(`Like:\n${audio}\n${pasted}`)]),
      section('agent', [textNode(`Here it is.\n${video}\n${audio}\nDone.`)]),
    ]

    expect(conversationPreview(sections)).toBe('Like: [audio] [video] Here it is. [video] [audio] Done.')
  })

  it('shows the app tags of agent and user text as labels with the name of the app, and a tag in code as its text', () => {
    const sections = [
      section('user', [textNode('Why is it empty?\n<dez:app name="notes"/>\n\n`<dez:app name="notes"/>`')]),
      section('agent', [textNode('Here it is.\n\n<dez:app name="unit-converter" open="1"/>\n\nTry it.')]),
    ]

    expect(conversationPreview(sections)).toBe('Why is it empty? [app notes] `<dez:app name="notes"/>` Here it is. [app unit-converter] Try it.')
  })

  // In a later agent section and in a user section the tag is plain text,
  // which the editor shows.
  it('shows the notes of a compaction block for people in the preview, and only that block', () => {
    const data = { count: 2, lastId: 'c', pictures: [] }
    const tag = compactionTagText(data)
    const sections = [
      section('agent', [textNode(`${compactionBlockText(data, `Notes of the work.\n${idImage(HIDDEN_IMAGE_PATH, 'b', true)}`)}\nTyped after it.`)]),
      section('user', [textNode('ask')]),
      section('agent', [textNode(`${tag}\nanswer`)]),
    ]

    expect(messageCount(sections)).toBe(3)
    expect(conversationPreview(sections)).toBe(`Notes of the work. [image] Typed after it. ask ${tag} answer`)
    expect(conversationPreview([section('user', [textNode(`${tag}\nask`)])])).toBe(`${tag} ask`)
  })
})
