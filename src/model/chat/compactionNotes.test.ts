import { describe, expect, it } from 'vitest'
import { jobResultState, type JobInfo } from '../tools/jobs'
import { jobInfo } from '../tools/testing'
import { COMPACTION_END_LINE, compactionBlockText, readCompactionBlock } from './compaction'
import {
  compactionNotesForPeople,
  compactionNotesParts,
  compactionNotesText,
  compactionTextForPeople,
  conversationCostText,
  messageFence,
  notesAssetLines,
  notesCellText,
  notesJobLines,
  notesLeftOutMessages,
  notesMessages,
  type CompactionNotes,
  type NotesAsset,
  type NotesAssetLine,
  type NotesJobLine,
} from './compactionNotes'
import { findImageReferences, imageReferenceTextWithKeptMark } from './images'
import { findMediaTags, mediaTagText } from './mediaTags'
import { FOX_ORIGIN, HIDDEN_IMAGE_PATH, hiddenClip, hiddenImage, idImage, invokeBlock, messagePart, notesData } from './testing'
import { findToolBlocks, unescapedModelText } from './toolBlocks'

const REQUIREMENTS = '## Requirements and decisions'
const ASSETS = '## Assets of the conversation'
const JOBS = '## Jobs of the reply'
const COST = '## Cost'
const USER_MESSAGES = '## User messages'
const FIRST_MESSAGE = '### First message'
const ONLY_MESSAGE = '### First and final message'
const MIDDLE_MESSAGES = '### Relevant middle messages'
const FINAL_MESSAGE = '### Final message'
// Headings of the notes of an older Dez.
const SUMMARY = '## Summary'
const NEXT_STEPS = '## Next steps'

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

function headings(text: string): string[] {
  return text.split('\n').filter((line) => line.startsWith('## '))
}

// The headings of the parts of the messages of the user in `text`.
function messageHeadings(text: string): string[] {
  return text.split('\n').filter((line) => line.startsWith('### '))
}

// The text `text` in a code fence of `length` backticks.
function fenced(text: string, length = 3): string {
  const fence = '`'.repeat(length)
  return `${fence}\n${text}\n${fence}`
}

function lineData({ text: _text, ...line }: NotesAsset): NotesAssetLine {
  return line
}

// The line that the notes must give back for `job`, whose inputs are
// `inputs`.
function jobLine(job: JobInfo, inputs: string[] = []): NotesJobLine {
  return { id: job.id, number: job.call.number, tool: job.tool, status: job.status, result: jobResultState(job), label: job.call.label, inputs }
}

// The text of the part `heading` of the notes `text`, up to the next part
// of its level.
function partText(text: string, heading: string): string {
  const level = heading.slice(0, heading.indexOf(' ') + 1)
  const start = text.indexOf(`${heading}\n\n`) + heading.length + 2
  const end = text.indexOf(`\n\n${level}`, start)
  return text.slice(start, end < 0 ? text.length : end)
}

// The first line of each part of the notes of an older Dez, with all the
// columns in each line.
const FIRST_FORM_ASSETS_HEAD = 'Each line: @id | kind | facts | who made it | what it is, how it was made, and what a later step needs it for. '
  + 'Every id still names its image or clip. An image or a clip that these notes do not show as a picture is kept as its line only.'
const FIRST_FORM_JOBS_HEAD = 'The jobs of the reply that ran at this compaction. Each line: job id | number in the order of the starts | tool | status | result | how its call begins. '
  + 'result: `ready` means that the next jobs_wait of that reply gives it, `given` that a jobs_wait gave it, and `-` that there is none.'

