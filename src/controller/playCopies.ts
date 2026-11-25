import sbp from '@sbp/sbp'
import { ClipReadError } from '../model/chat/mediaFiles'
import { PLAY_COPIES_MAX_BYTES, PLAY_COPY_MAX_BYTES, PLAY_COPY_RUN_TIMEOUT_MS, playCopyRun, type PlayCopyTarget } from '../model/chat/playCopies'
import { withoutLocalPaths } from '../model/tools/localPaths'
import { ffmpegRunDetails } from '../model/tools/programRuns'
import { ToolError } from '../model/tools/types'
import { FFMPEG_OUTPUT_BYTES } from '../model/tools/videoTool'
import { byteSizeText } from '../utils/byteSize'
import { longDuration } from '../utils/durationText'
import { rawErrorText } from '../utils/errorText'
import type { AppFileEntry } from './nativeTypes'
import { copyInputClip, errorOutputEnd, inWorkFolder, runProgram } from './programRuns'

// The play copies of local video clips that this computer cannot play
// (model/chat/playCopies.ts tells why they exist): `dez.controller/media/
// playCopy` has the bundled ffmpeg make one, and MediaPlayer.vue plays it.
//
// A copy is in memory only, as a Blob: no new file and no new kind of
// cache entry, so the cleanups (unusedFiles.ts) know nothing of it. The
// memo of this module keeps the copies of the session, so that a second
// player of the same clip (the preview box of a mention, the kept assets
// list) makes no second run. Its key is the `src` of the clip, and the
// size of the file tells a changed linked file.
//
// Nothing of a run goes to a model or to the user: an error goes only to
// `console.error`, with no path, and the player shows its card.

// The name of the runs in the texts of `runProgram`, which go nowhere.
const RUN_NAME = 'play copy'

// The most characters that Dez keeps of the end of the error output of a
// run, for the log.
const ERROR_END_CHARS = 1000

const QUEUE = 'dez.controller/media/playCopy'

const LOG_START = 'Failed to make the play copy of a clip:'

// The copy of one clip, while it is made and after.
interface PlayCopy {
  // The file of the clip. A Save moves the file of a temp copy, and its
  // copy with it (`movePlayCopy`): a run reads the file where it is when
  // the run starts.
  src: string
  size: number
  // The copy; null for a run that made none. It rejects only with the stop
  // of `stop`, after which the memo no longer holds it.
  copy: Promise<Blob | null>
  // True from the end of `copy`.
  done: boolean
  // The bytes of a copy that was made, for the cap of the memo.
  bytes: number
  // How many calls wait for the copy. The run stops when the last one
  // stops waiting.
  waiters: number
  stop: AbortController
}

// The copies of the session by `src`, the one that was used last at the
// end (a use deletes the key, and sets it again).
const copies = new Map<string, PlayCopy>()

// How one run ended: the copy, or the lines of the log of a run that made
// none.
type RunResult = { kind: 'made', blob: Blob } | { kind: 'failed', log: string }

// One run that makes the copy of the clip whose file is `src`, in a new
// work folder. Rust copies the file into the folder, so the bytes of the
// clip never come into the webview, and a linked file keeps its cap
// (`copyInputClip`). Rejects only with the stop of `signal`.
async function copyRun(src: string, target: PlayCopyTarget, signal: AbortSignal): Promise<RunResult> {
  const { inputName, name, type, args } = playCopyRun(target, src)
  try {
    return await inWorkFolder(async (folder): Promise<RunResult> => {
      const input = await copyInputClip({ name: inputName, clip: { src, url: null, expires: null } }, folder, signal)
      const errors = errorOutputEnd(ERROR_END_CHARS)
      const run = { args, folder, inputs: input ? [input] : [], timeoutMs: PLAY_COPY_RUN_TIMEOUT_MS, maxOutputBytes: FFMPEG_OUTPUT_BYTES }
      const end = await runProgram('ffmpeg', RUN_NAME, run, signal, ({ stream, text }) => {
        if (stream === 'stderr') errors.add(text)
      })
      if (end.kind === 'timedOut') return { kind: 'failed', log: `${LOG_START} ffmpeg took longer than ${longDuration(PLAY_COPY_RUN_TIMEOUT_MS)}.` }
      if (end.kind !== 'exited' || end.code !== 0) {
        // The error output can name a path that the data of the file holds.
        return { kind: 'failed', log: `${LOG_START} ${withoutLocalPaths(ffmpegRunDetails(end, errors.text(), FFMPEG_OUTPUT_BYTES))}` }
      }
      // `-fs` ends the run with no error at the size cap, so the size
      // tells a copy that is too large.
      const size = (await sbp('dez.native/listAppFiles', folder, 'cache') as AppFileEntry[]).find((file) => file.name === name)?.size ?? 0
      if (size > PLAY_COPY_MAX_BYTES) return { kind: 'failed', log: `${LOG_START} the copy is larger than ${byteSizeText(PLAY_COPY_MAX_BYTES)}.` }
      // The copy is read through Rust, not through the asset protocol: that
      // one follows links, and Dez follows no link in the cache root.
      const bytes = await sbp('dez.native/loadAppFileBytes', `${folder}/${name}`, 'cache') as Uint8Array
      return { kind: 'made', blob: new Blob([bytes], { type }) }
    })
  } catch (error) {
    signal.throwIfAborted()
    // `runProgram` logged the native error of a run that did not start.
    if (error instanceof ToolError) return { kind: 'failed', log: `${LOG_START} ffmpeg did not start.` }
    if (error instanceof ClipReadError) return { kind: 'failed', log: `${LOG_START} Dez could not read the file of the clip (${error.problem}).` }
    return { kind: 'failed', log: `${LOG_START} ${withoutLocalPaths(rawErrorText(error))}` }
  }
}

