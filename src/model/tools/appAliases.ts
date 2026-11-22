import { byteSizeText } from '../../utils/byteSize'
import type { MediaTagKind } from '../chat/mediaTags'
import type { AppRunTexts } from './appInvoke'
import { APP_RUN_MAX_DECODED_BYTES } from './appsTool'
import { WORK_VIRTUAL_ROOT } from './conversationWork'
import { ASSET_NAMES } from './jobs'
import type { Subcommand } from './subcommands'
import type { ToolParameter } from './types'

// The alias subcommands of the `audio` and the `video` tools: each one is
// a run of one built-in app (src-tauri/builtin-apps/), with the
// parameters of the app as its own, and its inputs in parameters with
// names. So a model measures a clip with one short call, and needs no
// `apps invoke`, no `inputs` in the right order, and no job. The call
// waits for its run, as an asset_info call does: the next step of the
// model needs the measurement. appInvoke.ts makes the run of a call
// (`aliasInvokeCall`), and controller/appInvoke.ts runs it
// (`runAliasCall`).
//
// This module imports no module that imports the `audio` or the `video`
// tool, as both tools list these subcommands.

/** The time limit of the run of an alias call, from the start of the call:
 *  the read and the decode of the clips, then the code of the app. A
 *  measurement of a clip of some minutes takes seconds. */
export const ALIAS_TIMEOUT_MS = 10 * 60 * 1000

/** A parameter of an alias that names inputs of the run. */
export interface AliasInput {
  /** The name of the parameter. */
  parameter: string
  /** Whether it names one or more clips, else exactly one. */
  many: boolean
  /** The kinds of clip that it can name. */
  kinds: readonly MediaTagKind[]
  /** What it names, for the error texts: one with its article (`a clip
   *  with sound`), and more than one (`clips with sound`). */
  what: { one: string, many: string }
}

/** An alias subcommand: the built-in app that it runs, and the parameters
 *  that name the inputs of the run. Every other parameter of the
 *  subcommand goes to the app as it is (`parameters` of `main`). */
export interface AppAlias {
  /** The tool of the subcommand. */
  tool: 'audio' | 'video'
  subcommand: Subcommand
  /** The name of the built-in app. */
  app: string
  /** In the order of `dez.inputs` of the run. */
  inputs: readonly AliasInput[]
}

// The parts of the help of every alias.
const WAITS = `The call waits for the run (no job), for at most ${ALIAS_TIMEOUT_MS / 60_000} minutes.`
const READ_FILE = `Read the file with apps read, or with code (js_eval, a script app) in \`dez.workFolder\`. Dez deletes ${WORK_VIRTUAL_ROOT}/ with the conversation.`
const TIMING = 'Use it for each time that must be exact: you are weak at timing by ear and by eye, even when you hear a clip or see its frames.'

// The first sentences of the help of an alias of `app`: what runs, and the
// call.
function runsText(app: string): string {
  return `It runs the built-in app ${app} (its code is /apps/${app}/main.ts) on the clips of the call. ${WAITS}`
}

// The `save_to` parameter of an alias whose run writes `file` by default.
// `many` tells that the call can give more than one clip: each one then
// gets its own file.
function saveToParameter(file: string, many: boolean): ToolParameter {
  return {
    name: 'save_to',
    type: 'string',
    description: many
      ? `The path of the JSON file of the result, in ${WORK_VIRTUAL_ROOT}/; only for a call with one clip. By default each clip gets ${file}.`
      : `The path of the JSON file of the result, in ${WORK_VIRTUAL_ROOT}/. Default: ${file}.`,
    required: false,
  }
}

const WITH_SOUND = { kinds: ['audio', 'video'], what: { one: 'a clip with sound', many: 'clips with sound' } } as const
const VIDEO = { kinds: ['video'], what: { one: 'a video clip', many: 'video clips' } } as const

const CLIPS_WITH_SOUND: ToolParameter = {
  name: 'clips',
  type: 'string',
  description: 'The ids of the clips: audio clips, or video clips with sound, as in "@b" or "@b @d".',
  required: true,
}

const MAX_LAG: ToolParameter = {
  name: 'max_lag',
  type: 'number',
  description: 'The latest start to search for, in seconds (0 or more). Default: 6. The search also ends at half the length of the clip that it searches in.',
  required: false,
}

const CUT_THRESHOLD: ToolParameter = {
  name: 'threshold',
  type: 'number',
  description: 'The lowest score of a cut, more than 0 (the score of two frames is 0 to 3). Default: 0.35. '
    + 'Give a lower one for soft cuts, a higher one for a clip with fast motion.',
  required: false,
}

