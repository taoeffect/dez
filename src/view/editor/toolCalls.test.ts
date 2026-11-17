import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { compactionBlockText } from '../../model/chat/compaction'
import { HIDDEN_CLIP_PATH, HIDDEN_IMAGE_PATH, hiddenClip, hiddenImage, invokeBlock, waitBlock } from '../../model/chat/testing'
import type { Role } from '../../model/chat/types'
import { toolBlockText, type ToolBlockStatus } from '../../model/chat/toolBlocks'
import { jobStartedText, jobsWaitText, type JobResultStatus } from '../../model/tools/jobs'
import { STOPPED_TOOL_RESULT } from '../../model/streams/toolRound'
import type { ToolArguments } from '../../model/tools/types'
import { PILL_OPEN, SECTION_SEP, sectionsField, setSectionsEffect, setSectionThinkingEffect } from '../thread/cmEditor'
import { setStreamingSectionEffect, streamingSectionField } from '../thread/modelChip'
import { PLAYER } from './testing'
import { intermediateLabel, intermediateSymbols, markdownToolCalls, renderedToolCalls, toolCallLabel, toolCallSummaries, type IntermediateCall } from './toolCalls'

function block(id: string, status: ToolBlockStatus = 'success', result = 'ok'): string {
  return toolBlockText({ id, name: 'model_list', status, arguments: { filter: 'gemini' }, result: status === 'running' ? '' : result })
}

/** A compaction block, the start of a compaction section. */
const COMPACTION_BLOCK = compactionBlockText({ count: 1, lastId: 'b', pictures: [] }, 'Notes')

/** A state whose doc is `texts`, one section each, with the roles of
 *  `roles` (section ids `s0`, `s1`, …). The first section is `user`, as
 *  its text starts with no compaction tag (`normalizeSectionModels` in
 *  cmEditor.ts). The line rules of the chips have their tests in
 *  `lineBlocks.test.ts`. */
function createState(texts: string[], roles: Role[], streaming: string | null = null): EditorState {
  return EditorState.create({
    doc: texts.join(`\n${SECTION_SEP}\n`),
    extensions: [
      sectionsField.init(() => roles.map((role, index) => ({ id: `s${index}`, role }))),
      streamingSectionField.init(() => streaming),
      markdownToolCalls(),
    ],
  })
}

/** The id, state, and source of each call that the editor shows. */
function shown(state: EditorState): [string, string, string][] {
  return renderedToolCalls(state).map((call) => [call.id, call.state, state.sliceDoc(call.from, call.to)])
}

