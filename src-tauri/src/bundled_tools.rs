//! Runs a program that Dez ships next to its own program (`BUNDLED_TOOLS`),
//! for the Dez tools of the frontend. This module knows nothing of the
//! options of a program: the caller gives the arguments, and gets the output
//! and the end of the run.
//!
//! The rules of a run, which no caller can change:
//! - Only a bundled program runs, never a program of the computer.
//! - It runs in a work folder of the cache root, with copies of its input
//!   files (`prepare_work_folder`), an empty environment, and no input.
//! - It ends at its time limit, at its output cap, at a cancel
//!   (`cancel_bundled_tool`), and when the app quits (`stop_all_runs`).

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Channel;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::{Notify, watch};

use crate::persistence::{FileRoot, app_file_path, is_app_file_segment};

// The programs that a run can name: the `bundle.externalBin` programs of
// tauri.conf.json, under the names that the bundle gives them (a test keeps
// the two lists the same).
const BUNDLED_TOOLS: [&str; 2] = ["dez-ffmpeg", "dez-ffprobe"];

// How long a quit of the app waits for the runs to end (`stop_all_runs`).
const EXIT_WAIT: Duration = Duration::from_secs(2);

// The size of one read of a program's output, which is also the largest
// output event.
const OUTPUT_PIECE_BYTES: usize = 16 * 1024;

// One run, as the frontend asks for it (`BundledToolRun` in nativeTypes.ts).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRun {
    // A name of `BUNDLED_TOOLS`.
    pub tool: String,
    pub args: Vec<String>,
    // The work folder, as a path in the cache root. The command has no root
    // parameter, so a program can never run in the app folder.
    pub folder: String,
    pub inputs: Vec<ToolInput>,
    // The time limit of the program's run. The input copies do not count.
    pub timeout_ms: u64,
    // The most bytes of output (stdout and stderr together) that the run
    // passes on. A program that writes more is ended.
    pub max_output_bytes: u64,
}

// A file that the work folder gets before the program starts.
#[derive(Debug, Clone, Deserialize)]
pub struct ToolInput {
    // The file name of the copy in the work folder.
    pub name: String,
    // The absolute path of the file to copy.
    pub source: String,
}

// What a run sends to the page (`BundledToolEvent` in nativeTypes.ts):
// `{ kind: 'output', data: { stream, text } }`, then one
// `{ kind: 'end', data: { kind, … } }` as the last event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
pub enum ToolRunEvent {
    // A piece of the program's output, in the order of its stream. A piece
    // is not a line: it ends where a read ended, but never inside a
    // character. The page splits lines, so `\r` and `\n` both reach it.
    Output { stream: OutputStream, text: String },
    End(ToolRunEnd),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputStream {
    Stdout,
    Stderr,
}

// How a run ended. Only `Exited` is an end that the program chose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ToolRunEnd {
    // `code` is `None` when a signal that Dez did not send ended the program.
    Exited { code: Option<i32> },
    TimedOut,
    Cancelled,
    OutputTooLarge,
}

// A run with its paths resolved: the program can be any file here, so the
// tests can run small system programs.
pub(crate) struct ProgramRun {
    program: PathBuf,
    args: Vec<String>,
    folder: PathBuf,
    inputs: Vec<ToolInput>,
    timeout: Duration,
    max_output_bytes: u64,
}

// The folder of the bundled programs: the folder of the Dez program in every
// build (tauri-build copies them there for a debug build, and the bundle
// puts them there: `usr/bin/` of an AppImage, `Contents/MacOS/` of a macOS
// app). `current_exe` can be a link to the program (macOS, when Dez starts
// through one), so the path is made canonical. On Linux it names a file that
// is gone after a rebuild while Dez runs (`… (deleted)`), which has no
// canonical path: then the path stays as it is, and its folder is still the
// right one.
fn tools_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|error| format!("Failed to find the Dez program: {}", error))?;
    let exe = std::fs::canonicalize(&exe).unwrap_or(exe);
    exe.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "The Dez program has no folder".to_string())
}

// The path of a bundled program. Any other name is refused, so the page can
// never start a program of the computer.
fn tool_path(dir: &Path, tool: &str) -> Result<PathBuf, String> {
    if !BUNDLED_TOOLS.contains(&tool) {
        return Err(format!("Not a bundled tool: {}", tool));
    }
    let path = dir.join(tool);
    if !path.is_file() {
        return Err(format!("The bundled tool {} is missing", tool));
    }
    Ok(path)
}

// Makes the work folder and puts the input files into it. The folder can be
// there already: a caller runs more than one program in one folder (a probe
// of the inputs, then the work), and a download can write into it first.
fn prepare_work_folder(folder: &Path, inputs: &[ToolInput]) -> Result<(), String> {
    make_private_folder(folder).map_err(|error| format!("Failed to make the work folder: {}", error))?;
    inputs.iter().try_for_each(|input| copy_input(folder, input))
}

