import { describe, expect, it } from 'vitest'
import { CARRIED_USER_ASSETS_LABEL } from '../chat/compaction'
import { compactionNotesText } from '../chat/compactionNotes'
import { IMAGE_MADE_BY_KEY, IMAGE_TOOL_KEY, imageMarkdown } from '../chat/images'
import { mediaTagText } from '../chat/mediaTags'
import { COMPACTION_TAG, FOX_ORIGIN, HIDDEN_IMAGE_PATH, hiddenClip, hiddenImage, idImage, invokeBlock } from '../chat/testing'
import { toolBlockText } from '../chat/toolBlocks'
import { jobStartedText, type JobInfo, type JobStatus } from '../tools/jobs'
import { CONVERSATION, RED, SKY, SONG } from '../tools/testing'
import { joinClipsCall, videoInputsText } from '../tools/videoTool'
import {
  assetDecisions,
  assetTableText,
  carriedAssetLines,
  compactionScope,
  keptUserTexts,
  openJobInputs,
  type CompactionAsset,
} from './compactionAssets'
import { MAX_ASSET_SENTENCE_LENGTH, type AnswerAsset, type AssetDecision, type CompactionAnswer } from './compactionRequest'
import { assetsOf, reply, user } from './testing'

// The notes of a compaction that kept the image `a` of the user and the
// image `b` that a job made.
const NOTES = compactionNotesText({
  summary: 'A fox for the user.',
  requirements: '',
  nextSteps: '',
  assets: [
    { id: 'a', kind: 'image', facts: 'JPEG, 800x600, 120 KB', origin: 'from the user', sentence: 'The reference photo.', text: null },
    { id: 'b', kind: 'image', facts: 'PNG, 1024x768, 1.2 MB', origin: FOX_ORIGIN, sentence: 'The fox frame of scene 1.', text: idImage(HIDDEN_IMAGE_PATH, 'b', true) },
  ],
  unnamed: [],
  jobs: [],
  cost: undefined,
})
const COMPACTION = reply('n', `${COMPACTION_TAG}\n${NOTES}`)
const CARRIED = user('u+', `${CARRIED_USER_ASSETS_LABEL}\n${idImage(RED, 'a', true)}`)

// The compaction message (the compaction section, the first kept message,
// the carried image `a`, and the newest kept message, into which the user
// pasted the image `e` after the compaction: the notes have no line for
// it), then the reply that runs, with the intermediate image `c` and
// clip `d`.
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

describe('compactionScope', () => {
  const SECTIONS = [...COMPACTED, user('u3', 'Now make it jump.')]

  it('replaces the sections up to the reply, and keeps the first and the newest message of the user before it', () => {
    expect(compactionScope(SECTIONS, 'r')).toStrictEqual({ reply: 4, end: 5, first: 1, last: 3 })
  })

  it('replaces every section in a reply whose section is gone', () => {
    expect(compactionScope(SECTIONS, 'gone')).toStrictEqual({ reply: null, end: 6, first: 1, last: 5 })
  })

  it('has no newest message apart from the first when the user wrote one message', () => {
    expect(compactionScope([user('u1', 'Make a fox.'), reply('r', 'A fox.')], 'r')).toStrictEqual({ reply: 1, end: 2, first: 0, last: null })
  })

  it('counts an empty user section as no message', () => {
    expect(compactionScope([user('u1', 'Make a fox.'), reply('r', 'A fox.'), user('u2', ' \n'), reply('r2', '')], 'r2')).toStrictEqual({ reply: 3, end: 4, first: 0, last: null })
  })

  it('counts the carried assets of the user as no message in the compaction message, but as a message after a reply', () => {
    expect(compactionScope([COMPACTION, user('u1', 'Make a fox.'), CARRIED, reply('r', '')], 'r')).toStrictEqual({ reply: 3, end: 4, first: 1, last: null })
    expect(compactionScope([COMPACTION, user('u1', 'Make a fox.'), CARRIED, reply('r', 'A fox.'), { ...CARRIED, id: 'u2' }, reply('r2', '')], 'r2'))
      .toStrictEqual({ reply: 5, end: 6, first: 1, last: 4 })
  })

  it('has no first and no newest message when the user wrote none', () => {
    expect(compactionScope([COMPACTION, reply('r', 'Going on.')], 'r')).toStrictEqual({ reply: 1, end: 2, first: null, last: null })
  })
})