describe('renderedToolCalls', () => {
  it('shows blocks of agent sections only, at their doc offsets', () => {
    const state = createState([`user\n${block('u')}`, `${block('a')}\nafter`, block('u2'), `before\n${block('b', 'error', 'boom')}`], ['user', 'agent', 'user', 'agent'])
    expect(shown(state)).toEqual([
      ['a', 'success', block('a')],
      ['b', 'error', block('b', 'error', 'boom')],
    ])
  })

  it('never pairs an opening line with a closing line of a later section', () => {
    const opening = block('a').split('\n')[0]
    const state = createState(['ask', opening, 'text\n</dez:tool>'], ['user', 'agent', 'agent'])
    expect(shown(state)).toEqual([])
  })

  it('leaves a block that holds a sentinel as text', () => {
    const state = createState(['ask', `<dez:tool id="a" name="model_list">\nx ${PILL_OPEN} y\n</dez:tool>`], ['user', 'agent'])
    expect(shown(state)).toEqual([])
  })

  it('shows a running block as running only in the streaming section', () => {
    const state = createState(['ask', block('a', 'running'), block('b', 'running')], ['user', 'agent', 'agent'], 's2')
    expect(shown(state).map(([id, callState]) => [id, callState])).toEqual([['a', 'interrupted'], ['b', 'running']])
    const ended = state.update({ effects: setStreamingSectionEffect.of(null) }).state
    expect(shown(ended).map(([id, callState]) => [id, callState])).toEqual([['a', 'interrupted'], ['b', 'interrupted']])
  })

  // Blocks of saved conversations: an older Dez had a limit of tool
  // rounds, which ran none of these calls, so nothing failed.
  it('shows a call that the round limit of an older Dez stopped as not run, with the limit of any release', () => {
    const state = createState(['ask', [
      block('a', 'error', 'Not run: the reply reached the limit of 40 tool rounds.'),
      block('b', 'error', 'Not run: the reply reached the limit of 20 tool rounds.'),
      block('c', 'error', STOPPED_TOOL_RESULT.content),
      block('d', 'success', 'Not run: the reply reached the limit of 40 tool rounds.'),
    ].join('\n')], ['user', 'agent'])

    expect(shown(state).map(([id, callState]) => [id, callState])).toEqual([['a', 'notRun'], ['b', 'notRun'], ['c', 'error'], ['d', 'success']])
  })

  it('shows and hides the chips when only the section roles change', () => {
    const state = createState(['ask', block('a')], ['user', 'user'])
    expect(shown(state)).toEqual([])
    const agent = state.update({ effects: setSectionsEffect.of([{ id: 's0', role: 'user' }, { id: 's1', role: 'agent' }]) }).state
    expect(shown(agent)).toEqual([['a', 'success', block('a')]])
    const user = agent.update({ effects: setSectionsEffect.of([{ id: 's0', role: 'user' }, { id: 's1', role: 'user' }]) }).state
    expect(shown(user)).toEqual([])
  })

  it('keeps the same array until a change can change the chips', () => {
    const state = createState(['ask', block('a')], ['user', 'agent'])
    const calls = renderedToolCalls(state)
    const moved = state.update({ selection: { anchor: 0 } }).state
    expect(renderedToolCalls(moved)).toBe(calls)
    const thought = moved.update({ effects: setSectionThinkingEffect.of({ sectionId: 's1', thinking: { text: 'hmm' } }) }).state
    expect(renderedToolCalls(thought)).toBe(calls)
    const typed = thought.update({ changes: { from: 0, insert: 'x' } }).state
    expect(renderedToolCalls(typed)).not.toBe(calls)
    expect(renderedToolCalls(typed)[0].from).toBe(calls[0].from + 1)
  })
})

