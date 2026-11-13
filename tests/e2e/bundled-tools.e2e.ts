import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AppFileEntry, BundledTool, BundledToolEnd, BundledToolOutput, BundledToolRun } from '../../src/controller/nativeTypes'
import { workFolderPath } from '../../src/model/tools/workFolders'
import { startApp, type RunningApp } from './harness/app'
import { consoleErrors, resetConsoleErrors, screenshotOnFailure, waitFor, waitForValue } from './harness/dom'
import { appFilePath, filesIn, mediaTempDir, seedAppState, workDir, writeTestFile } from './harness/fixtures'
import { WEBM_VIDEO } from './harness/media'
import { pidsWithCwd } from './harness/processes'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { sbpCall } from './harness/thread'

// The programs that Dez ships (ffmpeg and ffprobe), run by the real app
// through `dez.native/runBundledTool`: the work folder, the copies of the
// input files, the ends of a run, and the cleanup. No provider, and no tool
// of a model: the spec calls the native selectors in the page.

/** What the page got of one run. */
interface RunRecord {
  stdout: string
  stderr: string
  end: BundledToolEnd | null
  /** The error text of a run that did not start. The name is not `error`:
   *  webdriverio takes a script result with a set `error` field for a
   *  failure of the script. */
  refusal: string | null
}

const HOUR_MS = 60 * 60 * 1000
// Limits that no run of this spec reaches.
const WIDE_LIMITS = { timeoutMs: 60_000, maxOutputBytes: 1_000_000 }

/** A run that has no end and does little work: a tone to no file, at the
 *  pace of real time (`-re`). ffmpeg writes its state to stderr twice a
 *  second. */
function endlessRun (folder: string): BundledToolRun {
  return {
    tool: 'dez-ffmpeg',
    args: ['-hide_banner', '-nostdin', '-re', '-f', 'lavfi', '-i', 'sine=frequency=440', '-f', 'null', '-'],
    folder,
    inputs: [],
    ...WIDE_LIMITS,
  }
}

/** Starts a run in the page and does not wait for its end: `runRecord`
 *  reads what the page got of it. */
async function startRun (browser: E2EBrowser, runId: string, run: BundledToolRun): Promise<void> {
  await browser.execute((id: string, toolRun: BundledToolRun) => {
    const sbp = Reflect.get(window, 'sbp') as (selector: string, ...args: unknown[]) => Promise<unknown>
    const records = (Reflect.get(window, '__e2eToolRuns') ?? {}) as Record<string, RunRecord>
    Reflect.set(window, '__e2eToolRuns', records)
    const record: RunRecord = { stdout: '', stderr: '', end: null, refusal: null }
    records[id] = record
    sbp('dez.native/runBundledTool', toolRun, id, (output: BundledToolOutput) => {
      record[output.stream] += output.text
    }).then((end) => {
      record.end = end as BundledToolEnd
    }, (error: unknown) => {
      record.refusal = String(error)
    })
  }, runId, run)
}

async function runRecord (browser: E2EBrowser, runId: string): Promise<RunRecord> {
  return browser.execute((id: string) => (Reflect.get(window, '__e2eToolRuns') as Record<string, RunRecord>)[id], runId)
}

/** Waits for the end of a started run, and gives what the page got of it. */
async function endedRun (browser: E2EBrowser, runId: string): Promise<RunRecord> {
  let record = await runRecord(browser, runId)
  await browser.waitUntil(async () => {
    record = await runRecord(browser, runId)
    return record.end !== null || record.refusal !== null
  }, { timeout: 30_000, interval: 50, timeoutMsg: `the run ${runId} did not end within 30 s; it gave ${JSON.stringify(record)}` })
  return record
}

/** Waits until the program of a started run writes its output. */
async function waitForOutput (browser: E2EBrowser, runId: string): Promise<void> {
  await waitForValue(browser, `output of the run ${runId}`, async () => (await runRecord(browser, runId)).stderr.includes('Output #0, null'), true)
}

