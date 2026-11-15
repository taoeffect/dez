import { describe, expect, it } from 'vitest'
import { compactionTagText } from '../chat/compaction'
import { conversationCostText } from '../chat/compactionNotes'
import type { ConversationCost } from '../chat/conversationCost'
import { imageReferenceText } from '../chat/images'
import { holdsStoredFilePath } from '../chat/storedFilePaths'
import type { Section } from '../chat/types'
import { jobsListText, type JobInfo } from '../tools/jobs'
import { RED, SKY } from '../tools/testing'
import {
  answerHasNotes,
  compactionInstruction,
  compactionReason,
  newestReplyModel,
  readCompactionAnswer,
  repliedSinceCompaction,
  type AnswerAsset,
  type AssetDecision,
  type CompactionAnswer,
  type CompactionInstruction,
  type CompactionReason,
} from './compactionRequest'
import { NO_PICTURE_BUDGET, type PictureBudget } from './pictureBudget'
import { model, reply, user } from './testing'

const LIMITS: PictureBudget = { tokens: 50_000, bytes: 20_000_000, pictures: 20 }
// What a compaction leaves of LIMITS: half of each (`compactedPictureLimits`).
const LEAVES: PictureBudget = { tokens: 25_000, bytes: 10_000_000, pictures: 10 }

function reason(fields: Partial<Parameters<typeof compactionReason>[0]>): CompactionReason | null {
  return compactionReason({
    contextTokens: 0,
    threshold: 100_000,
    limits: LIMITS,
    leaves: LEAVES,
    spent: NO_PICTURE_BUDGET,
    kept: NO_PICTURE_BUDGET,
    requestSinceCompaction: true,
    ...fields,
  })
}

describe('compactionReason', () => {
  it('is null with no chat request since the last compaction, even when every number is over its limit', () => {
    expect(reason({ contextTokens: 500_000, spent: { tokens: 60_000, bytes: 30_000_000, pictures: 30 }, requestSinceCompaction: false })).toBeNull()
  })

  it('is due for the context size at exactly the threshold, and not one token under it', () => {
    expect(reason({ contextTokens: 100_000 })).toBe('tokens')
    expect(reason({ contextTokens: 99_999 })).toBeNull()
  })

  // 0.9 of the limits of LIMITS: 18 pictures, 18,000,000 bytes, 45,000 tokens.
  it.each<[CompactionReason, Partial<PictureBudget>, Partial<PictureBudget>]>([
    ['images', { pictures: 18 }, { pictures: 17 }],
    ['bytes', { bytes: 18_000_000 }, { bytes: 17_999_999 }],
    ['pictureTokens', { tokens: 45_000 }, { tokens: 44_999 }],
  ])('is due for %s at exactly 0.9 of its limit, and not just under it', (expected, at, under) => {
    expect(reason({ spent: { ...NO_PICTURE_BUDGET, ...at } })).toBe(expected)
    expect(reason({ spent: { ...NO_PICTURE_BUDGET, ...under } })).toBeNull()
  })

  it('names the first due reason in the order tokens, images, bytes, picture tokens', () => {
    const over: PictureBudget = { tokens: 50_000, bytes: 20_000_000, pictures: 20 }

    expect([
      reason({ contextTokens: 100_000, spent: over }),
      reason({ spent: over }),
      reason({ spent: { ...over, pictures: 0 } }),
      reason({ spent: { ...over, pictures: 0, bytes: 0 } }),
    ]).toStrictEqual(['tokens', 'images', 'bytes', 'pictureTokens'])
  })

  // The images of the kept messages of the user stay in the compaction
  // message, so a second compaction would make no room for pictures.
  it.each<[CompactionReason, keyof PictureBudget]>([
    ['images', 'pictures'],
    ['bytes', 'bytes'],
    ['pictureTokens', 'tokens'],
  ])('is not due for %s while the pictures cost no more than the newest compaction left', (expected, part) => {
    const spent = { ...NO_PICTURE_BUDGET, [part]: LIMITS[part] }

    expect(reason({ spent, kept: spent })).toBeNull()
    expect(reason({ spent, kept: { ...spent, [part]: LIMITS[part] - 1 } })).toBe(expected)
    // The context size does not follow the pictures.
    expect(reason({ contextTokens: 100_000, spent, kept: spent })).toBe('tokens')
  })

  // 0.9 of a limit of 1 picture is under 1 picture, and a compaction
  // leaves 1: without this rule, each request would compact.
  it('is not due for images while the context holds no more of them than a compaction leaves', () => {
    const one = { ...NO_PICTURE_BUDGET, pictures: 1 }

    expect(reason({ limits: { ...LIMITS, pictures: 1 }, leaves: { ...LEAVES, pictures: 1 }, spent: one })).toBeNull()
    expect(reason({ limits: { ...LIMITS, pictures: 2 }, leaves: { ...LEAVES, pictures: 1 }, spent: { ...one, pictures: 2 } })).toBe('images')
  })

  it('is never due for the pictures of a model that takes no image, or of one with no image limit', () => {
    expect(reason({ limits: { ...LIMITS, pictures: 0 }, leaves: { ...LEAVES, pictures: 0 } })).toBeNull()
    expect(reason({ limits: { ...LIMITS, pictures: Infinity }, leaves: { ...LEAVES, pictures: Infinity }, spent: { ...NO_PICTURE_BUDGET, pictures: 5000 } })).toBeNull()
  })
})

