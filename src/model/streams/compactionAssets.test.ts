import { describe, expect, it } from 'vitest'
import { CARRIED_USER_ASSETS_LABEL, compactionBlockText } from '../chat/compaction'
import { compactionNotesText, type CompactionNotes, type NotesAsset } from '../chat/compactionNotes'
import { IMAGE_MADE_BY_KEY, IMAGE_TOOL_KEY, imageMarkdown } from '../chat/images'
import { mediaTagText } from '../chat/mediaTags'
import { COMPACTION_TAG, FOX_ORIGIN, HIDDEN_IMAGE_PATH, hiddenClip, hiddenImage, idImage, invokeBlock, notesData } from '../chat/testing'
import type { Section } from '../chat/types'
import type { JobInfo, JobStatus } from '../tools/jobs'
import { jobInfo, RED, SKY, SONG } from '../tools/testing'
import {
  assetDecisions,
  assetTableText,
  carriedAssetLines,
  compactionScope,
  keptMiddleMessages,
  keptUserTexts,
  middleMessageStarts,
  openJobInputs,
  type CompactionAsset,
  type CompactionScope,
} from './compactionAssets'
import { MAX_ASSET_SENTENCE_LENGTH, type AnswerAsset, type AnswerMessage, type AssetDecision, type CompactionAnswer } from './compactionRequest'
import { assetsOf, reply, user } from './testing'

// The notes of a compaction of an older Dez, with no message part, that
// kept the image `a` of the user and the image `b` that a job of an
// earlier reply made.
const NOTES_DATA = notesData({
  assets: [
    { id: 'a', kind: 'image', facts: 'JPEG, 800x600, 120 KB', origin: 'from the user', sentence: 'The reference photo.', byReply: false, text: null },
    { id: 'b', kind: 'image', facts: 'PNG, 1024x768, 1.2 MB', origin: FOX_ORIGIN, sentence: 'The fox frame of scene 1.', byReply: false, text: idImage(HIDDEN_IMAGE_PATH, 'b', true) },
  ],
})
const NOTES = compactionNotesText(NOTES_DATA)
const COMPACTION = reply('n', `${COMPACTION_TAG}\n${NOTES}`)
const CARRIED = user('u+', `${CARRIED_USER_ASSETS_LABEL}\n${idImage(RED, 'a', true)}`)

// The compaction message of an older Dez (the compaction section, the
// first kept message, the carried image `a`, and the newest kept message,
// into which the user pasted the image `e` after the compaction: the notes
// have no line for it), then the reply that runs, with the intermediate
// image `c` and clip `d`.
const COMPACTED = [
  COMPACTION,
  user('u1', 'Make a fox.'),
  CARRIED,
  user('u2', `Make it run like this:\n${idImage(SKY, 'e')}`),
  reply('r', `${hiddenImage('j-aaaa', 'c')}\n${hiddenClip('j-aaaa', 'd')}`),
]

// The facts of the files. The ones of `b` are not the ones of its notes line.
const FACTS = new Map([['b', 'PNG | 10x10 | 1 KB'], ['c', 'PNG | 512x512 | 300 KB'], ['d', 'WAV | 2.0 s | mono'], ['e', 'PNG | 640x480 | 80 KB']])

// The `field` of each asset of `assets`, by id.
function byId<K extends keyof CompactionAsset>(assets: readonly CompactionAsset[], field: K): Record<string, CompactionAsset[K]> {
  return Object.fromEntries(assets.map((asset) => [asset.asset.id, asset[field]]))
}

// The scope of a compaction of `sections` in the reply `replySectionId`,
// with each message of the user as the index of its section.
function sectionScope(sections: readonly Section[], replySectionId: string): Record<string, number | number[] | null> {
  const { reply, end, first, middle, last } = compactionScope(sections, replySectionId)
  return { reply, end, first: first?.section ?? null, middle: middle.map((message) => message.section), last: last?.section ?? null }
}

// The texts of the messages of the user of `scope`.
function scopeTexts({ first, middle, last }: CompactionScope): { first: string | null, middle: string[], last: string | null } {
  return { first: first?.text ?? null, middle: middle.map((message) => message.text), last: last?.text ?? null }
}