describe('the intermediate data of a call (RenderedToolCall.intermediate)', () => {
  const INVOKE = invokeBlock('j-aaaa')

  function invoke(status: ToolBlockStatus, more: Record<string, unknown> = { is_intermediate: true }, result = 'The model studio/paint is not in the model list.'): string {
    return toolBlockText({ id: 'call_1', name: 'model_invoke', status, arguments: { model: 'studio/paint', prompt: 'A cat', ...more }, result: status === 'running' ? '' : result })
  }

  function waited(status: JobResultStatus, text: string): string {
    return waitBlock(jobsWaitText([{ id: 'j-aaaa', tool: 'model_invoke', status, text, call: { number: 1, label: 'A cat' } }], 0))
  }

  /** The intermediate data of the first chip of an agent section with the
   *  lines `lines`, which is the streaming section when `streams`. */
  function intermediate(lines: string[], streams = false): IntermediateCall | null {
    return renderedToolCalls(createState(['ask', lines.join('\n')], ['user', 'agent'], streams ? 's1' : null))[0].intermediate
  }

  it('holds the hidden assets of the job that the call started, in doc order', () => {
    const call = intermediate([INVOKE, '', hiddenClip('j-aaaa'), '', hiddenImage('j-aaaa'), '', 'Done.'])

    expect(call).toMatchObject({ jobId: 'j-aaaa', text: '', status: null })
    expect(call?.assets.map((asset) => asset.kind === 'image' ? ['image', asset.id, asset.path] : [asset.tag.kind, asset.tag.id, asset.tag.src])).toStrictEqual([
      ['audio', 'c', HIDDEN_CLIP_PATH],
      ['image', 'b', HIDDEN_IMAGE_PATH],
    ])
  })

  it('gives each call only the assets of its own job', () => {
    const state = createState(['ask', [INVOKE, invokeBlock('j-bbbb', { id: 'call_2' }), '', hiddenImage('j-bbbb', 'c'), '', hiddenImage('j-aaaa')].join('\n')], ['user', 'agent'])

    expect(renderedToolCalls(state).map((call) => call.intermediate?.assets.map((asset) => asset.kind === 'image' && asset.id))).toStrictEqual([['b'], ['c']])
  })

  it('holds no doc offset, so that a token before the chip changes nothing of it', () => {
    const state = createState(['ask', [INVOKE, '', hiddenClip('j-aaaa'), '', hiddenImage('j-aaaa')].join('\n')], ['user', 'agent'])
    const typed = state.update({ changes: { from: 0, insert: 'more ' } }).state

    expect(renderedToolCalls(typed)[0].intermediate).toStrictEqual(renderedToolCalls(state)[0].intermediate)
  })

  it('marks a call with is_intermediate that runs, or that started a job, with nothing to show yet', () => {
    expect(intermediate([invoke('running')], true)).toStrictEqual({ jobId: null, assets: [], text: '', status: null })
    expect(intermediate([INVOKE])).toStrictEqual({ jobId: 'j-aaaa', assets: [], text: '', status: null })
  })

  it('holds the text of a finished job that made no asset', () => {
    expect(intermediate([INVOKE, waited('finished', 'The cat is blue.\nIt sleeps.')])).toStrictEqual({ jobId: 'j-aaaa', assets: [], text: 'The cat is blue.\nIt sleeps.', status: 'finished' })
    // A job with no output.
    expect(intermediate([INVOKE, waited('finished', '')])).toStrictEqual({ jobId: 'j-aaaa', assets: [], text: '', status: 'finished' })
  })

  it('holds no text for a job with a hidden asset, and none of the lines that name its assets', () => {
    expect(intermediate([INVOKE, waited('finished', 'Made the image @b.'), '', hiddenImage('j-aaaa')])).toMatchObject({ text: '', status: 'finished' })
    // The asset is gone (its trash), and its line stays in the result.
    expect(intermediate([INVOKE, waited('finished', 'Made the image @b.')])).toStrictEqual({ jobId: 'j-aaaa', assets: [], text: '', status: 'finished' })
  })

  it('holds the status of a job that failed or timed out, with no text: the Result of jobs_wait shows the error', () => {
    expect(intermediate([INVOKE, waited('failed', 'The provider refused the prompt.')])).toStrictEqual({ jobId: 'j-aaaa', assets: [], text: '', status: 'failed' })
    expect(intermediate([INVOKE, waited('timed out', 'No answer.')])).toMatchObject({ text: '', status: 'timed out' })
  })

  it('is null for a call that started no job: a failed call, an interrupted one, and one without is_intermediate', () => {
    expect(intermediate([invoke('error')])).toBeNull()
    expect(intermediate([invoke('running')])).toBeNull()
    expect(intermediate([invoke('running', {})], true)).toBeNull()
    expect(intermediate([invoke('running', { is_intermediate: false })], true)).toBeNull()
    expect(intermediate([block('a')])).toBeNull()
  })

  it('is null for a call that shows its assets: a job with no hidden asset and no is_intermediate', () => {
    const shown = toolBlockText({ id: 'call_1', name: 'model_invoke', status: 'success', arguments: { model: 'studio/paint', prompt: 'A cat' }, result: jobStartedText('j-aaaa', 1) })

    expect(intermediate([shown, waited('finished', 'Made the image @b.')])).toBeNull()
  })

  function video(status: ToolBlockStatus, command: string, parameters: Record<string, unknown>, more: Record<string, boolean> = {}): string {
    const args = { command, parameters: JSON.stringify(parameters), ...more }
    return toolBlockText({ id: 'call_1', name: 'video', status, arguments: args, result: status === 'running' ? '' : jobStartedText('j-aaaa', 1) })
  }

  it('marks a join_clips or ffmpeg call of the video tool whose parameters have is_intermediate, and holds the assets of its job', () => {
    expect(intermediate([video('running', 'ffmpeg', { arguments: '-i @c cut.mp4', is_intermediate: true })], true)).toStrictEqual({ jobId: null, assets: [], text: '', status: null })
    expect(intermediate([video('success', 'join_clips', { clips: '@c @d', is_intermediate: true })])).toStrictEqual({ jobId: 'j-aaaa', assets: [], text: '', status: null })

    const call = intermediate([video('success', 'ffmpeg', { arguments: '-i @c cut.mp4', is_intermediate: true }), '', hiddenClip('j-aaaa', 'e', 'video')])
    expect(call?.assets.map((asset) => asset.kind === 'clip' && [asset.tag.kind, asset.tag.id])).toStrictEqual([['video', 'e']])
  })

  it('is null for a video call that asks to hide nothing: no is_intermediate, the flag next to command, and ffprobe, which takes no flag', () => {
    expect(intermediate([video('success', 'join_clips', { clips: '@c @d' })])).toBeNull()
    expect(intermediate([video('running', 'ffmpeg', { arguments: '-i @c cut.mp4' }, { is_intermediate: true })], true)).toBeNull()
    expect(intermediate([video('running', 'ffprobe', { arguments: '@c', is_intermediate: true })], true)).toBeNull()
  })
})