describe('bundled tools', () => {
  let app: RunningApp
  let browser: E2EBrowser

  beforeAll(async () => {
    app = await startApp()
    try {
      await seedAppState(app.home)
      browser = await createSession(app.binary, app.port)
    } catch (err) {
      await app.stop()
      throw err
    }
    await waitFor(browser, 'header.tab-bar', 60_000)
  })

  beforeEach(async () => {
    await resetConsoleErrors(browser)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    expect(await consoleErrors(browser)).toEqual([])
  })

  afterAll(async () => {
    await destroySession(browser)
    await app?.stop()
  })

  it('runs the programs in a private work folder on a copy of the input, and moves a new file out', async () => {
    const source = await writeTestFile(path.join(app.home, 'clips', 'source.webm'), WEBM_VIDEO)
    const id = randomUUID()
    const folder = workFolderPath(id)
    const dir = path.join(workDir(app.home), id)

    // A probe: its result is on stdout.
    const probeId = randomUUID()
    await startRun(browser, probeId, {
      tool: 'dez-ffprobe',
      args: ['-v', 'error', '-show_entries', 'format=format_name', '-of', 'default=noprint_wrappers=1', 'in.webm'],
      folder,
      inputs: [{ name: 'in.webm', source }],
      ...WIDE_LIMITS,
    })
    expect(await endedRun(browser, probeId)).toStrictEqual({
      stdout: 'format_name=matroska,webm\n',
      stderr: '',
      end: { kind: 'exited', code: 0 },
      refusal: null,
    })

    // Only the user can open the folder, and the input is a file of its
    // own: a program that writes to it cannot change the source.
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    const copy = fs.lstatSync(path.join(dir, 'in.webm'))
    expect({ plainFile: copy.isFile(), names: copy.nlink, isTheSource: copy.ino === fs.statSync(source).ino })
      .toStrictEqual({ plainFile: true, names: 1, isTheSource: false })

    // The work, in the folder that the probe made: ffmpeg writes its log to
    // stderr.
    const workId = randomUUID()
    await startRun(browser, workId, {
      tool: 'dez-ffmpeg',
      args: ['-hide_banner', '-nostdin', '-i', 'in.webm', '-c', 'copy', 'out.webm'],
      folder,
      inputs: [],
      ...WIDE_LIMITS,
    })
    const work = await endedRun(browser, workId)
    expect({ end: work.end, refusal: work.refusal, stdout: work.stdout }).toStrictEqual({ end: { kind: 'exited', code: 0 }, refusal: null, stdout: '' })
    expect(work.stderr).toContain("Input #0, matroska,webm, from 'in.webm':")
    expect(work.stderr).toContain("Output #0, webm, to 'out.webm':")

    const files = await sbpCall(browser, 'dez.native/listAppFiles', folder, 'cache') as AppFileEntry[]
    expect(files.map((file) => file.name).sort()).toStrictEqual(['in.webm', 'out.webm'])
    const folders = await sbpCall(browser, 'dez.native/listAppFiles', 'work', 'cache', { folders: true }) as AppFileEntry[]
    expect(folders.map((entry) => entry.name)).toContain(id)

    // The new file moves into the Dez folder, and is private there even
    // when the program made it readable for all.
    fs.chmodSync(path.join(dir, 'out.webm'), 0o644)
    await sbpCall(browser, 'dez.native/moveAppFile', { root: 'cache', path: `${folder}/out.webm` }, { root: 'app', path: 'assets/generated/video/out.webm' })
    const moved = appFilePath(app.home, 'assets', 'generated', 'video', 'out.webm')
    expect(fs.statSync(moved).mode & 0o777).toBe(0o600)
    // The four bytes that a WebM file starts with.
    expect(fs.readFileSync(moved).subarray(0, 4)).toStrictEqual(WEBM_VIDEO.subarray(0, 4))

    await sbpCall(browser, 'dez.native/deleteAppFile', folder, 'cache', { folder: true })
    expect(fs.existsSync(dir)).toBe(false)
    expect(fs.readFileSync(source).equals(WEBM_VIDEO)).toBe(true)
  })

  it('refuses a program that Dez does not ship, and a work folder outside the cache folder', async () => {
    const id = randomUUID()
    await startRun(browser, id, { tool: 'sh' as BundledTool, args: ['-c', 'echo out'], folder: workFolderPath(id), inputs: [], ...WIDE_LIMITS })
    expect(await endedRun(browser, id)).toStrictEqual({ stdout: '', stderr: '', end: null, refusal: 'Not a bundled tool: sh' })

    const outside = randomUUID()
    await startRun(browser, outside, { tool: 'dez-ffmpeg', args: ['-version'], folder: '../outside', inputs: [], ...WIDE_LIMITS })
    expect(await endedRun(browser, outside)).toStrictEqual({ stdout: '', stderr: '', end: null, refusal: 'Invalid app file path: ../outside' })

    // No refused run made a folder.
    expect(fs.existsSync(path.join(workDir(app.home), id))).toBe(false)
    expect(fs.existsSync(path.join(app.home, '.cache', 'outside'))).toBe(false)
  })

  // The OS rule of src-tauri/src/confinement.rs (Landlock on Linux): the
  // spec runs the programs with paths that the argument checks of the
  // `video` tool refuse, to show what the OS still allows and stops.
  it('lets a program open only the files of the cache folder and of the assets folder', async () => {
    const folder = workFolderPath(randomUUID())
    const dir = path.join(workDir(app.home), path.basename(folder))
    const finishedRun = async (tool: BundledTool, args: string[]) => {
      const runId = randomUUID()
      await startRun(browser, runId, { tool, args, folder, inputs: [], ...WIDE_LIMITS })
      return endedRun(browser, runId)
    }
    const tone = ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2']

    // An MPEG-TS clip, a type that an HLS playlist can name, in the cache
    // folder but not in the work folder, in the assets folder of the app
    // folder, and in the home folder.
    expect((await finishedRun('dez-ffmpeg', [...tone, '-c:a', 'mp2', 'tone.ts'])).end).toStrictEqual({ kind: 'exited', code: 0 })
    const clip = fs.readFileSync(path.join(dir, 'tone.ts'))
    const cached = await writeTestFile(path.join(mediaTempDir(app.home), `${randomUUID()}.ts`), clip)
    const asset = await writeTestFile(appFilePath(app.home, 'assets', 'audio', `${randomUUID()}.ts`), clip)
    const home = await writeTestFile(path.join(app.home, 'clips', 'tone.ts'), clip)
    // Files of the app folder outside its assets folder: a key file with no
    // keys, and the app state of the seed.
    const keys = await writeTestFile(appFilePath(app.home, 'provider_keys.json'), Buffer.from('{}'))
    const appState = appFilePath(app.home, 'app_state.json')

    const probe = (file: string) => finishedRun('dez-ffprobe', ['-v', 'error', '-show_entries', 'format=format_name', '-of', 'csv=p=0', file])
    for (const file of [cached, asset]) {
      expect(await probe(file)).toStrictEqual({ stdout: 'mpegts\n', stderr: '', end: { kind: 'exited', code: 0 }, refusal: null })
    }
    for (const file of [keys, appState, home]) {
      const refused = await probe(file)
      expect({ stdout: refused.stdout, end: refused.end }).toStrictEqual({ stdout: '', end: { kind: 'exited', code: 1 } })
      expect(refused.stderr).toContain('Permission denied')
    }

    // A playlist in the work folder names its segment by a path that no
    // argument holds. The hls demuxer does not pass on the cause of a failed
    // open: the run of the same playlist with the clip of the cache folder
    // shows it.
    const playlist = (segment: string) => `#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:0.2,\n${segment}\n#EXT-X-ENDLIST\n`
    fs.writeFileSync(path.join(dir, 'cached.m3u8'), playlist(cached))
    fs.writeFileSync(path.join(dir, 'home.m3u8'), playlist(home))
    const copy = (list: string, output: string) => finishedRun('dez-ffmpeg', ['-v', 'error', '-f', 'hls', '-i', list, '-c', 'copy', output])
    expect((await copy('cached.m3u8', 'cached.mkv')).end).toStrictEqual({ kind: 'exited', code: 0 })
    const refused = await copy('home.m3u8', 'home.mkv')
    expect(refused.end).not.toStrictEqual({ kind: 'exited', code: 0 })
    expect(refused.stderr).toContain('Error when loading first segment')
    expect(fs.existsSync(path.join(dir, 'home.mkv'))).toBe(false)

    // ffmpeg writes a new file into the assets folder, and none outside the
    // two folders.
    const stored = path.join(path.dirname(asset), `${randomUUID()}.wav`)
    expect(await finishedRun('dez-ffmpeg', [...tone, stored])).toStrictEqual({ stdout: '', stderr: '', end: { kind: 'exited', code: 0 }, refusal: null })
    expect(fs.readFileSync(stored).subarray(0, 4).toString()).toBe('RIFF')
    const written = path.join(app.home, 'written.wav')
    const write = await finishedRun('dez-ffmpeg', [...tone, written])
    expect(write.end).not.toStrictEqual({ kind: 'exited', code: 0 })
    expect(write.stderr).toContain('Permission denied')
    expect(fs.existsSync(written)).toBe(false)

    await sbpCall(browser, 'dez.native/deleteAppFile', folder, 'cache', { folder: true })
  })

  it('stops a program on a cancel, at its time limit, and at its output cap', async () => {
    const folderId = randomUUID()
    const folder = workFolderPath(folderId)
    const dir = path.join(workDir(app.home), folderId)

    const cancelled = randomUUID()
    await startRun(browser, cancelled, endlessRun(folder))
    await waitForOutput(browser, cancelled)
    expect(pidsWithCwd(dir)).toHaveLength(1)
    await sbpCall(browser, 'dez.native/cancelBundledTool', cancelled)
    expect((await endedRun(browser, cancelled)).end).toStrictEqual({ kind: 'cancelled' })
    // The program is gone when its run ends, not some time later.
    expect(pidsWithCwd(dir)).toStrictEqual([])

    const timedOut = randomUUID()
    await startRun(browser, timedOut, { ...endlessRun(folder), timeoutMs: 1000 })
    expect((await endedRun(browser, timedOut)).end).toStrictEqual({ kind: 'timedOut' })
    expect(pidsWithCwd(dir)).toStrictEqual([])

    // `-version` writes about 700 bytes to stdout: the page gets them up to
    // the cap.
    const capped = randomUUID()
    await startRun(browser, capped, { tool: 'dez-ffmpeg', args: ['-version'], folder, inputs: [], timeoutMs: 60_000, maxOutputBytes: 100 })
    const record = await endedRun(browser, capped)
    expect({ end: record.end, bytes: record.stdout.length, start: record.stdout.slice(0, 14) })
      .toStrictEqual({ end: { kind: 'outputTooLarge' }, bytes: 100, start: 'ffmpeg version' })
  })
})