// An answer with the message lines `messages`, and no asset line.
function answerWith(messages: AnswerMessage[] = []): CompactionAnswer {
  return { requirements: 'The fox runs.', messages, assets: [] }
}

// A linked image of the user: it counts in the notes only with the
// `linked` list of the tag.
const LINKED = '/home/u/Pictures/run.png'
const RUN_LIKE_THIS = `Make it run like this:\n${idImage(LINKED, 'e')}`

// The compaction section of a compaction with message parts: the first
// message of the user, and the final one, which links the image `e`,
// unless `fields` give other ones.
function partsCompaction(fields: Partial<CompactionNotes> = {}): Section {
  const notes = compactionNotesText({ ...NOTES_DATA, firstMessage: 'Make a fox.', finalMessage: RUN_LIKE_THIS, ...fields })
  return reply('n', compactionBlockText({ count: 1, lastId: 'e', pictures: [], linked: [LINKED] }, notes))
}

describe('compactionScope', () => {
  const SECTIONS = [...COMPACTED, user('u3', 'Now make it jump.')]

  it('replaces the sections up to the reply, and takes the first and the final message of the user before it', () => {
    expect(sectionScope(SECTIONS, 'r')).toStrictEqual({ reply: 4, end: 5, first: 1, middle: [], last: 3 })
  })

  it('replaces every section in a reply whose section is gone', () => {
    expect(sectionScope(SECTIONS, 'gone')).toStrictEqual({ reply: null, end: 6, first: 1, middle: [3], last: 5 })
  })

  it('takes each message of the user between the first and the final one as a middle message, oldest first', () => {
    const sections = [
      user('u0', 'Make a fox.'),
      reply('r0', 'A fox.'),
      user('u1', 'Use the red fur.'),
      reply('r1', 'ok'),
      user('u2', ' \n'),
      reply('r2', 'ok'),
      user('u3', 'Make it 16:9.'),
      reply('r3', 'ok'),
      user('u4', 'Now make it run.'),
      reply('r', ''),
    ]

    expect(sectionScope(sections, 'r')).toStrictEqual({ reply: 9, end: 10, first: 0, middle: [2, 6], last: 8 })
  })

  it('has no final message apart from the first when the user wrote one message', () => {
    expect(sectionScope([user('u1', 'Make a fox.'), reply('r', 'A fox.')], 'r')).toStrictEqual({ reply: 1, end: 2, first: 0, middle: [], last: null })
  })

  it('counts an empty user section as no message', () => {
    expect(sectionScope([user('u1', 'Make a fox.'), reply('r', 'A fox.'), user('u2', ' \n'), reply('r2', '')], 'r2')).toStrictEqual({ reply: 3, end: 4, first: 0, middle: [], last: null })
  })

  it('counts the carried assets of the user as no message in the compaction message, but as a message after a reply', () => {
    expect(sectionScope([COMPACTION, user('u1', 'Make a fox.'), CARRIED, reply('r', '')], 'r')).toStrictEqual({ reply: 3, end: 4, first: 1, middle: [], last: null })
    expect(sectionScope([COMPACTION, user('u1', 'Make a fox.'), CARRIED, reply('r', 'A fox.'), { ...CARRIED, id: 'u2' }, reply('r2', '')], 'r2'))
      .toStrictEqual({ reply: 5, end: 6, first: 1, middle: [], last: 4 })
  })

  it('has no first and no final message when the user wrote none', () => {
    expect(sectionScope([COMPACTION, reply('r', 'Going on.')], 'r')).toStrictEqual({ reply: 1, end: 2, first: null, middle: [], last: null })
  })

  it('keeps a user section as its whole plain text, in which a linked path counts', () => {
    const { first } = compactionScope([user('u1', RUN_LIKE_THIS), reply('r', '')], 'r')

    expect(first).toStrictEqual({ section: 0, text: RUN_LIKE_THIS, from: 0, to: RUN_LIKE_THIS.length, rule: 'user' })
  })
})