// A work folder holds copies of the user's files and what a program makes
// from them, so only the user can open it. The mode is set again after the
// create: a folder that was there can have another mode (`ensure_dir` of
// persistence.rs makes folders with the default one).
fn make_private_folder(folder: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(folder)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(folder, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

// Puts one input file into the work folder, as a copy. Never a symlink or a
// hard link: a program that writes to its input would then change the
// user's file. `std::fs::copy` clones the file where the file system can
// (APFS, Linux file systems with reflinks), so the copy is cheap there.
//
// The name is one path segment of the app-file rule, so the copy cannot
// leave the folder. A name that the folder already has is refused: the copy
// would replace a file of an earlier run, or write through a link that a
// program left there. The error texts name the copy, never the source path.
fn copy_input(folder: &Path, input: &ToolInput) -> Result<(), String> {
    let name = &input.name;
    if !is_app_file_segment(name) {
        return Err(format!("Invalid input file name: {}", name));
    }
    let source = Path::new(&input.source);
    if !source.is_absolute() {
        return Err(format!("The source of the input file {} is not an absolute path", name));
    }
    // `metadata` follows a link, so a link to a file is an input like a file.
    let is_file = std::fs::metadata(source)
        .map(|metadata| metadata.is_file())
        .map_err(|error| format!("Failed to read the source of the input file {}: {}", name, error))?;
    if !is_file {
        return Err(format!("The source of the input file {} is not a file", name));
    }
    let target = folder.join(name);
    // `symlink_metadata` also sees a link that names no file.
    if std::fs::symlink_metadata(&target).is_ok() {
        return Err(format!("The work folder already has a file named {}", name));
    }
    std::fs::copy(source, &target)
        .map(|_| ())
        .map_err(|error| format!("Failed to copy the input file {}: {}", name, error))
}

// The output bytes that a run can still pass on, for its two streams
// together. Both streams are read in one task, so there is no race; the
// atomic is here because the run's future must be `Send`, which a `Cell`
// behind a shared reference is not.
struct OutputBudget(AtomicU64);

impl OutputBudget {
    // Takes up to `wanted` bytes from the budget and returns how many it
    // gave.
    fn take(&self, wanted: usize) -> usize {
        let wanted = wanted as u64;
        let left = self.0.update(Ordering::Relaxed, Ordering::Relaxed, |left| left.saturating_sub(wanted));
        // At most `wanted`, which came from a `usize`.
        left.min(wanted) as usize
    }
}

// Makes text from the bytes of one output stream, piece by piece. A read
// can end inside a UTF-8 character: those bytes wait for the next piece, so
// no piece shows a broken character. Bytes that are no UTF-8 at all become
// U+FFFD, as a program can write any bytes (a file name, a binary stream).
#[derive(Default)]
struct TextDecoder {
    // The start of a character that the last piece cut: at most 3 bytes.
    cut: Vec<u8>,
}

impl TextDecoder {
    fn decode(&mut self, bytes: &[u8]) -> String {
        if !self.cut.is_empty() {
            // Rare: join the cut character with its other bytes. `cut` is
            // empty for the second call, so this goes one level deep.
            let mut joined = std::mem::take(&mut self.cut);
            joined.extend_from_slice(bytes);
            return self.decode(&joined);
        }
        let whole = whole_characters_len(bytes);
        self.cut.extend_from_slice(&bytes[whole..]);
        String::from_utf8_lossy(&bytes[..whole]).into_owned()
    }

    // The text of the bytes that still wait, at the end of the stream: a
    // character that never got its other bytes.
    fn finish(&mut self) -> String {
        let text = String::from_utf8_lossy(&self.cut).into_owned();
        self.cut.clear();
        text
    }
}

// The length of the start of `bytes` that does not end inside a UTF-8
// character. Invalid bytes count as whole: only a character that more bytes
// can still complete (`error_len() == None`) is left out.
fn whole_characters_len(bytes: &[u8]) -> usize {
    let mut checked = 0;
    loop {
        match std::str::from_utf8(&bytes[checked..]) {
            Ok(_) => return bytes.len(),
            Err(error) => match error.error_len() {
                None => return checked + error.valid_up_to(),
                Some(invalid) => checked += error.valid_up_to() + invalid,
            },
        }
    }
}

// The output went over the cap of its run.
struct OutputSpent;

// Passes the output of one pipe on as text, until the pipe ends (the
// program closed it or ended) or the budget is spent. The budget counts the
// bytes that the program wrote, not the bytes of the text. A read error ends
// the output like the end of the pipe: the exit of the program tells the
// rest.
async fn pass_output(
    mut pipe: impl AsyncRead + Unpin,
    stream: OutputStream,
    budget: &OutputBudget,
    send: &(impl Fn(ToolRunEvent) + Sync),
) -> Result<(), OutputSpent> {
    let send_text = |text: String| {
        if !text.is_empty() {
            send(ToolRunEvent::Output { stream, text });
        }
    };
    let mut decoder = TextDecoder::default();
    let mut buffer = vec![0_u8; OUTPUT_PIECE_BYTES];
    let result = loop {
        let read = match pipe.read(&mut buffer).await {
            Ok(0) | Err(_) => break Ok(()),
            Ok(read) => read,
        };
        let allowed = budget.take(read);
        send_text(decoder.decode(&buffer[..allowed]));
        if allowed < read {
            break Err(OutputSpent);
        }
    };
    send_text(decoder.finish());
    result
}

// Waits for the stop of a run (a cancel, or the quit of the app). A sender
// that is gone can stop nothing, so the wait then never ends. The wait is a
// function of its own so that the `Ref` of `wait_for`, which is not `Send`,
// is dropped in here.
async fn until_stopped(stopped: &mut watch::Receiver<bool>) {
    if stopped.wait_for(|stopped| *stopped).await.is_err() {
        std::future::pending::<()>().await;
    }
}

// Starts the program in its work folder and waits for its end.
// - `env_clear`: the program gets no variable of Dez's environment (API
//   keys can be there), and no `PATH`.
// - `Stdio::null()`: a program that reads its input (ffmpeg reads keys)
//   gets the end of the input at once.
// - `kill_on_drop`: a run whose future is dropped leaves no program.
async fn run_program(
    run: &ProgramRun,
    stopped: &mut watch::Receiver<bool>,
    send: &(impl Fn(ToolRunEvent) + Sync),
) -> Result<ToolRunEnd, String> {
    let mut child = tokio::process::Command::new(&run.program)
        .args(&run.args)
        .current_dir(&run.folder)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("Failed to start the program: {}", error))?;
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        return Err("The program has no output pipes".to_string());
    };
    let budget = OutputBudget(AtomicU64::new(run.max_output_bytes));

    let end = {
        // `try_join!` ends at the first stream that goes over the cap, so the
        // cap needs no signal between the two readers.
        let output = async {
            tokio::try_join!(
                pass_output(stdout, OutputStream::Stdout, &budget, send),
                pass_output(stderr, OutputStream::Stderr, &budget, send),
            )
        };
        // The exit comes after the end of both pipes, so the end event is
        // the last event and no output is lost. `None`: over the cap.
        let exit = async {
            match output.await {
                Ok(_) => Some(child.wait().await),
                Err(OutputSpent) => None,
            }
        };
        tokio::select! {
            // A stop and the time limit win over an exit of the same moment.
            biased;
            () = until_stopped(stopped) => ToolRunEnd::Cancelled,
            () = tokio::time::sleep(run.timeout) => ToolRunEnd::TimedOut,
            exit = exit => match exit {
                None => ToolRunEnd::OutputTooLarge,
                Some(status) => ToolRunEnd::Exited {
                    code: status.map_err(|error| format!("Failed to wait for the program: {}", error))?.code(),
                },
            },
        }
    };

    if !matches!(end, ToolRunEnd::Exited { .. }) {
        // `kill` sends SIGKILL and waits for the exit, so the program is
        // gone, and writes no file any more, when the run ends. An error
        // means that the program has already ended.
        let _ = child.kill().await;
    }
    Ok(end)
}