/** The alias subcommands of the `audio` tool. */
export const AUDIO_ALIASES: readonly AppAlias[] = [
  {
    tool: 'audio',
    app: 'dez-beats',
    inputs: [{ parameter: 'clips', many: true, ...WITH_SOUND }],
    subcommand: {
      name: 'beats',
      summary: 'Measure the beat grid of songs: the tempo (BPM), the time of each beat and downbeat, the loudness over time, and the strong hits.',
      description: `Measures the beat grid of each clip of \`clips\`. ${runsText('dez-beats')} `
        + 'The result gives the tempo, the count and the times of the first beats and downbeats, and the strong hits of each clip, '
        + `and the path of a JSON file in ${WORK_VIRTUAL_ROOT}/ for each clip, with id, duration, bpm, beats (the time of each beat), `
        + 'downbeatPhase, downbeats, loudnessStep, loudness (dBFS each 0.5 s), and accents (up to 60 strong hits). '
        + `Times are in seconds from the start of the clip, to the millisecond. ${READ_FILE} ${TIMING}`,
      parameters: [CLIPS_WITH_SOUND, saveToParameter(`${WORK_VIRTUAL_ROOT}/beats-<id>.json`, true)],
      example: { clips: '@b' },
    },
  },
  {
    tool: 'audio',
    app: 'dez-onsets',
    inputs: [{ parameter: 'clips', many: true, ...WITH_SOUND }],
    subcommand: {
      name: 'onsets',
      summary: 'Measure where the sound of clips starts, its loudest moment, and each hit, such as the time of a sound effect to put on a beat.',
      description: `Measures where the sound of each clip of \`clips\` starts (its first onset), its loudest moment (peak), and the start of each hit. ${runsText('dez-onsets')} `
        + 'To put a sound effect on a beat or a cut, line up its first onset, not the start of its file. '
        + `The result gives the facts of each clip and the path of a JSON file in ${WORK_VIRTUAL_ROOT}/ for each clip, `
        + 'with id, duration, level, first, peak, and onsets (the time of each hit). A clip with no sound has no onset: first and peak are null. '
        + `Times are in seconds from the start of the clip, to the millisecond. ${READ_FILE} ${TIMING}`,
      parameters: [
        CLIPS_WITH_SOUND,
        {
          name: 'level',
          type: 'number',
          description: 'A hit starts where the level of a 10 ms frame goes over this part of the level of the loudest frame, '
            + 'after the level fell to half of that: more than 0 and less than 1. Default: 0.3.',
          required: false,
        },
        saveToParameter(`${WORK_VIRTUAL_ROOT}/onsets-<id>.json`, true),
      ],
      example: { clips: '@b' },
    },
  },
  {
    tool: 'audio',
    app: 'dez-align',
    inputs: [
      { parameter: 'clip', many: false, ...WITH_SOUND },
      { parameter: 'within', many: false, ...WITH_SOUND },
    ],
    subcommand: {
      name: 'align',
      summary: 'Find where one clip starts in another, such as a song in the sound of a video edit.',
      description: `Finds where the sound of \`clip\` starts in the sound of \`within\`, with a confidence. ${runsText('dez-align')} `
        + 'The confidence is about 1 for the same sound, 0.5 or more for a match, and under 0.3 for sounds that do not match. '
        + `The result gives the start and the confidence, and the path of a JSON file in ${WORK_VIRTUAL_ROOT}/ with clip, within, offset, confidence, and maxLag. `
        + `Times are in seconds. ${READ_FILE} ${TIMING}`,
      parameters: [
        { name: 'clip', type: 'string', description: 'The id of the clip to find, as in "@b": an audio clip, or a video clip with sound.', required: true },
        { name: 'within', type: 'string', description: 'The id of the clip to find it in, as in "@c": an audio clip, or a video clip with sound.', required: true },
        MAX_LAG,
        saveToParameter(`${WORK_VIRTUAL_ROOT}/align-<clip>-in-<within>.json`, false),
      ],
      example: { clip: '@b', within: '@c' },
    },
  },
]