describe('compactionScope of notes with message parts', () => {
  it('takes the first and the final message from the parts while no user section came after them, with the linked paths of the tag', () => {
    const compaction = partsCompaction()
    const { first, middle, last } = compactionScope([compaction, reply('r', 'Running.')], 'r')
    const text = (compaction.content[0] as { text: string }).text

    expect([first?.section, first?.text, last?.section, last?.text]).toStrictEqual([0, 'Make a fox.', 0, RUN_LIKE_THIS])
    expect(middle).toStrictEqual([])
    expect(first?.rule).toStrictEqual(new Set([LINKED]))
    // The offsets are of the text with its escape, in the section.
    expect(text.slice(first?.from, first?.to)).toBe('Make a fox.')
    expect(text.slice(last?.from, last?.to)).toBe(RUN_LIKE_THIS)
  })

  it('takes the newest user section after the parts as the final message, and the final part as a middle message', () => {
    const compaction = partsCompaction()
    const scope = compactionScope([compaction, reply('r', 'A fox.'), user('u2', 'Now a wolf.'), reply('r2', '')], 'r2')
    const [part] = scope.middle

    expect(scopeTexts(scope)).toStrictEqual({ first: 'Make a fox.', middle: [RUN_LIKE_THIS], last: 'Now a wolf.' })
    expect(scope.last).toStrictEqual({ section: 2, text: 'Now a wolf.', from: 0, to: 11, rule: 'user' })
    expect([part.section, part.rule]).toStrictEqual([0, new Set([LINKED])])
    expect((compaction.content[0] as { text: string }).text.slice(part.from, part.to)).toBe(RUN_LIKE_THIS)
  })

  it('takes the middle parts as middle messages, and keeps the final part as the final message while no user section came after them', () => {
    const scope = compactionScope([partsCompaction({ middleMessages: ['Use the red fur.', 'Make it 16:9.'] }), reply('r', '')], 'r')

    expect(scopeTexts(scope)).toStrictEqual({ first: 'Make a fox.', middle: ['Use the red fur.', 'Make it 16:9.'], last: RUN_LIKE_THIS })
  })

  it('takes the middle parts, the final part, and each user section but the newest one as middle messages, in this order', () => {
    const compaction = partsCompaction({ middleMessages: ['Use the red fur.'] })
    const scope = compactionScope([compaction, reply('r', 'A fox.'), user('u2', 'Now a wolf.'), reply('r2', 'A wolf.'), user('u3', 'Now a hare.'), reply('r3', '')], 'r3')

    expect(scopeTexts(scope)).toStrictEqual({ first: 'Make a fox.', middle: ['Use the red fur.', RUN_LIKE_THIS, 'Now a wolf.'], last: 'Now a hare.' })
  })

  it('has no final message apart from the first when the notes hold one part and no user section came after it', () => {
    const scope = compactionScope([partsCompaction({ finalMessage: null }), reply('r', '')], 'r')

    expect(scopeTexts(scope)).toStrictEqual({ first: 'Make a fox.', middle: [], last: null })
  })

  it('gives the messages of the parts as the kept texts of the user', () => {
    const sections = [partsCompaction(), reply('r', 'Running.'), user('u3', 'Then use @b again.')]

    expect(keptUserTexts(sections, compactionScope(sections, 'r'), answerWith())).toStrictEqual(['Make a fox.', RUN_LIKE_THIS, 'Then use @b again.'])
  })

  it('counts an asset of a message part as an asset of the user, whatever its line tells, and an asset whose line tells the user', () => {
    const assets: NotesAsset[] = [
      { ...NOTES_DATA.assets[0], text: idImage(RED, 'a', true) },
      NOTES_DATA.assets[1],
      { id: 'e', kind: 'image', facts: 'PNG, 640x480, 80 KB', origin: FOX_ORIGIN, sentence: '', byReply: false, text: null },
    ]
    const seen = assetsOf([partsCompaction({ assets }), reply('r', '')], FACTS, { replySectionId: 'r' })

    expect(byId(seen, 'fromUser')).toStrictEqual({ e: true, a: true, b: false })
  })
})