// The runs that are active, by the run id of the page, each with the sender
// of its stop flag. A managed state of the app.
#[derive(Default)]
pub struct ToolRuns {
    active: Mutex<HashMap<String, watch::Sender<bool>>>,
    // Notified each time that a run leaves `active`.
    ended: Notify,
}

// The place of a run in `ToolRuns::active`. Its drop takes the run out, on
// every way out of `ToolRuns::run`.
struct ActiveRun<'a> {
    runs: &'a ToolRuns,
    run_id: &'a str,
}

impl Drop for ActiveRun<'_> {
    fn drop(&mut self) {
        self.runs.lock().remove(self.run_id);
        self.runs.ended.notify_waiters();
    }
}

impl ToolRuns {
    // The lock is never held over code that can panic, but a poisoned lock
    // must not stop every later run: the map is whole after each change.
    fn lock(&self) -> MutexGuard<'_, HashMap<String, watch::Sender<bool>>> {
        self.active.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    // Adds a run. An id that is active is refused: a cancel could not tell
    // the two runs apart.
    fn register<'a>(&'a self, run_id: &'a str) -> Result<(ActiveRun<'a>, watch::Receiver<bool>), String> {
        let (stop, stopped) = watch::channel(false);
        match self.lock().entry(run_id.to_string()) {
            Entry::Occupied(_) => Err(format!("A run with the id {} is active", run_id)),
            Entry::Vacant(entry) => {
                entry.insert(stop);
                Ok((ActiveRun { runs: self, run_id }, stopped))
            }
        }
    }

    // Stops a run. The flag stays set, so a cancel that comes while the
    // input files are copied is not lost. An id that is not active (the run
    // ended, or its command has not come yet) does nothing.
    pub(crate) fn cancel(&self, run_id: &str) {
        if let Some(stop) = self.lock().get(run_id) {
            stop.send_replace(true);
        }
    }

    // Stops every run and waits until each one ended, so that no program is
    // left. The wait for `ended` starts before the look at the list: a run
    // that ends between the look and the wait is then not missed.
    pub(crate) async fn stop_all(&self) {
        loop {
            let ended = self.ended.notified();
            tokio::pin!(ended);
            ended.as_mut().enable();
            {
                let active = self.lock();
                if active.is_empty() {
                    return;
                }
                for stop in active.values() {
                    stop.send_replace(true);
                }
            }
            ended.await;
        }
    }

    // One run from its start to its end event. An `Err` is a run that did
    // not start or whose end is not known, and it sends no end event.
    pub(crate) async fn run(
        &self,
        run_id: &str,
        mut run: ProgramRun,
        send: impl Fn(ToolRunEvent) + Send + Sync,
    ) -> Result<(), String> {
        let (_active, mut stopped) = self.register(run_id)?;
        // File copies block, so they run off the async threads.
        let (folder, inputs) = (run.folder.clone(), std::mem::take(&mut run.inputs));
        tokio::task::spawn_blocking(move || prepare_work_folder(&folder, &inputs))
            .await
            .map_err(|error| format!("Failed to prepare the work folder: {}", error))??;
        // A copy cannot stop in its middle, so a cancel that came during the
        // copies ends the run here, before the program starts.
        let cancelled = *stopped.borrow();
        let end = if cancelled {
            ToolRunEnd::Cancelled
        } else {
            run_program(&run, &mut stopped, &send).await?
        };
        send(ToolRunEvent::End(end));
        Ok(())
    }
}