describe('the spacing of the chip lines', () => {
  const SPACE = '(the space of a blank line)'
  const COLLAPSED = '(a blank line of no height)'

  /** The lines of `state` as the editor spaces them, top to bottom: a chip
   *  as `chip <id>`, `SPACE` where the line of a chip has extra space,
   *  `COLLAPSED` for a blank line that takes no height, and any other line
   *  as its text. Read from the decorations that the editor draws. */
  function rows(state: EditorState): string[] {
    const classes = new Map<number, string[]>()
    for (const source of state.facet(EditorView.decorations)) {
      if (typeof source === 'function') continue
      for (const cursor = source.iter(); cursor.value; cursor.next()) {
        const name: unknown = cursor.value.spec.class
        if (typeof name === 'string') classes.set(cursor.from, [...(classes.get(cursor.from) ?? []), name])
      }
    }
    const calls = renderedToolCalls(state)
    const result: string[] = []
    for (let pos = 0; pos <= state.doc.length;) {
      const line = state.doc.lineAt(pos)
      const call = calls.find(({ from }) => from === line.from)
      const names = classes.get(line.from) ?? []
      if (names.includes('dez-tool-call-line--after-content')) result.push(SPACE)
      result.push(call ? `chip ${call.id}` : names.includes('dez-tool-call-gap') ? COLLAPSED : line.text)
      if (names.includes('dez-tool-call-line--before-content')) result.push(SPACE)
      pos = (call ? call.to : line.to) + 1
    }
    return result
  }

  /** `rows` of an agent section with the lines `lines`, after a user
   *  section; the rows of the agent section only. `caret` puts a caret at
   *  the start of that line of the agent section (0 is its first). */
  function agentRows(lines: string[], caret?: number): string[] {
    let state = createState(['ask', lines.join('\n')], ['user', 'agent'])
    const start = state.doc.length - lines.join('\n').length
    if (caret !== undefined) state = state.update({ selection: { anchor: start + lines.slice(0, caret).join('\n').length + (caret > 0 ? 1 : 0) } }).state
    return rows(state).slice(2)
  }

  it('gives the chips of one group no extra space', () => {
    expect(agentRows([block('a'), block('b'), block('c')])).toEqual(['chip a', 'chip b', 'chip c'])
  })

  it('gives the blank lines between two chips no height', () => {
    expect(agentRows([block('a'), '', block('b'), block('c'), '', ' \t', block('d')])).toEqual([
      'chip a', COLLAPSED, 'chip b', 'chip c', COLLAPSED, COLLAPSED, 'chip d',
    ])
  })

  it('gives a chip the space of a blank line next to content on a line that touches it', () => {
    expect(agentRows(['before', block('a'), 'after'])).toEqual(['before', SPACE, 'chip a', SPACE, 'after'])
    expect(agentRows(['before', block('a'), block('b'), '', block('c'), 'after'])).toEqual([
      'before', SPACE, 'chip a', 'chip b', COLLAPSED, 'chip c', SPACE, 'after',
    ])
    const image = '![/home/u/.config/dez/assets/images/red.png](id=a)'
    expect(agentRows([image, block('a'), PLAYER])).toEqual([image, SPACE, 'chip a', SPACE, PLAYER])
  })

  it('leaves a chip with a blank line between it and content as it is', () => {
    expect(agentRows(['before', '', block('a'), ' ', 'after'])).toEqual(['before', '', 'chip a', ' ', 'after'])
    expect(agentRows([block('a'), '', 'between', '', block('b')])).toEqual(['chip a', '', 'between', '', 'chip b'])
    expect(agentRows([block('a'), '', 'between', block('b')])).toEqual(['chip a', '', 'between', SPACE, 'chip b'])
  })

  it('gives no space at the start and the end of a section, and keeps the blank lines there', () => {
    expect(agentRows([block('a')])).toEqual(['chip a'])
    expect(agentRows(['', block('a'), ''])).toEqual(['', 'chip a', ''])
    const sections = createState(['ask', block('a'), `${block('b')}\n`, 'next'], ['user', 'agent', 'agent', 'user'])
    expect(rows(sections)).toEqual(['ask', SECTION_SEP, 'chip a', SECTION_SEP, 'chip b', '', SECTION_SEP, 'next'])
  })

  it('counts a block that stays text as content', () => {
    const pillBlock = `<dez:tool id="p" name="model_list">\nx ${PILL_OPEN} y\n</dez:tool>`
    expect(agentRows([block('a'), pillBlock, block('b')])).toEqual(['chip a', SPACE, ...pillBlock.split('\n'), SPACE, 'chip b'])
    const user = createState(['ask', ['before', block('a'), '', block('b')].join('\n')], ['user', 'user'])
    expect(rows(user)).toEqual(['ask', SECTION_SEP, 'before', ...block('a').split('\n'), '', ...block('b').split('\n')])
  })

  it('shows a blank line between two chips while a caret is on it', () => {
    const lines = [block('a'), '', '', block('b')]
    expect(agentRows(lines, 1)).toEqual(['chip a', '', COLLAPSED, 'chip b'])
    expect(agentRows(lines, 2)).toEqual(['chip a', COLLAPSED, '', 'chip b'])
    expect(agentRows(lines, 3)).toEqual(['chip a', COLLAPSED, COLLAPSED, 'chip b'])
    // A selection that is not empty draws no caret.
    const state = createState(['ask', lines.join('\n')], ['user', 'agent'])
    const selected = state.update({ selection: EditorSelection.single(0, state.doc.length - block('b').length - 1) }).state
    expect(rows(selected).slice(2)).toEqual(['chip a', COLLAPSED, COLLAPSED, 'chip b'])
  })

  it('gives the line of a hidden asset, and the blank line that goes with it, no height', () => {
    const invoke = invokeBlock('j-aaaa')
    const image = hiddenImage('j-aaaa')
    const clip = hiddenClip('j-aaaa')

    expect(agentRows([invoke, '', image, '', 'Done.'])).toEqual(['chip call_1', COLLAPSED, COLLAPSED, '', 'Done.'])
    expect(agentRows([invoke, '', clip, '', image, '', 'Done.'])).toEqual(['chip call_1', COLLAPSED, COLLAPSED, COLLAPSED, COLLAPSED, '', 'Done.'])
    expect(agentRows(['Wait.', invoke, '', 'Done.', '', image])).toEqual(['Wait.', SPACE, 'chip call_1', '', 'Done.', COLLAPSED, COLLAPSED])
    // With no chip of its job, the asset shows at its own place.
    expect(agentRows([block('a'), '', image, '', 'Done.'])).toEqual(['chip a', '', image, '', 'Done.'])
  })

  it('takes a hidden asset as a blank line: chips with only such lines between them stay close together', () => {
    const invoke = invokeBlock('j-aaaa')
    const image = hiddenImage('j-aaaa')

    expect(agentRows([invoke, '', image, block('b')])).toEqual(['chip call_1', COLLAPSED, COLLAPSED, 'chip b'])
    expect(agentRows([invoke, '', image, '', block('b'), 'Done.'])).toEqual(['chip call_1', COLLAPSED, COLLAPSED, COLLAPSED, 'chip b', SPACE, 'Done.'])
    // The blank line keeps the chip as far from the text as with no asset.
    expect(agentRows([invoke, '', image, 'Done.'])).toEqual(['chip call_1', '', COLLAPSED, 'Done.'])
  })

  it('shows the line of a hidden asset while a caret is on it', () => {
    const image = hiddenImage('j-aaaa')
    const lines = [invokeBlock('j-aaaa'), '', image, '', 'Done.']

    expect(agentRows(lines, 2)).toEqual(['chip call_1', COLLAPSED, image, '', 'Done.'])
    expect(agentRows(lines, 1)).toEqual(['chip call_1', '', COLLAPSED, '', 'Done.'])
    expect(agentRows(lines, 4)).toEqual(['chip call_1', COLLAPSED, COLLAPSED, '', 'Done.'])
  })

  it('gives a chip right after the compaction block no space above: the lines of the block are out of view', () => {
    const compacted = (reply: string[]) => rows(createState([[COMPACTION_BLOCK, ...reply].join('\n'), 'ask'], ['agent', 'user']))
    const blockRows = COMPACTION_BLOCK.split('\n')

    expect(compacted([block('a'), 'Done.'])).toEqual([...blockRows, 'chip a', SPACE, 'Done.', SECTION_SEP, 'ask'])
    expect(compacted(['Working.', block('a'), 'Done.'])).toEqual([...blockRows, 'Working.', SPACE, 'chip a', SPACE, 'Done.', SECTION_SEP, 'ask'])
  })
})