describe('carriedAssetLines', () => {
  it('gives the asset lines of the notes of the compaction section by id', () => {
    expect(carriedAssetLines(COMPACTED)).toStrictEqual(new Map([
      ['a', { id: 'a', kind: 'image', facts: 'JPEG, 800x600, 120 KB', origin: 'from the user', sentence: 'The reference photo.', byReply: false }],
      ['b', { id: 'b', kind: 'image', facts: 'PNG, 1024x768, 1.2 MB', origin: FOX_ORIGIN, sentence: 'The fox frame of scene 1.', byReply: false }],
    ]))
  })

  it('gives no line in a conversation with no compaction section', () => {
    expect(carriedAssetLines([reply('n', NOTES), user('u1', 'Go on.')])).toStrictEqual(new Map())
    expect(carriedAssetLines([user('n', `${COMPACTION_TAG}\n${NOTES}`)])).toStrictEqual(new Map())
  })
})

describe('compactionAssets', () => {
  // The image `a` and the audio clip `b` of the user, then a reply with the
  // intermediate image `c` and video clip `d` of a job, and the image `e`.
  const PLAIN = [
    user('u1', `Make these move:\n${idImage(RED, 'a')}\n${mediaTagText(SONG)}`),
    reply('r', `${hiddenImage('j-aaaa', 'c')}\n${hiddenClip('j-aaaa', 'd', 'video')}\n${idImage(HIDDEN_IMAGE_PATH, 'e')}`),
  ]

  it('tells the kind of each asset, whether it is from the user, and whether a call made it as a part of its work', () => {
    const seen = Object.fromEntries(assetsOf(PLAIN, FACTS).map(({ asset, kind, fromUser, intermediate }) => [asset.id, { kind, fromUser, intermediate }]))

    expect(seen).toStrictEqual({
      a: { kind: 'image', fromUser: true, intermediate: false },
      b: { kind: 'audio', fromUser: true, intermediate: false },
      c: { kind: 'image', fromUser: false, intermediate: true },
      d: { kind: 'video', fromUser: false, intermediate: true },
      e: { kind: 'image', fromUser: false, intermediate: false },
    })
  })

  it('counts an asset as made by the reply only when its text is in the section of the reply that runs', () => {
    expect(byId(assetsOf(PLAIN, FACTS, { replySectionId: 'r' }), 'byReply')).toStrictEqual({ a: false, b: false, c: true, d: true, e: true })
    expect(byId(assetsOf([...PLAIN, user('u2', 'Now make them jump.'), reply('r2', '')], FACTS, { replySectionId: 'r2' }), 'byReply'))
      .toStrictEqual({ a: false, b: false, c: false, d: false, e: false })
  })

  // A compaction in the reply moved the text of its assets into the notes,
  // and the reply goes on after the block of its own section.
  it('counts an asset of the notes as made by the reply when its line tells it and that reply still runs', () => {
    const compaction = (byReply: boolean) => compactionBlockText({ count: 1, lastId: 'b', pictures: [] }, compactionNotesText({
      ...NOTES_DATA,
      assets: NOTES_DATA.assets.map((asset) => ({ ...asset, byReply: byReply && asset.id === 'b' })),
    }))
    const sections = (byReply: boolean) => [reply('r', `${compaction(byReply)}\n${hiddenImage('j-aaaa', 'c')}\n${hiddenClip('j-aaaa', 'd')}`)]
    const later = [...sections(true), user('u3', 'Now make it jump.'), reply('r2', '')]

    expect(byId(assetsOf(sections(true), FACTS, { replySectionId: 'r' }), 'byReply')).toStrictEqual({ b: true, c: true, d: true })
    expect(byId(assetsOf(sections(false), FACTS, { replySectionId: 'r' }), 'byReply')).toStrictEqual({ b: false, c: true, d: true })
    expect(byId(assetsOf(later, FACTS, { replySectionId: 'r2' }), 'byReply')).toStrictEqual({ b: false, c: false, d: false })
  })

  // A stop or a new submit cut the reply `r`, and the reply `r2` took its
  // jobs: the work of `r` counts as the work of `r2`.
  it('counts an asset as made by the reply when its text is in the section of a cut reply that handed its jobs on', () => {
    const sections = [...PLAIN, user('u2', 'No, make them jump.'), reply('r2', '')]

    expect(byId(assetsOf(sections, FACTS, { replySectionId: 'r2', replySections: ['r'] }), 'byReply')).toStrictEqual({ a: false, b: false, c: true, d: true, e: true })
  })

  it('counts an asset of the notes as made by the reply when a cut reply that handed its jobs on ran at their compaction', () => {
    const block = compactionBlockText({ count: 1, lastId: 'b', pictures: [] }, compactionNotesText({
      ...NOTES_DATA,
      assets: NOTES_DATA.assets.map((asset) => ({ ...asset, byReply: asset.id === 'b' })),
    }))
    const sections = [reply('r', `${block}\n${hiddenImage('j-aaaa', 'c')}`), user('u3', 'No, make it jump.'), reply('r2', '')]

    expect(byId(assetsOf(sections, FACTS, { replySectionId: 'r2', replySections: ['r'] }), 'byReply')).toStrictEqual({ b: true, c: true })
    expect(byId(assetsOf(sections, FACTS, { replySectionId: 'r2' }), 'byReply')).toStrictEqual({ b: false, c: false })
  })

  it('counts an asset as an input of a job when an open job of the reply takes it', () => {
    const jobInputs = new Map([['j-aaaa', ['a']], ['j-bbbb', ['e', 'a']]])

    expect(byId(assetsOf(PLAIN, FACTS, { jobInputs }), 'jobInput')).toStrictEqual({ a: true, b: false, c: false, d: false, e: true })
  })

  it('takes the facts of the files with no column mark, but the facts and the sentence of a notes line over them', () => {
    const assets = assetsOf(COMPACTED, FACTS)

    expect(byId(assets, 'facts')).toStrictEqual({
      a: 'JPEG, 800x600, 120 KB',
      b: 'PNG, 1024x768, 1.2 MB',
      c: 'PNG, 512x512, 300 KB',
      d: 'WAV, 2.0 s, mono',
      e: 'PNG, 640x480, 80 KB',
    })
    expect(byId(assets, 'sentence')).toStrictEqual({ a: 'The reference photo.', b: 'The fox frame of scene 1.', c: '', d: '', e: '' })
  })

  it('tells who made an asset with no column mark', () => {
    const made = imageMarkdown(HIDDEN_IMAGE_PATH, [{ key: 'id', value: 'b' }, { key: IMAGE_TOOL_KEY, value: 'model_invoke' }, { key: IMAGE_MADE_BY_KEY, value: 'j-aaaa' }])
    const [asset] = assetsOf([user('u1', 'Make a fox.'), reply('r', `${invokeBlock('j-aaaa', { prompt: 'A fox | a hare', intermediate: false })}\n\n${made}`)], FACTS)

    expect(asset.origin).not.toContain('|')
    expect(asset.origin).toContain('A fox')
    expect(asset.origin).toContain('a hare')
  })
})

