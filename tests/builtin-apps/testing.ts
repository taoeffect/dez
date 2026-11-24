// The run of a built-in app in a unit test: the `dez` object that a Deno
// run gives the app (runDez, src/model/tools/jsEvalRunner.js), with the
// decoded files of its inputs in a temp folder, as Dez's decode writes
// them (src/model/tools/inputDecode.ts).

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface TestInput {
  id: string
  kind: 'image' | 'audio' | 'video'
  type: string
  path: string
  audio?: { path: string, rate: number, count: number } | null
  frames?: { path: string, width: number, height: number, fps: number | null, count: number } | null
}

export interface TestRun {
  /** The folder of the decoded files. */
  folder: string
  /** `dez.workFolder`: /work/ of the conversation. */
  workFolder: string
  dez(inputs: TestInput[]): { inputs: TestInput[], outputFolder: string, appFolder: string, workFolder: string }
  /** Writes the decoded sound of a clip, as float32 samples. */
  audio(id: string, samples: Float32Array, rate: number): Promise<NonNullable<TestInput['audio']>>
  /** Writes the decoded frames of a video, as RGB bytes. */
  frames(id: string, bytes: Uint8Array, width: number, height: number, fps: number | null): Promise<NonNullable<TestInput['frames']>>
  /** The names of the files in /work/. */
  workFiles(): Promise<string[]>
  /** The JSON of a file of /work/, from its path after /work/. */
  workJson(name: string): Promise<unknown>
  /** The text of a file of /work/, from its path after /work/. */
  workText(name: string): Promise<string>
  remove(): Promise<void>
}

/** A temp folder for one run, with its /work/ folder. */
export async function testRun(): Promise<TestRun> {
  const folder = await mkdtemp(join(tmpdir(), 'dez-builtin-'))
  const workFolder = join(folder, 'work')
  return {
    folder,
    workFolder,
    dez: (inputs) => ({ inputs, outputFolder: join(folder, 'output'), appFolder: join(folder, 'app'), workFolder }),
    async audio(id, samples, rate) {
      const path = join(folder, `${id}.f32`)
      await writeFile(path, new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength))
      return { path, rate, count: samples.length }
    },
    async frames(id, bytes, width, height, fps) {
      const path = join(folder, `${id}.rgb`)
      await writeFile(path, bytes)
      return { path, width, height, fps, count: bytes.length / (width * height * 3) }
    },
    async workFiles() {
      return (await readdir(workFolder, { recursive: true })).sort()
    },
    workJson: async (name) => JSON.parse(await readFile(join(workFolder, name), 'utf8')),
    workText: (name) => readFile(join(workFolder, name), 'utf8'),
    remove: () => rm(folder, { recursive: true, force: true }),
  }
}

/** An input of the kind `kind`, with the file that no built-in reads. */
export function input(id: string, kind: TestInput['kind'], decoded: Pick<TestInput, 'audio' | 'frames'> = {}): TestInput {
  const type = { image: 'image/png', audio: 'audio/wav', video: 'video/webm' }[kind]
  return { id, kind, type, path: `/nowhere/${id}`, ...decoded }
}

/**
 * Video frames of `width`×`height`, one solid color for each shot: shots
 * that start at the frames of `cutFrames` (each after the one before),
 * dark and bright in turn, so that each cut changes every color.
 */
export function shotFrames(count: number, cutFrames: readonly number[], width = 16, height = 9): Uint8Array {
  const bytes = new Uint8Array(count * width * height * 3)
  const frameBytes = width * height * 3
  for (let frame = 0; frame < count; frame++) {
    const shot = cutFrames.filter((cut) => cut <= frame).length
    bytes.fill(shot % 2 === 0 ? 30 : 220, frame * frameBytes, (frame + 1) * frameBytes)
  }
  return bytes
}