describe('toolCallSummaries', () => {
  function summary(name: string, args: ToolArguments): string {
    return toolCallSummaries([{ name, arguments: args }])[0]
  }

  it('shows each argument in its order: a text in quotes on one line, a number with its name, a true switch by its name', () => {
    expect(summary('model_list', {})).toBe('')
    expect(summary('model_list', { filter: '  gem\n\tini ', other: 'x' })).toBe('"gem ini" "x"')
    expect(summary('model_invoke', { model: 'studio/paint', prompt: 'a cat', timeout_seconds: 600 })).toBe('"studio/paint" "a cat" timeout_seconds=600')
    expect(summary('jobs_wait', { all: true })).toBe('all')
  })

  it('leaves out a blank text, a false switch, and is_intermediate, which the chip tells by its own part', () => {
    expect(summary('jobs_wait', { all: false, jobs: ' ' })).toBe('')
    expect(summary('model_invoke', { model: 'studio/paint', is_intermediate: true })).toBe('"studio/paint"')
  })

  it('shows the subcommand of a subcommand tool as a word, then its parameters', () => {
    expect(summary('video', { command: 'join_clips', parameters: '{"clips":"@i @k","is_intermediate":true}' })).toBe('join_clips "@i @k"')
    expect(summary('video', { command: 'help', parameters: 'join_clips' })).toBe('help "join_clips"')
    expect(summary('video', { command: 'help' })).toBe('help')
  })

  it('cuts a long text at 40 characters, the ellipsis included', () => {
    expect(summary('model_list', { filter: 'a'.repeat(40) })).toBe(`"${'a'.repeat(40)}"`)
    expect(summary('model_list', { filter: 'a'.repeat(41) })).toBe(`"${'a'.repeat(39)}…"`)
    expect(summary('model_list', { filter: '😀'.repeat(41) })).toBe(`"${'😀'.repeat(39)}…"`)
  })

  it('shows a text that starts as the same argument of another call of the tool from the word where the two differ', () => {
    const start = 'Animated music video. The young woman '
    const calls: { name: string, arguments: ToolArguments }[] = [
      { name: 'model_invoke', arguments: { model: 'v/seedance', prompt: `${start}walks into the rain at night` } },
      { name: 'model_invoke', arguments: { model: 'v/seedance', prompt: `${start}waves from the train` } },
      { name: 'model_invoke', arguments: { model: 'v/seedance', prompt: 'A short text' } },
      { name: 'model_list', arguments: { filter: `${start}dances` } },
    ]

    expect(toolCallSummaries(calls)).toEqual([
      '"v/seedance" "…walks into the rain at night"',
      '"v/seedance" "…waves from the train"',
      '"v/seedance" "A short text"',
      // A call of another tool is no match.
      `"${`${start}dances`.slice(0, 39)}…"`,
    ])
  })

  it('shows a text from its start when the shared start is short or the texts are the same', () => {
    const calls = [
      { name: 'model_invoke', arguments: { model: 'v/seedance', prompt: 'A cat on a roof at noon' } },
      { name: 'model_invoke', arguments: { model: 'v/seedance', prompt: 'A cat on a boat at noon' } },
    ]

    expect(toolCallSummaries(calls)).toEqual(['"v/seedance" "A cat on a roof at noon"', '"v/seedance" "A cat on a boat at noon"'])
  })

  it('shows nothing for a tool that Dez does not have', () => {
    expect(summary('crop_scale_image', { image: 'a', width: '10' })).toBe('')
    expect(summary('Model_List', { filter: 'gemini' })).toBe('')
  })
})