describe('assetTableText', () => {
  it('gives one row for each asset: its id, its kind, and whether it is from the user, intermediate, of this reply, and an input of an open job', () => {
    const assets = assetsOf(COMPACTED, FACTS, { replySectionId: 'r', jobInputs: new Map([['j-bbbb', ['b']]]) })
    const [, ...rows] = assetTableText(assets).split('\n')
    // The id, the kind, and the four columns after the facts and the origin.
    const marks = new Map(rows.map((row) => row.split(' | ')).map((cells) => [cells[0], [cells[1], ...cells.slice(4)]]))

    expect(rows).toHaveLength(assets.length)
    expect(marks).toStrictEqual(new Map([
      ['@a', ['image', 'user', '-', '-', '-']],
      ['@b', ['image', 'made', '-', 'earlier', 'open job']],
      ['@c', ['image', 'made', 'intermediate', 'this reply', '-']],
      ['@d', ['audio clip', 'made', 'intermediate', 'this reply', '-']],
      ['@e', ['image', 'user', '-', '-', '-']],
    ]))
  })

  it('tells in one line that the conversation has no asset', () => {
    const table = assetTableText([])

    expect(table).not.toContain('\n')
    expect(table).toContain('no image and no clip')
  })
})

describe('openJobInputs', () => {
  function job(id: string, status: JobStatus, inputs: readonly string[], delivered = false): JobInfo {
    return jobInfo({ id, status, delivered, inputs })
  }

  it('takes the inputs of a job that runs, and of an ended job whose result no jobs_wait gave, by job', () => {
    expect(openJobInputs([job('j-aaaa', 'running', ['a', 'b']), job('j-bbbb', 'finished', ['c'])])).toStrictEqual(new Map([['j-aaaa', ['a', 'b']], ['j-bbbb', ['c']]]))
  })

  it('takes no input of a job whose result jobs_wait gave, or of a stopped or cancelled job', () => {
    expect(openJobInputs([job('j-aaaa', 'running', ['a']), job('j-bbbb', 'finished', ['c'], true), job('j-cccc', 'stopped', ['d']), job('j-dddd', 'cancelled', ['e'])]))
      .toStrictEqual(new Map([['j-aaaa', ['a']]]))
    expect(openJobInputs([])).toStrictEqual(new Map())
  })
})