/** The alias subcommands of the `video` tool. */
export const VIDEO_ALIASES: readonly AppAlias[] = [
  {
    tool: 'video',
    app: 'dez-cuts',
    inputs: [{ parameter: 'clips', many: true, ...VIDEO }],
    subcommand: {
      name: 'cuts',
      summary: 'Find the cuts (shot changes) of video clips: the frame, the time, and the score of each.',
      description: `Finds the cuts (shot changes) of each video clip of \`clips\`: a fast pan or a morph is no cut. ${runsText('dez-cuts')} `
        + `The result gives the cuts of each clip, and the path of a JSON file in ${WORK_VIRTUAL_ROOT}/ for each clip, with id, fps, frames, duration, threshold, `
        + 'and cuts: {frame, time, score} each, where frame is the first frame after the cut. '
        + `Times are in seconds from the start of the clip, to the millisecond. ${READ_FILE} ${TIMING}`,
      parameters: [
        { name: 'clips', type: 'string', description: 'The ids of the video clips, as in "@c" or "@c @e".', required: true },
        CUT_THRESHOLD,
        saveToParameter(`${WORK_VIRTUAL_ROOT}/cuts-<id>.json`, true),
      ],
      example: { clips: '@c' },
    },
  },
  {
    tool: 'video',
    app: 'dez-sync',
    inputs: [
      { parameter: 'edit', many: false, ...VIDEO },
      { parameter: 'song', many: false, ...WITH_SOUND },
    ],
    subcommand: {
      name: 'sync',
      summary: 'Check whether the cuts of a video edit are on the beats of its song: the error of each cut.',
      description: `Checks whether the cuts of the video clip \`edit\` are on the beats of the clip \`song\`. ${runsText('dez-sync')} `
        + 'It finds the beats of the song, where the song starts in the sound of the edit (unless the call gives `offset`), '
        + 'the cuts of the edit, and the error of each cut against its nearest beat. '
        + 'The result gives the start of the song, its tempo, the mean and the max error, and the cuts off the beat, '
        + `and the path of a JSON file in ${WORK_VIRTUAL_ROOT}/ with edit, song, offset, confidence, bpm, fps, tolerance, `
        + 'cuts ({time, beat, error, offBeat} each, times in the edit), meanError, and maxError. '
        + `Times are in seconds. ${READ_FILE} ${TIMING}`,
      parameters: [
        { name: 'edit', type: 'string', description: 'The id of the video clip of the edit, as in "@c".', required: true },
        { name: 'song', type: 'string', description: 'The id of the song, as in "@b": an audio clip, or a video clip with sound.', required: true },
        {
          name: 'offset',
          type: 'number',
          description: 'Where the song starts in the edit, in seconds: 0 when it starts with the edit. '
            + 'With it, Dez does not search for the song in the sound of the edit, so the edit needs no sound.',
          required: false,
        },
        MAX_LAG,
        CUT_THRESHOLD,
        {
          name: 'tolerance',
          type: 'number',
          description: 'A cut is off the beat when its error is more than this, in seconds (more than 0). Default: one frame of the edit.',
          required: false,
        },
        saveToParameter(`${WORK_VIRTUAL_ROOT}/sync-<edit>-to-<song>.json`, false),
      ],
      example: { edit: '@c', song: '@b' },
    },
  },
]

/** The words of the call of `alias`, as in `audio beats`. */
export function aliasCallText(alias: AppAlias): string {
  return `${alias.tool} ${alias.subcommand.name}`
}

/** What Dez did not do for an alias call that it refuses or that failed
 *  before the app ran. */
export function aliasNotDoneText(alias: AppAlias): string {
  return `Dez did not run ${alias.app}.`
}

/** The error texts of a run of `alias` (`AppRunTexts`): a call gives no
 *  `decode` and no time limit, so they do not tell it to change them. */
export function aliasRunTexts(alias: AppAlias): AppRunTexts {
  const call = aliasCallText(alias)
  return {
    decodeFailed: ({ kind, id }) => `Dez could not decode the ${ASSET_NAMES[kind]} @${id} for ${call}: its file is broken, or it has a type that the ffmpeg of Dez does not read. `
      + `${aliasNotDoneText(alias)} This is not a fault of the call. Tell the user, and do not call ${call} again for @${id}.`,
    decodedTooLarge: `The decoded clips of the call are larger than ${byteSizeText(APP_RUN_MAX_DECODED_BYTES)} together, the most that Dez decodes for one run, `
      + `so Dez stopped the decode. ${aliasNotDoneText(alias)} Give the call fewer clips, or cut the clips into shorter parts first and measure each part.`,
    timedOut: () => `${call} did not end within its time limit of ${ALIAS_TIMEOUT_MS / 60_000} minutes, so Dez stopped it. It has no result. `
      + 'This is not a fault of the call. Cut the clips into shorter parts, and measure each part.',
  }
}
