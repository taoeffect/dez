import { describe, expect, it } from 'vitest'
import { compactionTagText } from '../chat/compaction'
import { conversationCostText } from '../chat/compactionNotes'
import type { ConversationCost } from '../chat/conversationCost'
import { mediaTagText } from '../chat/mediaTags'
import { holdsStoredFilePath } from '../chat/storedFilePaths'
import { idImage } from '../chat/testing'
import type { Section } from '../chat/types'
import { jobsListText } from '../tools/jobs'
import { FILM, jobInfo, RED, SKY } from '../tools/testing'
import { compactionScope, middleMessageStarts } from './compactionAssets'
import {
  answerHasNotes,
  compactionInstruction,
  compactionReason,
  newestReplyModel,
  readCompactionAnswer,
  repliedSinceCompaction,
  type AnswerAsset,
  type AnswerMessage,
  type AssetDecision,
  type CompactionAnswer,
  type CompactionInstruction,
  type CompactionReason,
  type MessageDecision,
} from './compactionRequest'
import { NO_PICTURE_BUDGET, type PictureBudget } from './pictureBudget'
import { model, reply, user } from './testing'

const LIMITS: PictureBudget = { tokens: 50_000, bytes: 20_000_000, pictures: 20 }
// What a compaction leaves of LIMITS: half of each (`compactedPictureLimits`).
const LEAVES: PictureBudget = { tokens: 25_000, bytes: 10_000_000, pictures: 10 }

function reason(fields: Partial<Parameters<typeof compactionReason>[0]>): CompactionReason | null {
  return compactionReason({
    contextTokens: 0,
    dueSize: 100_000,
    limits: LIMITS,
    leaves: LEAVES,
    spent: NO_PICTURE_BUDGET,
    kept: NO_PICTURE_BUDGET,
    ...fields,
  })
}