describe('the summary of a rendered call', () => {
  it('tells apart the calls of one agent section, not the calls of another section', () => {
    const prompt = (end: string) => toolBlockText({ id: end, name: 'model_list', status: 'success', arguments: { filter: `The very long shared start of a filter ${end}` }, result: 'ok' })
    const state = createState(['ask', `${prompt('one')}\n\n${prompt('two')}`, 'more', prompt('three')], ['user', 'agent', 'user', 'agent'])

    expect(renderedToolCalls(state).map((call) => call.summary)).toEqual(['"…one"', '"…two"', '"The very long shared start of a filter…"'])
  })
})

describe('toolCallLabel', () => {
  it('names the call, its summary, and a state that the chip shows by a word or the spinner', () => {
    expect(toolCallLabel('model_list', '"gemini"', 'success')).toBe('Tool call model_list, "gemini"')
    expect(toolCallLabel('model_list', '"gemini"', 'running')).toBe('Tool call model_list, "gemini", running')
    expect(toolCallLabel('model_list', '"gemini"', 'error')).toBe('Tool call model_list, "gemini", failed')
    expect(toolCallLabel('model_list', '', 'interrupted')).toBe('Tool call model_list, interrupted')
    expect(toolCallLabel('model_invoke', '"studio/paint"', 'notRun')).toBe('Tool call model_invoke, "studio/paint", not run')
    expect(toolCallLabel('model_list', '', 'success')).toBe('Tool call model_list')
  })

  it('says that Dez does not have the tool, as the chip does', () => {
    expect(toolCallLabel('crop_scale_image', '', 'success')).toBe('Tool call, old/unrecognized tool: crop_scale_image')
    expect(toolCallLabel('web_search', '', 'error')).toBe('Tool call, old/unrecognized tool: web_search, failed')
  })

  it('ends with the label of an intermediate call', () => {
    expect(toolCallLabel('model_invoke', '"studio/paint"', 'success', 'intermediate asset hidden')).toBe('Tool call model_invoke, "studio/paint", intermediate asset hidden')
    expect(toolCallLabel('model_invoke', '"studio/paint"', 'running', 'intermediate')).toBe('Tool call model_invoke, "studio/paint", running, intermediate')
  })
})