describe('keptMiddleMessages', () => {
  // A conversation with three middle messages: `u1`, `u2`, and `u3`.
  const SECTIONS = [
    user('u0', 'Make a fox.'),
    reply('r0', 'A fox.'),
    user('u1', 'Use the red fur.'),
    reply('r1', 'ok'),
    user('u2', 'ok'),
    reply('r2', 'ok'),
    user('u3', 'Make it 16:9.'),
    reply('r3', 'ok'),
    user('u4', 'Now make it run.'),
    reply('r', ''),
  ]
  const SCOPE = compactionScope(SECTIONS, 'r')
  // The sections of the middle messages that `answer` keeps.
  const keptSections = (answer: CompactionAnswer) => keptMiddleMessages(SCOPE, answer).map((message) => message.section)

  it('keeps every middle message when the answer has no message line', () => {
    expect(keptSections(answerWith())).toStrictEqual([2, 4, 6])
  })

  it('drops each middle message whose number has a drop line, and keeps each other one, in order', () => {
    expect(keptSections(answerWith([{ number: 2, decision: 'drop' }, { number: 1, decision: 'keep' }]))).toStrictEqual([2, 6])
    expect(keptSections(answerWith([{ number: 3, decision: 'drop' }, { number: 1, decision: 'drop' }]))).toStrictEqual([4])
  })

  it('skips a line whose number has no middle message', () => {
    expect(keptSections(answerWith([{ number: 4, decision: 'drop' }, { number: 0, decision: 'drop' }]))).toStrictEqual([2, 4, 6])
  })
})

describe('middleMessageStarts', () => {
  it('gives the start of each middle message on one line, with a label in place of each image and clip', () => {
    const screen = mediaTagText({ kind: 'video', id: 'd', type: 'video/webm', src: '/home/u/Videos/screen.webm', url: null, expires: null, other: [] })
    const sections = [
      user('u0', 'Make a film.'),
      reply('r0', 'ok'),
      user('u1', `For the middle part use\n${idImage(LINKED, 'e')}  and\n${screen}\nnot the renders.`),
      reply('r1', 'ok'),
      user('u2', 'ok'),
      reply('r2', 'ok'),
      user('u3', 'Now make the film.'),
      reply('r', ''),
    ]

    expect(middleMessageStarts(compactionScope(sections, 'r'))).toStrictEqual(['For the middle part use [image] and [video] not the renders.', 'ok'])
  })

  it('labels an image of a message part by the linked paths of the tag', () => {
    const scope = compactionScope([partsCompaction(), reply('r', 'A fox.'), user('u2', 'Now a wolf.'), reply('r2', '')], 'r2')

    expect(middleMessageStarts(scope)).toStrictEqual(['Make it run like this: [image]'])
  })

  it('cuts a long message at 160 characters, with … as its last char', () => {
    const sections = [user('u0', 'Make a fox.'), reply('r0', 'ok'), user('u1', `${'word '.repeat(60)}end`), reply('r1', 'ok'), user('u2', 'Go on.'), reply('r', '')]
    const [start] = middleMessageStarts(compactionScope(sections, 'r'))

    expect(start.length).toBeLessThanOrEqual(160)
    expect(start).toMatch(/^(word )+word…$/)
  })

  it('gives no start when no message came between the first and the final one', () => {
    expect(middleMessageStarts(compactionScope([user('u0', 'Make a fox.'), reply('r0', 'ok'), user('u1', 'Go on.'), reply('r', '')], 'r'))).toStrictEqual([])
  })
})