describe('compactionNotesText', () => {
  it('writes the requirements of the model under their heading, then the assets, the jobs, and the cost', () => {
    const text = compactionNotesText(notesData({ assets: [FRAME], jobs: [jobInfo({})], cost: { usd: 0.25, requests: 3, unpriced: 0 } }))
    const lines = text.split('\n')

    expect(headings(text)).toStrictEqual([REQUIREMENTS, ASSETS, JOBS, COST])
    expect(lines[lines.indexOf(REQUIREMENTS) + 2]).toBe('Every frame is 16:9.')
    expect(lines.at(-1)).toContain('$0.25')
  })

  it('leaves out blank requirements with their heading, and always writes the parts of Dez', () => {
    expect(headings(compactionNotesText(notesData({ requirements: ' \n\t' })))).toStrictEqual([ASSETS, JOBS, COST])
    expect(headings(compactionNotesText(notesData({ requirements: '' })))).toStrictEqual([ASSETS, JOBS, COST])
  })

  it('keeps the reference of an image with no id in the assets part', () => {
    const path = '/home/u/.config/dez/assets/generated/images/old.png'
    const text = compactionNotesText(notesData({ unnamed: [imageReferenceTextWithKeptMark({ path, metadata: [] }, true)] }))
    const lines = text.split('\n')

    expect(findImageReferences(text, 'agent').map((reference) => reference.path)).toStrictEqual([path])
    expect(lines.findIndex((line) => line.includes(path))).toBeGreaterThan(lines.indexOf(ASSETS))
    expect(lines.findIndex((line) => line.includes(path))).toBeLessThan(lines.indexOf(JOBS))
  })

  it('puts the text of an asset alone on the line right before its line, and no text with the line of an asset in a message part', () => {
    const userImage: NotesAsset = { ...PHOTO, id: 'e', text: idImage('/home/u/.config/dez/assets/images/e.png', 'e', true) }
    const text = compactionNotesText(notesData({ assets: [PHOTO, FRAME, THEME, userImage] }))
    const lines = text.split('\n')
    const lineIndex = (id: string) => lines.findIndex((line) => line.startsWith(`@${id} | `))

    expect(lines[lineIndex(FRAME.id) - 1]).toBe(FRAME.text)
    expect(lines[lineIndex(THEME.id) - 1]).toBe(THEME.text)
    expect(lines[lineIndex(userImage.id) - 1]).toBe(userImage.text)
    expect(lines[lineIndex(PHOTO.id) - 1]).toBe('')
    expect(findImageReferences(text, 'agent').map((reference) => reference.id)).toStrictEqual([FRAME.id, userImage.id])
    expect(findMediaTags(text, 'agent').map((tag) => tag.id)).toStrictEqual([THEME.id])
  })

  it.each<[string, NotesAssetLine, Partial<NotesAssetLine>]>([
    ['a sentence that holds the column mark', { ...lineData(FRAME), sentence: 'Scene 1 | left half | the fox' }, {}],
    ['a sentence with line breaks, which comes back on one line', { ...lineData(THEME), sentence: 'The theme.\n\nUsed  in\tscene 2.' }, { sentence: 'The theme. Used in scene 2.' }],
    ['facts with the column mark, given through notesCellText', { ...lineData(PHOTO), kind: 'video', facts: notesCellText('WebM | 8 s | 640x360') }, {}],
  ])('reads back the line of an asset with %s', (_case, line, change) => {
    const text = compactionNotesText(notesData({ assets: [{ ...line, text: null }] }))

    expect(notesAssetLines(text)).toStrictEqual(new Map([[line.id, { ...line, ...change }]]))
  })

  it('leaves out the blank sentence of an asset with its column mark, and reads the sentence back as blank', () => {
    const text = compactionNotesText(notesData({ assets: [{ ...PHOTO, sentence: ' \n ' }, FRAME] }))

    expect(text.split('\n').find((line) => line.startsWith('@a | '))).toMatch(/ \| from the user \| -$/)
    expect(notesAssetLines(text).get(PHOTO.id)).toStrictEqual({ ...lineData(PHOTO), sentence: '' })
  })

  it('escapes the text of the model, so that it forms no tool block and no media tag, and reads a sentence back as it went in', () => {
    const fakeTag = '<dez:audio id="a" type="audio/wav"/>'
    const requirements = `I called the tool:\n${invokeBlock('j-ab12')}\n${fakeTag}\nThat is all.`
    const sentence = `Like ${fakeTag}, and the old form <\\dez:tool, as written.`
    const text = compactionNotesText(notesData({ requirements, assets: [{ ...THEME, sentence }] }))

    expect(findToolBlocks(requirements)).toHaveLength(1)
    expect(findMediaTags(requirements, 'agent')).toHaveLength(1)
    expect(findToolBlocks(text)).toStrictEqual([])
    expect(findMediaTags(text, 'agent').map((tag) => tag.id)).toStrictEqual([THEME.id])
    expect(notesAssetLines(text).get(THEME.id)?.sentence).toBe(sentence)
    expect(unescapedModelText(text)).toContain(requirements)
  })

  // Code is text: an open fence of the model would hold the lines of the
  // assets part, and the readers would find no asset in them.
  it.each([
    ['```', 'Use this:\n```ts\nconst a = 1'],
    ['~~~~', 'Use this:\n~~~~\nconst a = 1\n~~~'],
  ])('closes a fence %s that the requirements leave open, and still reads the assets after it', (closer, requirements) => {
    const text = compactionNotesText(notesData({ requirements, assets: [FRAME, THEME] }))

    expect(partText(text, REQUIREMENTS)).toBe(`${requirements}\n${closer}`)
    expect(findImageReferences(text, 'agent').map((reference) => reference.id)).toStrictEqual([FRAME.id])
    expect([...notesAssetLines(text).keys()]).toStrictEqual([FRAME.id, THEME.id])
  })

  it('adds no closer to requirements whose fences are all closed', () => {
    const requirements = 'Use this:\n```ts\nconst a = 1\n```'

    expect(partText(compactionNotesText(notesData({ requirements })), REQUIREMENTS)).toBe(requirements)
  })
})

