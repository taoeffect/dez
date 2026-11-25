import sbp from '@sbp/sbp'
import { ClipReadError } from '../model/chat/mediaFiles'
import { PLAY_COPY_KEEP_MS, PLAY_COPY_MAX_BYTES, PLAY_COPY_MEMO_MAX_BYTES, PLAY_COPY_RUN_TIMEOUT_MS, playCopyRun, type PlayCopyTarget } from '../model/chat/playCopies'
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
// memo of this module keeps a copy while a player shows it, so that a
// second player of the same clip (the preview box of a mention, the kept
// assets list) makes no second run, and `PLAY_COPY_KEEP_MS` after the last
// player went, so that a quick return (a tab switch, a scroll back) makes
// no second run either. Its key is the `src` of the clip, and the size of
// the file tells a changed linked file.
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
  // How many calls hold the copy: the calls whose signal did not stop. They
  // wait for the copy, or they show the copy that was made. The run stops
  // when the last one stops waiting (`lastPlayerWent`).
  players: number
  // The timer that takes a copy that was made out of the memo, from the
  // moment its last player went; null while a player shows it.
  freeTimer: ReturnType<typeof setTimeout> | null
  stop: AbortController
}

// The copies by `src`, the one that was used last at the end (a use
// deletes the key, and sets it again).
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

// Stops the timer that takes `entry` out of the memo.
function stopFreeTimer(entry: PlayCopy): void {
  if (entry.freeTimer === null) return
  clearTimeout(entry.freeTimer)
  entry.freeTimer = null
}

// Takes `entry` out of the memo, if it is still the entry of its `src`: a
// Save moves an entry (`movePlayCopy`), and a changed size replaces it.
function dropCopy(entry: PlayCopy): void {
  stopFreeTimer(entry)
  if (copies.get(entry.src) === entry) copies.delete(entry.src)
}

// Drops the oldest copies that no player shows while the memo holds more
// than its cap. A copy that a player shows counts, but stays: its player
// holds its bytes anyway, and the next player of its clip gets it with no
// run. A copy that failed stays: it holds no bytes, and the memo keeps the
// next player of its clip from a run that fails again.
function trimCopies(): void {
  let total = 0
  for (const entry of copies.values()) total += entry.bytes
  for (const entry of copies.values()) {
    if (total <= PLAY_COPY_MEMO_MAX_BYTES) return
    if (!entry.done || entry.bytes === 0 || entry.players > 0) continue
    total -= entry.bytes
    dropCopy(entry)
  }
}

// No call holds `entry` any more. A run stops at once, and its entry
// leaves the memo: a later call makes a new run, and never joins the one
// that stops. A copy that was made goes `PLAY_COPY_KEEP_MS` later, or
// before that when the memo is over its cap. A copy that failed stays.
function lastPlayerWent(entry: PlayCopy): void {
  if (!entry.done) {
    dropCopy(entry)
    entry.stop.abort()
    return
  }
  if (entry.bytes === 0 || copies.get(entry.src) !== entry) return
  entry.freeTimer = setTimeout(() => { dropCopy(entry) }, PLAY_COPY_KEEP_MS)
  trimCopies()
}

// A new copy of the clip whose file is `src`, in the memo.
function startCopy(src: string, size: number, target: PlayCopyTarget): PlayCopy {
  const entry: PlayCopy = { src, size, copy: Promise.resolve(null), done: false, bytes: 0, players: 0, freeTimer: null, stop: new AbortController() }
  entry.copy = makeCopy(entry, target)
  entry.copy.then((blob) => {
    entry.done = true
    entry.bytes = blob?.size ?? 0
    trimCopies()
  }, () => {
    // A stop: the last player took the copy out of the memo.
  })
  copies.set(src, entry)
  return entry
}

// The copy of `entry`, or the stop of `signal`. The signal is the hold of
// one player, from the call until the player no longer shows the copy: a
// stop before the copy came stops the wait, and a stop after it ends the
// hold. So its listener stays after the call ended, as the `signal` option
// of `addEventListener` removes a listener long after its call. A call
// that gets no copy holds nothing.
function waitForCopy(entry: PlayCopy, signal: AbortSignal): Promise<Blob | null> {
  entry.players += 1
  let holds = true
  return new Promise((resolve, reject) => {
    // A stop before a copy that failed leaves before the end of `copy`, and
    // the end must not leave again.
    const leave = () => {
      if (!holds) return
      holds = false
      signal.removeEventListener('abort', onStop)
      entry.players -= 1
      if (entry.players === 0) lastPlayerWent(entry)
    }
    const onStop = () => {
      reject(signal.reason)
      leave()
    }
    signal.addEventListener('abort', onStop, { once: true })
    entry.copy.then((blob) => {
      resolve(blob)
      if (blob === null) leave()
    }, (error: unknown) => {
      signal.removeEventListener('abort', onStop)
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
  const entry = copies.get(path)
  if (entry !== undefined) dropCopy(entry)
}

export default sbp('sbp/selectors/register', {
  // The play copy of the local video clip whose file is `src`, of `size`
  // bytes, in the format `target` (`playCopyTarget`); null when Dez made
  // none (the log tells why). A copy that the memo holds comes from it, and
  // so does the null of a copy that failed in this session. `signal` is
  // the hold of the player (`waitForCopy`): stop it when the player no
  // longer shows the copy, or no longer waits for it. A stop before the
  // copy came rejects with the stop, and stops the run when no other call
  // waits for it.
  async 'dez.controller/media/playCopy' (
    { src, size, target }: { src: string, size: number, target: PlayCopyTarget },
    { signal }: { signal: AbortSignal },
  ): Promise<Blob | null> {
    signal.throwIfAborted()
    let entry = copies.get(src)
    // A player that came back within the keep time keeps the copy; a
    // changed file replaces it at once.
    if (entry !== undefined) stopFreeTimer(entry)
    if (entry === undefined || entry.size !== size) {
      entry = startCopy(src, size, target)
    } else {
      copies.delete(src)
      copies.set(src, entry)
    }
    return waitForCopy(entry, signal)
  },
})
