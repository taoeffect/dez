import { spawnSync } from 'node:child_process'
import path from 'node:path'
import type { RunningApp } from './app'

// Runs of the ffmpeg and the ffprobe of the build under test, which
// tauri-build puts next to its binary. A spec reads with them the pictures
// and the clips that the app made: the same programs as those of the app,
// so a spec does not depend on the ffmpeg of the computer.

/** A bundled program that a spec runs. */
export type BundledProgram = 'dez-ffmpeg' | 'dez-ffprobe'

/** The standard output of a run of `program` of the build of `app`.
 *  Throws when the run fails. */
export function programRun (app: RunningApp, program: BundledProgram, args: string[]): Buffer {
  const run = spawnSync(path.join(path.dirname(app.binary), program), args)
  if (run.status !== 0) throw new Error(`${program} ${args.join(' ')} failed: ${run.stderr.toString()}`)
  return run.stdout
}

/** The standard output of `programRun` as text. */
export function programOutput (app: RunningApp, program: BundledProgram, args: string[]): string {
  return programRun(app, program, args).toString('utf8')
}

/** Each color of the pixels of the picture or clip `file` once (of all the
 *  frames of a clip), as its red, green, blue, and alpha (`32,128,255,127`),
 *  as ffmpeg decodes it. */
export function pixelColors (app: RunningApp, file: string): string[] {
  const pixels = programRun(app, 'dez-ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'])
  const colors = new Set<string>()
  for (let start = 0; start < pixels.length; start += 4) colors.add(pixels.subarray(start, start + 4).join(','))
  return [...colors]
}

/** The facts of the media file `file`: each stream (`video vp9 48x36`,
 *  `audio opus`), and the length in s to 1 decimal place (null for an
 *  image). */
export function mediaFacts (app: RunningApp, file: string): { streams: string[], seconds: number | null } {
  const output = programOutput(app, 'dez-ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration', '-of', 'json', file])
  const { streams, format } = JSON.parse(output) as {
    streams: Array<{ codec_type: string, codec_name: string, width?: number, height?: number }>
    format: { duration?: string }
  }
  return {
    streams: streams.map(({ codec_type: type, codec_name: codec, width, height }) => `${type} ${codec}${width === undefined ? '' : ` ${width}x${height}`}`),
    seconds: format.duration === undefined ? null : Math.round(Number(format.duration) * 10) / 10,
  }
}