// The compaction section of a compacted conversation.
const notes = reply('notes', `${compactionTagText({ count: 1, lastId: null, pictures: [] })}\nThe notes.`)

describe('repliedSinceCompaction', () => {
  it.each<[string, Section[], boolean]>([
    ['a first message', [user('u1', 'Hi'), reply('b', '')], false],
    ['a message after a reply', [user('u1', 'Hi'), reply('a1', 'Hello'), user('u2', 'More'), reply('b', '')], true],
    ['a message after a reply that has no text', [user('u1', 'Hi'), reply('a1', ' \n'), user('u2', 'More'), reply('b', '')], false],
    ['a message right after a compaction', [notes, user('u1', 'Hi'), user('u2', 'More'), reply('b', '')], false],
    ['a message after a reply since the compaction', [notes, user('u1', 'Hi'), reply('a1', 'Hello'), user('u2', 'More'), reply('b', '')], true],
    // The text of the reply that runs is no earlier reply.
    ['a reply that runs, with text', [user('u1', 'Hi'), reply('b', 'So far')], false],
    ['a reply after the one that runs', [user('u1', 'Hi'), reply('b', ''), user('u2', 'Typed'), reply('a2', 'Later')], false],
  ])('for %s', (_name, sections, expected) => {
    expect(repliedSinceCompaction(sections, 'b')).toBe(expected)
  })
})

describe('newestReplyModel', () => {
  const other = { providerId: 'other', modelId: 'large' }

  it('gives the model of the newest reply with text before the reply that runs', () => {
    const sections: Section[] = [
      user('u1', 'Hi'),
      { ...reply('a1', 'Hello'), model: other },
      user('u2', 'More'),
      // A reply with no text, and one that tells no model.
      reply('a2', ''),
      { id: 'a3', role: 'agent', content: [{ kind: 'text', text: 'From an older Dez' }] },
      reply('b', ''),
      { ...reply('a4', 'Later'), model },
    ]

    expect(newestReplyModel(sections, 'b')).toStrictEqual(other)
  })

  it('gives null when no reply before the one that runs tells its model', () => {
    expect(newestReplyModel([user('u1', 'Hi'), reply('b', 'So far')], 'b')).toBeNull()
  })
})

const TABLE = 'The images and the clips of the conversation (id | kind | facts).\n@a | image | 800 x 600 PNG\n@b | audio | 12 s WAV'

function instruction(fields: Partial<CompactionInstruction> = {}): string {
  return compactionInstruction({ assetTable: TABLE, jobs: [], cost: undefined, tools: true, ...fields })
}

describe('compactionInstruction', () => {
  it('holds the asset table as it was given', () => {
    expect(instruction()).toContain(TABLE)
  })

  it('holds the lines of the jobs of the reply', () => {
    const jobs: JobInfo[] = [
      { id: 'j1', tool: 'model_invoke', status: 'running', delivered: false, elapsedMs: 12_000, state: 'Queued.', call: { number: 1, label: 'A red cat' } },
      { id: 'j2', tool: 'shell', status: 'finished', delivered: false, elapsedMs: 3_400, state: '', call: { number: 2, label: '' }, cost: 0.04 },
    ]

    expect(instruction({ jobs })).toContain(jobsListText(jobs))
  })

  it('holds the cost of the conversation so far', () => {
    const cost: ConversationCost = { usd: 1.25, requests: 4, unpriced: 1 }

    expect(instruction({ cost })).toContain(conversationCostText(cost, 'so far'))
  })

  it('names asset_view only in a request that offers the Dez tools', () => {
    expect(instruction({ tools: true })).toContain('asset_view')
    expect(instruction({ tools: false })).not.toContain('asset_view')
  })

  it('holds no path of a stored file from the asset table', () => {
    const assetTable = [
      'The images and the clips of the conversation (id | kind | facts).',
      `@a | image | ${imageReferenceText({ path: RED, metadata: [{ key: 'id', value: 'a' }] }, false)}`,
      `@e | image | 640 x 480 PNG, at ${SKY}`,
    ].join('\n')
    const text = instruction({ assetTable })

    expect(holdsStoredFilePath(text)).toBe(false)
    expect(['/home/u', '.config/dez', 'assets/images', 'red.jpg', 'sky.png'].filter((part) => text.includes(part))).toStrictEqual([])
    expect(text).toContain('(id=a)')
  })

  it('asks for the four headings that readCompactionAnswer reads, in the order of its parts', () => {
    const headings = instruction().split('\n').filter((line) => line.startsWith('## '))
    const answer = readCompactionAnswer(headings.map((heading, index) => `${heading}\n@a: keep - Part ${index + 1}.`).join('\n'))

    expect(answer).toStrictEqual({
      summary: '@a: keep - Part 1.',
      requirements: '@a: keep - Part 2.',
      nextSteps: '@a: keep - Part 3.',
      assets: [{ id: 'a', decision: 'keep', sentence: 'Part 4.' }],
    })
  })
})