describe('the label and the type symbols of an intermediate chip', () => {
  const image = { kind: 'image', path: HIDDEN_IMAGE_PATH, id: 'b', linked: false } as const
  const clip = (kind: 'audio' | 'video') => ({ kind: 'clip', tag: { kind, id: 'c', type: `${kind}/x`, src: null, url: null, expires: null, other: [] }, linkedSrc: false }) as const

  function call(more: Partial<IntermediateCall>): IntermediateCall {
    return { jobId: 'j-aaaa', assets: [], text: '', status: null, ...more }
  }

  it('says what the chip hides, and that it is hidden only while the panel is closed', () => {
    expect(intermediateLabel(call({ assets: [image] }), false)).toBe('intermediate asset hidden')
    expect(intermediateLabel(call({ assets: [image] }), true)).toBe('intermediate asset')
    expect(intermediateLabel(call({ assets: [image, clip('audio')] }), false)).toBe('intermediate assets hidden')
    expect(intermediateLabel(call({ assets: [image, clip('audio')] }), true)).toBe('intermediate assets')
    expect(intermediateLabel(call({ text: 'The cat is blue.', status: 'finished' }), false)).toBe('intermediate text hidden')
    expect(intermediateLabel(call({ text: 'The cat is blue.', status: 'finished' }), true)).toBe('intermediate text')
  })

  it('says only "intermediate" for a call that hides nothing', () => {
    for (const nothing of [call({}), call({ jobId: null }), call({ status: 'failed' }), call({ status: 'timed out' }), call({ status: 'finished' })]) {
      expect(intermediateLabel(nothing, false)).toBe('intermediate')
      expect(intermediateLabel(nothing, true)).toBe('intermediate')
    }
  })

  it('shows each type of the hidden assets once, in the order of the output types', () => {
    expect(intermediateSymbols(call({ assets: [image] }), null)).toStrictEqual(['image'])
    expect(intermediateSymbols(call({ assets: [clip('video'), clip('audio'), image, image] }), ['text'])).toStrictEqual(['image', 'audio', 'video'])
    expect(intermediateSymbols(call({ text: 'The cat is blue.', status: 'finished' }), ['image'])).toStrictEqual(['text'])
  })

  it('shows what the model makes while the job has no result: its one type that is not text, else text', () => {
    expect(intermediateSymbols(call({}), ['image'])).toStrictEqual(['image'])
    expect(intermediateSymbols(call({ jobId: null }), ['text', 'video'])).toStrictEqual(['video'])
    expect(intermediateSymbols(call({}), ['text'])).toStrictEqual(['text'])
    // The type is not known: two types, no outputs, a model that Dez does
    // not have.
    expect(intermediateSymbols(call({}), ['image', 'audio'])).toStrictEqual([])
    expect(intermediateSymbols(call({}), [])).toStrictEqual([])
    expect(intermediateSymbols(call({}), null)).toStrictEqual([])
  })

  it('shows no type for a job that ended with nothing to hide', () => {
    for (const status of ['failed', 'timed out', 'finished'] as const) {
      expect(intermediateSymbols(call({ status }), ['image'])).toStrictEqual([])
    }
  })
})
