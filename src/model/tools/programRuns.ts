import { byteSizeText } from '../../utils/byteSize'
import { MAX_SAVED_CLIP_BYTES, mediaFileExtension } from '../chat/mediaFiles'
import type { MediaTagKind } from '../chat/mediaTags'
import type { ClipAttachment } from '../providers/clipInputs'
import type { JobAssetKind } from './jobs'

// What the tools that run ffmpeg or ffprobe, the programs that Dez ships
// (src-tauri/binaries/), share about a run: its input clips, its end, the
// new files that Dez keeps, and the texts of the failures that are the
// same for every tool. controller/programRuns.ts does the work.
//
// Every text here is a tool result: it goes to the chat provider.

/** A program that Dez ships. */
export type ShippedProgram = 'ffmpeg' | 'ffprobe'

/** A clip of a call, as the program gets it. */
export interface ClipInput {
  kind: MediaTagKind
  id: string
  /** The name of its copy in the work folder. */
  name: string
  clip: ClipAttachment
}

/** `clip` as the input of a program. The name of the copy is the id and
 *  the extension of the file's type, so it tells nothing of the user's
 *  file name. ffmpeg finds the format in the bytes, so a clip of a type
 *  that Dez does not know still reads (`.bin`). */
export function clipInput(clip: ClipAttachment): ClipInput {
  return { kind: clip.kind, id: clip.id, name: `${clip.id}.${mediaFileExtension(clip.type, clip.url) ?? 'bin'}`, clip }
}

/** How a program run ended by itself or by a limit (`BundledToolEnd`
 *  without the cancel). */
export type ProgramEnd =
  | { kind: 'exited', code: number | null }
  | { kind: 'timedOut' }
  | { kind: 'outputTooLarge' }

/** A new file of a run that Dez keeps: an image or a clip of a type that
 *  it stores. `extension` is the one of its stored file. */
export interface KeptFile {
  name: string
  kind: JobAssetKind
  type: string
  extension: string
}

/** What the model must do after a failure of the tool `tool` that is a
 *  fault of Dez or of the computer, and whose cause is only in the log
 *  (it can hold a path). */
export function tellUserConsole(tool: string): string {
  return `This is not a fault of the call. Tell the user that the ${tool} tool failed and that Help › Developer Console shows why, `
    + `and call the ${tool} tool again only when the user asks for it.`
}

/** The error result of a run for the tool `tool` that did not start: the
 *  program is missing, or the system did not let Dez make the work folder
 *  or copy an input file. */
export function programNotStartedText(program: ShippedProgram, tool: string): string {
  return `Dez could not start ${program} on this computer. ${tellUserConsole(tool)}`
}

/** The details of a clip that Dez does not give to the program because its
 *  file is too large. */
export const INPUT_CLIP_TOO_LARGE = `The file of the clip is larger than ${byteSizeText(MAX_SAVED_CLIP_BYTES)}, the most that Dez gives to a tool.`

/** The error result of a run for the tool `tool` whose new files Dez could
 *  not move into the Dez folder. */
export function outputNotStoredText(tool: string): string {
  return `The program made its files, but Dez could not move them into the Dez folder, so it kept none. ${tellUserConsole(tool)}`
}