const asset = (id: string, decision: AssetDecision, sentence = ''): AnswerAsset => ({ id, decision, sentence })

describe('readCompactionAnswer', () => {
  it('reads the three parts and the asset lines of the plain form', () => {
    const text = [
      '## Summary',
      'The user wants a red cat.',
      'The first draft failed: the model gave a dog.',
      '',
      '## Requirements and decisions',
      'The tail stays long.',
      '',
      '## Next steps',
      'Draw the cat again with studio/paint.',
      '',
      '## Assets',
      '@a: show - The red cat from the user.',
      '@b: drop - The dog of the failed draft.',
    ].join('\n')

    expect(readCompactionAnswer(text)).toStrictEqual({
      summary: 'The user wants a red cat.\nThe first draft failed: the model gave a dog.',
      requirements: 'The tail stays long.',
      nextSteps: 'Draw the cat again with studio/paint.',
      assets: [asset('a', 'show', 'The red cat from the user.'), asset('b', 'drop', 'The dog of the failed draft.')],
    })
  })

  // The answer starts in the assets part, which loses a line that is no
  // heading and no asset line.
  it.each<[string, 'summary' | 'requirements' | 'nextSteps']>([
    ['**Summary**', 'summary'],
    ['Summary:', 'summary'],
    ['### 1. Summary', 'summary'],
    ['**Requirements & decisions:**', 'requirements'],
    ['## NEXT STEPS', 'nextSteps'],
  ])('reads %s as a heading', (heading, part) => {
    expect(readCompactionAnswer(`## Assets\n${heading}\nThe text.`)[part]).toBe('The text.')
  })

  it('reads **Assets:** as the heading of the assets', () => {
    expect(readCompactionAnswer('## Summary\nDone.\n**Assets:**\n@a: keep - The cat.')).toStrictEqual({
      summary: 'Done.',
      requirements: '',
      nextSteps: '',
      assets: [asset('a', 'keep', 'The cat.')],
    })
  })

  it('reads a bare name line, and a line with a colon that names no part, as text of its part', () => {
    expect(readCompactionAnswer('## Next steps\nThe plan:\nSummary\nDraw the cat.')).toStrictEqual({
      summary: '',
      requirements: '',
      nextSteps: 'The plan:\nSummary\nDraw the cat.',
      assets: [],
    })
  })

  it('reads an answer in a code fence as the answer inside it', () => {
    expect(readCompactionAnswer('```markdown\n## Summary\nDone.\n## Assets\n@a: keep - The cat.\n```\n')).toStrictEqual({
      summary: 'Done.',
      requirements: '',
      nextSteps: '',
      assets: [asset('a', 'keep', 'The cat.')],
    })
  })

  it('keeps a code fence inside a part', () => {
    expect(readCompactionAnswer('## Summary\nThe test ran:\n```\nnpm test\n```').summary).toBe('The test ran:\n```\nnpm test\n```')
  })

  it('reads the text before the first heading, and an answer with no heading, as summary', () => {
    expect(readCompactionAnswer('The user asked for a cat.\n## Summary\nA cat was drawn.').summary).toBe('The user asked for a cat.\nA cat was drawn.')
    expect(readCompactionAnswer('Only notes.\nMore notes.')).toStrictEqual({ summary: 'Only notes.\nMore notes.', requirements: '', nextSteps: '', assets: [] })
  })

  it('goes on with the part of a heading that comes a second time', () => {
    const text = '## Summary\nOne.\n## Assets\n@a: keep\n## Next steps\nGo.\n## Summary\nTwo.\n## Assets\n@b: drop'

    expect(readCompactionAnswer(text)).toStrictEqual({
      summary: 'One.\nTwo.',
      requirements: '',
      nextSteps: 'Go.',
      assets: [asset('a', 'keep'), asset('b', 'drop')],
    })
  })

  it.each([
    '- @a: keep - The cat.',
    '1. @a: keep - The cat.',
    '| @a | keep | The cat. |',
    '**@a**: **keep** - The cat.',
    '`@a`: `keep` - The cat.',
    '@a: KEEP - The cat.',
    '@a | keep | The cat.',
    '@a = keep = The cat.',
    '@a - keep - The cat.',
    '@a > keep > The cat.',
  ])('reads the asset line %s', (line) => {
    expect(readCompactionAnswer(`## Assets\n${line}`).assets).toStrictEqual([asset('a', 'keep', 'The cat.')])
  })

  it('gives a blank sentence to an asset line with none', () => {
    expect(readCompactionAnswer('## Assets\n@a: drop\n| @b | show | |').assets).toStrictEqual([asset('a', 'drop'), asset('b', 'show')])
  })

  // A line that the reader took as `a` would win over the later line of `a`.
  it.each([
    ['an upper-case id', '@A: drop'],
    // `@a-team` is no mention of `a` (imageMentions.ts).
    ['a hyphenated word that starts with an id', '@a-team: drop'],
    ['a word that only starts with a decision', '@a: dropped by the user'],
  ])('takes no decision from a line with %s', (_name, line) => {
    expect(readCompactionAnswer(`## Assets\n${line}\n@a: keep - The cat.`).assets).toStrictEqual([asset('a', 'keep', 'The cat.')])
  })

  it('reads an asset line outside the assets part as text of its part', () => {
    expect(readCompactionAnswer('## Next steps\n@a: drop - The cat.\n## Assets\n@b: keep - The dog.')).toStrictEqual({
      summary: '',
      requirements: '',
      nextSteps: '@a: drop - The cat.',
      assets: [asset('b', 'keep', 'The dog.')],
    })
  })

  it('joins the lines that go on with the sentence of an asset line, up to a blank line', () => {
    const text = [
      '## Assets',
      '@a: keep - The first cat,',
      'drawn by studio/paint,',
      'with a long tail.',
      '@b: drop - A draft.',
      '',
      'A free line after a blank line.',
      '@c: show',
    ].join('\n')

    expect(readCompactionAnswer(text).assets).toStrictEqual([
      asset('a', 'keep', 'The first cat, drawn by studio/paint, with a long tail.'),
      asset('b', 'drop', 'A draft.'),
      asset('c', 'show'),
    ])
  })

  it('keeps the first line of an id that comes two times, and joins no line after the second one to it', () => {
    const text = '## Assets\n@a: show - The first line.\n@a: drop - The second line,\nwhich goes on.\n@b: keep - The dog.'

    expect(readCompactionAnswer(text).assets).toStrictEqual([asset('a', 'show', 'The first line.'), asset('b', 'keep', 'The dog.')])
  })

  it('gives the assets in the order of their lines', () => {
    expect(readCompactionAnswer('## Assets\n@c: keep\n@a: drop\n@b: show').assets.map(({ id }) => id)).toStrictEqual(['c', 'a', 'b'])
  })

  it('reads an answer whose lines end with CRLF', () => {
    expect(readCompactionAnswer('## Summary\r\nDone.\r\n## Assets\r\n@a: keep - The cat.\r\n@b: drop\r\n')).toStrictEqual({
      summary: 'Done.',
      requirements: '',
      nextSteps: '',
      assets: [asset('a', 'keep', 'The cat.'), asset('b', 'drop')],
    })
  })
})

const NO_NOTES: CompactionAnswer = { summary: '', requirements: '', nextSteps: '', assets: [] }

describe('answerHasNotes', () => {
  it('is false for an empty answer and for an answer with only asset lines', () => {
    expect(answerHasNotes(NO_NOTES)).toBe(false)
    expect(answerHasNotes({ ...NO_NOTES, assets: [asset('a', 'keep', 'The cat.')] })).toBe(false)
  })

  it.each<[string, Partial<CompactionAnswer>]>([
    ['summary', { summary: 'Done.' }],
    ['requirements', { requirements: 'Red only.' }],
    ['next steps', { nextSteps: 'Draw the cat.' }],
  ])('is true when the %s part has text', (_name, part) => {
    expect(answerHasNotes({ ...NO_NOTES, ...part })).toBe(true)
  })
})
