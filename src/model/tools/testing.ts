import { mediaTagText, type MediaTagData } from '../chat/mediaTags'
import { reply, user } from '../streams/testing'
import { APPS_TOOL, type AppsEntryKind, type AppsTree, type PathFacts } from './appsTool'
import type { JobInfo } from './jobs'
import { parseSubcommandCall } from './subcommands'
import { ToolError, type SubcommandArguments } from './types'

// Shared helpers of the unit tests of the Dez tools: the text of a refused
// call, the facts of a job, a conversation with images and clips for the
// `video` tool, the output of the ffprobe run that reads the facts of a
// clip for a join (`joinProbeArgs`), and the arguments and the listings of
// the `apps` tool.

/** The text of the `ToolError` that `call` throws. */
export function refusal(call: () => unknown): string {
  try {
    call()
  } catch (error) {
    if (error instanceof ToolError) return error.message
    throw error
  }
  throw new Error('The call was not refused.')
}

/** The facts of the job `j-aaaa`, job 1 of its reply: a `model_invoke` job
 *  that runs, with no state, no label, and no input, unless `fields` give
 *  them. */
export function jobInfo(fields: Partial<JobInfo>): JobInfo {
  return { id: 'j-aaaa', tool: 'model_invoke', status: 'running', delivered: false, elapsedMs: 0, state: '', call: { number: 1, label: '' }, inputs: [], ...fields }
}

export const RED = '/home/u/.config/dez/assets/images/red.jpg'
export const SKY = '/home/u/.config/dez/assets/images/sky.png'
export const PLAN = '/home/u/.config/dez/assets/images/plan.svg'
export const SONG: MediaTagData = { kind: 'audio', id: 'b', type: 'audio/wav', src: '/home/u/.config/dez/assets/audio/s1.wav', url: null, expires: null, other: [] }
export const FILM: MediaTagData = { kind: 'video', id: 'c', type: 'video/webm', src: '/home/u/.cache/dez/media/v1.webm', url: null, expires: null, other: [] }
/** A clip that is only at its provider's address. */
export const LOOP: MediaTagData = { kind: 'video', id: 'd', type: 'video/webm', src: null, url: 'https://clips.example/x/loop?sig=1', expires: null, other: [] }

/** A conversation with the JPEG image `a` (RED), the audio clip `b`
 *  (SONG), the video clips `c` (FILM) and `d` (LOOP), the PNG image `e`
 *  (SKY), and the SVG image `f` (PLAN). */
export const CONVERSATION = [
  user('u1', `![id=a](${RED})\n${mediaTagText(SONG)}`),
  reply('a1', `${mediaTagText(FILM)}\n${mediaTagText(LOOP)}`),
  user('u2', `![id=e](${SKY})\n![id=f](${PLAN})`),
]

/** A video stream of a probe output, as ffprobe writes it. */
export const VP9 = { index: 0, codec_name: 'vp9', codec_type: 'video', profile: 'Profile 0', level: -99, width: 48, height: 36, pix_fmt: 'yuv420p', r_frame_rate: '5/1', avg_frame_rate: '5/1', time_base: '1/1000', sample_aspect_ratio: '1:1' }

/** An audio stream of a probe output. */
export const OPUS = { index: 1, codec_name: 'opus', codec_type: 'audio', sample_rate: '48000', channels: 1, channel_layout: 'mono', r_frame_rate: '0/0', avg_frame_rate: '0/0', time_base: '1/1000', extradata_hash: 'MD5:19' }

/** The file facts of a probe output. */
export const WEBM = { format_name: 'matroska,webm', duration: '2.000000' }

/** The probe output of a clip with `streams`. */
export function probeOutput(streams: object[], format: object = WEBM): string {
  return JSON.stringify({ streams, format })
}

/** The checked arguments of a call of the subcommand `command` of the
 *  `apps` tool with `parameters`, as its runner gets them. */
export function appsArgs(command: string, parameters: Record<string, unknown>): SubcommandArguments {
  const call = parseSubcommandCall(APPS_TOOL, { command, parameters: JSON.stringify(parameters) })
  if (call.kind !== 'run') throw new Error(`The call does not run: ${call.text}`)
  return call.arguments
}

/** The listing of a path with nothing at it. */
export const MISSING_TREE: AppsTree = { kind: 'missing', size: 0, entries: [], more: false }
export const FOLDER_FACTS: PathFacts = { kind: 'folder', size: 0 }

/** The listing of a file of `size` bytes. */
export function fileTree(size: number): AppsTree {
  return { kind: 'file', size, entries: [], more: false }
}

/** The listing of a folder with `entries`: the size of each file by its
 *  path, null for a folder, and `other` for a link or a special file. */
export function folderTree(entries: Record<string, number | null | 'other'> = {}, more = false): AppsTree {
  return {
    kind: 'folder',
    size: 0,
    more,
    entries: Object.entries(entries).map(([path, size]) => {
      const kind: AppsEntryKind = size === null ? 'folder' : size === 'other' ? 'other' : 'file'
      return { path, kind, size: typeof size === 'number' ? size : 0 }
    }),
  }
}