describe('keptUserTexts', () => {
  it('gives the first and the final message of the user, and each user section after the replaced ones', () => {
    const sections = [...COMPACTED, reply('later', 'More.'), user('u3', 'Then use @b again.')]

    expect(keptUserTexts(sections, compactionScope(sections, 'r'), answerWith())).toStrictEqual([
      'Make a fox.',
      `Make it run like this:\n${idImage(SKY, 'e')}`,
      'Then use @b again.',
    ])
  })

  it('gives the middle messages that the answer keeps, in order, and not the ones that it drops', () => {
    const sections = [
      user('u0', 'Make a fox.'),
      reply('r0', 'A fox.'),
      user('u1', 'Use the fur of @b.'),
      reply('r1', 'ok'),
      user('u2', 'Then use @c.'),
      reply('r2', 'ok'),
      user('u3', 'Now make it run.'),
      reply('r', 'working'),
    ]
    const scope = compactionScope(sections, 'r')

    expect(keptUserTexts(sections, scope, answerWith())).toStrictEqual(['Make a fox.', 'Use the fur of @b.', 'Then use @c.', 'Now make it run.'])
    expect(keptUserTexts(sections, scope, answerWith([{ number: 2, decision: 'drop' }]))).toStrictEqual(['Make a fox.', 'Use the fur of @b.', 'Now make it run.'])
  })

  it('gives only the one message of a conversation in which the user wrote one', () => {
    const sections = [user('u1', 'Make a fox.'), reply('r', 'A fox.')]

    expect(keptUserTexts(sections, compactionScope(sections, 'r'), answerWith())).toStrictEqual(['Make a fox.'])
  })
})

