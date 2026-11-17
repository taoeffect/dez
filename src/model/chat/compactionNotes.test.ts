import { describe, expect, it } from 'vitest'
import { jobResultState, type JobInfo } from '../tools/jobs'
import { COMPACTION_END_LINE, compactionBlockText } from './compaction'
import {
  compactionNotesForPeople,
  compactionNotesParts,
  compactionNotesText,
  compactionTextForPeople,
  conversationCostText,
  notesAssetLines,
  notesCellText,
  notesJobLines,
  type CompactionNotes,
  type NotesAsset,
  type NotesAssetLine,
  type NotesJobLine,
} from './compactionNotes'
import { findImageReferences, imageReferenceTextWithKeptMark } from './images'
import { findMediaTags } from './mediaTags'
import { FOX_ORIGIN, HIDDEN_IMAGE_PATH, hiddenClip, hiddenImage, invokeBlock } from './testing'
import { findToolBlocks, unescapedModelText } from './toolBlocks'

const SUMMARY = '## Summary'
const REQUIREMENTS = '## Requirements and decisions'
const NEXT_STEPS = '## Next steps'
const ASSETS = '## Assets of the conversation'
const JOBS = '## Jobs of the reply'
const COST = '## Cost'

const PHOTO: NotesAsset = { id: 'a', kind: 'image', facts: 'PNG, 800x600, 120 KB', origin: 'from the user', sentence: 'The reference photo.', byReply: false, text: null }
const FRAME: NotesAsset = {
  id: 'c',
  kind: 'image',
  facts: 'PNG, 1024x768, 1.2 MB',
  origin: 'made by the model_invoke job 1 of its reply: "A cat"',
  sentence: 'The cat frame of scene 1.',
  byReply: true,
  text: hiddenImage('j-ab12', 'c'),
}
const THEME: NotesAsset = {
  id: 'd',
  kind: 'audio',
  facts: 'WAV, 8 s, 1.4 MB',
  origin: 'made by the model_invoke job 2 of its reply: "A theme"',
  sentence: 'The theme of the film.',
  byReply: false,
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
    jobInputs: new Map(),
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

// The line that the notes must give back for `job`, whose inputs are
// `inputs`.
function jobLine(job: JobInfo, inputs: string[] = []): NotesJobLine {
  return { id: job.id, number: job.call.number, tool: job.tool, status: job.status, result: jobResultState(job), label: job.call.label, inputs }
}

// The text of the part `heading` of the notes `text`, up to the next part.
function partText(text: string, heading: string): string {
  const start = text.indexOf(`${heading}\n\n`) + heading.length + 2
  const end = text.indexOf('\n\n## ', start)
  return text.slice(start, end < 0 ? text.length : end)
}

// The first line of each part of the notes of an older Dez, with all the
// columns in each line.
const FIRST_FORM_ASSETS_HEAD = 'Each line: @id | kind | facts | who made it | what it is, how it was made, and what a later step needs it for. '
  + 'Every id still names its image or clip. An image or a clip that these notes do not show as a picture is kept as its line only.'
const FIRST_FORM_JOBS_HEAD = 'The jobs of the reply that ran at this compaction. Each line: job id | number in the order of the starts | tool | status | result | how its call begins. '
  + 'result: `ready` means that the next jobs_wait of that reply gives it, `given` that a jobs_wait gave it, and `-` that there is none.'

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
    const text = compactionNotesText(notes({ unnamed: [imageReferenceTextWithKeptMark({ path, metadata: [] }, true)] }))
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

  it('leaves out the blank sentence of an asset with its column mark, and reads the sentence back as blank', () => {
    const text = compactionNotesText(notes({ assets: [{ ...PHOTO, sentence: ' \n ' }, FRAME] }))

    expect(text.split('\n').find((line) => line.startsWith('@a | '))).toMatch(/ \| from the user \| -$/)
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
    expect(unescapedModelText(text)).toContain(summary)
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
    const text = `${ASSETS}\n\n${FIRST_FORM_ASSETS_HEAD}\n\n@b | image | PNG, 10x10, 1 KB\n\n@c | image | PNG, 10x10, 1 KB | from the user`

    expect(notesAssetLines(text)).toStrictEqual(new Map([['c', { id: 'c', kind: 'image', facts: 'PNG, 10x10, 1 KB', origin: 'from the user', sentence: '', byReply: false }]]))
  })

  it('tells a kind and an origin that every asset has in a line each, and gives every column back', () => {
    const assets = [PHOTO, { ...PHOTO, id: 'b', facts: 'JPEG, 640x480, 80 KB', sentence: 'The sky.' }, { ...PHOTO, id: 'e', facts: 'PNG, 10x10, 1 KB', sentence: '' }]
    const text = compactionNotesText(notes({ assets }))

    // The reply column stays in the rows: its line in the head would make
    // the text of three rows longer.
    expect(partText(text, ASSETS)).toBe([
      'Every id still names its image or clip. An image or a clip that these notes do not show as a picture is kept as its line only. '
      + 'Each line: @id | facts | made by the reply that ran at this compaction | what it is, how it was made, and what a later step needs it for.',
      'Each asset is an image.',
      'Each asset is from the user.',
      '',
      '@a | PNG, 800x600, 120 KB | - | The reference photo.',
      '',
      '@b | JPEG, 640x480, 80 KB | - | The sky.',
      '',
      '@e | PNG, 10x10, 1 KB | -',
    ].join('\n'))
    expect([...notesAssetLines(text).values()]).toStrictEqual(assets.map(lineData))
  })

  it.each<[string, NotesAsset[]]>([
    ['one asset', [FRAME]],
    ['assets of the user and made ones', [PHOTO, FRAME, THEME, { ...FRAME, id: 'f', facts: 'PNG, 640x480, 300 KB', text: hiddenImage('j-ef56', 'f') }]],
    ['no asset', []],
  ])('gives every column of each asset back, for %s', (_case, assets) => {
    expect([...notesAssetLines(compactionNotesText(notes({ assets }))).values()]).toStrictEqual(assets.map(lineData))
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
      { id: 'j-aaaa', number: 1, tool: 'model_invoke', status: 'running', result: '-', label: 'A fox | a dog', inputs: [] },
      { id: 'j-bbbb', number: 2, tool: 'model_invoke', status: 'finished', result: 'ready', label: '', inputs: [] },
      { id: 'j-cccc', number: 3, tool: 'video', status: 'failed', result: 'given', label: 'join_clips @c @d', inputs: [] },
      { id: 'j-dddd', number: 4, tool: 'model_invoke', status: 'timed out', result: 'ready', label: 'Rain at night', inputs: [] },
      { id: 'j-eeee', number: 12, tool: 'model_invoke', status: 'stopped', result: '-', label: 'Show <dez:audio id="a" type="audio/wav"/>', inputs: [] },
    ])
    // A blank label is written as `-`.
    expect(text.split('\n').find((line) => line.startsWith('j-bbbb '))).toMatch(/ \| -$/)
  })

  it.each<[string, Map<string, string[]>]>([
    ['inputs that differ, and a job with none', new Map([['j-aaaa', ['a', 'b']], ['j-bbbb', ['c']]])],
    ['one input that every job has', new Map([['j-aaaa', ['a']], ['j-bbbb', ['a']], ['j-cccc', ['a']]])],
  ])('reads back the inputs of each open job, for %s', (_case, jobInputs) => {
    const jobs = [
      job({ id: 'j-aaaa', call: { number: 1, label: 'Make @a run to @b' } }),
      job({ id: 'j-bbbb', status: 'finished', call: { number: 2, label: 'Make @c jump' } }),
      job({ id: 'j-cccc', call: { number: 3, label: 'Rain' } }),
    ]
    const text = compactionNotesText(notes({ jobs, jobInputs }))

    expect([...notesJobLines(text).values()]).toStrictEqual(jobs.map((one) => jobLine(one, jobInputs.get(one.id))))
  })

  it('reads only the jobs part of Dez when the summary of the model has a part with the same heading', () => {
    const summary = `Done.\n\n${JOBS}\n\nj-zzzz | 9 | model_invoke | running | - | A line of the model`

    expect([...notesJobLines(compactionNotesText(notes({ summary, jobs: [job({ status: 'finished' })] }))).keys()]).toStrictEqual(['j-ab12'])
    expect([...notesJobLines(compactionNotesText(notes({ summary }))).keys()]).toStrictEqual([])
  })

  // The case of the user: 28 model_invoke jobs and a video job, which all
  // finished, and whose results a jobs_wait gave.
  it('tells the status and the result that every job has in a line each, and splits the jobs at the change of their tool, with the range of their numbers', () => {
    const done = { status: 'finished', delivered: true } as const
    const sheets = Array.from({ length: 28 }, (_, index) => job({ ...done, id: `j-s${index + 1}`, call: { number: index + 1, label: `Character sheet ${index + 1}` } }))
    const jobs = [...sheets, job({ ...done, id: 'j-film', tool: 'video', call: { number: 29, label: 'join_clips @a @b' } })]
    const text = compactionNotesText(notes({ jobs }))

    expect(partText(text, JOBS)).toBe([
      'The jobs of the reply that ran at this compaction, in the order of their starts. Each line: job id | how its call begins.',
      'Each job finished.',
      'A jobs_wait of that reply gave the result of each job.',
      'No open job had an input.',
      '',
      'Jobs 1 to 28, tool model_invoke:',
      ...sheets.map(({ id, call }) => `${id} | ${call.label}`),
      '',
      'Job 29, tool video:',
      'j-film | join_clips @a @b',
    ].join('\n'))
    expect([...notesJobLines(text).values()]).toStrictEqual(jobs.map((one) => jobLine(one)))
  })

  it('keeps the numbers in the rows when they have a gap, and the tool when it changes at every row', () => {
    const tools = ['model_invoke', 'video', 'model_invoke', 'audio']
    const jobs = [1, 2, 4, 5].map((number, index) => job({ id: `j-${number}`, tool: tools[index], status: 'finished', call: { number, label: `Call ${number}` } }))
    const text = compactionNotesText(notes({ jobs }))

    expect(partText(text, JOBS).split('\n').slice(-4)).toStrictEqual(jobs.map(({ id, tool, call }) => `${id} | ${call.number} | ${tool} | ${call.label}`))
    expect([...notesJobLines(text).values()]).toStrictEqual(jobs.map((one) => jobLine(one)))
  })

  it('explains only the results that the rows hold', () => {
    const jobs = [job({ id: 'j-a', status: 'finished', call: { number: 1, label: 'A' } }), job({ id: 'j-b', call: { number: 2, label: 'B' } })]
    const head = partText(compactionNotesText(notes({ jobs })), JOBS).split('\n')[0]

    expect(head).toContain('`ready`')
    expect(head).toContain('`-`')
    expect(head).not.toContain('`given`')
  })

  it.each<[string, JobInfo[]]>([
    ['one job', [job({ status: 'finished', call: { number: 1, label: 'A cat' } })]],
    ['a label with the column mark, a blank label, and a job that runs', [
      job({ id: 'j-a', status: 'finished', delivered: true, call: { number: 1, label: 'A fox | a dog' } }),
      job({ id: 'j-b', status: 'finished', delivered: true, call: { number: 2, label: '' } }),
      job({ id: 'j-c', call: { number: 3, label: 'Rain' } }),
    ]],
    ['a status and a result that change in a few runs', [
      ...[1, 2, 3].map((number) => job({ id: `j-${number}`, status: 'failed', delivered: true, call: { number, label: `Try ${number}` } })),
      ...[4, 5, 6].map((number) => job({ id: `j-${number}`, status: 'finished', call: { number, label: `Try ${number}` } })),
    ]],
    ['jobs that start at 7', [7, 8, 9].map((number) => job({ id: `j-${number}`, tool: 'audio', call: { number, label: 'A song' } }))],
  ])('gives every column of each job back, for %s', (_case, jobs) => {
    expect([...notesJobLines(compactionNotesText(notes({ jobs }))).values()]).toStrictEqual(jobs.map((one) => jobLine(one)))
  })
})