// Runs one bundled tool to its end. The output and the end come as events
// on the channel, not as the result of the command: Tauri sends a channel
// message and a command result on different paths, so a result could reach
// the page before the last output (`stream_http` in http_bridge.rs has the
// same rule). `Ok` tells only that every event is sent. An `Err` is a run
// that did not start (a name that is no bundled tool, a bad folder path or
// input file, a run id that is active) or whose end is not known.
#[tauri::command]
pub async fn run_bundled_tool(
    run: ToolRun,
    run_id: String,
    on_event: Channel<ToolRunEvent>,
    runs: State<'_, ToolRuns>,
) -> Result<(), String> {
    let run = ProgramRun {
        program: tool_path(&tools_dir()?, &run.tool)?,
        args: run.args,
        folder: app_file_path(FileRoot::Cache, &run.folder)?,
        inputs: run.inputs,
        timeout: Duration::from_millis(run.timeout_ms),
        max_output_bytes: run.max_output_bytes,
    };
    runs.run(&run_id, run, |event| {
        // A send fails only when the page is gone, and then nobody waits
        // for the event.
        let _ = on_event.send(event);
    })
    .await
}

// Stops the run with this id (`ToolRuns::cancel`). The run then ends with
// `ToolRunEnd::Cancelled`, on its own channel.
#[tauri::command]
pub async fn cancel_bundled_tool(run_id: String, runs: State<'_, ToolRuns>) -> Result<(), String> {
    runs.cancel(&run_id);
    Ok(())
}

