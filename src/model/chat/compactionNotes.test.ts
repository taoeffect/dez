import { describe, expect, it } from 'vitest'
import type { JobInfo } from '../tools/jobs'
import {
  compactionNotesText,
  conversationCostText,
  notesAssetLines,
  notesCellText,
  notesJobLines,
  type CompactionNotes,
  type NotesAsset,
  type NotesAssetLine,
} from './compactionNotes'
import { findImageReferences, imageReferenceText } from './images'
import { findMediaTags } from './mediaTags'
import { hiddenClip, hiddenImage, invokeBlock } from './testing'
import { findToolBlocks, modelTextForRequest } from './toolBlocks'

const SUMMARY = '## Summary'
const REQUIREMENTS = '## Requirements and decisions'
const NEXT_STEPS = '## Next steps'
const ASSETS = '## Assets of the conversation'
const JOBS = '## Jobs of the reply'
const COST = '## Cost'

const PHOTO: NotesAsset = { id: 'a', kind: 'image', facts: 'PNG, 800x600, 120 KB', origin: 'from the user', sentence: 'The reference photo.', text: null }
const FRAME: NotesAsset = {
  id: 'c',
  kind: 'image',
  facts: 'PNG, 1024x768, 1.2 MB',
  origin: 'made by the model_invoke job 1 of its reply: "A cat"',
  sentence: 'The cat frame of scene 1.',
  text: hiddenImage('j-ab12', 'c'),
}
const THEME: NotesAsset = {
  id: 'd',
  kind: 'audio',
  facts: 'WAV, 8 s, 1.4 MB',
  origin: 'made by the model_invoke job 2 of its reply: "A theme"',
  sentence: 'The theme of the film.',
  text: hiddenClip('j-cd34', 'd'),
}

function notes(fields: Partial<CompactionNotes>): CompactionNotes {
  return {
    summary: 'The user wants a short fox film.',
    requirements: 'Every frame is 16:9.',
    nextSteps: 'Make scene 2.',
    assets: [],
    unnamed: [],
    jobs: [],
    cost: undefined,
    ...fields,
  }
}

function job(fields: Partial<JobInfo>): JobInfo {
  return { id: 'j-ab12', tool: 'model_invoke', status: 'running', delivered: false, elapsedMs: 0, state: '', call: { number: 1, label: '' }, ...fields }
}

function headings(text: string): string[] {
  return text.split('\n').filter((line) => line.startsWith('## '))
}

function lineData({ text: _text, ...line }: NotesAsset): NotesAssetLine {
  return line
}