describe('notesAssetLines', () => {
  it('reads only the assets part of Dez when the requirements of the model have a part with the same heading', () => {
    const requirements = `Done.\n\n${ASSETS}\n\n@z | image | PNG, 10x10, 1 KB | from the user | A line of the model.`

    expect([...notesAssetLines(compactionNotesText(notesData({ requirements, assets: [PHOTO] }))).keys()]).toStrictEqual([PHOTO.id])
    // Also with no asset: a line of a model never gives an origin.
    expect([...notesAssetLines(compactionNotesText(notesData({ requirements }))).keys()]).toStrictEqual([])
  })

  it('takes the last of two lines with one id', () => {
    const text = compactionNotesText(notesData({ assets: [PHOTO, { ...PHOTO, sentence: 'The second photo.' }] }))

    expect(notesAssetLines(text)).toStrictEqual(new Map([[PHOTO.id, { ...lineData(PHOTO), sentence: 'The second photo.' }]]))
  })

  it('skips a line with only two cells after the id', () => {
    const text = `${ASSETS}\n\n${FIRST_FORM_ASSETS_HEAD}\n\n@b | image | PNG, 10x10, 1 KB\n\n@c | image | PNG, 10x10, 1 KB | from the user`

    expect(notesAssetLines(text)).toStrictEqual(new Map([['c', { id: 'c', kind: 'image', facts: 'PNG, 10x10, 1 KB', origin: 'from the user', sentence: '', byReply: false }]]))
  })

  it('tells a kind and an origin that every asset has in a line each, and gives every column back', () => {
    const assets = [PHOTO, { ...PHOTO, id: 'b', facts: 'JPEG, 640x480, 80 KB', sentence: 'The sky.' }, { ...PHOTO, id: 'e', facts: 'PNG, 10x10, 1 KB', sentence: '' }]
    const text = compactionNotesText(notesData({ assets }))

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
    expect([...notesAssetLines(compactionNotesText(notesData({ assets }))).values()]).toStrictEqual(assets.map(lineData))
  })
})