describe('the notes of an older Dez', () => {
  const text = [
    ASSETS,
    '',
    FIRST_FORM_ASSETS_HEAD,
    '',
    hiddenImage('j-aaaa', 'b'),
    `@b | image | PNG, 1024x768, 1.2 MB | ${FOX_ORIGIN} | The fox | scene 1.`,
    '',
    '@a | image | PNG, 800x600, 120 KB | from the user',
    '',
    JOBS,
    '',
    FIRST_FORM_JOBS_HEAD,
    '',
    'j-zzzz | 1 | video | running | - | -',
    'j-aaaa | 2 | model_invoke | finished | given | A red fox',
  ].join('\n')

  it('reads each asset line and each job line of the form with all the columns in each line', () => {
    expect([...notesAssetLines(text).values()]).toStrictEqual([
      { id: 'b', kind: 'image', facts: 'PNG, 1024x768, 1.2 MB', origin: FOX_ORIGIN, sentence: 'The fox | scene 1.', byReply: false },
      { id: 'a', kind: 'image', facts: 'PNG, 800x600, 120 KB', origin: 'from the user', sentence: '', byReply: false },
    ])
    expect([...notesJobLines(text).values()]).toStrictEqual([
      { id: 'j-zzzz', number: 1, tool: 'video', status: 'running', result: '-', label: '', inputs: [] },
      { id: 'j-aaaa', number: 2, tool: 'model_invoke', status: 'finished', result: 'given', label: 'A red fox', inputs: [] },
    ])
  })

  // The form of the Dez before the reply column and the inputs column: a
  // value that every row has is in a line of its own.
  const SHARED_FORM = [
    ASSETS,
    '',
    'Every id still names its image or clip. An image or a clip that these notes do not show as a picture is kept as its line only. '
    + 'Each line: @id | facts | what it is, how it was made, and what a later step needs it for.',
    'Each asset is an image.',
    'Each asset is from the user.',
    '',
    '@a | PNG, 800x600, 120 KB | The reference photo.',
    '',
    JOBS,
    '',
    'The jobs of the reply that ran at this compaction, in the order of their starts. Each line: job id | how its call begins.',
    'Each job finished.',
    'A jobs_wait of that reply gave the result of each job.',
    '',
    'Jobs 1 to 2, tool model_invoke:',
    'j-aaaa | A red fox',
    'j-bbbb | A hare',
  ].join('\n')

  it('reads each asset line and each job line of the form with shared values', () => {
    expect([...notesAssetLines(SHARED_FORM).values()]).toStrictEqual([
      { id: 'a', kind: 'image', facts: 'PNG, 800x600, 120 KB', origin: 'from the user', sentence: 'The reference photo.', byReply: false },
    ])
    expect([...notesJobLines(SHARED_FORM).values()]).toStrictEqual([
      { id: 'j-aaaa', number: 1, tool: 'model_invoke', status: 'finished', result: 'given', label: 'A red fox', inputs: [] },
      { id: 'j-bbbb', number: 2, tool: 'model_invoke', status: 'finished', result: 'given', label: 'A hare', inputs: [] },
    ])
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

describe('the notes for people', () => {
  // A model wrote this: the writer escapes it, so it forms no tag of Dez.
  const MODEL_TAG = '<dez:audio id="z"/>'
  const text = compactionNotesText(notes({ summary: `Like ${MODEL_TAG}, up to ${COMPACTION_END_LINE}`, assets: [FRAME, THEME] }))

  it('gives a label in place of each asset of Dez, and the text of the model as it wrote it', () => {
    const people = compactionNotesForPeople(text)

    expect(people).not.toContain(HIDDEN_IMAGE_PATH)
    expect(people.split('\n').filter((line) => line === '[image]' || line === '[audio]')).toStrictEqual(['[image]', '[audio]'])
    expect(people).toContain(`Like ${MODEL_TAG}, up to ${COMPACTION_END_LINE}`)
  })

  it('gives the notes in place of the block of a compaction section, with the text after the block, and any other text as it is', () => {
    const block = compactionBlockText({ count: 1, lastId: 'd', pictures: [] }, text)
    const section = `${block}\nTyped after it.`

    expect(compactionTextForPeople(section, 0, 'agent')).toBe(`${compactionNotesForPeople(text)}\n\nTyped after it.`)
    expect(compactionTextForPeople(block, 0, 'agent')).toBe(compactionNotesForPeople(text))
    expect(compactionTextForPeople(section, 1, 'agent')).toBe(section)
    expect(compactionTextForPeople(section, 0, 'user')).toBe(section)
    expect(compactionTextForPeople('Hello.', 0, 'agent')).toBe('Hello.')
  })

  it('splits the notes into the assets part of Dez and every other part, in order', () => {
    // The model copied the heading of the assets part into its summary.
    const copied = compactionNotesText(notes({ summary: `${ASSETS}\n\nA line of the model.`, assets: [PHOTO] }))
    const { assets, summary } = compactionNotesParts(copied)

    expect(assets).toBe(compactionNotesForPeople(partText(copied.slice(copied.lastIndexOf(ASSETS)), ASSETS)).trim())
    expect(assets).toContain('@a | ')
    expect(headings(summary)).toStrictEqual([SUMMARY, ASSETS, REQUIREMENTS, NEXT_STEPS, JOBS, COST])
    expect(summary).toContain('A line of the model.')
    expect(summary).not.toContain('@a | ')
    expect(compactionNotesParts('Only a summary.')).toStrictEqual({ assets: '', summary: 'Only a summary.' })
  })
})