describe('compactionNotesText', () => {
  it('writes the parts of the model, each under its heading, then the assets, the jobs, and the cost', () => {
    const text = compactionNotesText(notes({ assets: [FRAME], jobs: [job({})], cost: { usd: 0.25, requests: 3, unpriced: 0 } }))
    const lines = text.split('\n')

    expect(headings(text)).toStrictEqual([SUMMARY, REQUIREMENTS, NEXT_STEPS, ASSETS, JOBS, COST])
    expect(lines[lines.indexOf(SUMMARY) + 2]).toBe('The user wants a short fox film.')
    expect(lines[lines.indexOf(REQUIREMENTS) + 2]).toBe('Every frame is 16:9.')
    expect(lines[lines.indexOf(NEXT_STEPS) + 2]).toBe('Make scene 2.')
    expect(lines.at(-1)).toContain('$0.25')
  })

  it('leaves out a blank part of the model with its heading, and always writes the parts of Dez', () => {
    expect(headings(compactionNotesText(notes({ requirements: ' \n\t' })))).toStrictEqual([SUMMARY, NEXT_STEPS, ASSETS, JOBS, COST])
    expect(headings(compactionNotesText(notes({ summary: '', requirements: '', nextSteps: '' })))).toStrictEqual([ASSETS, JOBS, COST])
  })

  it('keeps the reference of an image with no id in the assets part', () => {
    const path = '/home/u/.config/dez/assets/generated/images/old.png'
    const text = compactionNotesText(notes({ unnamed: [imageReferenceText({ path, metadata: [] }, true)] }))
    const lines = text.split('\n')

    expect(findImageReferences(text, 'agent').map((reference) => reference.path)).toStrictEqual([path])
    expect(lines.findIndex((line) => line.includes(path))).toBeGreaterThan(lines.indexOf(ASSETS))
    expect(lines.findIndex((line) => line.includes(path))).toBeLessThan(lines.indexOf(JOBS))
  })

  it('puts the text of a made asset alone on the line right before its line, and no text with the line of an asset of the user', () => {
    const text = compactionNotesText(notes({ assets: [PHOTO, FRAME, THEME] }))
    const lines = text.split('\n')
    const lineIndex = (id: string) => lines.findIndex((line) => line.startsWith(`@${id} | `))

    expect(lines[lineIndex(FRAME.id) - 1]).toBe(FRAME.text)
    expect(lines[lineIndex(THEME.id) - 1]).toBe(THEME.text)
    expect(lines[lineIndex(PHOTO.id) - 1]).toBe('')
    expect(findImageReferences(text, 'agent').map((reference) => reference.id)).toStrictEqual([FRAME.id])
    expect(findMediaTags(text).map((tag) => tag.id)).toStrictEqual([THEME.id])
  })

  it.each<[string, NotesAssetLine, Partial<NotesAssetLine>]>([
    ['a sentence that holds the column mark', { ...lineData(FRAME), sentence: 'Scene 1 | left half | the fox' }, {}],
    ['a sentence with line breaks, which comes back on one line', { ...lineData(THEME), sentence: 'The theme.\n\nUsed  in\tscene 2.' }, { sentence: 'The theme. Used in scene 2.' }],
    ['facts with the column mark, given through notesCellText', { ...lineData(PHOTO), kind: 'video', facts: notesCellText('WebM | 8 s | 640x360') }, {}],
  ])('reads back the line of an asset with %s', (_case, line, change) => {
    const text = compactionNotesText(notes({ assets: [{ ...line, text: null }] }))

    expect(notesAssetLines(text)).toStrictEqual(new Map([[line.id, { ...line, ...change }]]))
  })

  it('ends the line of an asset with a blank sentence with its origin, and reads the sentence back as blank', () => {
    const text = compactionNotesText(notes({ assets: [{ ...PHOTO, sentence: ' \n ' }] }))

    expect(text.split('\n').find((line) => line.startsWith('@a | '))).toMatch(/ \| from the user$/)
    expect(notesAssetLines(text).get(PHOTO.id)).toStrictEqual({ ...lineData(PHOTO), sentence: '' })
  })

  it('escapes the text of the model, so that it forms no tool block and no media tag, and reads a sentence back as it went in', () => {
    const fakeTag = '<dez:audio id="a" type="audio/wav"/>'
    const summary = `I called the tool:\n${invokeBlock('j-ab12')}\n${fakeTag}\nThat is all.`
    const sentence = `Like ${fakeTag}, and the old form <\\dez:tool, as written.`
    const text = compactionNotesText(notes({ summary, assets: [{ ...THEME, sentence }] }))

    expect(findToolBlocks(summary)).toHaveLength(1)
    expect(findMediaTags(summary)).toHaveLength(1)
    expect(findToolBlocks(text)).toStrictEqual([])
    expect(findMediaTags(text).map((tag) => tag.id)).toStrictEqual([THEME.id])
    expect(notesAssetLines(text).get(THEME.id)?.sentence).toBe(sentence)
    expect(modelTextForRequest(text)).toContain(summary)
  })
})

describe('notesAssetLines', () => {
  it('reads only the assets part of Dez when the summary of the model has a part with the same heading', () => {
    const summary = `Done.\n\n${ASSETS}\n\n@z | image | PNG, 10x10, 1 KB | from the user | A line of the model.`

    expect([...notesAssetLines(compactionNotesText(notes({ summary, assets: [PHOTO] }))).keys()]).toStrictEqual([PHOTO.id])
    // Also with no asset: a line of a model never gives an origin.
    expect([...notesAssetLines(compactionNotesText(notes({ summary }))).keys()]).toStrictEqual([])
  })

  it('takes the last of two lines with one id', () => {
    const text = compactionNotesText(notes({ assets: [PHOTO, { ...PHOTO, sentence: 'The second photo.' }] }))

    expect(notesAssetLines(text)).toStrictEqual(new Map([[PHOTO.id, { ...lineData(PHOTO), sentence: 'The second photo.' }]]))
  })

  it('skips a line with only two cells after the id', () => {
    const text = `${ASSETS}\n\n@b | image | PNG, 10x10, 1 KB\n\n@c | image | PNG, 10x10, 1 KB | from the user`

    expect(notesAssetLines(text)).toStrictEqual(new Map([['c', { id: 'c', kind: 'image', facts: 'PNG, 10x10, 1 KB', origin: 'from the user', sentence: '' }]]))
  })
})