describe('bundled tools at the start and the quit of the app', () => {
  let app: RunningApp
  let browser: E2EBrowser

  /** Makes the work folder `name` with one file in it, last changed
   *  `ageMs` ago. */
  async function seedWorkFolder (name: string, ageMs: number): Promise<void> {
    const dir = path.join(workDir(app.home), name)
    await writeTestFile(path.join(dir, 'part.webm'), WEBM_VIDEO)
    // After the write: a new file in a folder sets the time of the folder.
    const changed = new Date(Date.now() - ageMs)
    await fs.promises.utimes(dir, changed, changed)
  }

  beforeAll(async () => {
    app = await startApp()
    try {
      await seedAppState(app.home)
      await seedWorkFolder('old', 25 * HOUR_MS)
      await seedWorkFolder('fresh', 23 * HOUR_MS)
      browser = await createSession(app.binary, app.port)
    } catch (err) {
      await app.stop()
      throw err
    }
    await waitFor(browser, 'header.tab-bar', 60_000)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
  })

  afterAll(async () => {
    await destroySession(browser)
    await app?.stop()
  })

  it('deletes the work folders that are older than a day when it starts, with their files', async () => {
    await waitForValue(browser, 'work folders after the app start', () => filesIn(workDir(app.home)), ['fresh'])
    expect(await filesIn(path.join(workDir(app.home), 'fresh'))).toStrictEqual(['part.webm'])
  })

  // The last case: it ends the app.
  it('ends a program that runs when the app quits', async () => {
    const id = randomUUID()
    const dir = path.join(workDir(app.home), id)
    await startRun(browser, id, endlessRun(workFolderPath(id)))
    await waitForOutput(browser, id)
    expect(pidsWithCwd(dir)).toHaveLength(1)

    try {
      // The close of the window, which ends the app as File › Quit does
      // (`controller/menu.ts`). The page goes with it, so the call can end
      // with no answer.
      await browser.execute(() => {
        const internals = Reflect.get(window, '__TAURI_INTERNALS__') as {
          invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>
        }
        void internals.invoke('plugin:window|close', { label: 'main' })
      }).catch(() => {})

      await waitForValue(browser, 'programs in the work folder after the quit', async () => pidsWithCwd(dir), [])
    } finally {
      // A program that the quit left would run with no end.
      for (const pid of pidsWithCwd(dir)) process.kill(pid, 'SIGKILL')
    }
  })
})