describe('carriedAssetLines', () => {
  it('gives the asset lines of the notes of the compaction section by id', () => {
    expect(carriedAssetLines(COMPACTED)).toStrictEqual(new Map([
      ['a', { id: 'a', kind: 'image', facts: 'JPEG, 800x600, 120 KB', origin: 'from the user', sentence: 'The reference photo.' }],
      ['b', { id: 'b', kind: 'image', facts: 'PNG, 1024x768, 1.2 MB', origin: FOX_ORIGIN, sentence: 'The fox frame of scene 1.' }],
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

  it('counts every asset as new in a conversation with no compaction', () => {
    expect(byId(assetsOf(PLAIN, FACTS), 'isNew')).toStrictEqual({ a: true, b: true, c: true, d: true, e: true })
  })

  it('counts an asset as earlier only when the notes of the compaction before have its line', () => {
    expect(byId(assetsOf(COMPACTED, FACTS), 'isNew')).toStrictEqual({ a: false, b: false, e: true, c: true, d: true })
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
  it('gives one row for each asset: its id, its kind, and whether it is from the user, intermediate, and new', () => {
    const assets = assetsOf(COMPACTED, FACTS)
    const [, ...rows] = assetTableText(assets).split('\n')
    // The id, the kind, and the three columns after the facts and the origin.
    const marks = new Map(rows.map((row) => row.split(' | ')).map((cells) => [cells[0], [cells[1], ...cells.slice(4)]]))

    expect(rows).toHaveLength(assets.length)
    expect(marks).toStrictEqual(new Map([
      ['@a', ['image', 'user', '-', 'earlier']],
      ['@b', ['image', 'made', '-', 'earlier']],
      ['@c', ['image', 'made', 'intermediate', 'new']],
      ['@d', ['audio clip', 'made', 'intermediate', 'new']],
      ['@e', ['image', 'user', '-', 'new']],
    ]))
  })

  it('tells in one line that the conversation has no asset', () => {
    const table = assetTableText([])

    expect(table).not.toContain('\n')
    expect(table).toContain('no image and no clip')
  })
})

describe('openJobInputs', () => {
  const images = (...ids: string[]) => ids.map((id) => ({ id, kind: 'image' as const }))
  const REPLY = [
    'Making the scenes.',
    invokeBlock('j-aaaa', { number: 1, prompt: 'Make @a run to @b', intermediate: false, inputs: images('a', 'b') }),
    invokeBlock('j-bbbb', { number: 2, prompt: 'Make @c jump', intermediate: false, inputs: images('c') }),
    invokeBlock('j-cccc', { number: 3, prompt: 'Make @d swim', intermediate: false, inputs: images('d') }),
    invokeBlock('j-dddd', { number: 4, prompt: 'Make @e fly', intermediate: false, inputs: images('e') }),
  ].join('\n\n')

  function job(id: string, status: JobStatus, delivered = false): JobInfo {
    return { id, tool: 'model_invoke', status, delivered, elapsedMs: 1000, state: '', call: { number: 1, label: '' } }
  }

  it('takes the inputs of a job that runs, and of an ended job whose result no jobs_wait gave', () => {
    expect(openJobInputs(REPLY, [job('j-aaaa', 'running'), job('j-bbbb', 'finished')])).toStrictEqual(new Set(['a', 'b', 'c']))
  })

  it('takes no input of a job whose result jobs_wait gave, of a stopped job, or of a job that the list does not hold', () => {
    expect(openJobInputs(REPLY, [job('j-aaaa', 'running'), job('j-bbbb', 'finished', true), job('j-cccc', 'stopped')])).toStrictEqual(new Set(['a', 'b']))
    expect(openJobInputs(REPLY, [])).toStrictEqual(new Set())
  })

  // `join_clips` takes ids with no `@`, so only the start result, which
  // the runner writes from the inputs of the job, names its clips as `@c`.
  it('takes the clips of a join whose call names them with no @', () => {
    const parameters = { clips: 'c d' }
    const result = `${jobStartedText('j-aaaa', 1)}\n${videoInputsText(joinClipsCall(parameters, CONVERSATION).inputs)}`
    const join = toolBlockText({ id: 'call_1', name: 'video', status: 'success', arguments: { command: 'join_clips', parameters: JSON.stringify(parameters) }, result })

    expect(openJobInputs(join, [job('j-aaaa', 'running')])).toStrictEqual(new Set(['c', 'd']))
  })
})

describe('keptUserTexts', () => {
  it('gives the first and the newest message of the user, and each user section after the replaced ones', () => {
    const sections = [...COMPACTED, reply('later', 'More.'), user('u3', 'Then use @b again.')]

    expect(keptUserTexts(sections, compactionScope(sections, 'r'))).toStrictEqual([
      'Make a fox.',
      `Make it run like this:\n${idImage(SKY, 'e')}`,
      'Then use @b again.',
    ])
  })

  it('gives only the one message of a conversation in which the user wrote one', () => {
    const sections = [user('u1', 'Make a fox.'), reply('r', 'A fox.')]

    expect(keptUserTexts(sections, compactionScope(sections, 'r'))).toStrictEqual(['Make a fox.'])
  })
})

describe('assetDecisions', () => {
  type Guards = Parameters<typeof assetDecisions>[2]

  const ASSETS = assetsOf(COMPACTED, FACTS)
  // The asset `id` of COMPACTED.
  const assetOf = (id: string): CompactionAsset => {
    const found = ASSETS.find((asset) => asset.asset.id === id)
    if (found === undefined) throw new Error(`COMPACTED has no asset ${id}`)
    return found
  }
  const USER = assetOf('a')
  const EARLIER = assetOf('b')
  const NEW = assetOf('c')
  const NO_GUARDS: Guards = { jobInputs: new Set(), keptTexts: [] }

  function answer(assets: AnswerAsset[], notes: Partial<CompactionAnswer> = {}): CompactionAnswer {
    return { summary: 'The fox runs.', requirements: '', nextSteps: '', assets, ...notes }
  }

  // The decision for `asset` alone when the answer gives it `given`.
  function decision(asset: CompactionAsset, given: AssetDecision, guards = NO_GUARDS, notes: Partial<CompactionAnswer> = {}): AssetDecision {
    return assetDecisions([asset], answer([{ id: asset.asset.id, decision: given, sentence: '' }], notes), guards)[0].decision
  }

  // The sentence of the notes for `asset` when the answer gives it `given`.
  function sentence(asset: CompactionAsset, given: string): string {
    return assetDecisions([asset], answer([{ id: asset.asset.id, decision: 'keep', sentence: given }]), NO_GUARDS)[0].sentence
  }

  it('keeps an asset that the answer does not name, with its sentence of the compaction before, after every named one', () => {
    expect(assetDecisions([EARLIER], answer([]), NO_GUARDS)).toStrictEqual([{ asset: EARLIER, decision: 'keep', sentence: 'The fox frame of scene 1.', rank: Infinity }])
  })

  it('follows the answer for an earlier made asset that nothing holds', () => {
    expect((['show', 'keep', 'drop'] as const).map((given) => decision(EARLIER, given))).toStrictEqual(['show', 'keep', 'drop'])
  })

  it.each<[string, CompactionAsset, Guards, Partial<CompactionAnswer>]>([
    ['an asset of the user', USER, NO_GUARDS, {}],
    ['an asset that came after the compaction before', NEW, NO_GUARDS, {}],
    ['an input of an open job', EARLIER, { jobInputs: new Set(['b']), keptTexts: [] }, {}],
    ['an asset that the summary names', EARLIER, NO_GUARDS, { summary: 'The fox of @b runs.' }],
    ['an asset that the requirements name', EARLIER, NO_GUARDS, { requirements: 'Keep the fur of @b.' }],
    ['an asset that the next steps name', EARLIER, NO_GUARDS, { nextSteps: 'Animate @b.' }],
    ['an asset that a kept message of the user names', EARLIER, { jobInputs: new Set(), keptTexts: ['Make it run like @b.'] }, {}],
  ])('keeps %s that the answer drops, and shows it when the answer shows it', (_name, asset, guards, notes) => {
    expect(decision(asset, 'drop', guards, notes)).toBe('keep')
    expect(decision(asset, 'show', guards, notes)).toBe('show')
  })

  it('takes the sentence of the answer over the one of the compaction before, but not a blank one', () => {
    expect(sentence(EARLIER, 'The fox at the river.')).toBe('The fox at the river.')
    expect(sentence(EARLIER, '')).toBe('The fox frame of scene 1.')
  })

  it('puts a sentence on one line', () => {
    expect(sentence(NEW, 'The fox runs.\nThen it swims.')).toBe('The fox runs. Then it swims.')
  })

  it('cuts a sentence over the limit at its end, with … as its last char', () => {
    const full = 'a'.repeat(MAX_ASSET_SENTENCE_LENGTH)
    const cut = sentence(NEW, `${full}z`)

    expect(sentence(NEW, full)).toBe(full)
    expect(cut.length).toBeLessThanOrEqual(MAX_ASSET_SENTENCE_LENGTH)
    expect(cut).toMatch(/^a+…$/)
  })

  it('cuts a sentence between two characters, never inside one', () => {
    const cut = sentence(NEW, `${'a'.repeat(MAX_ASSET_SENTENCE_LENGTH - 2)}😀${'b'.repeat(10)}`)

    expect(cut.endsWith('😀…')).toBe(true)
  })

  it('ranks each asset by the place of its line in the answer, in the order of the assets', () => {
    const lines: AnswerAsset[] = [{ id: 'c', decision: 'show', sentence: '' }, { id: 'a', decision: 'show', sentence: '' }]
    const choices = assetDecisions([USER, EARLIER, NEW], answer(lines), NO_GUARDS)

    expect(choices.map((choice) => [choice.asset.asset.id, choice.rank])).toStrictEqual([['a', 1], ['b', Infinity], ['c', 0]])
  })
})