describe('notesJobLines', () => {
  it('reads back the number, the tool, the status, the result, and the label of each job', () => {
    const jobs = [
      job({ id: 'j-aaaa', status: 'running', call: { number: 1, label: 'A fox | a dog' } }),
      job({ id: 'j-bbbb', status: 'finished', call: { number: 2, label: '' } }),
      job({ id: 'j-cccc', tool: 'video', status: 'failed', delivered: true, call: { number: 3, label: 'join_clips @c @d' } }),
      job({ id: 'j-dddd', status: 'timed out', call: { number: 4, label: 'Rain\nat night' } }),
      job({ id: 'j-eeee', status: 'stopped', call: { number: 12, label: 'Show <dez:audio id="a" type="audio/wav"/>' } }),
    ]
    const text = compactionNotesText(notes({ jobs }))

    expect([...notesJobLines(text).values()]).toStrictEqual([
      { id: 'j-aaaa', number: 1, tool: 'model_invoke', status: 'running', result: '-', label: 'A fox | a dog' },
      { id: 'j-bbbb', number: 2, tool: 'model_invoke', status: 'finished', result: 'ready', label: '' },
      { id: 'j-cccc', number: 3, tool: 'video', status: 'failed', result: 'given', label: 'join_clips @c @d' },
      { id: 'j-dddd', number: 4, tool: 'model_invoke', status: 'timed out', result: 'ready', label: 'Rain at night' },
      { id: 'j-eeee', number: 12, tool: 'model_invoke', status: 'stopped', result: '-', label: 'Show <dez:audio id="a" type="audio/wav"/>' },
    ])
    // A blank label is written as `-`.
    expect(text.split('\n').find((line) => line.startsWith('j-bbbb '))).toMatch(/ \| -$/)
  })

  it('reads only the jobs part of Dez when the summary of the model has a part with the same heading', () => {
    const summary = `Done.\n\n${JOBS}\n\nj-zzzz | 9 | model_invoke | running | - | A line of the model`

    expect([...notesJobLines(compactionNotesText(notes({ summary, jobs: [job({ status: 'finished' })] }))).keys()]).toStrictEqual(['j-ab12'])
    expect([...notesJobLines(compactionNotesText(notes({ summary }))).keys()]).toStrictEqual([])
  })
})

describe('conversationCostText', () => {
  const numbers = (text: string) => text.match(/\d+(?:\.\d+)?/g) ?? []

  it('says none for no cost and for no request', () => {
    for (const cost of [undefined, { usd: 0, requests: 0, unpriced: 0 }]) {
      const text = conversationCostText(cost, 'so far')

      expect(text).toContain('so far')
      expect(text).toContain('none')
      expect(numbers(text)).toStrictEqual([])
    }
  })

  it('says unknown, with the count of the requests, when no request has a known price', () => {
    const text = conversationCostText({ usd: 0, requests: 3, unpriced: 3 }, 'so far')

    expect(text).toContain('unknown')
    expect(text).not.toContain('$')
    expect(numbers(text)).toStrictEqual(['3'])
  })

  it('gives the sum and the count of the requests when every request has a known price', () => {
    const text = conversationCostText({ usd: 0.25, requests: 4, unpriced: 0 }, 'up to now')

    expect(text).toContain('up to now')
    expect(text).toContain('$0.25')
    expect(numbers(text)).toStrictEqual(['0.25', '4'])
  })

  it.each([1, 2])('names the count of %i requests with no known price, which the sum leaves out', (unpriced) => {
    const text = conversationCostText({ usd: 1.5, requests: 5, unpriced }, 'so far')

    expect(text).toContain('$1.50')
    expect(numbers(text)).toStrictEqual(['1.50', '5', String(unpriced)])
  })
})