// The copy of `entry`, by one run at a time for all players: two runs at
// once would take twice the time for each. A Save that moves the file
// while a run reads it makes the run fail; the run then goes again on the
// saved file.
function makeCopy(entry: PlayCopy, target: PlayCopyTarget): Promise<Blob | null> {
  const signal = entry.stop.signal
  return sbp('okTurtles.eventQueue/queueEvent', QUEUE, async (): Promise<Blob | null> => {
    for (;;) {
      signal.throwIfAborted()
      const src = entry.src
      const result = await copyRun(src, target, signal)
      if (result.kind === 'made') return result.blob
      if (entry.src !== src) continue
      console.error(result.log)
      return null
    }
  }) as Promise<Blob | null>
}

// Drops the oldest copies that were made while the memo holds more than
// its cap. A player that plays a dropped copy keeps it. A copy that failed
// stays: it holds no bytes, and the memo keeps the next player of its clip
// from a run that fails again.
function trimCopies(): void {
  let total = 0
  for (const entry of copies.values()) total += entry.bytes
  for (const [src, entry] of copies) {
    if (total <= PLAY_COPIES_MAX_BYTES) return
    if (!entry.done || entry.bytes === 0) continue
    total -= entry.bytes
    copies.delete(src)
  }
}

// A new copy of the clip whose file is `src`, in the memo.
function startCopy(src: string, size: number, target: PlayCopyTarget): PlayCopy {
  const entry: PlayCopy = { src, size, copy: Promise.resolve(null), done: false, bytes: 0, waiters: 0, stop: new AbortController() }
  entry.copy = makeCopy(entry, target)
  entry.copy.then((blob) => {
    entry.done = true
    entry.bytes = blob?.size ?? 0
    trimCopies()
  }, () => {
    // A stop: the last waiter took the copy out of the memo.
  })
  copies.set(src, entry)
  return entry
}

// The copy of `entry`, or the stop of `signal`.
function waitForCopy(entry: PlayCopy, signal: AbortSignal): Promise<Blob | null> {
  entry.waiters += 1
  return new Promise((resolve, reject) => {
    const leave = () => {
      entry.waiters -= 1
      reject(signal.reason)
      if (entry.waiters > 0 || entry.done) return
      // Out of the memo at once: a later call makes a new run, and never
      // joins the one that stops.
      if (copies.get(entry.src) === entry) copies.delete(entry.src)
      entry.stop.abort()
    }
    signal.addEventListener('abort', leave, { once: true })
    entry.copy.then((blob) => {
      signal.removeEventListener('abort', leave)
      resolve(blob)
    }, (error: unknown) => {
      signal.removeEventListener('abort', leave)
      reject(error)
    })
  })
}

/** Moves the copy of the clip whose file was at `from` to the clip's new
 *  file `to`: the Save of a temp copy (`dez.controller/media/save`). */
export function movePlayCopy(from: string, to: string): void {
  const entry = copies.get(from)
  if (entry === undefined) return
  copies.delete(from)
  entry.src = to
  copies.set(to, entry)
}

/** Takes the copy of the clip whose file was at `path` out of the memo:
 *  the file is gone (`dez.controller/media/delete`). */
export function forgetPlayCopy(path: string): void {
  copies.delete(path)
}

export default sbp('sbp/selectors/register', {
  // The play copy of the local video clip whose file is `src`, of `size`
  // bytes, in the format `target` (`playCopyTarget`); null when Dez made
  // none (the log tells why). A copy that a call of this session made, or
  // could not make, comes from the memo. A stop of `signal` rejects with
  // the stop, and stops the run when no other call waits for it.
  async 'dez.controller/media/playCopy' (
    { src, size, target }: { src: string, size: number, target: PlayCopyTarget },
    { signal }: { signal: AbortSignal },
  ): Promise<Blob | null> {
    signal.throwIfAborted()
    let entry = copies.get(src)
    if (entry === undefined || entry.size !== size) {
      entry = startCopy(src, size, target)
    } else {
      copies.delete(src)
      copies.set(src, entry)
    }
    return waitForCopy(entry, signal)
  },
})