describe('assetDecisions', () => {
  type Guards = Parameters<typeof assetDecisions>[2]

  const ASSETS = assetsOf(COMPACTED, FACTS, { replySectionId: 'r' })
  // The asset `id` of COMPACTED.
  const assetOf = (id: string): CompactionAsset => {
    const found = ASSETS.find((asset) => asset.asset.id === id)
    if (found === undefined) throw new Error(`COMPACTED has no asset ${id}`)
    return found
  }
  const USER = assetOf('a')
  const EARLIER = assetOf('b')
  const OWN = assetOf('c')
  const OTHER = assetOf('d')
  const NO_GUARDS: Guards = { keptTexts: [] }

  function answer(assets: AnswerAsset[], notes: Partial<CompactionAnswer> = {}): CompactionAnswer {
    return { ...answerWith(), assets, ...notes }
  }

  // The decision for `asset` alone when the answer gives it `given`.
  function decision(asset: CompactionAsset, given: AssetDecision, guards = NO_GUARDS, notes: Partial<CompactionAnswer> = {}): AssetDecision {
    return assetDecisions([asset], answer([{ id: asset.asset.id, decision: given, sentence: '' }], notes), guards)[0].decision
  }

  // The decision for `asset` when the answer has a line only for OTHER.
  function unnamed(asset: CompactionAsset, guards = NO_GUARDS, notes: Partial<CompactionAnswer> = {}): AssetDecision {
    return assetDecisions([asset, OTHER], answer([{ id: OTHER.asset.id, decision: 'keep', sentence: '' }], notes), guards)[0].decision
  }

  // The sentence of the notes for `asset` when the answer gives it `given`.
  function sentence(asset: CompactionAsset, given: string): string {
    return assetDecisions([asset], answer([{ id: asset.asset.id, decision: 'keep', sentence: given }]), NO_GUARDS)[0].sentence
  }

  it('keeps every asset when no line of the answer is for one of them, with its sentence of the compaction before, after every named one', () => {
    const kept = [{ asset: EARLIER, decision: 'keep', sentence: 'The fox frame of scene 1.', rank: Infinity }]

    expect(assetDecisions([EARLIER], answer([]), NO_GUARDS)).toStrictEqual(kept)
    expect(assetDecisions([EARLIER], answer([{ id: 'z', decision: 'drop', sentence: '' }]), NO_GUARDS)).toStrictEqual(kept)
  })

  it('drops a made asset of an earlier reply that the answer has no line for, and keeps one of the reply that runs', () => {
    const choices = assetDecisions([USER, EARLIER, OWN, OTHER], answer([{ id: 'd', decision: 'keep', sentence: '' }]), NO_GUARDS)

    expect(choices.map((choice) => [choice.asset.asset.id, choice.decision])).toStrictEqual([['a', 'keep'], ['b', 'drop'], ['c', 'keep'], ['d', 'keep']])
  })

  it('drops an asset of an earlier reply at the first compaction of a conversation too', () => {
    const sections = [user('u1', 'Make a fox.'), reply('r1', idImage(HIDDEN_IMAGE_PATH, 'a')), user('u2', 'Now a hare.'), reply('r', idImage(HIDDEN_IMAGE_PATH, 'b'))]
    const assets = assetsOf(sections, new Map(), { replySectionId: 'r' })

    expect(assetDecisions(assets, answer([{ id: 'b', decision: 'keep', sentence: '' }]), NO_GUARDS).map((choice) => choice.decision)).toStrictEqual(['drop', 'keep'])
  })

  it('follows the answer for a made asset that nothing holds, also a drop of an asset of the reply that runs', () => {
    expect((['show', 'keep', 'drop'] as const).map((given) => decision(EARLIER, given))).toStrictEqual(['show', 'keep', 'drop'])
    expect((['show', 'keep', 'drop'] as const).map((given) => decision(OWN, given))).toStrictEqual(['show', 'keep', 'drop'])
  })

  it.each<[string, CompactionAsset, Guards, Partial<CompactionAnswer>]>([
    ['an asset of the user', USER, NO_GUARDS, {}],
    ['an input of an open job', { ...EARLIER, jobInput: true }, NO_GUARDS, {}],
    ['an asset that the requirements name', EARLIER, NO_GUARDS, { requirements: 'Keep the fur of @b.' }],
    ['an asset that a kept message of the user names', EARLIER, { keptTexts: ['Make it run like @b.'] }, {}],
  ])('keeps %s that the answer drops or has no line for, and shows it when the answer shows it', (_name, asset, guards, notes) => {
    expect(decision(asset, 'drop', guards, notes)).toBe('keep')
    expect(unnamed(asset, guards, notes)).toBe('keep')
    expect(decision(asset, 'show', guards, notes)).toBe('show')
  })

  it('takes the sentence of the answer over the one of the compaction before, but not a blank one', () => {
    expect(sentence(EARLIER, 'The fox at the river.')).toBe('The fox at the river.')
    expect(sentence(EARLIER, '')).toBe('The fox frame of scene 1.')
  })

  it('puts a sentence on one line', () => {
    expect(sentence(OWN, 'The fox runs.\nThen it swims.')).toBe('The fox runs. Then it swims.')
  })

  it('cuts a sentence over the limit at its end, with … as its last char', () => {
    const full = 'a'.repeat(MAX_ASSET_SENTENCE_LENGTH)
    const cut = sentence(OWN, `${full}z`)

    expect(sentence(OWN, full)).toBe(full)
    expect(cut.length).toBeLessThanOrEqual(MAX_ASSET_SENTENCE_LENGTH)
    expect(cut).toMatch(/^a+…$/)
  })

  it('cuts a sentence between two characters, never inside one', () => {
    const cut = sentence(OWN, `${'a'.repeat(MAX_ASSET_SENTENCE_LENGTH - 2)}😀${'b'.repeat(10)}`)

    expect(cut.endsWith('😀…')).toBe(true)
  })

  it('ranks each asset by the place of its line in the answer, in the order of the assets', () => {
    const lines: AnswerAsset[] = [{ id: 'c', decision: 'show', sentence: '' }, { id: 'a', decision: 'show', sentence: '' }]
    const choices = assetDecisions([USER, EARLIER, OWN], answer(lines), NO_GUARDS)

    expect(choices.map((choice) => [choice.asset.asset.id, choice.rank])).toStrictEqual([['a', 1], ['b', Infinity], ['c', 0]])
  })
})
