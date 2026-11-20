import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { withoutLocalPaths } from '../../src/model/tools/localPaths'
import { consoleErrors, resetConsoleErrors, screenshotOnFailure } from './harness/dom'
import { appFilePath, makeConversation, mediaTempDir, seedConversation, workDir, writeTestFile } from './harness/fixtures'
import { evalCall, expectReplyEnd } from './harness/jsEval'
import { startMockProviderApp, takeRequest, type MockProviderApp } from './harness/mockProviderApp'
import { mockChatPath, sendToolCalls, toolResult, type HeldRequest, type MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import { newTab, submit } from './harness/thread'

// The audit of the sandbox of the `js_eval` tool, driven through the real
// app against a mock chat model in this process. The code of each call
// tries to get out of its run, in the real Deno of the debug build, with
// the command line and the OS rule that Dez gives every run. A new version
// of Deno (`scripts/update-deno.js`) must pass it too.
// - Deno refuses each thing of the computer that the code asks it for: a
//   file, the network, a variable of the environment, a fact of the
//   system, a program, a native library, and a new permission.
// - Deno loads a file that the code imports with no check of a permission,
//   so only the OS rule stops such an import: no file outside the work
//   folder of the run loads. Not the keys of the user, not a conversation,
//   and not a file of the other Dez folders.
// - The limits of a run hold: code that writes without end or that fills
//   the memory ends with an error result, the memory of typed arrays has
//   an end that the code can catch, and a line that the code writes in the
//   form of Dez's own result line changes no result. No program and no
//   work folder stays (`expectReplyEnd`). The time limit of a call, with
//   code that never ends, is a case of js-eval.e2e.ts.
// - A result names the work folder of its run as `/work`, and holds only
//   the known start of any other path of the computer. The code can read
//   these paths, and each text of a run goes to the provider. This covers
//   a path as the code got it: code that changes the text of a path (a
//   reversed text, base64) gets it out, a known limit.
// No request holds the private text of the seeded files, or a path of the
// test HOME (`takeRequest` checks each one), and no seeded file changes.
//
// The same escapes with every permission of Deno on, and with native code,
// are Rust tests (`mod runs` in src-tauri/src/bundled_tools.rs): there only
// the OS rule holds, and no page code can widen the flags of a run.
//
// One app session serves the whole file; each test starts in a new tab.

const CALLER: MockProvider = { id: 'caller', name: 'Caller Mock', modelId: 'caller-model', modelName: 'Caller Model' }
const CHAT_PATH = mockChatPath(CALLER)

// The text of each seeded file that the code of a call must not get. No
// code of a call holds it, so it is in a request only when a run read a
// file.
const PRIVATE = 'private text of the audit'

// One try of the code of a call: its name, the source of a function that
// does the try, and the outcome that the call must give for it.
type Probe = readonly [name: string, source: string, outcome: string]

// The code of a call that runs `probes` in their order and returns one line
// for each: its name, then `ok: ` and the value that its function gave, or
// the name of the error that it threw and the cause that the error text
// names. The cause is the permission of Deno that the code does not have
// (`Requires read access`) or the refusal of the OS, each without the path
// that follows it: Dez cuts a line of a result at a local path
// (`withoutLocalPaths`), and the refusal of the OS comes after the path.
// The text of any other error goes on to its first `;` or line end.
function probeCode (probes: readonly Probe[]): string {
  return [
    'const outcome = async (probe) => {',
    '  try {',
    '    return `ok: ${Deno.inspect(await probe())}`',
    '  } catch (error) {',
    '    const text = String(error?.message)',
    '    const cause = /^Requires \\w+ access|Permission denied \\(os error \\d+\\)/.exec(text)',
    '    return `${error?.name}: ${cause ? cause[0] : text.split(/[;\\n]/)[0]}`',
    '  }',
    '}',
    // What a stream of Node gives: its first event tells whether the
    // connection or the program started.
    'const firstEvent = (emitter) => new Promise((resolve, reject) => {',
    '  for (const name of ["connect", "response", "spawn"]) emitter.once(name, () => resolve(name))',
    '  emitter.once("error", reject)',
    '})',
    'const lines = []',
    ...probes.map(([name, source]) => `lines.push(${JSON.stringify(`${name}: `)} + await outcome(${source}))`),
    'return lines.join("\\n")',
  ].join('\n')
}

// The lines that the code of `probeCode` must return for `probes`.
function probeLines (probes: readonly Probe[]): string[] {
  return probes.map(([name, , outcome]) => `${name}: ${outcome}`)
}

describe('js_eval sandbox', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser
  // The text of each private file, by its path: no run must read or change
  // one.
  const privateFiles = new Map<string, string>()

  // The next chat request. It holds the results of the calls before it.
  const chatRequest = async (): Promise<HeldRequest> => {
    const request = await takeRequest(setup, CHAT_PATH)
    expect(request.body).not.toContain(PRIVATE)
    return request
  }

  // The path of `file` as the code of a call names it: from the work folder
  // of a run, with no folder of the test HOME in it. The code of a call is
  // in the next request, which must hold no path of the test HOME.
  const fromWorkFolder = (file: string): string => path.relative(path.join(workDir(setup.app.home), 'run'), file)

  // The JavaScript string literal of the path of `file` for the code of a
  // call.
  const literal = (file: string): string => JSON.stringify(fromWorkFolder(file))

  // Notes the text of the private file `file`, and gives `file`.
  function privateFile (file: string): string {
    privateFiles.set(file, fs.readFileSync(file, 'utf8'))
    return file
  }

  // Writes the private file `file` with `text`, and gives `file`.
  async function seedPrivateFile (file: string, text: string): Promise<string> {
    return privateFile(await writeTestFile(file, Buffer.from(text)))
  }

  // Checks that each private file is there with the text that it had.
  function expectPrivateFilesUnchanged (): void {
    for (const [file, text] of privateFiles) expect(fs.readFileSync(file, 'utf8'), file).toBe(text)
  }

  let keys: string
  let appState: string
  let conversation: string
  let homeText: string
  let homeModule: string
  let cached: string
  let asset: string

  beforeAll(async () => {
    setup = await startMockProviderApp(CALLER)
    browser = setup.browser
    const { home } = setup.app
    keys = await seedPrivateFile(appFilePath(home, 'provider_keys.json'), JSON.stringify({ audit: { api_key: PRIVATE } }))
    appState = appFilePath(home, 'app_state.json')
    conversation = privateFile(await seedConversation(home, makeConversation({ id: 'audit', sections: [{ role: 'user', nodes: [{ kind: 'text', text: PRIVATE }] }] })))
    // Files of the user that are in no Dez folder.
    homeText = await seedPrivateFile(path.join(home, 'notes', 'private.txt'), PRIVATE)
    homeModule = await seedPrivateFile(path.join(home, 'notes', 'private.ts'), `export default ${JSON.stringify(PRIVATE)}\n`)
    // Files of the Dez folders that ffmpeg can open, and Deno cannot.
    cached = await seedPrivateFile(path.join(mediaTempDir(home), 'audit.txt'), PRIVATE)
    asset = await seedPrivateFile(appFilePath(home, 'assets', 'images', 'audit.txt'), PRIVATE)
  })

  beforeEach(async () => {
    await newTab(browser)
    await resetConsoleErrors(browser)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    await setup.mock.dropOpenReplies(browser)
  })

  afterAll(async () => {
    await setup?.stop()
  })

  it('refuses each thing of the computer that the code asks Deno for', async () => {
    const file = literal(keys)
    const home = literal(setup.app.home)
    // The mock server of the spec: a real server that would answer.
    const { port } = new URL(setup.mock.url)
    const refusedRead = 'NotCapable: Requires read access'
    const refusedWrite = 'NotCapable: Requires write access'
    const refusedNet = 'NotCapable: Requires net access'
    const refusedEnv = 'NotCapable: Requires env access'
    const refusedSys = 'NotCapable: Requires sys access'
    const refusedRun = 'NotCapable: Requires run access'
    const probes: Probe[] = [
      // Files, also the ones of the work folder of the run.
      ['read a file', `() => Deno.readTextFile(${file})`, refusedRead],
      ['read a file with Node', `async () => (await import("node:fs")).readFileSync(${file}, "utf8")`, refusedRead],
      ['open a file', `() => Deno.open(${file})`, refusedRead],
      ['the facts of a file', `() => Deno.stat(${file})`, refusedRead],
      ['fetch a file', `() => fetch(new URL(${file}, import.meta.url))`, refusedRead],
      // Deno reads the code of an `import` only when its path is a text of
      // the code, so it asks for this one.
      ['import a file by a path that the code makes', `() => import([${file}].join(""))`, 'TypeError: Requires read access'],
      ['list the home folder', `() => Array.fromAsync(Deno.readDir(${home}))`, refusedRead],
      ['list the work folder', '() => Array.fromAsync(Deno.readDir("."))', refusedRead],
      ['go to another folder', `async () => Deno.chdir(${home})`, refusedRead],
      ['write a file', `() => Deno.writeTextFile(${file}, "changed")`, refusedWrite],
      ['write a file of the work folder', '() => Deno.writeTextFile("note.txt", "text")', refusedWrite],
      ['make a folder', '() => Deno.mkdir("made")', refusedWrite],
      ['make a temp file', '() => Deno.makeTempFile()', refusedWrite],
      ['delete a file', `() => Deno.remove(${file})`, refusedWrite],
      ['move a file', `() => Deno.rename(${file}, "keys.json")`, refusedRead],
      ['link to a file', `() => Deno.link(${file}, "keys.json")`, refusedRead],
      ['make a symbolic link', `() => Deno.symlink(${file}, "keys.json")`, 'NotCapable: Deno.symlink() requires unscoped --allow-read and --allow-write permissions'],
      // The network.
      ['fetch', `() => fetch("http://127.0.0.1:${port}/")`, refusedNet],
      ['connect', `() => Deno.connect({ hostname: "127.0.0.1", port: ${port} })`, refusedNet],
      ['connect with Node', `async () => firstEvent((await import("node:net")).connect(${port}, "127.0.0.1"))`, refusedNet],
      ['a request with Node', `async () => firstEvent((await import("node:http")).get("http://127.0.0.1:${port}/"))`, refusedNet],
      ['a WebSocket', `async () => new WebSocket("ws://127.0.0.1:${port}/")`, refusedNet],
      ['a socket of the computer', '() => Deno.connect({ transport: "unix", path: "/run/dbus/system_bus_socket" })', refusedRead],
      ['listen', 'async () => Deno.listen({ port: 0 })', refusedNet],
      ['serve', 'async () => Deno.serve({ port: 0 }, () => new Response("text"))', refusedNet],
      // The name server is given, so that Deno does not read the name
      // servers of the computer first.
      ['a host name', `() => Deno.resolveDns("example.com", "A", { nameServer: { ipAddr: "127.0.0.1", port: ${port} } })`, refusedNet],
      ['code from the network', `() => import("http://127.0.0.1:${port}/code.js")`, 'TypeError: Requires import access'],
      // The environment and the facts of the system.
      ['a variable', 'async () => Deno.env.get("HOME")', refusedEnv],
      ['all variables', 'async () => Deno.env.toObject()', refusedEnv],
      ['a variable with Node', 'async () => process.env.HOME', refusedEnv],
      ['the host name', 'async () => Deno.hostname()', refusedSys],
      ['the version of the system', 'async () => Deno.osRelease()', refusedSys],
      ['the network interfaces', 'async () => Deno.networkInterfaces()', refusedSys],
      ['the memory of the computer', 'async () => Deno.systemMemoryInfo()', refusedSys],
      ['the load of the computer', 'async () => Deno.loadavg()', refusedSys],
      ['the user id', 'async () => Deno.uid()', refusedSys],
      ['the user with Node', 'async () => (await import("node:os")).userInfo()', refusedSys],
      ['the home folder with Node', 'async () => (await import("node:os")).homedir()', refusedSys],
      // Programs and native code. `eval` of Deno has every permission of
      // Deno.
      ['a program', '() => new Deno.Command("/bin/sh", { args: ["-c", "id"] }).output()', refusedRun],
      ['Deno again', '() => new Deno.Command(Deno.execPath(), { args: ["eval", "1"] }).output()', refusedRun],
      // Node reads the environment for the program first.
      ['a program with Node', 'async () => firstEvent((await import("node:child_process")).spawn("/bin/sh", ["-c", "id"]))', refusedEnv],
      // To Dez, with a signal that a program ignores when it does not ask
      // for it.
      ['a signal', 'async () => Deno.kill(Deno.ppid, "SIGURG")', refusedRun],
      ['a native library', 'async () => Deno.dlopen("libc.so.6", {})', 'NotCapable: Requires ffi access'],
      // `--no-prompt`: a question is a "no".
      ['ask for each permission', 'async () => (await Promise.all(["read", "write", "net", "env", "sys", "run", "ffi"].map((name) => Deno.permissions.request({ name })))).map((status) => status.state).join(" ")', 'ok: "denied denied denied denied denied denied denied"'],
    ]
    // A Worker has its own load of code: Deno asks for the file of one,
    // and tells of the refusal in an event and on the console.
    const workerCode = [
      'return await new Promise((resolve) => {',
      '  const worker = new Worker("file:///etc/passwd", { type: "module" })',
      '  worker.onerror = (event) => { event.preventDefault(); resolve(event.message) }',
      '  worker.onmessage = () => resolve("the worker ran")',
      '})',
    ].join('\n')

    await submit(browser, 'Look around.')
    const first = await chatRequest()
    sendToolCalls(first.reply, [evalCall('call_ask', probeCode(probes)), evalCall('call_worker', workerCode)])

    const second = await chatRequest()
    expect(toolResult(second, 'call_ask').split('\n')).toStrictEqual(probeLines(probes))
    const workerRefusal = 'Requires read access to "/etc/passwd", run again with the --allow-read flag'
    expect(toolResult(second, 'call_worker')).toBe(`${workerRefusal}\n\nConsole output of the code:\nerror: Uncaught (in worker "") ${workerRefusal}`)
    await expectReplyEnd(setup, CALLER, second)
    expectPrivateFilesUnchanged()
    // Each call gave a value: a refusal that the code caught is no failure
    // of the tool.
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('loads no file outside the work folder of a run, where only the OS stops Deno', async () => {
    const refused = 'TypeError: Permission denied (os error 13)'
    const text = '{ with: { type: "text" } }'
    const json = '{ with: { type: "json" } }'
    const probes: Probe[] = [
      ['the keys', `() => import(${literal(keys)}, ${json})`, refused],
      ['the keys as a text', `() => import(${literal(keys)}, ${text})`, refused],
      ['the keys as code', `() => import(${literal(keys)})`, refused],
      // Deno loads a JSON file also by a path that the code makes.
      ['the keys by a path that the code makes', `() => import([${literal(keys)}].join(""), ${json})`, refused],
      ['the app state', `() => import(${literal(appState)}, ${json})`, refused],
      ['a conversation', `() => import(${literal(conversation)}, ${text})`, refused],
      ['a text of the home folder', `() => import(${literal(homeText)}, ${text})`, refused],
      ['code of the home folder', `() => import(${literal(homeModule)})`, refused],
      ['a temp file of Dez', `() => import(${literal(cached)}, ${text})`, refused],
      ['an asset', `() => import(${literal(asset)}, ${text})`, refused],
      ['a file of the system', `() => import("/etc/passwd", ${text})`, refused],
      // Code of the work folder loads, and so does code in a URL.
      ['the module of Dez', '() => import("./runner.js").then(() => "loaded")', 'ok: "loaded"'],
      ['code in a URL', '() => import("data:text/javascript,export default 5").then((module) => module.default)', 'ok: 5'],
    ]

    await submit(browser, 'Read the files.')
    const first = await chatRequest()
    sendToolCalls(first.reply, [
      evalCall('call_import', probeCode(probes)),
      // The whole text of such an error, as Deno gives it.
      evalCall('call_thrown', `return await import("/etc/passwd", ${text})`),
    ])

    const second = await chatRequest()
    expect(toolResult(second, 'call_import').split('\n')).toStrictEqual(probeLines(probes))
    expect(toolResult(second, 'call_thrown')).toBe([
      'The code threw an error:',
      'TypeError: Import \'file:///etc/passwd\' failed.',
      '    0: Permission denied (os error 13)',
      '    at file:///work/code.ts:1:55',
      '    at async default (file:///work/code.ts:1:42)',
    ].join('\n'))
    await expectReplyEnd(setup, CALLER, second)
    expectPrivateFilesUnchanged()
  })

  it('ends code at the limits of a run, and takes no result line from the code', async () => {
    // A line in the form of the result line of Dez's module.
    const fakeLine = 'const fake = new TextEncoder().encode("\\x1e" + JSON.stringify({ type: "result", text: "a made-up value" }) + "\\n")'
    await submit(browser, 'Use it all.')
    const first = await chatRequest()
    sendToolCalls(first.reply, [
      evalCall('call_output', 'const line = "x".repeat(65536)\nfor (;;) console.log(line)'),
      // The heap of JavaScript has a limit, at which Deno ends.
      evalCall('call_heap', 'const all = []\nfor (;;) all.push(new Array(100_000).fill(all.length))'),
      // Typed arrays are not in that heap: the limit of the OS on the
      // memory of the program is their end, and the code goes on after it.
      evalCall('call_arrays', [
        'const arrays = []',
        'try {',
        '  for (;;) arrays.push(new Uint8Array(256 * 1024 * 1024))',
        '} catch (error) {',
        '  return `${arrays.length} arrays, then ${error.name}: ${error.message}`',
        '}',
      ].join('\n')),
      // The last line counts, and that is the line of Dez's module.
      evalCall('call_lines', `${fakeLine}\nfor (let count = 0; count < 1000; count++) Deno.stdout.writeSync(fake)\nthrow new Error("the real end")`),
      // A line counts only with the end that Dez's module gives a run.
      evalCall('call_exit', `${fakeLine}\nDeno.stdout.writeSync(fake)\nDeno.exit(3)`),
    ])

    const second = await chatRequest()
    const output = toolResult(second, 'call_output')
    expect(output.startsWith(
      'The console output has 4,194,304 characters: this result holds only its start and its end, with a line of … between them.\n'
      + 'Dez stopped the code: it wrote more than 4.0 MB of output. Write less to the console, and return only what you need.'
      + '\n\nConsole output of the code:\nxxxx',
    )).toBe(true)
    // A result holds at most 20,000 characters of the console output: the
    // flood does not fill the requests.
    expect(output.length).toBeLessThan(21_000)

    const heap = toolResult(second, 'call_heap')
    expect(heap.startsWith(
      'The system ended the code before it returned a value. The usual cause: the code used more memory than a run can have. '
      + 'Use less memory (smaller arrays and strings, or the work in parts), and call again.\n\nConsole output of the code:\n',
    )).toBe(true)
    expect(heap).toContain('Fatal JavaScript out of memory')

    // The limit of the OS is 2 GiB, and Deno needs a part of it for itself.
    const arrays = /^(\d+) arrays, then RangeError: Array buffer allocation failed$/.exec(toolResult(second, 'call_arrays'))
    expect(Number(arrays?.[1])).toBeGreaterThan(0)
    expect(Number(arrays?.[1])).toBeLessThan(8)

    expect(toolResult(second, 'call_lines')).toBe('The code threw an error:\nError: the real end\n    at default (file:///work/code.ts:3:7)')
    expect(toolResult(second, 'call_exit')).toBe(
      'The code ended before it returned a value (exit code 3). The usual causes: an error in a timer or in a promise that the code did not await, '
      + 'an `await` of a promise that never settles, or a call of `Deno.exit`. The code wrote nothing to the console.',
    )
    await expectReplyEnd(setup, CALLER, second)
  })

  it('names the work folder of a run as /work, and cuts each other path of the computer at its known start', async () => {
    // The Deno program is next to the app. The code can read its path, and
    // Dez knows no folder of it: a result names it as the rule of the known
    // starts of a local path leaves it (`/home/…`), so a program in a folder
    // that the rule does not know (`/usr/…`) shows whole.
    const program = withoutLocalPaths(path.join(path.dirname(setup.app.binary), 'dez-deno'))
    await submit(browser, 'Where are you?')
    const first = await chatRequest()
    sendToolCalls(first.reply, [
      evalCall('call_places', [
        'return [',
        '  Deno.execPath(), process.execPath, ...process.argv, Deno.mainModule,',
        '  import.meta.url, import.meta.filename, import.meta.dirname, Deno.cwd(), process.cwd(),',
        '].join("\\n")',
      ].join('\n')),
      evalCall('call_thrown', 'console.log(Deno.cwd())\nthrow new Error(`in ${import.meta.dirname}`, { cause: Deno.mainModule })'),
      // A path of the test HOME outside the work folder: `takeRequest`
      // fails for a result that holds it whole.
      evalCall('call_outside', `return [import.meta.resolve(${literal(keys)}), new URL(${literal(keys)}, import.meta.url).pathname].join("\\n")`),
    ])

    const second = await chatRequest()
    expect(toolResult(second, 'call_places').split('\n')).toStrictEqual([
      program, program, program, '/work/runner.js', 'file:///work/runner.js',
      'file:///work/code.ts', '/work/code.ts', '/work', '/work', '/work',
    ])
    expect(toolResult(second, 'call_thrown')).toBe(
      'The code threw an error:\nError: in /work\n    at default (file:///work/code.ts:2:7)\nCaused by: "file:///work/runner.js"\n\nConsole output of the code:\n/work',
    )
    expect(toolResult(second, 'call_outside').split('\n')).toStrictEqual([withoutLocalPaths(pathToFileURL(keys).href), withoutLocalPaths(keys)])
    await expectReplyEnd(setup, CALLER, second)
  })
})