describe('notesJobLines', () => {
  it('reads back the number, the tool, the status, the result, and the label of each job', () => {
    const jobs = [
      jobInfo({ id: 'j-aaaa', status: 'running', call: { number: 1, label: 'A fox | a dog' } }),
      jobInfo({ id: 'j-bbbb', status: 'finished', call: { number: 2, label: '' } }),
      jobInfo({ id: 'j-cccc', tool: 'video', status: 'failed', delivered: true, call: { number: 3, label: 'join_clips @c @d' } }),
      jobInfo({ id: 'j-dddd', status: 'timed out', call: { number: 4, label: 'Rain\nat night' } }),
      jobInfo({ id: 'j-eeee', status: 'stopped', call: { number: 12, label: 'Show <dez:audio id="a" type="audio/wav"/>' } }),
      jobInfo({ id: 'j-ffff', status: 'cancelled', call: { number: 13, label: 'A wrong cat' } }),
    ]
    const text = compactionNotesText(notesData({ jobs }))

    expect([...notesJobLines(text).values()]).toStrictEqual([
      { id: 'j-aaaa', number: 1, tool: 'model_invoke', status: 'running', result: '-', label: 'A fox | a dog', inputs: [] },
      { id: 'j-bbbb', number: 2, tool: 'model_invoke', status: 'finished', result: 'ready', label: '', inputs: [] },
      { id: 'j-cccc', number: 3, tool: 'video', status: 'failed', result: 'given', label: 'join_clips @c @d', inputs: [] },
      { id: 'j-dddd', number: 4, tool: 'model_invoke', status: 'timed out', result: 'ready', label: 'Rain at night', inputs: [] },
      { id: 'j-eeee', number: 12, tool: 'model_invoke', status: 'stopped', result: '-', label: 'Show <dez:audio id="a" type="audio/wav"/>', inputs: [] },
      { id: 'j-ffff', number: 13, tool: 'model_invoke', status: 'cancelled', result: '-', label: 'A wrong cat', inputs: [] },
    ])
    // A blank label is written as `-`.
    expect(text.split('\n').find((line) => line.startsWith('j-bbbb '))).toMatch(/ \| -$/)
  })

  it.each<[string, Map<string, string[]>]>([
    ['inputs that differ, and a job with none', new Map([['j-aaaa', ['a', 'b']], ['j-bbbb', ['c']]])],
    ['one input that every job has', new Map([['j-aaaa', ['a']], ['j-bbbb', ['a']], ['j-cccc', ['a']]])],
  ])('reads back the inputs of each open job, for %s', (_case, jobInputs) => {
    const jobs = [
      jobInfo({ id: 'j-aaaa', call: { number: 1, label: 'Make @a run to @b' } }),
      jobInfo({ id: 'j-bbbb', status: 'finished', call: { number: 2, label: 'Make @c jump' } }),
      jobInfo({ id: 'j-cccc', call: { number: 3, label: 'Rain' } }),
    ]
    const text = compactionNotesText(notesData({ jobs, jobInputs }))

    expect([...notesJobLines(text).values()]).toStrictEqual(jobs.map((one) => jobLine(one, jobInputs.get(one.id))))
  })

  it('reads only the jobs part of Dez when the requirements of the model have a part with the same heading', () => {
    const requirements = `Done.\n\n${JOBS}\n\nj-zzzz | 9 | model_invoke | running | - | A line of the model`

    expect([...notesJobLines(compactionNotesText(notesData({ requirements, jobs: [jobInfo({ status: 'finished' })] }))).keys()]).toStrictEqual(['j-aaaa'])
    expect([...notesJobLines(compactionNotesText(notesData({ requirements }))).keys()]).toStrictEqual([])
  })

  // The case of the user: 28 model_invoke jobs and a video job, which all
  // finished, and whose results a jobs_wait gave.
  it('tells the status and the result that every job has in a line each, and splits the jobs at the change of their tool, with the range of their numbers', () => {
    const done = { status: 'finished', delivered: true } as const
    const sheets = Array.from({ length: 28 }, (_, index) => jobInfo({ ...done, id: `j-s${index + 1}`, call: { number: index + 1, label: `Character sheet ${index + 1}` } }))
    const jobs = [...sheets, jobInfo({ ...done, id: 'j-film', tool: 'video', call: { number: 29, label: 'join_clips @a @b' } })]
    const text = compactionNotesText(notesData({ jobs }))

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
    const jobs = [1, 2, 4, 5].map((number, index) => jobInfo({ id: `j-${number}`, tool: tools[index], status: 'finished', call: { number, label: `Call ${number}` } }))
    const text = compactionNotesText(notesData({ jobs }))

    expect(partText(text, JOBS).split('\n').slice(-4)).toStrictEqual(jobs.map(({ id, tool, call }) => `${id} | ${call.number} | ${tool} | ${call.label}`))
    expect([...notesJobLines(text).values()]).toStrictEqual(jobs.map((one) => jobLine(one)))
  })

  it('explains only the results that the rows hold', () => {
    const jobs = [jobInfo({ id: 'j-a', status: 'finished', call: { number: 1, label: 'A' } }), jobInfo({ id: 'j-b', call: { number: 2, label: 'B' } })]
    const head = partText(compactionNotesText(notesData({ jobs })), JOBS).split('\n')[0]

    expect(head).toContain('`ready`')
    expect(head).toContain('`-`')
    expect(head).not.toContain('`given`')
  })

  it.each<[string, JobInfo[]]>([
    ['one job', [jobInfo({ status: 'finished', call: { number: 1, label: 'A cat' } })]],
    ['a label with the column mark, a blank label, and a job that runs', [
      jobInfo({ id: 'j-a', status: 'finished', delivered: true, call: { number: 1, label: 'A fox | a dog' } }),
      jobInfo({ id: 'j-b', status: 'finished', delivered: true, call: { number: 2, label: '' } }),
      jobInfo({ id: 'j-c', call: { number: 3, label: 'Rain' } }),
    ]],
    ['a status and a result that change in a few runs', [
      ...[1, 2, 3].map((number) => jobInfo({ id: `j-${number}`, status: 'failed', delivered: true, call: { number, label: `Try ${number}` } })),
      ...[4, 5, 6].map((number) => jobInfo({ id: `j-${number}`, status: 'finished', call: { number, label: `Try ${number}` } })),
    ]],
    ['jobs that start at 7', [7, 8, 9].map((number) => jobInfo({ id: `j-${number}`, tool: 'audio', call: { number, label: 'A song' } }))],
  ])('gives every column of each job back, for %s', (_case, jobs) => {
    expect([...notesJobLines(compactionNotesText(notesData({ jobs }))).values()]).toStrictEqual(jobs.map((one) => jobLine(one)))
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

  // The layout of the Dez before the part of the messages of the user: the
  // first message before the three parts of the model, and the newest one
  // after the cost.
  const MESSAGES_AROUND = [
    `## First message of the user\n\n${messagePart('Make a fox.')}`,
    `${SUMMARY}\n\nThe user wants a short fox film.`,
    `${REQUIREMENTS}\n\nEvery frame is 16:9.`,
    `${NEXT_STEPS}\n\nMake scene 2.`,
    compactionNotesText(notesData({ requirements: '', assets: [PHOTO], jobs: [jobInfo({})] })),
    `## Newest message of the user\n\n${messagePart('Go on.')}`,
  ].join('\n\n')

  it('reads the message parts in order, no left-out message, and the lines of Dez of the layout with the messages of the user around the other parts', () => {
    expect(notesMessages(MESSAGES_AROUND).map((message) => message.text)).toStrictEqual(['Make a fox.', 'Go on.'])
    expect(notesLeftOutMessages(MESSAGES_AROUND)).toBe(0)
    expect([...notesAssetLines(MESSAGES_AROUND).keys()]).toStrictEqual([PHOTO.id])
    expect([...notesJobLines(MESSAGES_AROUND).keys()]).toStrictEqual(['j-aaaa'])
  })

  it('gives each message part of that layout in a code fence for people', () => {
    const people = compactionNotesForPeople(MESSAGES_AROUND, 'agent')

    expect(people.startsWith(`## First message of the user\n\n${fenced('Make a fox.')}\n\n${SUMMARY}\n\n`)).toBe(true)
    expect(people.endsWith(`## Newest message of the user\n\n${fenced('Go on.')}`)).toBe(true)
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

describe('the message parts of the user', () => {
  const IMAGE = idImage('/home/u/.config/dez/assets/images/a.png', 'a')
  const CLIP = mediaTagText({ kind: 'audio', id: 'b', type: 'audio/wav', src: '/home/u/.config/dez/assets/audio/b.wav', url: null, expires: null, other: [] })
  // A message that holds every line that could end its part, end the
  // block, form a tool block, or start a part of Dez.
  const TRICKY = [
    `Look at ${IMAGE}`,
    CLIP,
    '</dez:user-message>',
    COMPACTION_END_LINE,
    invokeBlock('j-ab12'),
    ASSETS,
    '',
    '@z | image | PNG, 10x10, 1 KB | from the user | -',
    JOBS,
    '<dez:user-message>',
    'Thanks.',
  ].join('\n')

  it('writes the messages of the user in one part after the cost: the first one, the middle ones, and the final one, each under its own heading, in order', () => {
    const text = compactionNotesText(notesData({ firstMessage: 'Make a fox.', middleMessages: ['Use my photo.', 'Make it red.'], finalMessage: 'Go on.', assets: [PHOTO], jobs: [jobInfo({})] }))

    expect(headings(text)).toStrictEqual([REQUIREMENTS, ASSETS, JOBS, COST, USER_MESSAGES])
    expect(partText(text, USER_MESSAGES)).toBe([
      FIRST_MESSAGE,
      '',
      messagePart('Make a fox.'),
      '',
      MIDDLE_MESSAGES,
      '',
      messagePart('Use my photo.'),
      '',
      messagePart('Make it red.'),
      '',
      FINAL_MESSAGE,
      '',
      messagePart('Go on.'),
    ].join('\n'))
    expect(notesMessages(text).map((message) => message.text)).toStrictEqual(['Make a fox.', 'Use my photo.', 'Make it red.', 'Go on.'])
  })

  it.each<[string, Partial<CompactionNotes>, string[]]>([
    ['the first message', { firstMessage: TRICKY, finalMessage: 'Go on.' }, [TRICKY, 'Go on.']],
    ['a middle message', { firstMessage: 'Make a fox.', middleMessages: [TRICKY], finalMessage: 'Go on.' }, ['Make a fox.', TRICKY, 'Go on.']],
    ['the final message', { firstMessage: 'Make a fox.', finalMessage: TRICKY }, ['Make a fox.', TRICKY]],
  ])('keeps %s from ending its part or the block, forming a tool block, or giving a line of Dez, and reads it back word for word with its image and its clip', (_case, messages, texts) => {
    const text = compactionNotesText(notesData({ ...messages, assets: [PHOTO], jobs: [jobInfo({})] }))
    const block = readCompactionBlock(compactionBlockText({ count: 1, lastId: 'b', pictures: [] }, text))

    expect(block?.notes).toBe(text)
    expect(notesMessages(text).map((message) => message.text)).toStrictEqual(texts)
    expect(findToolBlocks(text)).toStrictEqual([])
    expect(findImageReferences(text, 'agent').map((reference) => reference.id)).toStrictEqual(['a'])
    expect(findMediaTags(text, 'agent').map((tag) => tag.id)).toStrictEqual(['b'])
    expect([...notesAssetLines(text).keys()]).toStrictEqual([PHOTO.id])
    expect([...notesJobLines(text).keys()]).toStrictEqual(['j-aaaa'])
  })

  it('writes one part under its own heading when the first message is the final one', () => {
    const text = compactionNotesText(notesData({ firstMessage: 'Make a fox.' }))

    expect(partText(text, USER_MESSAGES)).toBe(`${ONLY_MESSAGE}\n\n${messagePart('Make a fox.')}`)
    expect(notesMessages(text).map((message) => message.text)).toStrictEqual(['Make a fox.'])
  })

  it('writes no middle heading when the notes keep no middle message and left out none', () => {
    const text = compactionNotesText(notesData({ firstMessage: 'Make a fox.', finalMessage: 'Go on.' }))

    expect(messageHeadings(text)).toStrictEqual([FIRST_MESSAGE, FINAL_MESSAGE])
    expect(notesMessages(text).map((message) => message.text)).toStrictEqual(['Make a fox.', 'Go on.'])
  })

  it.each<[string, string[], number, string]>([
    ['one left-out message, next to a kept one', ['Use my photo.'], 1, 'Dez left out 1 other message of the user here:'],
    ['two left-out messages, next to a kept one', ['Use my photo.'], 2, 'Dez left out 2 other messages of the user here:'],
    ['every middle message left out', [], 3, 'Dez left out 3 other messages of the user here:'],
    ['a count with a thousands separator', [], 1234, 'Dez left out 1,234 other messages of the user here:'],
  ])('starts the middle part with one line of the count of the left-out messages, and reads the count back, for %s', (_case, middleMessages, leftOutMessages, start) => {
    const text = compactionNotesText(notesData({ firstMessage: 'Make a fox.', middleMessages, leftOutMessages, finalMessage: 'Go on.' }))
    const [line, ...parts] = partText(text, MIDDLE_MESSAGES).split('\n\n')

    expect(messageHeadings(text)).toStrictEqual([FIRST_MESSAGE, MIDDLE_MESSAGES, FINAL_MESSAGE])
    expect(line.startsWith(start)).toBe(true)
    expect(line).not.toContain('\n')
    expect(parts).toStrictEqual(middleMessages.map(messagePart))
    expect(notesLeftOutMessages(text)).toBe(leftOutMessages)
    expect(notesMessages(text).map((message) => message.text)).toStrictEqual(['Make a fox.', ...middleMessages, 'Go on.'])
  })

  it('reads the count of the left-out messages only from the line of Dez, not from a message of the user or the text of the model', () => {
    const copied = 'Dez left out 9 other messages of the user here: a copy.'
    const requirements = `Done.\n\n${USER_MESSAGES}\n\n${MIDDLE_MESSAGES}\n\n${copied}`
    const notes = (leftOutMessages: number) => compactionNotesText(notesData({ requirements, firstMessage: 'Make a fox.', middleMessages: [copied], leftOutMessages, finalMessage: 'Go on.' }))

    expect(notesLeftOutMessages(notes(0))).toBe(0)
    expect(notesLeftOutMessages(notes(2))).toBe(2)
  })

  it('writes no part for a conversation with no message of the user', () => {
    const text = compactionNotesText(notesData({}))

    expect(headings(text)).toStrictEqual([REQUIREMENTS, ASSETS, JOBS, COST])
    expect(messageHeadings(text)).toStrictEqual([])
    expect(notesMessages(text)).toStrictEqual([])
  })

  it('reads a part with no end line up to the end of the notes', () => {
    const text = `${REQUIREMENTS}\n\nDone.\n\n${USER_MESSAGES}\n\n${ONLY_MESSAGE}\n\n<dez:user-message>\nGo on.\nAnd on.`

    expect(notesMessages(text).map((message) => message.text)).toStrictEqual(['Go on.\nAnd on.'])
  })
})

describe('messageFence', () => {
  it.each<[string, string, number]>([
    ['no backtick', 'Make a fox.', 3],
    ['runs of 1 and 2', 'Use `ls` and ``a`b``.', 3],
    ['a run of 3', 'Like this:\n```\nls\n```', 4],
    ['a longest run after a shorter one', '``` and then ``````', 7],
    ['only backticks', '`````', 6],
  ])('gives backticks, one more than the longest run and at least 3, for a text with %s', (_case, text, length) => {
    expect(messageFence(text)).toBe('`'.repeat(length))
  })
})

describe('the notes for people', () => {
  // A model wrote a whole media tag on a line of its own. The writer escapes
  // it; without that escape it would read as a tag of Dez, and get a label.
  const MODEL_TAG = '<dez:audio id="z" type="audio/wav"/>'
  const text = compactionNotesText(notesData({ requirements: `Like this:\n${MODEL_TAG}\nup to ${COMPACTION_END_LINE}`, assets: [FRAME, THEME] }))

  it('gives a label in place of each asset of Dez, and the text of the model as it wrote it', () => {
    const people = compactionNotesForPeople(text, 'agent')

    expect(people).not.toContain(HIDDEN_IMAGE_PATH)
    expect(people.split('\n').filter((line) => line === '[image]' || line === '[audio]')).toStrictEqual(['[image]', '[audio]'])
    expect(people).toContain(`Like this:\n${MODEL_TAG}\nup to ${COMPACTION_END_LINE}`)
  })

  it('gives each message part as the text of its message in a code fence, with a label for each asset, each app, and each linked image that the rule lists', () => {
    const linked = '/home/u/Pictures/fox.png'
    const message = `Draw this: ${idImage(linked, 'a')}\n<dez:tool, as typed.\n${COMPACTION_END_LINE}`
    const withMessages = compactionNotesText(notesData({
      firstMessage: message,
      middleMessages: [`Also ${idImage(linked, 'a')} here.\n<dez:app name="notes" open="1"/>`],
      finalMessage: `And ${idImage(linked, 'a')} again.`,
    }))
    const people = compactionNotesForPeople(withMessages, new Set([linked]))

    expect(people.endsWith([
      USER_MESSAGES,
      '',
      FIRST_MESSAGE,
      '',
      fenced(`Draw this: [image]\n<dez:tool, as typed.\n${COMPACTION_END_LINE}`),
      '',
      MIDDLE_MESSAGES,
      '',
      fenced('Also [image] here.\n[app notes]'),
      '',
      FINAL_MESSAGE,
      '',
      fenced('And [image] again.'),
    ].join('\n'))).toBe(true)
    expect(people).not.toContain(linked)
    expect(people).not.toContain('dez:user-message')
  })

  it('draws the fence of each message longer than the longest run of backticks in it, so that no run closes it', () => {
    const message = 'Run this:\n````sh\nls ``*.png``\n````'
    const people = compactionNotesForPeople(compactionNotesText(notesData({ firstMessage: 'Make a fox.', middleMessages: [message], finalMessage: 'Go on with `ls`.' })), 'agent')

    expect(people.endsWith([
      FIRST_MESSAGE,
      '',
      fenced('Make a fox.'),
      '',
      MIDDLE_MESSAGES,
      '',
      fenced(message, 5),
      '',
      FINAL_MESSAGE,
      '',
      fenced('Go on with `ls`.'),
    ].join('\n'))).toBe(true)
  })

  it('gives the notes in place of the block of a compaction section, with the text after the block, and any other text, in the form of the caller', () => {
    const block = compactionBlockText({ count: 1, lastId: 'd', pictures: [] }, text)
    const section = `${block}\nTyped after it.`
    const upper = (part: string) => part.toUpperCase()

    expect(compactionTextForPeople(section, 0, 'agent', upper)).toBe(`${compactionNotesForPeople(text, 'agent')}\n\nTYPED AFTER IT.`)
    expect(compactionTextForPeople(block, 0, 'agent', upper)).toBe(compactionNotesForPeople(text, 'agent'))
    expect(compactionTextForPeople(section, 1, 'agent', upper)).toBe(section.toUpperCase())
    expect(compactionTextForPeople(section, 0, 'user', upper)).toBe(section.toUpperCase())
    expect(compactionTextForPeople('Hello.', 0, 'agent', upper)).toBe('HELLO.')
  })

  it('splits the notes into the assets part of Dez and every other part, in order', () => {
    // The model copied the heading of the assets part into its requirements.
    const copied = compactionNotesText(notesData({ requirements: `${ASSETS}\n\nA line of the model.`, assets: [PHOTO] }))
    const { assets, summary } = compactionNotesParts(copied, 'agent')

    expect(assets).toBe(compactionNotesForPeople(partText(copied.slice(copied.lastIndexOf(ASSETS)), ASSETS), 'agent').trim())
    expect(assets).toContain('@a | ')
    expect(headings(summary)).toStrictEqual([REQUIREMENTS, ASSETS, JOBS, COST])
    expect(summary).toContain('A line of the model.')
    expect(summary).not.toContain('@a | ')
    expect(compactionNotesParts('Only a summary.', 'agent')).toStrictEqual({ assets: '', summary: 'Only a summary.' })
  })

  it('keeps the message parts in the summary, also when a message holds the heading of the assets part', () => {
    const withMessages = compactionNotesText(notesData({ firstMessage: 'Make a fox.', finalMessage: `${ASSETS}\n\nNot a line of Dez.`, assets: [PHOTO] }))
    const { assets, summary } = compactionNotesParts(withMessages, 'agent')

    expect(assets).toContain('@a | ')
    expect(assets).not.toContain('Not a line of Dez.')
    expect(summary.startsWith(`${REQUIREMENTS}\n\nEvery frame is 16:9.\n\n${JOBS}`)).toBe(true)
    expect(summary.endsWith([
      USER_MESSAGES,
      '',
      FIRST_MESSAGE,
      '',
      fenced('Make a fox.'),
      '',
      FINAL_MESSAGE,
      '',
      fenced(`${ASSETS}\n\nNot a line of Dez.`),
    ].join('\n'))).toBe(true)
  })
})