describe('compactionReason', () => {
  it('is due for the context size at exactly its due size, and not one token under it', () => {
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
  return compactionInstruction({ middleMessages: [], assetTable: TABLE, jobs: [], cost: undefined, tools: true, ...fields })
}

describe('compactionInstruction', () => {
  it('holds the asset table as it was given', () => {
    expect(instruction()).toContain(TABLE)
  })

  it('holds the lines of the jobs of the reply', () => {
    const jobs = [
      jobInfo({ id: 'j1', elapsedMs: 12_000, state: 'Queued.', call: { number: 1, label: 'A red cat' } }),
      jobInfo({ id: 'j2', tool: 'shell', status: 'finished', elapsedMs: 3_400, call: { number: 2, label: '' }, cost: 0.04 }),
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
      `@a | image | ${idImage(RED, 'a')}`,
      `@e | image | 640 x 480 PNG, at ${SKY}`,
    ].join('\n')
    const text = instruction({ assetTable })

    expect(holdsStoredFilePath(text)).toBe(false)
    expect(['/home/u', '.config/dez', 'assets/images', 'red.jpg', 'sky.png'].filter((part) => text.includes(part))).toStrictEqual([])
    expect(text).toContain('(id=a)')
  })

  // The lines of the list of the middle messages: `m1: "start"`.
  const listed = (text: string) => text.split('\n').filter((line) => /^m\d+: "/.test(line))

  it('lists each middle message of the user as m1 to mN, oldest first, on one line with labels and no path of a stored file', () => {
    const sections: Section[] = [
      user('u1', 'Make a film of a red cat.'),
      user('u2', `For the middle part use my screenshot\n${idImage(SKY, 'e')}\nand my clip\n${mediaTagText(FILM)}\nnot the renders.`),
      user('u3', 'ok'),
      user('u4', 'Make the film now.'),
      reply('r', ''),
    ]
    const text = instruction({ middleMessages: middleMessageStarts(compactionScope(sections, 'r')) })

    expect(listed(text)).toStrictEqual([
      'm1: "For the middle part use my screenshot [image] and my clip [video] not the renders."',
      'm2: "ok"',
    ])
    expect(holdsStoredFilePath(text)).toBe(false)
    expect(['sky.png', 'v1.webm'].filter((part) => text.includes(part))).toStrictEqual([])
  })

  it('tells that the answer needs no message line when no message of the user came between the first and the newest one', () => {
    const text = instruction({ middleMessages: [] })

    expect(listed(text)).toStrictEqual([])
    expect(text).toContain('needs no line under the Middle messages heading')
  })

  it('asks for the three headings that readCompactionAnswer reads, in the order of its parts', () => {
    const headings = instruction().split('\n').filter((line) => line.startsWith('## '))
    const answer = readCompactionAnswer(headings.map((heading, index) => `${heading}\nm${index + 1}: drop\n@a: keep - Part ${index + 1}.`).join('\n'))

    expect(answer).toStrictEqual({
      requirements: 'm1: drop\n@a: keep - Part 1.',
      messages: [{ number: 2, decision: 'drop' }],
      assets: [{ id: 'a', decision: 'keep', sentence: 'Part 3.' }],
    })
  })
})

const asset = (id: string, decision: AssetDecision, sentence = ''): AnswerAsset => ({ id, decision, sentence })
const message = (number: number, decision: MessageDecision): AnswerMessage => ({ number, decision })

describe('readCompactionAnswer', () => {
  it('reads the three parts, the message lines, and the asset lines of the plain form', () => {
    const text = [
      '## Requirements and decisions',
      'The tail stays long.',
      'The first draft failed: the model gave a dog.',
      '',
      '## Middle messages',
      'm1: keep',
      'm2: drop',
      '',
      '## Assets',
      '@a: show - The red cat from the user.',
      '@b: drop - The dog of the failed draft.',
    ].join('\n')

    expect(readCompactionAnswer(text)).toStrictEqual({
      requirements: 'The tail stays long.\nThe first draft failed: the model gave a dog.',
      messages: [message(1, 'keep'), message(2, 'drop')],
      assets: [asset('a', 'show', 'The red cat from the user.'), asset('b', 'drop', 'The dog of the failed draft.')],
    })
  })

  // The answer starts in the assets part, which loses a line that is no
  // heading and no asset line.
  it.each(['**Requirements & decisions:**', 'Decisions:', '**Summary**', 'Summary:', '### 1. Summary', '## NEXT STEPS', '## Next step'])(
    'reads %s as a heading of the requirements',
    (heading) => {
      expect(readCompactionAnswer(`## Assets\n${heading}\nThe text.`).requirements).toBe('The text.')
    },
  )

  // A model can copy the headings of older notes, which had the parts
  // Summary and Next steps.
  it('reads the text under the Summary and the Next steps headings as requirements', () => {
    const text = '## Summary\nA cat was drawn.\n## Requirements and decisions\nRed only.\n## Next steps\nDraw the tail.'

    expect(readCompactionAnswer(text)).toStrictEqual({ requirements: 'A cat was drawn.\nRed only.\nDraw the tail.', messages: [], assets: [] })
  })

  it.each(['## Middle messages', '**Relevant middle messages:**', '### User messages', 'Messages:'])('reads %s as the heading of the middle messages', (heading) => {
    expect(readCompactionAnswer(`Done.\n${heading}\nm1: drop`)).toStrictEqual({ requirements: 'Done.', messages: [message(1, 'drop')], assets: [] })
  })

  // `## Assets of the conversation` is the heading of the earlier notes,
  // which a model can copy at a second compaction.
  it.each(['**Assets:**', '## Assets of the conversation'])('reads %s as the heading of the assets', (heading) => {
    expect(readCompactionAnswer(`Done.\n${heading}\n@a: drop - The cat.`)).toStrictEqual({
      requirements: 'Done.',
      messages: [],
      assets: [asset('a', 'drop', 'The cat.')],
    })
  })

  it('reads a bare name line, and a line with a colon that names no part, as text of its part', () => {
    expect(readCompactionAnswer('## Requirements and decisions\nThe plan:\nAssets\nMiddle messages\nDraw the cat.')).toStrictEqual({
      requirements: 'The plan:\nAssets\nMiddle messages\nDraw the cat.',
      messages: [],
      assets: [],
    })
  })

  it('reads an answer in a code fence as the answer inside it', () => {
    expect(readCompactionAnswer('```markdown\n## Requirements and decisions\nDone.\n## Assets\n@a: keep - The cat.\n```\n')).toStrictEqual({
      requirements: 'Done.',
      messages: [],
      assets: [asset('a', 'keep', 'The cat.')],
    })
  })

  it('keeps a code fence inside a part', () => {
    expect(readCompactionAnswer('## Requirements and decisions\nThe test ran:\n```\nnpm test\n```').requirements).toBe('The test ran:\n```\nnpm test\n```')
  })

  it('reads the text before the first heading, and an answer with no heading, as requirements', () => {
    expect(readCompactionAnswer('The user asked for a cat.\n## Middle messages\nm1: keep\n## Requirements and decisions\nRed only.').requirements)
      .toBe('The user asked for a cat.\nRed only.')
    expect(readCompactionAnswer('Only notes.\nMore notes.')).toStrictEqual({ requirements: 'Only notes.\nMore notes.', messages: [], assets: [] })
  })

  it('goes on with the part of a heading that comes a second time', () => {
    const text = '## Requirements and decisions\nOne.\n## Assets\n@a: keep\n## Middle messages\nm1: keep\n## Requirements and decisions\nTwo.\n## Assets\n@b: drop\n## Middle messages\nm2: drop'

    expect(readCompactionAnswer(text)).toStrictEqual({
      requirements: 'One.\nTwo.',
      messages: [message(1, 'keep'), message(2, 'drop')],
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
    expect(readCompactionAnswer('## Requirements and decisions\n@a: drop - The cat.\n## Assets\n@b: keep - The dog.')).toStrictEqual({
      requirements: '@a: drop - The cat.',
      messages: [],
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

  it.each([
    '- m2: drop',
    '1. m2: drop',
    '| m2 | drop |',
    '**m2**: **drop**',
    '`m2`: `drop`',
    'm2: DROP',
    'M2: Drop',
    'm2 | drop',
    'm2 = drop',
    'm2 - drop',
    'm2 > drop',
    'm2 – drop',
    'm2: drop - Its work is done.',
  ])('reads the message line %s', (line) => {
    expect(readCompactionAnswer(`## Middle messages\n${line}`).messages).toStrictEqual([message(2, 'drop')])
  })

  // A model can quote a message of the user under the heading, or copy a
  // line of the list of the instruction (`m1: "start"`). Dez quotes the
  // kept messages itself.
  it('skips each line under the heading of the middle messages that is no message line', () => {
    const text = [
      '## Middle messages',
      'The user asked for the screenshots here:',
      'm1: "keep going with the screenshots"',
      'm1: dropped by the user',
      '@a: drop - The cat.',
      'm2: keep',
    ].join('\n')

    expect(readCompactionAnswer(text)).toStrictEqual({ requirements: '', messages: [message(2, 'keep')], assets: [] })
  })

  it('reads a message line outside the part of the middle messages as text of its part', () => {
    expect(readCompactionAnswer('m1: drop\n## Assets\n@a: keep - The cat.\nm2: drop\n## Middle messages\nm3: keep')).toStrictEqual({
      requirements: 'm1: drop',
      messages: [message(3, 'keep')],
      assets: [asset('a', 'keep', 'The cat. m2: drop')],
    })
  })

  it('keeps the first line of a number that comes two times, and gives the messages in the order of their lines', () => {
    expect(readCompactionAnswer('## Middle messages\nm2: drop\nm1: keep\nm2: keep').messages).toStrictEqual([message(2, 'drop'), message(1, 'keep')])
  })

  it('reads an answer whose lines end with CRLF', () => {
    expect(readCompactionAnswer('## Requirements and decisions\r\nDone.\r\n## Middle messages\r\nm1: drop\r\n## Assets\r\n@a: keep - The cat.\r\n@b: drop\r\n')).toStrictEqual({
      requirements: 'Done.',
      messages: [message(1, 'drop')],
      assets: [asset('a', 'keep', 'The cat.'), asset('b', 'drop')],
    })
  })
})

const NO_NOTES: CompactionAnswer = { requirements: '', messages: [], assets: [] }

describe('answerHasNotes', () => {
  // An answer that the model cut off at once holds nothing, or only headings.
  it('is false for an answer with nothing that Dez can read', () => {
    expect(answerHasNotes(readCompactionAnswer(''))).toBe(false)
    expect(answerHasNotes(readCompactionAnswer('## Requirements and decisions\n## Middle messages\n## Assets\n'))).toBe(false)
  })

  it.each<[string, Partial<CompactionAnswer>]>([
    ['only requirements text', { requirements: 'Red only.' }],
    ['only message lines', { messages: [message(1, 'keep')] }],
    ['only asset lines', { assets: [asset('a', 'keep', 'The cat.')] }],
  ])('is true for an answer with %s', (_name, part) => {
    expect(answerHasNotes({ ...NO_NOTES, ...part })).toBe(true)
  })
})