// Ends every run when the app quits. The event loop ends the process with
// `process::exit`, which drops no task, so `kill_on_drop` does nothing then,
// and a program that is in the middle of its work would go on with no app
// (ffmpeg does not end when its output pipes close). The wait has a limit,
// so that a program that cannot be ended does not hold the quit.
// A crash or a kill of Dez still leaves its programs: each one then runs to
// its own end.
pub fn stop_all_runs(app: &tauri::AppHandle) {
    use tauri::Manager;
    let runs = app.state::<ToolRuns>();
    tauri::async_runtime::block_on(async {
        if tokio::time::timeout(EXIT_WAIT, runs.stop_all()).await.is_err() {
            eprintln!("A bundled tool did not end in time at the quit of the app");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::tests::TempDir;
    use serde_json::json;

    #[test]
    fn the_tool_list_is_the_external_programs_of_the_bundle() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).expect("config is JSON");
        let programs: Vec<&str> = config["bundle"]["externalBin"]
            .as_array()
            .expect("externalBin list")
            .iter()
            .map(|program| program.as_str().expect("program path").trim_start_matches("binaries/"))
            .collect();

        assert_eq!(programs, BUNDLED_TOOLS);
    }

    #[test]
    fn only_a_bundled_program_that_is_there_has_a_path() {
        let dir = TempDir::new("tools-path");
        for name in ["dez-ffmpeg", "sh"] {
            std::fs::write(dir.0.join(name), b"program").expect("write");
        }

        assert_eq!(tool_path(&dir.0, "dez-ffmpeg"), Ok(dir.0.join("dez-ffmpeg")));
        // A bundled name whose program the folder does not have.
        assert!(tool_path(&dir.0, "dez-ffprobe").is_err());
        for name in ["sh", "/bin/sh", "../dez-ffmpeg", "./dez-ffmpeg", "dez-ffmpeg ", "DEZ-FFMPEG", ""] {
            assert!(tool_path(&dir.0, name).is_err(), "{name:?} must be refused");
        }
    }

    // Like a read that ends after each byte of the output.
    #[test]
    fn text_that_is_cut_inside_a_character_comes_out_whole() {
        let text = "é€😀 a";
        let mut decoder = TextDecoder::default();

        let pieces: Vec<String> = text.bytes().map(|byte| decoder.decode(&[byte])).collect();

        assert_eq!(pieces.concat(), text);
        assert!(pieces.iter().all(|piece| !piece.contains('\u{FFFD}')), "{pieces:?}");
        assert_eq!(decoder.finish(), "");
    }

    #[test]
    fn bytes_that_are_no_text_become_replacement_characters() {
        let mut decoder = TextDecoder::default();

        assert_eq!(decoder.decode(b"a\xFFb\xC3"), "a\u{FFFD}b");
        // The start of a character, and then a byte that cannot go on it.
        assert_eq!(decoder.decode(b"(c"), "\u{FFFD}(c");
        // The stream ends inside a character.
        assert_eq!(decoder.decode(b"d\xE2\x82"), "d");
        assert_eq!(decoder.finish(), "\u{FFFD}");
        assert_eq!(decoder.finish(), "");
    }

    // The names are mapped by hand on both sides (nativeTypes.ts).
    #[test]
    fn a_run_and_its_events_have_the_json_names_of_the_page() {
        let run: ToolRun = serde_json::from_value(json!({
            "tool": "dez-ffprobe",
            "args": ["-i", "in.mp4"],
            "folder": "work/a",
            "inputs": [{ "name": "in.mp4", "source": "/home/ann/clip.mp4" }],
            "timeoutMs": 5000,
            "maxOutputBytes": 1024,
        }))
        .expect("run");
        assert_eq!((run.timeout_ms, run.max_output_bytes), (5000, 1024));
        assert_eq!((run.inputs[0].name.as_str(), run.inputs[0].source.as_str()), ("in.mp4", "/home/ann/clip.mp4"));

        let event_json = |event: ToolRunEvent| serde_json::to_value(event).expect("event JSON");
        assert_eq!(
            event_json(ToolRunEvent::Output { stream: OutputStream::Stderr, text: "frame=1\r".to_string() }),
            json!({ "kind": "output", "data": { "stream": "stderr", "text": "frame=1\r" } }),
        );
        assert_eq!(
            event_json(ToolRunEvent::Output { stream: OutputStream::Stdout, text: "{}".to_string() }),
            json!({ "kind": "output", "data": { "stream": "stdout", "text": "{}" } }),
        );
        let ends = [
            (ToolRunEnd::Exited { code: Some(1) }, json!({ "kind": "exited", "code": 1 })),
            (ToolRunEnd::Exited { code: None }, json!({ "kind": "exited", "code": null })),
            (ToolRunEnd::TimedOut, json!({ "kind": "timedOut" })),
            (ToolRunEnd::Cancelled, json!({ "kind": "cancelled" })),
            (ToolRunEnd::OutputTooLarge, json!({ "kind": "outputTooLarge" })),
        ];
        for (end, data) in ends {
            assert_eq!(event_json(ToolRunEvent::End(end)), json!({ "kind": "end", "data": data }));
        }
    }

    // The work folder and the runs, with small programs of the system in
    // place of the bundled ones (and one test with those).
    #[cfg(unix)]
    mod runs {
        use super::*;
        use crate::persistence::tests::mode_of;
        use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
        use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

        // A program that tells that it runs, with its process id in the
        // file `pid`, and then does not end by itself. `exec` keeps the id.
        const ENDLESS: &str = "echo $$ > pid; echo started; exec /bin/sleep 60";

        // What a run sent.
        #[derive(Debug, Default, PartialEq)]
        struct Sent {
            stdout: String,
            stderr: String,
            ends: Vec<ToolRunEnd>,
            // An event came after the end event.
            event_after_end: bool,
        }

        fn exited(code: i32) -> Vec<ToolRunEnd> {
            vec![ToolRunEnd::Exited { code: Some(code) }]
        }

        fn input(name: &str, source: &Path) -> ToolInput {
            ToolInput { name: name.to_string(), source: source.to_str().expect("UTF-8 path").to_string() }
        }

        // The environment of a run is empty, so the tests name each program
        // by its path.
        fn program_run(program: &str, args: &[&str], folder: &Path) -> ProgramRun {
            ProgramRun {
                program: PathBuf::from(program),
                args: args.iter().map(|arg| arg.to_string()).collect(),
                folder: folder.to_path_buf(),
                inputs: Vec::new(),
                timeout: Duration::from_secs(30),
                max_output_bytes: 1024 * 1024,
            }
        }

        fn script(text: &str, folder: &Path) -> ProgramRun {
            program_run("/bin/sh", &["-c", text], folder)
        }

        // The `send` of a run, and the events that it sends.
        fn event_channel() -> (impl Fn(ToolRunEvent) + Send + Sync, UnboundedReceiver<ToolRunEvent>) {
            let (sender, receiver) = unbounded_channel();
            let send = move |event| {
                let _ = sender.send(event);
            };
            (send, receiver)
        }

        // The events of a run that ended: the run dropped its `send`, so the
        // channel ends after the last event.
        async fn sent(mut events: UnboundedReceiver<ToolRunEvent>) -> Sent {
            let mut sent = Sent::default();
            while let Some(event) = events.recv().await {
                sent.event_after_end |= !sent.ends.is_empty();
                match event {
                    ToolRunEvent::Output { stream: OutputStream::Stdout, text } => sent.stdout.push_str(&text),
                    ToolRunEvent::Output { stream: OutputStream::Stderr, text } => sent.stderr.push_str(&text),
                    ToolRunEvent::End(end) => sent.ends.push(end),
                }
            }
            sent
        }

        // One run from its start to its end.
        async fn finished(run: ProgramRun) -> Sent {
            let (send, events) = event_channel();
            assert_eq!(ToolRuns::default().run("run", run, send).await, Ok(()));
            sent(events).await
        }

        // Waits until a run wrote `wanted`.
        async fn wait_for_output(events: &mut UnboundedReceiver<ToolRunEvent>, wanted: &str) {
            let mut output = String::new();
            while !output.contains(wanted) {
                match events.recv().await {
                    Some(ToolRunEvent::Output { text, .. }) => output.push_str(&text),
                    other => panic!("the run ended before it wrote {wanted:?}: {other:?}"),
                }
            }
        }

        // Whether the program of an `ENDLESS` run in this folder still runs.
        // A program that was ended and waited for has no process any more.
        fn program_is_running(folder: &Path) -> bool {
            let pid = std::fs::read_to_string(folder.join("pid")).expect("pid file");
            std::process::Command::new("/bin/sh")
                .args(["-c", &format!("kill -0 {}", pid.trim())])
                .stderr(Stdio::null())
                .status()
                .expect("run kill")
                .success()
        }

        #[test]
        fn the_work_folder_is_private_also_when_it_was_there() {
            let dir = TempDir::new("tools-folder-mode");
            let new = dir.0.join("work").join("new");
            let old = dir.0.join("work").join("old");

            prepare_work_folder(&new, &[]).expect("prepare");
            assert_eq!(mode_of(&new), 0o700);

            std::fs::create_dir(&old).expect("create folder");
            std::fs::set_permissions(&old, std::fs::Permissions::from_mode(0o755)).expect("chmod");
            prepare_work_folder(&old, &[]).expect("prepare again");
            assert_eq!(mode_of(&old), 0o700);
        }

        // A program can write to its input. That must never reach the file
        // of the user.
        #[test]
        fn an_input_is_a_copy_that_a_write_does_not_take_to_its_source() {
            let dir = TempDir::new("tools-input-copy");
            // A source can be anywhere, under any name.
            let source = dir.0.join("my clip (1).mp4");
            let link = dir.0.join("link.mp4");
            let folder = dir.0.join("work");
            std::fs::write(&source, b"the clip of the user").expect("write");
            symlink(&source, &link).expect("link");

            prepare_work_folder(&folder, &[input("in.mp4", &source), input("linked.mp4", &link)]).expect("prepare");

            for name in ["in.mp4", "linked.mp4"] {
                let copy = folder.join(name);
                let metadata = std::fs::symlink_metadata(&copy).expect("stat");
                assert!(metadata.is_file(), "{name} is not a plain file");
                assert_eq!(metadata.nlink(), 1, "{name} is a hard link");
                assert_eq!(std::fs::read(&copy).expect("read"), b"the clip of the user");
                // A write into the file, as a program does it.
                std::fs::write(&copy, b"changed").expect("write the copy");
            }
            assert_eq!(std::fs::read(&source).expect("read"), b"the clip of the user");
        }

        #[test]
        fn a_bad_input_is_refused_and_writes_no_file() {
            let dir = TempDir::new("tools-input-refused");
            let source = dir.0.join("clip.mp4");
            let folder = dir.0.join("work");
            std::fs::write(&source, b"clip").expect("write");

            for name in ["", ".", "..", "../out.mp4", "a/b.mp4", "/tmp/dez-test-out.mp4", "a b.mp4"] {
                assert!(prepare_work_folder(&folder, &[input(name, &source)]).is_err(), "the name {name:?}");
            }
            let relative = ToolInput { name: "in.mp4".to_string(), source: "clip.mp4".to_string() };
            assert!(prepare_work_folder(&folder, &[relative]).is_err(), "a relative source");
            assert!(prepare_work_folder(&folder, &[input("in.mp4", &dir.0.join("gone.mp4"))]).is_err(), "a missing source");
            assert!(prepare_work_folder(&folder, &[input("in.mp4", &dir.0)]).is_err(), "a folder as the source");
            assert_eq!(std::fs::read_dir(&folder).expect("list").count(), 0);
            assert_eq!(dir.file_names().len(), 2, "a file left the work folder");

            // A name that the folder has: its file stays as it was.
            std::fs::write(folder.join("in.mp4"), b"of an earlier run").expect("write");
            assert!(prepare_work_folder(&folder, &[input("in.mp4", &source)]).is_err(), "a name of the folder");
            assert_eq!(std::fs::read(folder.join("in.mp4")).expect("read"), b"of an earlier run");
            // Also a link that names no file: a copy would write through it.
            symlink(dir.0.join("outside.mp4"), folder.join("link.mp4")).expect("link");
            assert!(prepare_work_folder(&folder, &[input("link.mp4", &source)]).is_err(), "a link of the folder");
            assert!(!dir.0.join("outside.mp4").exists());
            // And a name that the same call gave before.
            let twice = [input("twice.mp4", &source), input("twice.mp4", &source)];
            assert!(prepare_work_folder(&folder, &twice).is_err(), "a name twice");
        }

        // The page can pass the error on to a model, which must learn no
        // path of the computer.
        #[test]
        fn an_input_error_names_the_copy_and_not_the_path_of_its_source() {
            let dir = TempDir::new("tools-input-error");
            let missing = dir.0.join("private-folder").join("gone.mp4");

            let error = prepare_work_folder(&dir.0.join("work"), &[input("in.mp4", &missing)]).expect_err("refused");

            assert!(error.contains("in.mp4"), "{error}");
            assert!(!error.contains("private-folder") && !error.contains("gone.mp4"), "{error}");
        }

        #[tokio::test]
        async fn a_run_gives_both_outputs_and_the_exit_code() {
            let dir = TempDir::new("tools-run-output");

            let sent = finished(script("echo out; echo err >&2; exit 3", &dir.0.join("work"))).await;

            assert_eq!(sent, Sent { stdout: "out\n".to_string(), stderr: "err\n".to_string(), ends: exited(3), event_after_end: false });
        }

        #[tokio::test]
        async fn a_program_runs_in_its_private_work_folder_with_its_inputs() {
            let dir = TempDir::new("tools-run-folder");
            let source = dir.0.join("source.txt");
            let folder = dir.0.join("work").join("a");
            std::fs::write(&source, b"input text").expect("write");
            let mut run = script("/bin/cat in.txt > out.txt", &folder);
            run.inputs = vec![input("in.txt", &source)];

            let sent = finished(run).await;

            assert_eq!(sent.ends, exited(0), "{}", sent.stderr);
            assert_eq!(std::fs::read(folder.join("out.txt")).expect("read"), b"input text");
            assert_eq!(mode_of(&folder), 0o700);
        }

        // The test program has an environment (`PATH`, `HOME`) and can have
        // an input. A program of a run gets none of them.
        #[tokio::test]
        async fn a_program_gets_no_environment_and_no_input() {
            let dir = TempDir::new("tools-run-empty");
            let nothing = Sent { ends: exited(0), ..Sent::default() };

            // `env` prints each variable that it got.
            assert_eq!(finished(program_run("/usr/bin/env", &[], &dir.0.join("env"))).await, nothing);
            // `cat` with no file reads its input to the end.
            assert_eq!(finished(program_run("/bin/cat", &[], &dir.0.join("cat"))).await, nothing);
        }

        #[tokio::test]
        async fn a_program_that_a_signal_ended_has_no_exit_code() {
            let dir = TempDir::new("tools-run-signal");

            let sent = finished(script("kill -9 $$", &dir.0.join("work"))).await;

            assert_eq!(sent.ends, [ToolRunEnd::Exited { code: None }]);
        }

        #[tokio::test]
        async fn a_program_that_cannot_start_is_an_error_with_no_end_event() {
            let dir = TempDir::new("tools-run-missing");
            let (send, events) = event_channel();

            let result = ToolRuns::default().run("run", program_run("/dez-test/no-such-program", &[], &dir.0.join("work")), send).await;

            assert!(result.is_err());
            assert_eq!(sent(events).await, Sent::default());
        }

        #[tokio::test]
        async fn a_run_ends_at_its_time_limit_and_leaves_no_program() {
            let dir = TempDir::new("tools-run-timeout");
            let folder = dir.0.join("work");
            let mut run = script(ENDLESS, &folder);
            run.timeout = Duration::from_millis(500);
            let start = std::time::Instant::now();

            let sent = finished(run).await;

            assert_eq!(sent.ends, [ToolRunEnd::TimedOut]);
            assert_eq!(sent.stdout, "started\n");
            assert!(!sent.event_after_end);
            assert!(start.elapsed() < Duration::from_secs(20), "{:?}", start.elapsed());
            assert!(!program_is_running(&folder));
        }

        #[tokio::test]
        async fn a_cancel_ends_a_run_and_leaves_no_program() {
            let dir = TempDir::new("tools-run-cancel");
            let folder = dir.0.join("work");
            let runs = ToolRuns::default();
            let (send, mut events) = event_channel();

            let (result, ()) = tokio::join!(runs.run("a", script(ENDLESS, &folder), send), async {
                wait_for_output(&mut events, "started").await;
                assert!(program_is_running(&folder));
                // The cancel of another id leaves this run.
                runs.cancel("b");
                runs.cancel("a");
            });

            assert_eq!(result, Ok(()));
            assert_eq!(sent(events).await.ends, [ToolRunEnd::Cancelled]);
            assert!(!program_is_running(&folder));
            assert!(runs.lock().is_empty());
        }

        #[tokio::test]
        async fn a_cancel_during_the_input_copies_starts_no_program() {
            let dir = TempDir::new("tools-run-early-cancel");
            let source = dir.0.join("source.txt");
            let folder = dir.0.join("work");
            std::fs::write(&source, b"input text").expect("write");
            let runs = ToolRuns::default();
            let (send, events) = event_channel();
            let mut run = script("echo ran > ran.txt", &folder);
            run.inputs = vec![input("in.txt", &source)];

            // `join!` polls the run first: it is in the list and waits for
            // its copies when the cancel comes.
            let (result, ()) = tokio::join!(runs.run("a", run, send), async { runs.cancel("a") });

            assert_eq!(result, Ok(()));
            assert_eq!(sent(events).await, Sent { ends: vec![ToolRunEnd::Cancelled], ..Sent::default() });
            assert!(folder.join("in.txt").is_file());
            assert!(!folder.join("ran.txt").exists());
        }

        #[tokio::test]
        async fn a_run_ends_when_its_output_goes_over_the_cap() {
            let dir = TempDir::new("tools-run-cap");
            let mut run = script("while :; do echo 0123456789abcdef; done", &dir.0.join("work"));
            run.max_output_bytes = 4096;

            let sent = finished(run).await;

            assert_eq!(sent.ends, [ToolRunEnd::OutputTooLarge]);
            // The output up to the cap still comes.
            assert_eq!(sent.stdout.len(), 4096);
            assert!(sent.stdout.starts_with("0123456789abcdef\n0123456789abcdef\n"));
            assert!(!sent.event_after_end);
        }

        // The two streams count against one cap: 8 bytes on each.
        #[tokio::test]
        async fn output_of_exactly_the_cap_is_not_too_large() {
            let dir = TempDir::new("tools-run-at-cap");
            let text = "printf 01234567; printf 89abcdef >&2";
            let mut at_the_cap = script(text, &dir.0.join("at"));
            at_the_cap.max_output_bytes = 16;
            let mut one_byte_over = script(text, &dir.0.join("over"));
            one_byte_over.max_output_bytes = 15;

            let sent = finished(at_the_cap).await;
            assert_eq!(sent, Sent { stdout: "01234567".to_string(), stderr: "89abcdef".to_string(), ends: exited(0), event_after_end: false });

            let sent = finished(one_byte_over).await;
            assert_eq!(sent.ends, [ToolRunEnd::OutputTooLarge]);
            assert_eq!(sent.stdout.len() + sent.stderr.len(), 15);
        }

        #[tokio::test]
        async fn a_second_run_with_an_active_id_is_refused_and_leaves_the_first() {
            let dir = TempDir::new("tools-run-same-id");
            let second_folder = dir.0.join("second");
            let runs = ToolRuns::default();
            let (send, mut events) = event_channel();
            let (second_send, second_events) = event_channel();

            let (first, second) = tokio::join!(runs.run("a", script(ENDLESS, &dir.0.join("first")), send), async {
                wait_for_output(&mut events, "started").await;
                let second = runs.run("a", script("echo ran > ran.txt", &second_folder), second_send).await;
                // The first run is still the run of the id.
                runs.cancel("a");
                second
            });

            assert!(second.is_err());
            assert_eq!(sent(second_events).await, Sent::default());
            assert!(!second_folder.exists());
            assert_eq!(first, Ok(()));
            assert_eq!(sent(events).await.ends, [ToolRunEnd::Cancelled]);

            // The id is free after the end of its run.
            let (send, events) = event_channel();
            assert_eq!(runs.run("a", script("echo ran > ran.txt", &second_folder), send).await, Ok(()));
            assert_eq!(sent(events).await.ends, exited(0));
        }

        // A cancel can come before the run command (or after the end of the
        // run). It must not end a later run of that id.
        #[tokio::test]
        async fn a_cancel_of_an_id_that_is_not_active_does_nothing() {
            let dir = TempDir::new("tools-run-unknown-cancel");
            let runs = ToolRuns::default();
            let (send, events) = event_channel();

            runs.cancel("a");
            let result = runs.run("a", script("echo done", &dir.0.join("work")), send).await;

            assert_eq!(result, Ok(()));
            assert_eq!(sent(events).await, Sent { stdout: "done\n".to_string(), ends: exited(0), ..Sent::default() });
        }

        // The quit of the app.
        #[tokio::test]
        async fn stop_all_ends_every_run_before_it_returns() {
            let dir = TempDir::new("tools-run-stop-all");
            let (folder_a, folder_b) = (dir.0.join("a"), dir.0.join("b"));
            let runs = ToolRuns::default();
            let (send_a, mut events_a) = event_channel();
            let (send_b, mut events_b) = event_channel();

            // With no run, there is nothing to wait for.
            runs.stop_all().await;

            let (a, b, ()) = tokio::join!(
                runs.run("a", script(ENDLESS, &folder_a), send_a),
                runs.run("b", script(ENDLESS, &folder_b), send_b),
                async {
                    wait_for_output(&mut events_a, "started").await;
                    wait_for_output(&mut events_b, "started").await;
                    runs.stop_all().await;
                    assert!(runs.lock().is_empty());
                    assert!(!program_is_running(&folder_a));
                    assert!(!program_is_running(&folder_b));
                },
            );

            assert_eq!((a, b), (Ok(()), Ok(())));
            assert_eq!(sent(events_a).await.ends, [ToolRunEnd::Cancelled]);
            assert_eq!(sent(events_b).await.ends, [ToolRunEnd::Cancelled]);
        }

        // The real programs, as a tool call runs them: ffmpeg makes a file,
        // and ffprobe reads a copy of it as its input. cargo puts the test
        // program into `target/<profile>/deps/`, and the programs that
        // build.rs copied are one folder up.
        #[tokio::test]
        async fn the_bundled_programs_run_and_read_an_input_copy() {
            let dir = TempDir::new("tools-run-bundled");
            let tools = tools_dir().expect("tools folder").parent().expect("the folder above deps").to_path_buf();
            let tool = |name: &str, args: &[&str], folder: &Path| ProgramRun {
                program: tool_path(&tools, name).expect("a bundled program"),
                ..program_run("", args, folder)
            };
            let made = dir.0.join("made");

            let make = ["-hide_banner", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", "tone.wav"];
            let ffmpeg = finished(tool("dez-ffmpeg", &make, &made)).await;

            assert_eq!(ffmpeg.ends, exited(0), "{}", ffmpeg.stderr);
            assert_eq!(ffmpeg.stdout, "");
            assert!(ffmpeg.stderr.contains("tone.wav"), "{}", ffmpeg.stderr);

            let read = ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", "in.wav"];
            let mut probe = tool("dez-ffprobe", &read, &dir.0.join("probe"));
            probe.inputs = vec![input("in.wav", &made.join("tone.wav"))];
            let ffprobe = finished(probe).await;

            assert_eq!(ffprobe, Sent { stdout: "0.200000\n".to_string(), ends: exited(0), ..Sent::default() });
        }
    }
}
