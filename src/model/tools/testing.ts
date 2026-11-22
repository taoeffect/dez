import { mediaTagText, type MediaTagData } from '../chat/mediaTags'
import type { Section } from '../chat/types'
import { reply, user } from '../streams/testing'
import { AUDIO_ALIASES, VIDEO_ALIASES, type AppAlias } from './appAliases'
import { appManifestText, type AppKind } from './appManifest'
import { grepCall, grepPlan, grepRequest, grepText } from './appsGrep'
import { APPS_TOOL, type AppsEntryKind, type AppsTree, type PathFacts } from './appsTool'
import { grepFiles } from './grepMatch'
import type { JsEvalLine, RunFolderForms } from './jsEval'
import type { JobInfo } from './jobs'
import { parseSubcommandCall } from './subcommands'
import { ToolError, type SubcommandArguments } from './types'
import type { CallContext } from './videoTool'

// Shared helpers of the unit tests of the Dez tools: the text of a refused
// call, the facts of a job, a conversation with images and clips for the
// `video` tool, the output of the ffprobe run that reads the facts of a
// clip for a join (`joinProbeArgs`), the arguments, the listings, and the
// `grep` results of the `apps` tool, an alias subcommand of `audio` or
// `video`, the protocol lines and the work folder of a `js_eval` run, and
// the bytes of a file. This module registers no selector, so a test of
// the model can import it; controller/testing.ts imports it too.

/** The message of the error of `errorClass` (a `ToolError` if not given)
 *  that `call` throws. */
export function refusal(call: () => unknown, errorClass: abstract new (...args: never[]) => Error = ToolError): string {
  try {
    call()
  } catch (error) {
    if (error instanceof errorClass) return error.message
    throw error
  }
  throw new Error('The call was not refused.')
}

/** A protocol line of a `js_eval` run, as the module of Dez writes it
 *  (jsEvalRunner.js). */
export function protocolLine(line: JsEvalLine): string {
  return `\x1e${JSON.stringify(line)}\n`
}

/** The run folder of a `js_eval` run as Dez made its path, and its real
 *  path. */
export const RUN_FOLDER_ID = '0b0c1a5e-7b1f-4c3a-9d1e-2f3a4b5c6d7e'
export const JOINED_RUN_FOLDER = `/home/u/.cache/dez/work/${RUN_FOLDER_ID}`
export const REAL_RUN_FOLDER = `/mnt/disk/cache/dez/work/${RUN_FOLDER_ID}`

/** The conversation of a run, and its work folder as Dez made its path
 *  and its real path. */
export const CONVERSATION_ID = 'c0ffee00-0000-4000-8000-000000000001'
export const JOINED_WORK_FOLDER = `/home/u/.config/dez/work/${CONVERSATION_ID}`
export const REAL_WORK_FOLDER = `/mnt/disk/config/dez/work/${CONVERSATION_ID}`

/** The folders of a `js_eval` run, each in both forms, as the code of the
 *  run gets them. */
export const RUN_FOLDERS: RunFolderForms = { run: [REAL_RUN_FOLDER, JOINED_RUN_FOLDER], work: [REAL_WORK_FOLDER, JOINED_WORK_FOLDER] }

/** The UTF-8 bytes of `text`. */
export function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** The first bytes of a PNG image and of a WAV clip. */
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
export const WAV_BYTES = textBytes('RIFF\0\0\0\0WAVEfmt ')

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

/** The context of a `video` call in the conversation of `sections`, whose
 *  id is `CONVERSATION_ID`. */
export function videoContext(sections: readonly Section[] = CONVERSATION): CallContext {
  return { sections, conversationId: CONVERSATION_ID }
}

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

/** The bytes of a valid manifest file of the app `notes` of `kind`. */
export function notesManifest(kind: AppKind): Uint8Array {
  return textBytes(appManifestText({ name: 'notes', description: 'Keeps notes.', kind }))
}

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

/** The result of an `apps grep` call with `parameters` on the folder of its
 *  `path` (`/apps` when it has none), which holds `files`: the text or the
 *  bytes of each file, by its path in the folder. The plan, the matching,
 *  and the text are the real ones, with no worker. */
export function grepResult(parameters: Record<string, unknown>, files: Record<string, string | Uint8Array>): string {
  const call = grepCall(appsArgs('grep', parameters), CONVERSATION_ID)
  const contents = Object.fromEntries(Object.entries(files).map(([path, content]) => [path, typeof content === 'string' ? textBytes(content) : content]))
  const plan = grepPlan(call, folderTree(Object.fromEntries(Object.entries(contents).map(([path, bytes]) => [path, bytes.length]))))
  if (plan.kind === 'text') return plan.text
  const bytes = plan.files.map((file) => contents[file.path.names.slice(call.path.names.length).join('/')])
  return grepText(call, plan, grepFiles(grepRequest(call, plan.files, bytes)))
}

/** The alias subcommand `name` of the tool `tool`. */
export function aliasOf(tool: 'audio' | 'video', name: string): AppAlias {
  const alias = [...AUDIO_ALIASES, ...VIDEO_ALIASES].find((each) => each.tool === tool && each.subcommand.name === name)
  if (!alias) throw new Error(`There is no alias ${tool} ${name}.`)
  return alias
}
