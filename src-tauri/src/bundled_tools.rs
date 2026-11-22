//! Runs a program that Dez ships next to its own program (`BUNDLED_TOOLS`),
//! for the Dez tools of the frontend. This module knows nothing of the
//! work of a tool: the caller gives the arguments, and gets the output and
//! the end of the run. It knows what each program is allowed
//! (`ProgramRules`).
//!
//! The rules of a run, which no caller can change:
//! - Only a bundled program runs, never a program of the computer (on macOS
//!   it starts through `/usr/bin/sandbox-exec`, see confinement.rs).
//! - It runs in a work folder of the cache root, with copies of its input
//!   files (`prepare_work_folder`). Its environment holds only what its
//!   rules name and the time zone of the run. It has no input, or one that
//!   only `write_bundled_tool_input` writes.
//! - The OS keeps it inside its folders (confinement.rs, which also tells
//!   what a computer with no confinement does), with no network:
//!   - ffmpeg and ffprobe: the cache root and the assets folder of the app
//!     folder (`PROGRAM_APP_FOLDER`). They can read and write no file
//!     outside the cache root, and in the assets folder they can read,
//!     make, and change files, but not delete or move them.
//!   - Deno: the work folder of its run; for a run of an app, that one
//!     folder of `APPS_FOLDER` (or of `BUILT_IN_APPS_FOLDER`, only to read)
//!     and the fonts that Dez ships; for a run with a conversation, its
//!     folder of `CONVERSATION_WORK_FOLDERS`; and the libraries that Dez
//!     ships, only to read (`RunPlaces`). Rust builds its command line, and
//!     the page gives only the name of a script and the names of the places
//!     (`DENO_RULES`). It does not run on a computer with no confinement,
//!     and its memory has a limit.
//!
//!   No program can make a symlink, and Dez follows no link of the cache
//!   root or of the folders of `APPS_FOLDER` and `CONVERSATION_WORK_FOLDERS`
//!   (`has_link_below`).
//! - It ends at its time limit, at its output cap, at a cancel
//!   (`cancel_bundled_tool`, also one that came before the run command),
//!   and when the app quits (`stop_all_runs`). The end of a run ends the
//!   programs that it started too (`ProcessGroup`).

use std::collections::hash_map::Entry;
use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Channel;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::ChildStdin;
use tokio::sync::{Notify, mpsc, watch};

use crate::confinement::{Confinement, confined_command};
use crate::persistence::{APPS_FOLDER, CONVERSATION_WORK_FOLDERS, FileRoot, has_link_below, is_app_file_segment, make_private_folder, root_dir};

// The programs that a run can name (`const BUNDLED_TOOLS: &[&str]`): the
// `bundle.externalBin` programs of tauri.conf.json, under the names that
// the bundle gives them. build.rs writes the list from the config, so the
// config is its one place.
include!(concat!(env!("OUT_DIR"), "/bundled_tools.rs"));

// The folder of the app folder whose files ffmpeg and ffprobe can read,
// make, and change, but not delete, move, or link
// (`Confinement::also_writable`): the folder of every stored asset
// (`IMAGE_FOLDERS` in images.ts, `MEDIA_FOLDERS` in mediaTags.ts). Never the
// app folder itself: it holds provider_keys.json, app_state.json, and
// conversations/, and Landlock cannot take a folder back out of an allowed
// one. A constant and not a command parameter, so no page code can widen it.
const PROGRAM_APP_FOLDER: &str = "assets";

// The folder of the cache root that holds the work folders (`WORK_ROOT` in
// src/model/tools/workFolders.ts).
const WORK_ROOT: &str = "work";

// The folders of Tauri's resource dir that Dez ships for the runs of Deno
// (`bundle.resources` of tauri.conf.json): the libraries, which a script
// imports by the names of their import map, the fonts, and the built-in
// apps, one folder for each. They are no Dez folders: the bundle holds
// them, and no run, tool, or file code of Dez changes them.
const LIBS_FOLDER: &str = "libs";
const FONTS_FOLDER: &str = "fonts";
const BUILT_IN_APPS_FOLDER: &str = "builtin-apps";

// The import map of the libraries, in `LIBS_FOLDER`
// (scripts/update-libs.js writes it). Its entries are relative to the map,
// so the map holds in every place of the bundle.
const LIBS_IMPORT_MAP: &str = "import_map.json";

// The folder of the script of skia-canvas in `LIBS_FOLDER`, and its native
// library there (`ToolRun::native_canvas`). The script loads the library
// with a `require`, which reads the files of its folder through Deno.
const CANVAS_SCRIPT_FOLDER: &str = "skia-canvas/lib";
const CANVAS_NATIVE_LIBRARY: &str = "skia.node";

// The variables of the environment that the script of skia-canvas reads
// when it loads. A run has none of them, but a read that Deno does not
// allow is an error, and the script would not load.
const CANVAS_VARIABLES: &[&str] = &["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY", "LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE", "SKIA_CANVAS_STRICT"];

// How long a quit of the app waits for the runs to end (`stop_all_runs`).
const EXIT_WAIT: Duration = Duration::from_secs(2);

// How many cancels of ids with no active run `ToolRuns` keeps, for a run
// whose command comes after its cancel. Such a cancel waits only for the
// moment until its run starts, so a few are enough. Most kept cancels are
// of runs that had ended, and nothing else takes them out.
const KEPT_CANCELS: usize = 16;

// The size of one read of a program's output, which is also the largest
// output event.
const OUTPUT_PIECE_BYTES: usize = 16 * 1024;

// How many texts for the input of a run can wait until the program reads
// them (`ToolRuns::write_input`). A write after that waits for its place,
// so a program that does not read holds its writer, and not memory of Dez.
const INPUT_QUEUE: usize = 16;

// One run, as the frontend asks for it (`BundledToolRun` in nativeTypes.ts).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRun {
    // A name of `BUNDLED_TOOLS`.
    pub tool: String,
    // What the rules of the program make of them (`PageArgs`). The
    // arguments of ffmpeg and ffprobe are not checked here: the caller
    // keeps every path outside the work folder out of them (for a command
    // line of a model, `argumentProblem` in videoTool.ts).
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
    // Whether the program gets an input that stays open, for the texts of
    // `write_bundled_tool_input`. Without it, the program gets the end of
    // its input at once.
    #[serde(default)]
    pub stdin: bool,
    // The name of one folder of `APPS_FOLDER`, which the program can then
    // read and change. Only for a program whose rules take places.
    #[serde(default)]
    pub app_folder: Option<String>,
    // The name of one folder of `BUILT_IN_APPS_FOLDER`, a built-in app,
    // which the program can then only read. Not with `app_folder`.
    #[serde(default)]
    pub built_in_app: Option<String>,
    // The id of a conversation, whose folder of `CONVERSATION_WORK_FOLDERS`
    // the program can then read and change. Rust makes the folder when it
    // is missing.
    #[serde(default)]
    pub conversation_folder: Option<String>,
    // Whether the program can load the native library of skia-canvas. Its
    // code opens files with no check of Deno, so only a run of an app,
    // whose manifest asks for it, gets it: never the code of a model
    // (`js_eval`).
    #[serde(default)]
    pub native_canvas: bool,
    // The name of a time zone (`Europe/Berlin`), which the program gets as
    // `TZ`: its local time is then the one of the user.
    #[serde(default)]
    pub time_zone: Option<String>,
}

// A file that the work folder gets before the program starts.
#[derive(Debug, Clone, Deserialize)]
pub struct ToolInput {
    // The name of the copy in the work folder: a file name, or one subfolder
    // and a file name (`fonts/a.ttf`).
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

// What the page arguments of a run are for a program.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PageArgs {
    // The arguments of the program, after its first ones.
    AsGiven,
    // One file name of the work folder: the script that the program runs.
    // It goes to the program as `./<name>`, so that a name can never be a
    // flag (`--allow-all` passes the name rule).
    Script,
}

// The folder that the OS confines a program to (`Confinement::folder`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConfinedTo {
    // The cache root: every work folder and the temp clips.
    CacheRoot,
    // The work folder of the run, which must be one folder of `WORK_ROOT`.
    WorkFolder,
}

// What Dez allows one bundled program, and how it starts it. The rules are
// constants and not parameters of the command, so no page code can widen
// them.
struct ProgramRules {
    // The arguments that each run starts with.
    first_args: &'static [&'static str],
    page_args: PageArgs,
    // `None`: a run of the program has no place but those of its rules (no
    // app, no conversation, no library that Dez ships). Else the flags
    // that give a run its places (`RunPlaces`).
    place_flags: Option<PlaceFlags>,
    // The variables of the environment of each run.
    env: &'static [(&'static str, &'static str)],
    // A variable that names a folder for the own files of the program, and
    // the name of that folder in the work folder.
    state_folder: Option<(&'static str, &'static str)>,
    confined_to: ConfinedTo,
    // Whether the program can read, make, and change the files of
    // `PROGRAM_APP_FOLDER`.
    assets_writable: bool,
    // The next three are the fields of the same names of `Confinement`.
    system_libraries: bool,
    must_be_confined: bool,
    data_limit: Option<u64>,
}

// The flags of a program that give a run its places (`RunPlaces`). Each
// takes its value after a `=`: one path, or a list of entries with a comma
// between two of them.
struct PlaceFlags {
    // The import map of the libraries that Dez ships, for every run.
    import_map: &'static str,
    // The places that the run can read, and those that it can change.
    read: &'static str,
    write: &'static str,
    // The two flags of a run with the native library of skia-canvas: the
    // file of the library, and the variables that its script reads.
    native_library: &'static str,
    variables: &'static str,
}

// ffmpeg and ffprobe: static programs with no network code, which read and
// write media files. The page builds their command line.
const FFMPEG_RULES: ProgramRules = ProgramRules {
    first_args: &[],
    page_args: PageArgs::AsGiven,
    place_flags: None,
    env: &[],
    state_folder: None,
    confined_to: ConfinedTo::CacheRoot,
    assets_writable: true,
    system_libraries: false,
    must_be_confined: false,
    data_limit: None,
};

// Deno runs code that a model wrote, so it has two guards: the OS rule,
// which holds also when the code breaks out of Deno (a bug of V8), and
// Deno's own permissions.
// - `run`, never `eval`, which has every permission. `--no-prompt`: a
//   refused permission is an error and not a question. `--no-remote` and
//   `--no-npm`: no code from the network. `--no-config` and `--no-lock`: no
//   file of the work folder changes how Deno runs.
// - No `--allow-*` flag but those of the places of a run (`RunPlaces`): no
//   network, no other program, no facts of the system. A run of the code
//   of a model (no app) can read and change only the folder of its
//   conversation, and loads no native library. Deno's file flags do not
//   cover an `import`, which only the OS rule keeps in the folders: each
//   run imports the libraries that Dez ships by the names of their import
//   map, with no read flag.
// - The environment is empty but for these: Deno reads many variables, and
//   one of them (`DENO_PERMISSION_BROKER_PATH`) turns its flags off.
//   `DENO_DIR` is where Deno keeps its caches, and it must be a folder
//   that the run can write.
// - Two memory limits. The heap of V8 (in MB) ends a run whose objects
//   grow without end, with a clear text. It does not count the data of
//   typed arrays and of WebAssembly, which the data limit of the OS
//   covers, on Linux. The data limit counts reserved memory too: Deno
//   needs about 0.4 GB of it to start, and each Worker about 0.3 GB more.
const DENO_RULES: ProgramRules = ProgramRules {
    first_args: &["run", "--no-prompt", "--no-remote", "--no-npm", "--no-config", "--no-lock", "--v8-flags=--max-old-space-size=512"],
    page_args: PageArgs::Script,
    place_flags: Some(PlaceFlags {
        import_map: "--import-map",
        read: "--allow-read",
        write: "--allow-write",
        native_library: "--allow-ffi",
        variables: "--allow-env",
    }),
    env: &[("DENO_NO_UPDATE_CHECK", "1"), ("NO_COLOR", "1")],
    state_folder: Some(("DENO_DIR", "deno-dir")),
    confined_to: ConfinedTo::WorkFolder,
    assets_writable: false,
    system_libraries: true,
    must_be_confined: true,
    data_limit: Some(2 * 1024 * 1024 * 1024),
};

// The rules of a bundled program. A program with no rules does not run.
fn rules_of(tool: &str) -> Option<&'static ProgramRules> {
    match tool {
        "dez-ffmpeg" | "dez-ffprobe" => Some(&FFMPEG_RULES),
        "dez-deno" => Some(&DENO_RULES),
        _ => None,
    }
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
    // The whole environment of the program.
    env: Vec<(String, OsString)>,
    // Whether the input of the program stays open (`ToolRun::stdin`).
    takes_input: bool,
    // The folder below which Dez follows no link when it makes the work
    // folder and copies the inputs (`has_link_below`): the cache root,
    // where ffmpeg can change every file.
    link_root: PathBuf,
    // What the OS lets the program do. Its folder holds `folder`, or is
    // `folder`.
    confinement: Confinement,
}

// The folders that a run of the app is made from.
struct Roots {
    // The folder of the bundled programs.
    tools: PathBuf,
    cache: PathBuf,
    app: PathBuf,
    // Tauri's resource dir, with the folders that Dez ships for the runs
    // (`LIBS_FOLDER`, `FONTS_FOLDER`, `BUILT_IN_APPS_FOLDER`). Its path is
    // the one of Tauri, with no canonical form: the page builds the paths of
    // a run from the same path (`dez.native/resourcePath`), and Deno
    // compares the paths of its flags as text.
    resources: PathBuf,
}

// `PROGRAM_APP_FOLDER` of the app folder `app_dir`, made when it is
// missing: the confinement of a run needs a folder that is there (Landlock
// opens it, Seatbelt resolves it).
fn program_app_folder(app_dir: &Path) -> Result<PathBuf, String> {
    let folder = app_dir.join(PROGRAM_APP_FOLDER);
    std::fs::create_dir_all(&folder).map_err(|error| format!("Failed to make the folder {}: {}", PROGRAM_APP_FOLDER, error))?;
    Ok(folder)
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

// The work folder of a run, from its path in the cache root. A program that
// is confined to its work folder gets one folder of `WORK_ROOT` and nothing
// wider: the cache root or `work` itself would give it the files of the
// other runs. Whether the path goes through a link is a check of
// `prepare_work_folder`.
fn work_folder(cache: &Path, relative: &str, rules: &ProgramRules) -> Result<PathBuf, String> {
    let segments: Vec<&str> = relative.split('/').collect();
    if !segments.iter().all(|segment| is_app_file_segment(segment)) {
        return Err(format!("Invalid work folder path: {}", relative));
    }
    if rules.confined_to == ConfinedTo::WorkFolder && !matches!(segments[..], [WORK_ROOT, _]) {
        return Err(format!("The work folder of this program must be a folder of {}/, and not {}", WORK_ROOT, relative));
    }
    Ok(cache.join(relative))
}

// The folder of an app, from its name in `APPS_FOLDER`. It must be there,
// and as a folder: the program gets every file below it, so a link in its
// place (the user's, as no program can make one) would give the program the
// folder that the link names.
fn app_folder(app_root: &Path, name: &str) -> Result<PathBuf, String> {
    if !is_app_file_segment(name) {
        return Err(format!("Invalid app folder name: {}", name));
    }
    let folder = app_root.join(APPS_FOLDER).join(name);
    if has_link_below(app_root, &folder) {
        return Err(format!("The app folder {} goes through a link", name));
    }
    if !folder.is_dir() {
        return Err(format!("There is no app folder {}", name));
    }
    Ok(folder)
}

// The folder of a built-in app, from its name in `BUILT_IN_APPS_FOLDER` of
// the resource dir. It must be there, as a folder.
fn built_in_app_folder(resources: &Path, name: &str) -> Result<PathBuf, String> {
    if !is_app_file_segment(name) {
        return Err(format!("Invalid built-in app name: {}", name));
    }
    let folder = resources.join(BUILT_IN_APPS_FOLDER).join(name);
    if !folder.is_dir() {
        return Err(format!("There is no built-in app {}", name));
    }
    Ok(folder)
}

// The work folder of a conversation, from its id: one folder of
// `CONVERSATION_WORK_FOLDERS`. The program changes every file below it,
// so a link on its path (the user's, as no program can make one) would
// give the program the folder that the link names. `resolved_run` makes
// the folder when it is missing.
fn conversation_folder(app_root: &Path, id: &str) -> Result<PathBuf, String> {
    if !is_app_file_segment(id) {
        return Err(format!("Invalid conversation id: {}", id));
    }
    let folder = app_root.join(CONVERSATION_WORK_FOLDERS).join(id);
    if has_link_below(app_root, &folder) {
        return Err("The work folder of the conversation goes through a link".to_string());
    }
    Ok(folder)
}

// A folder or file `name` of `folder` that Dez ships, which must be there:
// the OS rule of a run opens each of its places. A missing one is a broken
// install. The error names no path of the computer.
fn shipped(folder: &Path, name: &str, is_there: fn(&Path) -> bool) -> Result<PathBuf, String> {
    let path = folder.join(name);
    if !is_there(&path) {
        return Err(format!("Dez cannot find {} in the files that it ships: install Dez again", name));
    }
    Ok(path)
}

// A path as one entry of the path list of a flag
// (`--allow-read=<a>,<b>`). Deno splits the list at each comma and has no
// way to write a comma of a path, so such a path is refused, and one that
// is not UTF-8 too. The error names no path: the page can pass it on to a
// model.
fn flag_path(path: &Path) -> Result<&str, String> {
    path.to_str()
        .filter(|text| !text.contains(','))
        .ok_or_else(|| "A folder or file of the run has a comma in its path, or a path that is not UTF-8 text, which the program cannot take".to_string())
}

// Whether `text` can be the `TZ` of a program: the form of the name of a
// time zone (`Europe/Berlin`, `Etc/GMT+5`, `UTC`). A `TZ` can also name a
// file (`:/path`, a name with `..`), and this form has none of those.
fn is_time_zone(text: &str) -> bool {
    text.len() <= 64
        && text.starts_with(|first: char| first.is_ascii_alphanumeric())
        && text.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '+' | '-' | '/'))
}

// The places of a run beyond its work folder, in the OS rule and in the
// flags of its program.
#[derive(Default)]
struct RunPlaces {
    // The flags that name the places.
    flags: Vec<String>,
    // `Confinement::also_owned` and `Confinement::also_readable`.
    owned: Vec<PathBuf>,
    readable: Vec<PathBuf>,
    // The work folder of the conversation, which `resolved_run` makes
    // when the run passes every check.
    conversation: Option<PathBuf>,
}

// The places of a run: those that the page names (an app or a built-in
// app, a conversation, the native library of skia-canvas) and those that
// Dez ships. Each kind of run gets only what it needs:
// - Every run imports the libraries (the OS rule lets it read them; an
//   `import` needs no flag of Deno) and changes nothing of them.
// - A run of an app reads and changes its work folder, which holds its
//   inputs and outputs, and the folder of its app (a built-in app only
//   reads it), and reads the fonts.
// - A run with a conversation reads and changes the folder of it. The code
//   of a model (`js_eval`, no app) gets no other file flag.
// - The native code of skia-canvas opens files with no check of Deno, so
//   only a run of an app gets it, when the page asks for it.
// Each path goes into a flag through `flag_path`.
fn run_places(run: &ToolRun, rules: &ProgramRules, roots: &Roots, folder: &Path) -> Result<RunPlaces, String> {
    let Some(flags) = &rules.place_flags else {
        if run.app_folder.is_some() || run.built_in_app.is_some() || run.conversation_folder.is_some() || run.native_canvas {
            return Err(format!("A run of {} cannot have an app, a conversation folder, or a native library", run.tool));
        }
        return Ok(RunPlaces::default());
    };
    let app = match (&run.app_folder, &run.built_in_app) {
        (None, None) => None,
        (Some(name), None) => Some(app_folder(&roots.app, name)?),
        (None, Some(name)) => Some(built_in_app_folder(&roots.resources, name)?),
        (Some(_), Some(_)) => return Err("A run cannot have both an app folder and a built-in app".to_string()),
    };
    let built_in = run.built_in_app.is_some();
    if run.native_canvas && app.is_none() {
        return Err("Only a run of an app can load the native library of skia-canvas".to_string());
    }
    let conversation = run.conversation_folder.as_deref().map(|id| conversation_folder(&roots.app, id)).transpose()?;
    let libs = shipped(&roots.resources, LIBS_FOLDER, Path::is_dir)?;
    let import_map = shipped(&libs, LIBS_IMPORT_MAP, Path::is_file)?;
    let fonts = if app.is_some() { Some(shipped(&roots.resources, FONTS_FOLDER, Path::is_dir)?) } else { None };
    let canvas = if run.native_canvas {
        let script_folder = shipped(&libs, CANVAS_SCRIPT_FOLDER, Path::is_dir)?;
        let library = shipped(&script_folder, CANVAS_NATIVE_LIBRARY, Path::is_file)?;
        Some((script_folder, library))
    } else {
        None
    };

    let run_folder = app.as_ref().map(|_| folder);
    let read: Vec<&Path> = [run_folder, app.as_deref(), conversation.as_deref(), fonts.as_deref(), canvas.as_ref().map(|(script_folder, _)| script_folder.as_path())]
        .into_iter()
        .flatten()
        .collect();
    let write: Vec<&Path> = [run_folder, app.as_deref().filter(|_| !built_in), conversation.as_deref()].into_iter().flatten().collect();
    let mut places = RunPlaces { flags: vec![format!("{}={}", flags.import_map, flag_path(&import_map)?)], ..RunPlaces::default() };
    for (flag, paths) in [(flags.read, &read), (flags.write, &write)] {
        if !paths.is_empty() {
            let list: Vec<&str> = paths.iter().map(|path| flag_path(path)).collect::<Result<_, _>>()?;
            places.flags.push(format!("{flag}={}", list.join(",")));
        }
    }
    if let Some((_, library)) = &canvas {
        places.flags.push(format!("{}={}", flags.native_library, flag_path(library)?));
        places.flags.push(format!("{}={}", flags.variables, CANVAS_VARIABLES.join(",")));
    }

    places.readable.push(libs);
    places.readable.extend(fonts);
    match app {
        Some(app) if built_in => places.readable.push(app),
        Some(app) => places.owned.push(app),
        None => {}
    }
    places.owned.extend(conversation.clone());
    places.conversation = conversation;
    Ok(places)
}

// A run of the page as the rules of its program allow it, with its paths
// resolved: the one place where the page's words become a command line, an
// environment, and a confinement.
fn resolved_run(run: ToolRun, roots: &Roots) -> Result<ProgramRun, String> {
    let program = tool_path(&roots.tools, &run.tool)?;
    let rules = rules_of(&run.tool).ok_or_else(|| format!("Dez has no rules for the bundled tool {}", run.tool))?;
    let folder = work_folder(&roots.cache, &run.folder, rules)?;
    let places = run_places(&run, rules, roots, &folder)?;

    let mut args: Vec<String> = rules.first_args.iter().map(|arg| arg.to_string()).collect();
    args.extend(places.flags);
    match rules.page_args {
        PageArgs::AsGiven => args.extend(run.args),
        PageArgs::Script => match run.args.as_slice() {
            [script] if is_app_file_segment(script) => args.push(format!("./{script}")),
            _ => return Err(format!("A run of {} takes one argument, the name of a script file of its work folder", run.tool)),
        },
    }

    let mut env: Vec<(String, OsString)> = rules.env.iter().map(|(name, value)| (name.to_string(), OsString::from(value))).collect();
    if let Some((name, subfolder)) = rules.state_folder {
        env.push((name.to_string(), folder.join(subfolder).into_os_string()));
    }
    if let Some(zone) = run.time_zone {
        if !is_time_zone(&zone) {
            return Err(format!("Invalid time zone: {}", zone));
        }
        env.push(("TZ".to_string(), zone.into()));
    }

    // Made only now, so that a run that a check refuses makes no folder.
    if let Some(conversation) = &places.conversation {
        make_private_folder(conversation).map_err(|error| format!("Failed to make the work folder of the conversation: {}", error))?;
    }
    let confinement = Confinement {
        folder: match rules.confined_to {
            ConfinedTo::CacheRoot => roots.cache.clone(),
            ConfinedTo::WorkFolder => folder.clone(),
        },
        also_owned: places.owned,
        also_writable: if rules.assets_writable { vec![program_app_folder(&roots.app)?] } else { Vec::new() },
        also_readable: places.readable,
        also_startable: Vec::new(),
        system_libraries: rules.system_libraries,
        required: rules.must_be_confined,
        data_limit: rules.data_limit,
    };
    Ok(ProgramRun {
        program,
        args,
        folder,
        inputs: run.inputs,
        timeout: Duration::from_millis(run.timeout_ms),
        max_output_bytes: run.max_output_bytes,
        env,
        takes_input: run.stdin,
        link_root: roots.cache.clone(),
        confinement,
    })
}

// Makes the work folder and puts the input files into it. The folder can be
// there already: a caller runs more than one program in one folder (a probe
// of the inputs, then the work), and a download can write into it first. A
// folder that goes through a link below `link_root` is refused before the
// chmod: the link can name a folder of the user.
fn prepare_work_folder(folder: &Path, inputs: &[ToolInput], link_root: &Path) -> Result<(), String> {
    if has_link_below(link_root, folder) {
        return Err("The work folder goes through a link".to_string());
    }
    make_private_folder(folder).map_err(|error| format!("Failed to make the work folder: {}", error))?;
    inputs.iter().try_for_each(|input| copy_input(folder, input, link_root))
}

// Puts one input file into the work folder, as a copy. Never a symlink or a
// hard link: a program that writes to its input would then change the
// user's file, and a link to a file of the app folder (provider_keys.json)
// would open that file past the OS rule (confinement.rs). `std::fs::copy`
// clones the file where the file system can (APFS, Linux file systems with
// reflinks), so the copy is cheap there.
//
// The name is one path segment of the app-file rule, or two: a subfolder,
// which is made private as the work folder, and a file name. So the copy
// cannot leave the folder. A subfolder keeps files apart from the others
// for a program that reads every file of a folder (the fonts of libass). A
// name that the folder already has is refused: the copy would replace a
// file of an earlier run, or write through a link that a program left
// there. The error texts name the copy, never the source path.
fn copy_input(folder: &Path, input: &ToolInput, link_root: &Path) -> Result<(), String> {
    let name = &input.name;
    let subfolder = match name.split_once('/') {
        None if is_app_file_segment(name) => None,
        Some((subfolder, file)) if is_app_file_segment(subfolder) && is_app_file_segment(file) => Some(folder.join(subfolder)),
        _ => return Err(format!("Invalid input file name: {}", name)),
    };
    let source = Path::new(&input.source);
    if !source.is_absolute() {
        return Err(format!("The source of the input file {} is not an absolute path", name));
    }
    // A link below `link_root` (a temp clip) can be the work of a program
    // and name any file, the API keys too. A link outside it is the user's
    // (a linked file), and `metadata` follows it: it is an input like a file.
    if has_link_below(link_root, source) {
        return Err(format!("The source of the input file {} goes through a link in the folder of the program", name));
    }
    let is_file = std::fs::metadata(source)
        .map(|metadata| metadata.is_file())
        .map_err(|error| format!("Failed to read the source of the input file {}: {}", name, error))?;
    if !is_file {
        return Err(format!("The source of the input file {} is not a file", name));
    }
    if let Some(subfolder) = subfolder {
        // Before the chmod, as for the work folder: a link can name a
        // folder of the user.
        if has_link_below(link_root, &subfolder) {
            return Err(format!("The folder of the input file {} goes through a link", name));
        }
        make_private_folder(&subfolder).map_err(|error| format!("Failed to make the folder of the input file {}: {}", name, error))?;
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

// The process group of a running program, which `process_group(0)` makes
// with the program's process id. A program can start other programs (a
// shell, a helper), and a kill of the program alone leaves them running,
// still able to write files. `end` kills every process of the group. The
// caller calls it while the program is not waited for yet: its process
// then still holds the group id, so the id can name no other group. The
// drop ends the group too, for a run whose future is dropped. On Linux no
// program leaves the group: the confinement refuses `setsid` and
// `setpgid`. On macOS a program that leaves it is not ended; it stays
// under the OS rule of its run.
struct ProcessGroup(Option<u32>);

impl ProcessGroup {
    fn end(&mut self) {
        #[cfg(unix)]
        if let Some(id) = self.0.take() {
            // SAFETY: `killpg` takes two integers and touches no memory. An
            // error means that no process of the group is left.
            unsafe { libc::killpg(id as libc::pid_t, libc::SIGKILL) };
        }
    }
}

impl Drop for ProcessGroup {
    fn drop(&mut self) {
        self.end();
    }
}

// Passes the texts of the page on to the input of the program, in their
// order, as long as the run lasts: it never ends by itself. A write that
// fails (the program closed its input, or ended) drops the pipe and the
// queue, so the next `ToolRuns::write_input` of the run fails.
async fn pass_input(pipe: Option<ChildStdin>, texts: Option<mpsc::Receiver<String>>) -> Infallible {
    if let (Some(mut pipe), Some(mut texts)) = (pipe, texts) {
        while let Some(text) = texts.recv().await {
            if pipe.write_all(text.as_bytes()).await.is_err() {
                break;
            }
        }
    }
    std::future::pending().await
}

// Starts the program in its work folder and waits for its end.
// - `confined_command`: the OS keeps the program inside its folders.
// - `env_clear`: the program gets no variable of Dez's environment (API
//   keys can be there), and no `PATH`; only the variables of its run.
// - `Stdio::null()`: a program that reads its input (ffmpeg reads keys)
//   gets the end of the input at once. A run that takes input gets a pipe
//   that stays open to its end (`pass_input`).
// - `process_group(0)`: the program and the programs that it starts are in
//   a group of their own (`ProcessGroup`). The end of a run ends them all,
//   also after a normal exit: the end of both outputs is the end of the run,
//   so a program that closes them before its exit is ended too.
// - `kill_on_drop`: a run whose future is dropped leaves no program.
async fn run_program(
    run: &ProgramRun,
    stopped: &mut watch::Receiver<bool>,
    texts: Option<mpsc::Receiver<String>>,
    send: &(impl Fn(ToolRunEvent) + Sync),
) -> Result<ToolRunEnd, String> {
    let mut command = confined_command(&run.program, &run.args, &run.confinement)?;
    command
        .current_dir(&run.folder)
        .env_clear()
        .envs(run.env.iter().map(|(name, value)| (name, value)))
        .stdin(if run.takes_input { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|error| format!("Failed to start the program: {}", error))?;
    // After `child`, so that a drop ends the group before tokio's drop of
    // `child` kills and waits for the program.
    let mut group = ProcessGroup(child.id());
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        return Err("The program has no output pipes".to_string());
    };
    let input = pass_input(child.stdin.take(), texts);
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
            // The input goes on next to the output, and ends with it.
            let output = tokio::select! {
                output = output => output,
                never = input => match never {},
            };
            match output {
                Ok(_) => {
                    group.end();
                    Some(child.wait().await)
                }
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
        group.end();
        // `kill` sends SIGKILL and waits for the exit, so the program is
        // gone, and writes no file any more, when the run ends. An error
        // means that the program has already ended.
        let _ = child.kill().await;
    }
    Ok(end)
}

// The runs that are active, by the run id of the page, each with the ways
// to reach it, and the cancels that came before their run. A managed state
// of the app.
#[derive(Default)]
pub struct ToolRuns {
    table: Mutex<RunTable>,
    // Notified each time that a run leaves `active`.
    ended: Notify,
}

// One lock holds both lists: a cancel that finds no active run and the
// register of its run must not pass each other.
#[derive(Default)]
struct RunTable {
    active: HashMap<String, RunControls>,
    // The ids of the cancels that came when their run was not active, the
    // oldest first, at most `KEPT_CANCELS`.
    kept_cancels: VecDeque<String>,
}

// The ways to reach an active run: the sender of its stop flag, and the
// queue of the texts for its input when the run takes input.
struct RunControls {
    stop: watch::Sender<bool>,
    input: Option<mpsc::Sender<String>>,
}

// The place of a run in `RunTable::active`. Its drop takes the run out, on
// every way out of `ToolRuns::run`.
struct ActiveRun<'a> {
    runs: &'a ToolRuns,
    run_id: &'a str,
}

impl Drop for ActiveRun<'_> {
    fn drop(&mut self) {
        self.runs.lock().active.remove(self.run_id);
        self.runs.ended.notify_waiters();
    }
}

impl ToolRuns {
    // The lock is never held over code that can panic, but a poisoned lock
    // must not stop every later run: the table is whole after each change.
    fn lock(&self) -> MutexGuard<'_, RunTable> {
        self.table.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    // Adds a run, as stopped when its cancel came first, and gives the two
    // ends that the run reads: its stop flag and, for a run that takes
    // input, the queue of its texts. An id that is active is refused: a
    // cancel could not tell the two runs apart.
    #[allow(clippy::type_complexity)]
    fn register<'a>(&'a self, run_id: &'a str, takes_input: bool) -> Result<(ActiveRun<'a>, watch::Receiver<bool>, Option<mpsc::Receiver<String>>), String> {
        let mut table = self.lock();
        let RunTable { active, kept_cancels } = &mut *table;
        match active.entry(run_id.to_string()) {
            Entry::Occupied(_) => Err(format!("A run with the id {} is active", run_id)),
            Entry::Vacant(entry) => {
                let cancelled = kept_cancels.iter().position(|id| id == run_id).and_then(|index| kept_cancels.remove(index)).is_some();
                let (stop, stopped) = watch::channel(cancelled);
                let (input, texts) = takes_input.then(|| mpsc::channel(INPUT_QUEUE)).unzip();
                entry.insert(RunControls { stop, input });
                Ok((ActiveRun { runs: self, run_id }, stopped, texts))
            }
        }
    }

    // Stops a run. The flag stays set, so a cancel that comes while the
    // input files are copied is not lost. Tauri runs each command as its own
    // task, so a cancel can also come before its run is active: its id is
    // then kept, and the run of that id starts as stopped. A cancel that
    // comes after the end of its run is kept too, so each run needs a new id.
    pub(crate) fn cancel(&self, run_id: &str) {
        let mut table = self.lock();
        if let Some(run) = table.active.get(run_id) {
            run.stop.send_replace(true);
        } else if !table.kept_cancels.iter().any(|id| id == run_id) {
            if table.kept_cancels.len() == KEPT_CANCELS {
                table.kept_cancels.pop_front();
            }
            table.kept_cancels.push_back(run_id.to_string());
        }
    }

    // Puts `text` into the queue for the input of a run, and waits while
    // the queue is full. The program gets the text as it is, after the texts
    // that came before. An `Err` is a run that is not active, takes no
    // input, or whose program closed its input. Tauri runs each command as
    // its own task, so the first write of a run can come before the run is
    // active: the caller waits for an output of the program first.
    pub(crate) async fn write_input(&self, run_id: &str, text: String) -> Result<(), String> {
        let input = self.lock().active.get(run_id).and_then(|run| run.input.clone());
        let Some(input) = input else {
            return Err(format!("No active run with the id {} takes input", run_id));
        };
        input.send(text).await.map_err(|_| format!("The program of the run {} takes no more input", run_id))
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
                let table = self.lock();
                if table.active.is_empty() {
                    return;
                }
                for run in table.active.values() {
                    run.stop.send_replace(true);
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
        let (_active, mut stopped, texts) = self.register(run_id, run.takes_input)?;
        // File copies block, so they run off the async threads.
        let (folder, inputs, link_root) = (run.folder.clone(), std::mem::take(&mut run.inputs), run.link_root.clone());
        tokio::task::spawn_blocking(move || prepare_work_folder(&folder, &inputs, &link_root))
            .await
            .map_err(|error| format!("Failed to prepare the work folder: {}", error))??;
        // A copy cannot stop in its middle, so a cancel that came before the
        // run or during the copies ends the run here, before the program
        // starts.
        let cancelled = *stopped.borrow();
        let end = if cancelled {
            ToolRunEnd::Cancelled
        } else {
            run_program(&run, &mut stopped, texts, &send).await?
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
// that did not start (a name that is no bundled tool, a run that the rules
// of its program refuse, a bad folder path or input file, a run id that is
// active, a computer with no confinement for a program that needs one) or
// whose end is not known.
#[tauri::command]
pub async fn run_bundled_tool(
    app: tauri::AppHandle,
    run: ToolRun,
    run_id: String,
    on_event: Channel<ToolRunEvent>,
    runs: State<'_, ToolRuns>,
) -> Result<(), String> {
    use tauri::Manager;
    let resources = app.path().resource_dir().map_err(|error| format!("Failed to find the files that Dez ships: {}", error))?;
    let roots = Roots { tools: tools_dir()?, cache: root_dir(FileRoot::Cache)?, app: root_dir(FileRoot::App)?, resources };
    let run = resolved_run(run, &roots)?;
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

// Writes `text` to the input of the run with this id, which must be a run
// with `ToolRun::stdin` (`ToolRuns::write_input`). `Ok` tells that the text
// is in the queue of the run, not that the program read it.
#[tauri::command]
pub async fn write_bundled_tool_input(run_id: String, text: String, runs: State<'_, ToolRuns>) -> Result<(), String> {
    runs.write_input(&run_id, text).await
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

    // A run as the page asks for it, with no option.
    fn tool_run(tool: &str, args: &[&str], folder: &str) -> ToolRun {
        ToolRun {
            tool: tool.to_string(),
            args: args.iter().map(|arg| arg.to_string()).collect(),
            folder: folder.to_string(),
            inputs: Vec::new(),
            timeout_ms: 30_000,
            max_output_bytes: 1024 * 1024,
            stdin: false,
            app_folder: None,
            built_in_app: None,
            conversation_folder: None,
            native_canvas: false,
            time_zone: None,
        }
    }

    // The built-in app of `fake_roots`.
    const FAKE_BUILT_IN_APP: &str = "dez-built-in";

    // The folders of a run in `dir`, with an empty file in place of each
    // bundled program and of each file that Dez ships for a run.
    fn fake_roots(dir: &Path) -> Roots {
        let roots = Roots { tools: dir.join("tools"), cache: dir.join("cache"), app: dir.join("config"), resources: dir.join("resources") };
        let canvas = roots.resources.join(LIBS_FOLDER).join(CANVAS_SCRIPT_FOLDER);
        for folder in [roots.tools.clone(), canvas.clone(), roots.resources.join(FONTS_FOLDER), roots.resources.join(BUILT_IN_APPS_FOLDER).join(FAKE_BUILT_IN_APP)] {
            std::fs::create_dir_all(folder).expect("create");
        }
        let files = BUNDLED_TOOLS.iter().map(|tool| roots.tools.join(tool)).chain([roots.resources.join(LIBS_FOLDER).join(LIBS_IMPORT_MAP), canvas.join(CANVAS_NATIVE_LIBRARY)]);
        for file in files {
            std::fs::write(file, b"").expect("write");
        }
        roots
    }

    // The flags of a Deno run that give it its places.
    fn place_flags(run: &ProgramRun) -> Vec<&str> {
        run.args.iter().map(String::as_str).filter(|arg| arg.starts_with("--allow") || arg.starts_with("--import-map")).collect()
    }

    #[test]
    fn each_bundled_program_has_rules() {
        for tool in BUNDLED_TOOLS {
            assert!(rules_of(tool).is_some(), "{tool} has no rules");
        }
    }

    // The page gives a Deno run only the name of its script. Rust writes
    // the command line, so no word of the page is a flag of Deno.
    #[test]
    fn a_deno_run_takes_one_script_name_that_is_never_a_flag() {
        let dir = TempDir::new("tools-deno-args");
        let roots = fake_roots(&dir.0);
        let args_of = |args: &[&str]| resolved_run(tool_run("dez-deno", args, "work/a"), &roots).map(|run| run.args);

        let args = args_of(&["main.ts"]).expect("a script name");
        // `run`, and not `eval`, which has every permission.
        assert_eq!(args.first().map(String::as_str), Some("run"));
        assert_eq!(args.last().map(String::as_str), Some("./main.ts"));
        // A run with no app and no conversation has no permission of Deno:
        // only the import map of the libraries that Dez ships.
        assert!(!args.iter().any(|arg| arg.starts_with("--allow") || arg == "-A"), "{args:?}");
        let import_map = format!("--import-map={}", roots.resources.join(LIBS_FOLDER).join(LIBS_IMPORT_MAP).display());
        assert_eq!(args[DENO_RULES.first_args.len()..], [import_map, "./main.ts".to_string()]);
        // A file can have the name of a flag.
        assert_eq!(args_of(&["--allow-all"]).expect("a file name").last().map(String::as_str), Some("./--allow-all"));
        let refused: [&[&str]; 8] = [&[], &["--allow-all", "main.ts"], &["main.ts", "extra"], &[""], &["../main.ts"], &["sub/main.ts"], &["/tmp/main.ts"], &["main.ts "]];
        for args in refused {
            assert!(args_of(args).is_err(), "{args:?} must be refused");
        }
    }

    // The OS keeps a Deno run in its own work folder, so that folder must
    // be one folder of the work root: a wider one would give the run the
    // files of the other runs. ffmpeg has all of the cache root.
    #[test]
    fn a_deno_run_is_confined_to_its_work_folder_which_is_one_folder_of_the_work_root() {
        let dir = TempDir::new("tools-deno-folder");
        let roots = fake_roots(&dir.0);
        let run_in = |tool: &str, folder: &str| resolved_run(tool_run(tool, &["main.ts"], folder), &roots);

        let run = run_in("dez-deno", "work/a").expect("a work folder");
        assert_eq!(run.folder, roots.cache.join("work").join("a"));
        assert_eq!(run.confinement.folder, run.folder);
        assert!(run.confinement.required);
        assert!(run.confinement.also_writable.is_empty() && run.confinement.also_owned.is_empty() && run.confinement.also_startable.is_empty());
        assert_eq!(run.confinement.also_readable, [roots.resources.join(LIBS_FOLDER)]);
        for folder in ["work", "work/a/b", "media/a", "a", "", "work/", "work/..", "work/../media", "/work/a", "work//a"] {
            assert!(run_in("dez-deno", folder).is_err(), "the folder {folder:?}");
        }

        let run = run_in("dez-ffmpeg", "work/a/b").expect("a folder of the cache root");
        assert_eq!(run.confinement.folder, roots.cache);
        assert_eq!(run.confinement.also_writable, [roots.app.join(PROGRAM_APP_FOLDER)]);
        assert!(run.confinement.also_owned.is_empty() && run.confinement.also_readable.is_empty());
        assert!(!run.confinement.required);
        for folder in ["", "../a", "/tmp/a", "work/../../a"] {
            assert!(run_in("dez-ffmpeg", folder).is_err(), "the folder {folder:?}");
        }
    }

    // The app folder of a run is one folder of `apps/` that is there, by
    // its name. Deno gets it and the work folder in its two file flags, and
    // reads the fonts that Dez ships.
    #[test]
    fn an_app_folder_is_one_real_folder_of_the_apps_and_only_deno_takes_one() {
        let dir = TempDir::new("tools-app-folder");
        let roots = fake_roots(&dir.0);
        let apps = roots.app.join(APPS_FOLDER);
        let (app, outside) = (apps.join("my-app"), dir.0.join("outside"));
        std::fs::create_dir_all(&app).expect("create");
        std::fs::create_dir_all(&outside).expect("create");
        std::fs::write(apps.join("a-file"), b"").expect("write");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, apps.join("linked")).expect("link");
        let with_app = |tool: &str, name: &str| resolved_run(ToolRun { app_folder: Some(name.to_string()), ..tool_run(tool, &["main.ts"], "work/a") }, &roots);

        let run = with_app("dez-deno", "my-app").expect("an app folder");
        assert_eq!(run.confinement.also_owned, [app.clone()]);
        let fonts = roots.resources.join(FONTS_FOLDER);
        assert_eq!(run.confinement.also_readable, [roots.resources.join(LIBS_FOLDER), fonts.clone()]);
        let folders = format!("{},{}", roots.cache.join("work").join("a").display(), app.display());
        assert_eq!(place_flags(&run)[1..], [format!("--allow-read={folders},{}", fonts.display()), format!("--allow-write={folders}")]);
        assert_eq!(run.args.last().map(String::as_str), Some("./main.ts"));

        for name in ["", ".", "..", "../config", "my-app/sub", "/tmp", "no-such-app", "a-file", "linked"] {
            assert!(with_app("dez-deno", name).is_err(), "the app folder {name:?}");
        }
        assert!(with_app("dez-ffmpeg", "my-app").is_err(), "ffmpeg with an app folder");
    }

    // Deno splits the path list of a flag at each comma, so a comma in a
    // path would make two other paths of it, and a flag is text, so it
    // cannot hold a path that is not UTF-8. The check is on each path of a
    // flag: here only one root has such a path. The error can go to a
    // model, so it names no path.
    #[test]
    fn a_deno_run_is_refused_when_a_path_of_its_flags_cannot_be_in_a_flag() {
        let dir = TempDir::new("tools-deno-flag-path");
        let mut roots = vec![
            Roots { cache: dir.0.join("private,cache"), ..fake_roots(&dir.0) },
            Roots { app: dir.0.join("private,config"), ..fake_roots(&dir.0) },
        ];
        // No folder is made on this path, which macOS would refuse.
        #[cfg(unix)]
        roots.push(Roots { cache: dir.0.join(<std::ffi::OsStr as std::os::unix::ffi::OsStrExt>::from_bytes(b"private\xffcache")), ..fake_roots(&dir.0) });
        let refused = |error: String| {
            assert!(error.contains("comma") && error.contains("UTF-8"), "{error}");
            assert!(!error.contains("private"), "{error}");
        };
        for roots in roots {
            std::fs::create_dir_all(roots.app.join(APPS_FOLDER).join("my-app")).expect("create");
            let run = tool_run("dez-deno", &["main.ts"], "work/a");

            // A run with no app folder has no flag that names these roots.
            assert!(resolved_run(run.clone(), &roots).is_ok(), "{}", roots.cache.display());
            refused(resolved_run(ToolRun { app_folder: Some("my-app".to_string()), ..run }, &roots).err().expect("refused"));
        }

        // The libraries that Dez ships are in the flags of every run.
        let roots = fake_roots(&dir.0.join("private,dez"));
        refused(resolved_run(tool_run("dez-deno", &["main.ts"], "work/a"), &roots).err().expect("refused"));
        assert!(resolved_run(tool_run("dez-ffmpeg", &["-version"], "work/a"), &roots).is_ok());
    }

    // The rights of each kind of Deno run: the code of a model, an app, a
    // built-in app, and an app with the native library of skia-canvas. Each
    // gets the flags of Deno and the places of the OS rule of its kind, and
    // no more.
    #[test]
    fn each_kind_of_deno_run_gets_only_the_places_of_its_kind() {
        let dir = TempDir::new("tools-run-places");
        let roots = fake_roots(&dir.0);
        let (work, app) = (roots.cache.join("work").join("a"), roots.app.join(APPS_FOLDER).join("my-app"));
        std::fs::create_dir_all(&app).expect("create");
        let conversation = roots.app.join(CONVERSATION_WORK_FOLDERS).join("c-1");
        let (libs, fonts) = (roots.resources.join(LIBS_FOLDER), roots.resources.join(FONTS_FOLDER));
        let built_in = roots.resources.join(BUILT_IN_APPS_FOLDER).join(FAKE_BUILT_IN_APP);
        let canvas = libs.join(CANVAS_SCRIPT_FOLDER);
        let list = |paths: &[&Path]| paths.iter().map(|path| path.display().to_string()).collect::<Vec<_>>().join(",");
        let import_map = format!("--import-map={}", libs.join(LIBS_IMPORT_MAP).display());
        let run_of = |run: ToolRun| {
            let run = ToolRun { conversation_folder: Some("c-1".to_string()), ..run };
            resolved_run(ToolRun { args: vec!["main.ts".to_string()], folder: "work/a".to_string(), ..run }, &roots).expect("a run")
        };
        let deno = || tool_run("dez-deno", &[], "");

        // The code of a model reads and changes only the folder of its
        // conversation, which Rust makes.
        assert!(!conversation.exists());
        let run = run_of(deno());
        assert!(conversation.is_dir());
        #[cfg(unix)]
        assert_eq!(std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&conversation).expect("metadata").permissions()) & 0o777, 0o700);
        let conversation_flags = [format!("--allow-read={}", conversation.display()), format!("--allow-write={}", conversation.display())];
        assert_eq!(place_flags(&run), [import_map.as_str(), conversation_flags[0].as_str(), conversation_flags[1].as_str()]);
        assert_eq!((run.confinement.also_owned, run.confinement.also_readable), (vec![conversation.clone()], vec![libs.clone()]));

        let run = run_of(ToolRun { app_folder: Some("my-app".to_string()), ..deno() });
        let read = format!("--allow-read={}", list(&[&work, &app, &conversation, &fonts]));
        let write = format!("--allow-write={}", list(&[&work, &app, &conversation]));
        assert_eq!(place_flags(&run), [import_map.as_str(), read.as_str(), write.as_str()]);
        assert_eq!((run.confinement.also_owned, run.confinement.also_readable), (vec![app.clone(), conversation.clone()], vec![libs.clone(), fonts.clone()]));

        // A built-in app is a place to read.
        let run = run_of(ToolRun { built_in_app: Some(FAKE_BUILT_IN_APP.to_string()), ..deno() });
        let read = format!("--allow-read={}", list(&[&work, &built_in, &conversation, &fonts]));
        let write = format!("--allow-write={}", list(&[&work, &conversation]));
        assert_eq!(place_flags(&run), [import_map.as_str(), read.as_str(), write.as_str()]);
        assert_eq!((run.confinement.also_owned, run.confinement.also_readable), (vec![conversation.clone()], vec![libs.clone(), fonts.clone(), built_in.clone()]));

        // The native library: exactly its file, and the variables that the
        // script of skia-canvas reads. Its folder is in the libraries.
        let run = run_of(ToolRun { built_in_app: Some(FAKE_BUILT_IN_APP.to_string()), native_canvas: true, ..deno() });
        let read = format!("--allow-read={}", list(&[&work, &built_in, &conversation, &fonts, &canvas]));
        let ffi = format!("--allow-ffi={}", canvas.join(CANVAS_NATIVE_LIBRARY).display());
        let env = "--allow-env=https_proxy,HTTPS_PROXY,http_proxy,HTTP_PROXY,LC_ALL,LC_MESSAGES,LANG,LANGUAGE,SKIA_CANVAS_STRICT";
        assert_eq!(place_flags(&run), [import_map.as_str(), read.as_str(), write.as_str(), ffi.as_str(), env]);
        assert_eq!(run.confinement.also_readable, [libs.clone(), fonts.clone(), built_in.clone()]);
        assert_eq!(run.args.last().map(String::as_str), Some("./main.ts"));
    }

    // A run can have only the places of its kind, by names that are one
    // folder each. A refused run makes no folder.
    #[test]
    fn a_run_is_refused_the_places_that_its_kind_cannot_have() {
        let dir = TempDir::new("tools-refused-places");
        let roots = fake_roots(&dir.0);
        std::fs::create_dir_all(roots.app.join(APPS_FOLDER).join("my-app")).expect("create");
        // Runs that are good but for the field under test.
        let deno = || tool_run("dez-deno", &["main.ts"], "work/a");
        let ffmpeg = || tool_run("dez-ffmpeg", &["-version"], "work/a");
        let app = || Some("my-app".to_string());
        let built_in = || Some(FAKE_BUILT_IN_APP.to_string());
        let conversation = || Some("c-1".to_string());
        assert!(resolved_run(deno(), &roots).is_ok() && resolved_run(ffmpeg(), &roots).is_ok());

        let refused = [
            // The native library is never for the code of a model.
            ToolRun { native_canvas: true, ..deno() },
            ToolRun { native_canvas: true, conversation_folder: conversation(), ..deno() },
            ToolRun { app_folder: app(), built_in_app: built_in(), ..deno() },
            ToolRun { app_folder: app(), ..ffmpeg() },
            ToolRun { built_in_app: built_in(), ..ffmpeg() },
            ToolRun { conversation_folder: conversation(), ..ffmpeg() },
            ToolRun { native_canvas: true, ..ffmpeg() },
            // The other checks of a run come before the folder is made.
            ToolRun { conversation_folder: conversation(), args: vec!["../main.ts".to_string()], ..deno() },
            ToolRun { conversation_folder: conversation(), time_zone: Some(":/etc/localtime".to_string()), ..deno() },
        ];
        for run in refused {
            let description = format!("{run:?}");
            assert!(resolved_run(run, &roots).is_err(), "{description}");
        }
        for id in ["", ".", "..", "../config", "a/b", "/tmp"] {
            assert!(resolved_run(ToolRun { conversation_folder: Some(id.to_string()), ..deno() }, &roots).is_err(), "the conversation {id:?}");
        }
        for name in ["", ".", "..", "../libs", "a/b", "/tmp", "no-such-app", "my-app"] {
            assert!(resolved_run(ToolRun { built_in_app: Some(name.to_string()), ..deno() }, &roots).is_err(), "the built-in app {name:?}");
        }
        assert!(!roots.app.join(CONVERSATION_WORK_FOLDERS).exists(), "a refused run made a folder");

        // The folder of a conversation through a link of the user.
        #[cfg(unix)]
        {
            let outside = dir.0.join("outside");
            std::fs::create_dir_all(roots.app.join(CONVERSATION_WORK_FOLDERS)).expect("create");
            std::fs::create_dir_all(&outside).expect("create");
            std::os::unix::fs::symlink(&outside, roots.app.join(CONVERSATION_WORK_FOLDERS).join("linked")).expect("link");
            assert!(resolved_run(ToolRun { conversation_folder: Some("linked".to_string()), ..deno() }, &roots).is_err());
        }
    }

    // A part that Dez ships and that a run needs is missing: the run does
    // not start, with a text that names no path of the computer.
    #[test]
    fn a_run_does_not_start_when_a_file_that_dez_ships_is_missing() {
        let dir = TempDir::new("tools-missing-parts");
        let roots = fake_roots(&dir.0);
        std::fs::create_dir_all(roots.app.join(APPS_FOLDER).join("my-app")).expect("create");
        let resolve = |run: ToolRun| resolved_run(ToolRun { args: vec!["main.ts".to_string()], folder: "work/a".to_string(), ..run }, &roots);
        let deno = || tool_run("dez-deno", &[], "");
        let app_run = || ToolRun { app_folder: Some("my-app".to_string()), ..deno() };
        let missing = |error: String| assert!(error.contains("install Dez again") && !error.contains(&dir.0.display().to_string()), "{error}");

        std::fs::remove_file(roots.resources.join(LIBS_FOLDER).join(CANVAS_SCRIPT_FOLDER).join(CANVAS_NATIVE_LIBRARY)).expect("remove");
        missing(resolve(ToolRun { native_canvas: true, ..app_run() }).err().expect("refused"));
        assert!(resolve(app_run()).is_ok());

        std::fs::remove_dir(roots.resources.join(FONTS_FOLDER)).expect("remove");
        missing(resolve(app_run()).err().expect("refused"));
        assert!(resolve(deno()).is_ok());

        std::fs::remove_file(roots.resources.join(LIBS_FOLDER).join(LIBS_IMPORT_MAP)).expect("remove");
        missing(resolve(deno()).err().expect("refused"));
        assert!(resolve(tool_run("dez-ffmpeg", &[], "")).is_ok());
    }

    // A `TZ` can also name a file of the computer (`:/path`), so only the
    // form of a zone name goes to a program.
    #[test]
    fn only_the_name_of_a_time_zone_becomes_the_tz_of_a_program() {
        let dir = TempDir::new("tools-time-zone");
        let roots = fake_roots(&dir.0);
        let with_zone = |tool: &str, zone: &str| resolved_run(ToolRun { time_zone: Some(zone.to_string()), ..tool_run(tool, &["main.ts"], "work/a") }, &roots);
        let tz = |run: ProgramRun| run.env.into_iter().find(|(name, _)| name == "TZ").map(|(_, zone)| zone);

        for zone in ["Europe/Berlin", "UTC", "Etc/GMT+5", "Etc/GMT-14", "America/Argentina/Buenos_Aires"] {
            for tool in ["dez-deno", "dez-ffmpeg"] {
                assert_eq!(tz(with_zone(tool, zone).expect("a zone name")), Some(OsString::from(zone)), "{tool} with {zone}");
            }
        }
        let long = "a".repeat(65);
        for zone in ["", ":/etc/passwd", "/etc/localtime", "../zone", "Europe/../../etc/passwd", "Europe/Berlin\n", "Europe Berlin", "-5", "Zürich", long.as_str()] {
            assert!(with_zone("dez-deno", zone).is_err(), "the zone {zone:?}");
        }
        assert_eq!(tz(resolved_run(tool_run("dez-deno", &["main.ts"], "work/a"), &roots).expect("a run")), None);
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
        // A run with no option has none.
        assert_eq!((run.stdin, run.app_folder, run.time_zone), (false, None, None));
        assert_eq!((run.built_in_app, run.conversation_folder, run.native_canvas), (None, None, false));
        let run: ToolRun = serde_json::from_value(json!({
            "tool": "dez-deno",
            "args": ["main.ts"],
            "folder": "work/a",
            "inputs": [],
            "timeoutMs": 5000,
            "maxOutputBytes": 1024,
            "stdin": true,
            "appFolder": "my-app",
            "builtInApp": "dez-tool",
            "conversationFolder": "c-1",
            "nativeCanvas": true,
            "timeZone": "Europe/Berlin",
        }))
        .expect("run with options");
        assert_eq!((run.stdin, run.app_folder.as_deref(), run.time_zone.as_deref()), (true, Some("my-app"), Some("Europe/Berlin")));
        assert_eq!((run.built_in_app.as_deref(), run.conversation_folder.as_deref(), run.native_canvas), (Some("dez-tool"), Some("c-1"), true));

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

        // The error text of an open that the confinement refused: Landlock
        // gives EACCES, Seatbelt EPERM.
        #[cfg(not(target_os = "macos"))]
        const DENIED: &str = "Permission denied";
        #[cfg(target_os = "macos")]
        const DENIED: &str = "Operation not permitted";
        // The cause to check first when a test of the confinement fails.
        const NOT_CONFINED: &str = "The program could read a file outside its folder: Linux needs Landlock (kernel 5.13+, `landlock` in /sys/kernel/security/lsm).";

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
        // by its path. The program is confined to its work folder, and it
        // can read and start the files of the system's folders that
        // `/bin/sh` and the programs that it starts need (their libraries,
        // and the cache of the library loader in /etc).
        fn program_run(program: &str, args: &[&str], folder: &Path) -> ProgramRun {
            ProgramRun {
                program: PathBuf::from(program),
                args: args.iter().map(|arg| arg.to_string()).collect(),
                folder: folder.to_path_buf(),
                inputs: Vec::new(),
                timeout: Duration::from_secs(30),
                max_output_bytes: 1024 * 1024,
                env: Vec::new(),
                takes_input: false,
                link_root: folder.to_path_buf(),
                confinement: Confinement {
                    folder: folder.to_path_buf(),
                    also_startable: ["/usr", "/bin", "/lib", "/lib64", "/etc"].into_iter().map(PathBuf::from).filter(|path| path.exists()).collect(),
                    ..Confinement::default()
                },
            }
        }

        fn script(text: &str, folder: &Path) -> ProgramRun {
            program_run("/bin/sh", &["-c", text], folder)
        }

        // The run with the folders of an ffmpeg run: confined to `cache`,
        // which holds its work folder, and where Dez follows no link.
        fn in_cache(mut run: ProgramRun, cache: &Path) -> ProgramRun {
            run.confinement.folder = cache.to_path_buf();
            run.link_root = cache.to_path_buf();
            run
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

        // Whether the program whose id is in the file `pid` of this folder
        // (an `ENDLESS` run does that) still runs. A program that was ended
        // and waited for has no process any more.
        fn program_is_running(folder: &Path) -> bool {
            let pid = std::fs::read_to_string(folder.join("pid")).expect("pid file");
            std::process::Command::new("/bin/sh")
                .args(["-c", &format!("kill -0 {}", pid.trim())])
                .stderr(Stdio::null())
                .status()
                .expect("run kill")
                .success()
        }

        // Waits for the end of the program of the file `pid`, for a program
        // that was started in the background. After the end of its run it
        // is a child of the system's first program, which waits for it a
        // moment after its end.
        async fn program_ended(folder: &Path) -> bool {
            let mut checks = 0;
            while program_is_running(folder) && checks < 100 {
                tokio::time::sleep(Duration::from_millis(50)).await;
                checks += 1;
            }
            !program_is_running(folder)
        }

        #[test]
        fn the_work_folder_is_private_also_when_it_was_there() {
            let dir = TempDir::new("tools-folder-mode");
            let new = dir.0.join("work").join("new");
            let old = dir.0.join("work").join("old");

            prepare_work_folder(&new, &[], &new).expect("prepare");
            assert_eq!(mode_of(&new), 0o700);

            std::fs::create_dir(&old).expect("create folder");
            std::fs::set_permissions(&old, std::fs::Permissions::from_mode(0o755)).expect("chmod");
            prepare_work_folder(&old, &[], &old).expect("prepare again");
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

            prepare_work_folder(&folder, &[input("in.mp4", &source), input("linked.mp4", &link)], &folder).expect("prepare");

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

            for name in ["", ".", "..", "../out.mp4", "./out.mp4", "a/b/c.mp4", "a//b.mp4", "a/", "a/..", "/tmp/dez-test-out.mp4", "a b.mp4", "a/b c.mp4"] {
                assert!(prepare_work_folder(&folder, &[input(name, &source)], &folder).is_err(), "the name {name:?}");
            }
            let relative = ToolInput { name: "in.mp4".to_string(), source: "clip.mp4".to_string() };
            assert!(prepare_work_folder(&folder, &[relative], &folder).is_err(), "a relative source");
            assert!(prepare_work_folder(&folder, &[input("in.mp4", &dir.0.join("gone.mp4"))], &folder).is_err(), "a missing source");
            assert!(prepare_work_folder(&folder, &[input("in.mp4", &dir.0)], &folder).is_err(), "a folder as the source");
            assert!(prepare_work_folder(&folder, &[input("sub/in.mp4", &dir.0.join("gone.mp4"))], &folder).is_err(), "a missing source in a subfolder");
            assert_eq!(std::fs::read_dir(&folder).expect("list").count(), 0);
            assert_eq!(dir.file_names().len(), 2, "a file left the work folder");

            // A name that the folder has: its file stays as it was.
            std::fs::write(folder.join("in.mp4"), b"of an earlier run").expect("write");
            assert!(prepare_work_folder(&folder, &[input("in.mp4", &source)], &folder).is_err(), "a name of the folder");
            assert_eq!(std::fs::read(folder.join("in.mp4")).expect("read"), b"of an earlier run");
            // Also a link that names no file: a copy would write through it.
            symlink(dir.0.join("outside.mp4"), folder.join("link.mp4")).expect("link");
            assert!(prepare_work_folder(&folder, &[input("link.mp4", &source)], &folder).is_err(), "a link of the folder");
            assert!(!dir.0.join("outside.mp4").exists());
            // And a name that the same call gave before.
            let twice = [input("twice.mp4", &source), input("twice.mp4", &source)];
            assert!(prepare_work_folder(&folder, &twice, &folder).is_err(), "a name twice");
        }

        // A subfolder keeps files apart from the other copies, for a
        // program that reads every file of a folder (libass, the fonts).
        #[test]
        fn an_input_can_go_into_one_private_subfolder_that_is_no_link() {
            let dir = TempDir::new("tools-input-subfolder");
            let (source, outside) = (dir.0.join("font.ttf"), dir.0.join("outside"));
            let folder = dir.0.join("work");
            std::fs::write(&source, b"font").expect("write");
            std::fs::create_dir(&outside).expect("create");
            std::fs::set_permissions(&outside, std::fs::Permissions::from_mode(0o755)).expect("chmod");

            prepare_work_folder(&folder, &[input("fonts/a.ttf", &source), input("fonts/b.ttf", &source)], &folder).expect("prepare");
            assert_eq!(std::fs::read(folder.join("fonts").join("b.ttf")).expect("read"), b"font");
            assert_eq!(mode_of(&folder.join("fonts")), 0o700);

            // A link that a program left in place of the subfolder.
            symlink(&outside, folder.join("linked")).expect("link");
            assert!(prepare_work_folder(&folder, &[input("linked/a.ttf", &source)], &folder).is_err(), "a linked subfolder");
            assert_eq!(mode_of(&outside), 0o755);
            assert_eq!(std::fs::read_dir(&outside).expect("list").count(), 0);
        }

        // The page can pass the error on to a model, which must learn no
        // path of the computer.
        #[test]
        fn an_input_error_names_the_copy_and_not_the_path_of_its_source() {
            let dir = TempDir::new("tools-input-error");
            let missing = dir.0.join("private-folder").join("gone.mp4");

            let folder = dir.0.join("work");
            let error = prepare_work_folder(&folder, &[input("in.mp4", &missing)], &folder).expect_err("refused");

            assert!(error.contains("in.mp4"), "{error}");
            assert!(!error.contains("private-folder") && !error.contains("gone.mp4"), "{error}");
        }

        // A program can change all of its folder (the cache root). A link
        // that it left there, in place of a temp clip or of a work folder,
        // must not take a copy or a chmod of Dez to a file of the user. A
        // link outside that folder is the user's own (a linked file), and an
        // input like a file (`an_input_is_a_copy_that_…`).
        #[test]
        fn a_link_in_the_folder_of_the_program_is_no_input_and_no_work_folder() {
            let dir = TempDir::new("tools-input-link");
            let (cache, home) = (dir.0.join("cache"), dir.0.join("home"));
            let (clip, keys, source) = (cache.join("media").join("clip.mp4"), home.join("provider_keys.json"), dir.0.join("source.mp4"));
            std::fs::create_dir_all(cache.join("media")).expect("create");
            std::fs::create_dir_all(cache.join("work")).expect("create");
            std::fs::create_dir_all(&home).expect("create");
            std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o755)).expect("chmod");
            std::fs::write(&keys, b"keys").expect("write");
            std::fs::write(&source, b"clip").expect("write");
            symlink(&keys, &clip).expect("link");
            symlink(&home, cache.join("linked-media")).expect("link");
            let folder = cache.join("work").join("a");

            let error = prepare_work_folder(&folder, &[input("in.mp4", &clip)], &cache).expect_err("a temp clip that is a link");
            assert!(error.contains("in.mp4") && !error.contains("provider_keys"), "{error}");
            let through = cache.join("linked-media").join("provider_keys.json");
            assert!(prepare_work_folder(&folder, &[input("in.mp4", &through)], &cache).is_err(), "a clip in a linked folder");
            assert_eq!(std::fs::read_dir(&folder).expect("list").count(), 0);

            // A work folder that is a link to a folder of the user, or that
            // is below one.
            let linked = cache.join("work").join("b");
            symlink(&home, &linked).expect("link");
            assert!(prepare_work_folder(&linked, &[input("in.mp4", &source)], &cache).is_err(), "a linked work folder");
            assert!(prepare_work_folder(&linked.join("c"), &[], &cache).is_err(), "a work folder below a link");
            assert_eq!(mode_of(&home), 0o755);
            assert_eq!(std::fs::read_dir(&home).expect("list").count(), 1);
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
        // an input. A program of a run gets only the variables of its run,
        // and no input.
        #[tokio::test]
        async fn a_program_gets_only_the_environment_of_its_run_and_no_input() {
            let dir = TempDir::new("tools-run-empty");
            let nothing = Sent { ends: exited(0), ..Sent::default() };

            // `env` prints each variable that it got.
            assert_eq!(finished(program_run("/usr/bin/env", &[], &dir.0.join("env"))).await, nothing);
            let mut with_zone = program_run("/usr/bin/env", &[], &dir.0.join("zone"));
            with_zone.env = vec![("TZ".to_string(), OsString::from("Europe/Berlin"))];
            assert_eq!(finished(with_zone).await.stdout, "TZ=Europe/Berlin\n");
            // `cat` with no file reads its input to the end.
            assert_eq!(finished(program_run("/bin/cat", &[], &dir.0.join("cat"))).await, nothing);
        }

        // A run with input: the program gets each text of the page, in
        // their order, while it runs.
        #[tokio::test]
        async fn a_run_with_input_gets_the_texts_of_the_page_in_their_order() {
            let dir = TempDir::new("tools-run-input");
            let runs = ToolRuns::default();
            let (send, mut events) = event_channel();
            let mut run = script("echo ready; read first; read second; echo \"$first, $second\"", &dir.0.join("work"));
            run.takes_input = true;

            let (result, ()) = tokio::join!(runs.run("a", run, send), async {
                wait_for_output(&mut events, "ready").await;
                // A text can end inside a line, and can hold more than one.
                for text in ["on", "e\ntwo\nthree\n"] {
                    assert_eq!(runs.write_input("a", text.to_string()).await, Ok(()));
                }
            });

            assert_eq!(result, Ok(()));
            assert_eq!(sent(events).await, Sent { stdout: "one, two\n".to_string(), ends: exited(0), ..Sent::default() });
        }

        // Only a run that asked for an input has one, and only while its
        // program has it open.
        #[tokio::test]
        async fn a_write_is_an_error_for_a_run_that_takes_no_input_or_closed_it() {
            let dir = TempDir::new("tools-run-no-input");
            let runs = ToolRuns::default();
            let (send, mut events) = event_channel();
            let (closed_send, mut closed_events) = event_channel();
            // `exec <&-` closes the input of the shell, and so of the sleep.
            let mut closed = script("exec <&-; echo started; exec /bin/sleep 60", &dir.0.join("closed"));
            closed.takes_input = true;

            assert!(runs.write_input("no-run", "text\n".to_string()).await.is_err());
            let (no_input, closed, ()) = tokio::join!(
                runs.run("no-input", script(ENDLESS, &dir.0.join("no-input")), send),
                runs.run("closed", closed, closed_send),
                async {
                    wait_for_output(&mut events, "started").await;
                    wait_for_output(&mut closed_events, "started").await;
                    assert!(runs.write_input("no-input", "text\n".to_string()).await.is_err());
                    // Dez learns of a closed input at its write to the
                    // program, so the first texts still go into the queue.
                    let mut writes = 0;
                    while runs.write_input("closed", "text\n".to_string()).await.is_ok() {
                        writes += 1;
                        assert!(writes < 100, "a write to a closed input is no error");
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                    runs.cancel("no-input");
                    runs.cancel("closed");
                },
            );

            assert_eq!((no_input, closed), (Ok(()), Ok(())));
        }

        // The OS keeps a program inside its folder: it reads and writes
        // there, also a file that is not in its work folder, and it can read
        // and write no file outside it, by any path.
        #[tokio::test]
        async fn a_program_reads_and_writes_only_inside_its_folder() {
            let dir = TempDir::new("tools-run-confined");
            let inside = dir.0.join("cache");
            let folder = inside.join("work").join("a");
            let sibling = inside.join("media").join("clip.txt");
            let (outside, written, made) = (dir.0.join("private.txt"), dir.0.join("written.txt"), inside.join("made.txt"));
            std::fs::create_dir_all(sibling.parent().expect("a folder")).expect("create");
            std::fs::write(&sibling, b"sibling text").expect("write");
            std::fs::write(&outside, b"private text").expect("write");
            let text = format!(
                "/bin/cat ../../media/clip.txt > copy.txt; /bin/cat '{}'; /bin/cat ../../../private.txt; echo text > '{}'; echo text > '{}'",
                outside.display(),
                written.display(),
                made.display(),
            );
            let run = in_cache(script(&text, &folder), &inside);

            let sent = finished(run).await;

            assert_eq!(sent.stdout, "", "{NOT_CONFINED}");
            assert_eq!(sent.stderr.matches(DENIED).count(), 3, "{}", sent.stderr);
            assert_eq!(std::fs::read(folder.join("copy.txt")).expect("read"), b"sibling text");
            assert_eq!(std::fs::read(&made).expect("read"), b"text\n");
            assert!(!written.exists());
        }

        // The assets folder of the app folder, as `run_bundled_tool` gives
        // it: a program reads, changes, and makes the files of the stored
        // assets, but it cannot delete one, make a folder there, or link a
        // file of the app folder in, and it can open no other file of the
        // app folder (the API keys, the app state, a conversation).
        #[tokio::test]
        async fn a_program_changes_the_assets_but_opens_no_other_file_of_the_app_folder() {
            let dir = TempDir::new("tools-run-assets");
            let (app, cache) = (dir.0.join("config"), dir.0.join("cache"));
            let assets = program_app_folder(&app).expect("assets folder");
            let (image, clip, made) = (assets.join("images").join("a.png"), assets.join("audio").join("b.wav"), assets.join("generated").join("images").join("c.png"));
            let (new_folder, linked) = (assets.join("images").join("new"), assets.join("images").join("keys.png"));
            let (keys, state, conversation) = (app.join("provider_keys.json"), app.join("app_state.json"), app.join("conversations").join("c.md"));
            for (file, text) in [(&image, "image"), (&clip, "clip"), (&keys, "keys"), (&state, "state"), (&conversation, "conversation")] {
                std::fs::create_dir_all(file.parent().expect("a folder")).expect("create");
                std::fs::write(file, text).expect("write");
            }
            std::fs::create_dir_all(made.parent().expect("a folder")).expect("create");
            // The error of the link goes to /dev/null: its text differs by
            // OS (Landlock gives EXDEV for a link that needs `Refer`).
            let text = format!(
                "/bin/cat '{image}'; echo changed > '{clip}'; echo made > '{made}'; /bin/rm '{image}'; /bin/mkdir '{new_folder}'; /bin/cat '{keys}' '{state}' '{conversation}'; /bin/ln '{keys}' '{linked}' 2>/dev/null",
                image = image.display(),
                clip = clip.display(),
                made = made.display(),
                new_folder = new_folder.display(),
                keys = keys.display(),
                state = state.display(),
                conversation = conversation.display(),
                linked = linked.display(),
            );
            let mut run = in_cache(script(&text, &cache.join("work").join("a")), &cache);
            run.confinement.also_writable = vec![assets.clone()];

            let sent = finished(run).await;

            assert_eq!(sent.stdout, "image", "{NOT_CONFINED}");
            // The delete, the folder, and the three reads.
            assert_eq!(sent.stderr.matches(DENIED).count(), 5, "{}", sent.stderr);
            assert_eq!(std::fs::read(&image).expect("read"), b"image");
            assert_eq!(std::fs::read(&clip).expect("read"), b"changed\n");
            assert_eq!(std::fs::read(&made).expect("read"), b"made\n");
            assert!(!new_folder.exists());
            assert!(!linked.exists());
        }

        // Dez's own file code is not confined: it would follow a link in
        // the folder of a program (the cache root) to any file. So a
        // program can make no symlink there, in place of a temp clip or of
        // a work folder. A hard link to a file outside the folder would
        // open that file to the program itself.
        #[tokio::test]
        async fn a_program_makes_no_link_in_its_folder() {
            let dir = TempDir::new("tools-run-no-link");
            let inside = dir.0.join("cache");
            let folder = inside.join("work").join("a");
            let (clip, hard) = (inside.join("media").join("clip.txt"), inside.join("media").join("hard.txt"));
            let (keys, home) = (dir.0.join("provider_keys.json"), dir.0.join("home"));
            std::fs::create_dir_all(clip.parent().expect("a folder")).expect("create");
            std::fs::create_dir_all(&home).expect("create");
            std::fs::write(&clip, b"clip").expect("write");
            std::fs::write(&keys, b"keys").expect("write");
            // The error of the hard link goes to /dev/null: its text differs
            // by OS (Landlock gives EXDEV for a link that needs `Refer`).
            let text = format!(
                "/bin/rm ../../media/clip.txt; /bin/ln -s '{keys}' ../../media/clip.txt; /bin/ln -s '{home}' ../b; /bin/ln '{keys}' ../../media/hard.txt 2>/dev/null",
                keys = keys.display(),
                home = home.display(),
            );
            let run = in_cache(script(&text, &folder), &inside);

            let sent = finished(run).await;

            // The two symlinks.
            assert_eq!(sent.stderr.matches(DENIED).count(), 2, "{}", sent.stderr);
            // The program could delete the clip, as the rule lets it.
            assert!(std::fs::symlink_metadata(&clip).is_err(), "{}", sent.stderr);
            assert!(std::fs::symlink_metadata(inside.join("work").join("b")).is_err());
            assert!(!hard.exists());
        }

        // The folder of a script app, as a Deno run gets it: the program
        // reads, makes, renames, and deletes files and folders there. It
        // makes no symlink there and, on Linux, no hard link from or to
        // another folder: such a link would keep a file of the work folder
        // open to the app after Dez stored it.
        #[tokio::test]
        async fn a_program_owns_its_app_folder_but_links_nothing_into_or_out_of_it() {
            let dir = TempDir::new("tools-run-app-folder");
            let (app, folder, home) = (dir.0.join("config").join("apps").join("a"), dir.0.join("cache").join("work").join("a"), dir.0.join("home"));
            std::fs::create_dir_all(&app).expect("create");
            std::fs::create_dir_all(&home).expect("create");
            std::fs::write(app.join("data.txt"), b"data").expect("write");
            std::fs::write(app.join("old.txt"), b"old").expect("write");
            // The errors of the hard links go to /dev/null: their text
            // differs by OS (Landlock gives EXDEV for a link that needs
            // `Refer`).
            let text = format!(
                "/bin/cat '{app}/data.txt'; echo made > '{app}/made.txt'; /bin/mv '{app}/made.txt' '{app}/renamed.txt'; /bin/mkdir '{app}/sub'; echo below > '{app}/sub/below.txt'; /bin/rm '{app}/old.txt'; \
                 /bin/ln -s '{home}' '{app}/link'; echo work > work.txt; /bin/ln work.txt '{app}/hard.txt' 2>/dev/null; /bin/ln '{app}/data.txt' hard.txt 2>/dev/null",
                app = app.display(),
                home = home.display(),
            );
            let mut run = script(&text, &folder);
            run.confinement.also_owned = vec![app.clone()];

            let sent = finished(run).await;

            assert_eq!(sent.stdout, "data", "{NOT_CONFINED}");
            assert_eq!(std::fs::read(app.join("renamed.txt")).expect("read"), b"made\n", "{}", sent.stderr);
            assert_eq!(std::fs::read(app.join("sub").join("below.txt")).expect("read"), b"below\n", "{}", sent.stderr);
            assert!(!app.join("made.txt").exists() && !app.join("old.txt").exists(), "{}", sent.stderr);
            // The symlink.
            assert_eq!(sent.stderr.matches(DENIED).count(), 1, "{}", sent.stderr);
            assert!(std::fs::symlink_metadata(app.join("link")).is_err());
            #[cfg(target_os = "linux")]
            assert!(!app.join("hard.txt").exists() && !folder.join("hard.txt").exists());
        }

        // The OS rule on files does not cover a change of the mode or the
        // times of a file by its path (Landlock), so the rule on system
        // calls refuses those: a program must not open the API keys file
        // to every user of the computer.
        #[tokio::test]
        async fn a_program_changes_no_mode_and_no_time_of_a_file_outside_its_folder() {
            let dir = TempDir::new("tools-run-file-facts");
            let keys = dir.0.join("provider_keys.json");
            std::fs::write(&keys, b"keys").expect("write");
            std::fs::set_permissions(&keys, std::fs::Permissions::from_mode(0o600)).expect("chmod");
            let modified = std::fs::metadata(&keys).expect("stat").modified().expect("time");
            let text = format!("/bin/chmod 644 '{keys}'; /bin/touch -t 200101010000 '{keys}'; echo done", keys = keys.display());

            let sent = finished(script(&text, &dir.0.join("work"))).await;

            assert_eq!(sent.stdout, "done\n", "{}", sent.stderr);
            assert_eq!(mode_of(&keys), 0o600, "{}", sent.stderr);
            assert_eq!(std::fs::metadata(&keys).expect("stat").modified().expect("time"), modified, "{}", sent.stderr);
        }

        // A program reaches no server, also not one of the computer itself:
        // the texts for a TCP port and a UDP port of the test never come.
        // bash opens a socket for a `/dev/tcp/…` or `/dev/udp/…` path.
        #[tokio::test]
        async fn a_program_has_no_network() {
            let dir = TempDir::new("tools-run-no-network");
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("listen");
            let datagrams = std::net::UdpSocket::bind("127.0.0.1:0").expect("bind");
            listener.set_nonblocking(true).expect("non-blocking");
            datagrams.set_nonblocking(true).expect("non-blocking");
            let text = format!(
                "echo text > /dev/tcp/127.0.0.1/{}; echo text > /dev/udp/127.0.0.1/{}; echo done",
                listener.local_addr().expect("address").port(),
                datagrams.local_addr().expect("address").port(),
            );

            let sent = finished(program_run("/bin/bash", &["-c", &text], &dir.0.join("work"))).await;

            assert_eq!(sent.stdout, "done\n", "{}", sent.stderr);
            let nothing_came = Err(std::io::ErrorKind::WouldBlock);
            assert_eq!(listener.accept().map(|_| ()).map_err(|error| error.kind()), nothing_came, "{}", sent.stderr);
            assert_eq!(datagrams.recv_from(&mut [0; 16]).map(|_| ()).map_err(|error| error.kind()), nothing_came, "{}", sent.stderr);
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
            assert!(runs.lock().active.is_empty());
        }

        // A program can start another program that keeps on after the
        // first ends. The end of a run, at an exit or at the time limit,
        // ends it too: else it could still write files.
        #[tokio::test]
        async fn the_end_of_a_run_ends_the_programs_that_its_program_started() {
            let dir = TempDir::new("tools-run-group");
            let (exits, times_out) = (dir.0.join("exits"), dir.0.join("times-out"));
            let start_one = "/bin/sleep 60 > /dev/null 2>&1 & echo $! > pid";
            let mut timed = script(&format!("{start_one}; echo started; exec /bin/sleep 60"), &times_out);
            timed.timeout = Duration::from_millis(500);

            assert_eq!(finished(script(start_one, &exits)).await.ends, exited(0));
            assert_eq!(finished(timed).await.ends, [ToolRunEnd::TimedOut]);

            for folder in [&exits, &times_out] {
                assert!(program_ended(folder).await, "{}", folder.display());
            }
        }

        // The input copies run on a blocking thread, and a fast copy could
        // end before the run first looks at it: the run would then start
        // its program before the cancel. So the runtime has one blocking
        // thread, which the test holds until after the cancel, and the
        // copies wait for it. The program of the run is not there: a try to
        // start it fails at once. A real program would show nothing, as the
        // stop ends it before it can write a file.
        #[test]
        fn a_cancel_during_the_input_copies_starts_no_program() {
            let runtime = tokio::runtime::Builder::new_current_thread().max_blocking_threads(1).enable_all().build().expect("runtime");
            runtime.block_on(async {
                let dir = TempDir::new("tools-run-early-cancel");
                let source = dir.0.join("source.txt");
                let folder = dir.0.join("work");
                std::fs::write(&source, b"input text").expect("write");
                let runs = ToolRuns::default();
                let (send, events) = event_channel();
                let mut run = program_run(dir.0.join("no-program").to_str().expect("UTF-8 path"), &[], &folder);
                run.inputs = vec![input("in.txt", &source)];
                let (held, holding) = tokio::sync::oneshot::channel();
                let (release, released) = std::sync::mpsc::channel::<()>();
                let hold = tokio::task::spawn_blocking(move || {
                    let _ = held.send(());
                    let _ = released.recv();
                });
                holding.await.expect("the blocking thread is held");

                let (result, ()) = tokio::join!(biased; runs.run("a", run, send), async {
                    runs.cancel("a");
                    release.send(()).expect("release the blocking thread");
                });

                hold.await.expect("the hold ends");
                assert_eq!(result, Ok(()));
                assert_eq!(sent(events).await, Sent { ends: vec![ToolRunEnd::Cancelled], ..Sent::default() });
                assert!(folder.join("in.txt").is_file());
            });
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

        // Tauri runs each command as its own task, so the cancel of a run
        // can come before the run. Most kept cancels are of runs that had
        // ended, so only the newest few stay.
        #[tokio::test]
        async fn a_cancel_that_comes_before_its_run_stops_it_while_it_is_kept() {
            let dir = TempDir::new("tools-run-cancel-first");
            let (newest_folder, oldest_folder) = (dir.0.join("newest"), dir.0.join("oldest"));
            let runs = ToolRuns::default();
            let (newest_send, newest_events) = event_channel();
            let (oldest_send, oldest_events) = event_channel();
            runs.cancel("oldest");
            for index in 0..KEPT_CANCELS {
                runs.cancel(&format!("newer-{index}"));
            }
            let newest = format!("newer-{}", KEPT_CANCELS - 1);

            assert_eq!(runs.run(&newest, script("echo ran > ran.txt", &newest_folder), newest_send).await, Ok(()));
            assert_eq!(runs.run("oldest", script("echo ran > ran.txt", &oldest_folder), oldest_send).await, Ok(()));

            assert_eq!(sent(newest_events).await, Sent { ends: vec![ToolRunEnd::Cancelled], ..Sent::default() });
            assert!(!newest_folder.join("ran.txt").exists());
            assert_eq!(sent(oldest_events).await.ends, exited(0));
            assert!(oldest_folder.join("ran.txt").is_file());
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
                    assert!(runs.lock().active.is_empty());
                    assert!(!program_is_running(&folder_a));
                    assert!(!program_is_running(&folder_b));
                },
            );

            assert_eq!((a, b), (Ok(()), Ok(())));
            assert_eq!(sent(events_a).await.ends, [ToolRunEnd::Cancelled]);
            assert_eq!(sent(events_b).await.ends, [ToolRunEnd::Cancelled]);
        }

        // The folder of the real bundled programs. tauri-build copies the
        // programs next to the Dez program of the build (`target/<profile>/`).
        // The folder of the test program below it depends on the version
        // of cargo (`deps/` before Rust 1.100, a folder deep in `build/`
        // since), so the programs are in the first folder above the test
        // program that holds them.
        fn real_tools() -> PathBuf {
            let test_dir = tools_dir().expect("the folder of the test program");
            test_dir
                .ancestors()
                .find(|dir| BUNDLED_TOOLS.iter().all(|tool| dir.join(tool).is_file()))
                .unwrap_or_else(|| panic!("No folder above {} holds the bundled programs", test_dir.display()))
                .to_path_buf()
        }

        // The files of the small copy of the resource dir that `real_roots`
        // makes, as paths in it, with their texts: a library of the import
        // map, the map, a font, and a file of a built-in app.
        const FAKE_LIB_TEXT: &str = "shipped lib";
        const FAKE_SHIPPED_FILES: [(&str, &str); 4] = [
            ("libs/import_map.json", r#"{ "imports": { "dez-test-lib": "./test-lib/mod.js" } }"#),
            ("libs/test-lib/mod.js", "export const text = 'shipped lib'\n"),
            ("fonts/test.ttf", "font bytes"),
            ("builtin-apps/dez-built-in/data.txt", "built-in data"),
        ];

        // The folders of the runs of the real bundled programs, in `dir`: a
        // cache root, an app folder, and a small resource dir with the
        // files of `FAKE_SHIPPED_FILES`, which a run that the OS rule does
        // not hold can change with no harm to the build.
        fn real_roots(dir: &Path) -> Roots {
            let roots = Roots { tools: real_tools(), cache: dir.join("cache"), app: dir.join("config"), resources: dir.join("resources") };
            for (file, text) in FAKE_SHIPPED_FILES {
                let path = roots.resources.join(file);
                std::fs::create_dir_all(path.parent().expect("a folder")).expect("create");
                std::fs::write(&path, text).expect("write");
            }
            roots
        }

        // The folders of the runs of the real bundled programs, in `dir`,
        // with the real libraries and fonts: in a build, tauri-build copies
        // the resources next to the programs too.
        fn shipped_roots(dir: &Path) -> Roots {
            let tools = real_tools();
            Roots { resources: tools.clone(), tools, cache: dir.join("cache"), app: dir.join("config") }
        }

        // A run of a real bundled program as `run_bundled_tool` makes it,
        // in the folder `folder` of the cache root.
        fn bundled_run(roots: &Roots, tool: &str, args: &[&str], folder: &str) -> ProgramRun {
            resolved_run(tool_run(tool, args, folder), roots).expect("a run that the rules allow")
        }

        // A run of the real Deno with `text` as its script, which Dez
        // copies into the work folder `work/<name>` as an input.
        fn deno_run(dir: &Path, name: &str, text: &str) -> ToolRun {
            let source = dir.join(format!("{name}.ts"));
            std::fs::write(&source, text).expect("write the script");
            ToolRun { inputs: vec![input("main.ts", &source)], ..tool_run("dez-deno", &["main.ts"], &format!("work/{name}")) }
        }

        // The real programs, as a tool call runs them: ffmpeg makes a file,
        // and ffprobe reads a copy of it as its input. The source of the
        // input is outside the folder of the confined ffprobe, as a file
        // that the user linked is: Dez copies it before the program starts,
        // so the program needs no right on the folder of the source.
        #[tokio::test]
        async fn the_bundled_programs_run_and_read_an_input_copy() {
            let dir = TempDir::new("tools-run-bundled");
            let roots = real_roots(&dir.0);
            let linked = dir.0.join("linked.wav");

            let make = ["-hide_banner", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", "tone.wav"];
            let ffmpeg = finished(bundled_run(&roots, "dez-ffmpeg", &make, "made")).await;

            assert_eq!(ffmpeg.ends, exited(0), "{}", ffmpeg.stderr);
            assert_eq!(ffmpeg.stdout, "");
            assert!(ffmpeg.stderr.contains("tone.wav"), "{}", ffmpeg.stderr);
            std::fs::rename(roots.cache.join("made").join("tone.wav"), &linked).expect("move");

            let read = ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", "in.wav"];
            let mut probe = bundled_run(&roots, "dez-ffprobe", &read, "probe");
            probe.inputs = vec![input("in.wav", &linked)];
            let ffprobe = finished(probe).await;

            assert_eq!(ffprobe, Sent { stdout: "0.200000\n".to_string(), ends: exited(0), ..Sent::default() });
        }

        // The real Deno, as a tool call runs it: a TypeScript file of its
        // work folder, with the time zone of the user, and with the texts
        // of the page on its input.
        #[tokio::test]
        async fn deno_runs_a_script_with_the_time_zone_and_the_input_of_its_run() {
            let dir = TempDir::new("tools-run-deno");
            let roots = real_roots(&dir.0);
            let text = r#"
                const zone: string = Intl.DateTimeFormat().resolvedOptions().timeZone
                console.log(`ready in ${zone}`)
                const decoder = new TextDecoder()
                for await (const piece of Deno.stdin.readable) {
                  const line = decoder.decode(piece).trim()
                  if (line === 'end') Deno.exit(3)
                  console.log(`got ${line}`)
                }
            "#;
            let run = ToolRun { stdin: true, time_zone: Some("Asia/Tokyo".to_string()), ..deno_run(&dir.0, "a", text) };
            let run = resolved_run(run, &roots).expect("a run that the rules allow");
            let runs = ToolRuns::default();
            let (send, mut events) = event_channel();

            let (result, ()) = tokio::join!(runs.run("a", run, send), async {
                wait_for_output(&mut events, "ready in Asia/Tokyo").await;
                assert_eq!(runs.write_input("a", "one\n".to_string()).await, Ok(()));
                wait_for_output(&mut events, "got one").await;
                assert_eq!(runs.write_input("a", "end\n".to_string()).await, Ok(()));
            });

            assert_eq!(result, Ok(()));
            let sent = sent(events).await;
            assert_eq!((sent.ends, sent.stderr.as_str()), (exited(3), ""));
        }

        // The two guards of a Deno run. Deno's own permissions: a script
        // reads and writes its work folder, its app folder, and the folder
        // of its conversation, reads a built-in app and the fonts, and
        // opens no other file; the code of a model (no app) opens only the
        // folder of its conversation. Every run imports the libraries by
        // their import map, but reads none of their files. The OS rule: an
        // `import`, which Deno's file permissions do not cover, loads no
        // file from outside the places of the run.
        #[tokio::test]
        async fn deno_opens_only_the_places_of_its_run() {
            let dir = TempDir::new("tools-run-deno-files");
            let roots = real_roots(&dir.0);
            let app = roots.app.join(APPS_FOLDER).join("my-app");
            let built_in = roots.resources.join(BUILT_IN_APPS_FOLDER).join("dez-built-in");
            let conversation = roots.app.join(CONVERSATION_WORK_FOLDERS).join("c-1");
            let private = dir.0.join("private.ts");
            std::fs::create_dir_all(&app).expect("create");
            std::fs::write(app.join("data.txt"), "app data").expect("write");
            std::fs::write(&private, "export const text = 'private text'\n").expect("write");
            // What each open gives: its text, or the name of its error. The
            // script names each file by the path that Dez joined from its
            // root, as the code of an app does (`dez.appFolder`,
            // appInvoke.ts): Deno checks a path against its flags as text,
            // and finds a relative path from the real path of its folder,
            // which is another text when a folder above is a link (macOS:
            // `/var` of the temp folder is a link to `/private/var`).
            let path_text = |path: &Path| serde_json::to_string(path.to_str().expect("UTF-8 path")).expect("JSON");
            let opens = |name: &str, app: &Path| {
                let (work, app, outside) = (path_text(&roots.cache.join(WORK_ROOT).join(name)), path_text(app), path_text(&private));
                let (conversation, resources) = (path_text(&conversation), path_text(&roots.resources));
                format!(
                    r#"
                    import {{ text }} from 'dez-test-lib'
                    const outcome = (open: () => Promise<unknown>) => open().then(String, (error) => error.name)
                    const work = {work}
                    const app = {app}
                    const conversation = {conversation}
                    const resources = {resources}
                    const outside = {outside}
                    console.log([
                      await outcome(() => Deno.writeTextFile(work + '/made.txt', 'made').then(() => Deno.readTextFile(work + '/made.txt'))),
                      await outcome(() => Deno.readTextFile(app + '/data.txt')),
                      await outcome(() => Deno.writeTextFile(app + '/new.txt', 'new').then(() => 'written')),
                      await outcome(() => Deno.writeTextFile(conversation + '/made.txt', 'made').then(() => Deno.readTextFile(conversation + '/made.txt'))),
                      await outcome(() => Deno.readTextFile(resources + '/fonts/test.ttf')),
                      await outcome(() => Deno.readTextFile(resources + '/libs/test-lib/mod.js')),
                      await outcome(() => Deno.readTextFile(outside)),
                      await outcome(() => Deno.writeTextFile(outside, 'changed').then(() => 'written')),
                      text,
                    ].join(', '))
                    "#
                )
            };
            let import = "import { text } from '../../../private.ts'\nconsole.log(text)\n";
            let run = |run: ToolRun| finished(resolved_run(run, &roots).expect("a run that the rules allow"));
            let in_conversation = |run: ToolRun| ToolRun { conversation_folder: Some("c-1".to_string()), ..run };
            let lib = format!(", NotCapable, NotCapable, NotCapable, {FAKE_LIB_TEXT}\n");

            let with_app = run(in_conversation(ToolRun { app_folder: Some("my-app".to_string()), ..deno_run(&dir.0, "with-app", &opens("with-app", &app)) })).await;
            assert_eq!(with_app.stdout, format!("made, app data, written, made, font bytes{lib}"), "{}", with_app.stderr);
            assert_eq!(std::fs::read(app.join("new.txt")).expect("read"), b"new");

            let built_in_run = ToolRun { built_in_app: Some("dez-built-in".to_string()), ..deno_run(&dir.0, "built-in", &opens("built-in", &built_in)) };
            let with_built_in = run(in_conversation(built_in_run)).await;
            assert_eq!(with_built_in.stdout, format!("made, built-in data, NotCapable, made, font bytes{lib}"), "{}", with_built_in.stderr);
            assert!(!built_in.join("new.txt").exists());

            // The code of a model.
            let model_code = run(in_conversation(deno_run(&dir.0, "model-code", &opens("model-code", &app)))).await;
            assert_eq!(model_code.stdout, format!("NotCapable, NotCapable, NotCapable, made, NotCapable{lib}"), "{}", model_code.stderr);

            let without_places = run(deno_run(&dir.0, "without-places", &opens("without-places", &app))).await;
            assert_eq!(without_places.stdout, format!("NotCapable, NotCapable, NotCapable, NotCapable, NotCapable{lib}"), "{}", without_places.stderr);

            let imported = run(ToolRun { app_folder: Some("my-app".to_string()), ..deno_run(&dir.0, "import", import) }).await;
            assert_eq!(imported.stdout, "", "{NOT_CONFINED}");
            assert_ne!(imported.ends, exited(0), "{}", imported.stderr);
            assert!(imported.stderr.contains(DENIED), "{}", imported.stderr);
            assert_eq!(std::fs::read(&private).expect("read"), b"export const text = 'private text'\n");
        }

        // The libraries that Dez ships load in a run by the names of their
        // import map, under the OS rule, with no permission of Deno: the
        // code of a model with no conversation has none.
        #[tokio::test]
        async fn deno_imports_the_libraries_that_dez_ships() {
            let dir = TempDir::new("tools-run-deno-libs");
            let roots = shipped_roots(&dir.0);
            let text = r#"
                import * as THREE from 'three'
                import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
                import { Chart } from 'chart.js'
                import { color } from 'chart.js/helpers'
                import FFT from 'fft.js'
                const fft = new FFT(8)
                const out = fft.createComplexArray()
                fft.realTransform(out, [1, 1, 1, 1, 1, 1, 1, 1])
                console.log([new THREE.Vector3(1, 2, 2).length(), typeof OrbitControls, typeof Chart, color('#ff0000').rgbString(), out[0]].join(', '))
            "#;

            let sent = finished(resolved_run(deno_run(&dir.0, "a", text), &roots).expect("a run that the rules allow")).await;

            assert_eq!(sent.stdout, "3, function, function, rgb(255, 0, 0), 8\n", "{}", sent.stderr);
            assert_eq!(sent.ends, exited(0), "{}", sent.stderr);
        }

        // The native library of skia-canvas loads in a run of an app that
        // asks for it, from a folder that the run can only read, and draws.
        // Its code opens files with no check of Deno, so the OS rule is the
        // only guard of its file calls: it reads the fonts that Dez ships
        // and writes into the work folder, but reads and writes no file
        // outside the places of the run.
        #[tokio::test]
        async fn the_native_canvas_of_an_app_reads_and_writes_only_the_places_of_its_run() {
            let dir = TempDir::new("tools-run-deno-canvas");
            let roots = shipped_roots(&dir.0);
            let app = roots.app.join(APPS_FOLDER).join("my-app");
            std::fs::create_dir_all(&app).expect("create");
            let (outside_font, outside_image) = (dir.0.join("private.ttf"), dir.0.join("private.png"));
            std::fs::copy(roots.resources.join(FONTS_FOLDER).join("NotoSans-Regular.ttf"), &outside_font).expect("copy");
            let path_text = |path: &Path| serde_json::to_string(path.to_str().expect("UTF-8 path")).expect("JSON");
            let text = format!(
                r#"
                import {{ Canvas, FontLibrary }} from 'skia-canvas'
                const outcome = (work: () => unknown) => Promise.resolve().then(work).then((value) => `ok ${{value}}`, (error) => `${{error.name}}: ${{error.message}}`)
                const fonts = {fonts}
                const canvas = new Canvas(64, 32, {{ gpu: false }})
                const context = canvas.getContext('2d')
                context.fillStyle = '#ff0000'
                context.fillRect(0, 0, 64, 32)
                console.log(`pixel: ${{context.getImageData(1, 1, 1, 1).data.join(' ')}}`)
                console.log(`shipped font: ${{await outcome(() => FontLibrary.use('Shipped', [fonts + '/NotoSans-Regular.ttf']).map((font) => font.family).join(' '))}}`)
                console.log(`own file: ${{await outcome(() => canvas.toFile('made.png').then(() => Deno.statSync('made.png').size > 0))}}`)
                console.log(`variable of skia-canvas: ${{await outcome(() => Deno.env.get('LANG'))}}`)
                console.log(`other variable: ${{await outcome(() => Deno.env.get('HOME'))}}`)
                console.log(`outside font: ${{await outcome(() => FontLibrary.use('Outside', [{outside_font}]).map((font) => font.family).join(' '))}}`)
                console.log(`outside file: ${{await outcome(() => canvas.toFile({outside_image}))}}`)
                "#,
                fonts = path_text(&roots.resources.join(FONTS_FOLDER)),
                outside_font = path_text(&outside_font),
                outside_image = path_text(&outside_image),
            );
            let run = ToolRun { app_folder: Some("my-app".to_string()), native_canvas: true, ..deno_run(&dir.0, "a", &text) };

            let sent = finished(resolved_run(run, &roots).expect("a run that the rules allow")).await;

            assert_eq!(sent.ends, exited(0), "{}\n{}", sent.stdout, sent.stderr);
            let lines: Vec<&str> = sent.stdout.lines().collect();
            let fixed = ["pixel: 255 0 0 255", "shipped font: ok Shipped", "own file: ok true", "variable of skia-canvas: ok undefined"];
            assert_eq!(lines[..4], fixed, "{}", sent.stderr);
            assert!(lines[4].starts_with("other variable: NotCapable"), "{}", sent.stdout);
            // Native code gets the error of the OS (Linux: EACCES of
            // Landlock; macOS: EPERM of Seatbelt), with no check of Deno.
            let os_refused = |line: &str, name: &str| line.starts_with(&format!("{name}: Error:")) && (line.contains("Permission denied") || line.contains("Operation not permitted"));
            assert!(lines.len() == 7 && os_refused(lines[5], "outside font") && os_refused(lines[6], "outside file"), "{NOT_CONFINED}\n{}", sent.stdout);
            assert!(!outside_image.exists(), "{NOT_CONFINED}");
        }

        // Two flags of a Deno run, with the real Deno and the command line
        // that Dez builds. `--no-remote`: Deno itself allows an import
        // from a few hosts, and the flag refuses it before any request.
        // `--no-config`: a `deno.json` in the work folder does not change
        // what an import means. The last import shows that the files of
        // the config are there.
        // `--no-prompt` and `--no-lock` have no test: a run has no terminal
        // to ask on, and Deno reads a lock file only next to a config file.
        #[tokio::test]
        async fn deno_loads_no_code_from_the_network_and_reads_no_config_file() {
            let dir = TempDir::new("tools-run-deno-flags");
            let roots = real_roots(&dir.0);
            let (config, mapped) = (dir.0.join("deno.json"), dir.0.join("mapped.ts"));
            std::fs::write(&config, r#"{ "imports": { "mapped": "./mapped.ts" } }"#).expect("write");
            std::fs::write(&mapped, "export const text = 'mapped'\n").expect("write");
            // Each import names its module in the code: Deno's permissions
            // cover an import of a name that the script computes.
            let text = r#"
                // The error of a bare name ends with the path of the
                // script, which differs in each test folder.
                const outcome = (module: Promise<{ text?: string }>) => module.then((module) => `loaded ${module.text}`, (error) => error.message.split('\n')[0].replace(/ from "file:.*$/, ''))
                console.log(await outcome(import('https://deno.land/x/dez_audit/mod.ts')))
                console.log(await outcome(import('mapped')))
                console.log(await outcome(import('./mapped.ts')))
            "#;
            let mut run = deno_run(&dir.0, "a", text);
            run.inputs.extend([input("deno.json", &config), input("mapped.ts", &mapped)]);

            let sent = finished(resolved_run(run, &roots).expect("a run that the rules allow")).await;

            let lines = [
                r#"A remote specifier was requested: "https://deno.land/x/dez_audit/mod.ts", but --no-remote is specified."#,
                r#"Import "mapped" not a dependency and not in import map"#,
                "loaded mapped",
            ];
            assert_eq!(sent.stdout, lines.join("\n") + "\n", "{}", sent.stderr);
            assert_eq!(sent.ends, exited(0), "{}", sent.stderr);
        }

        // The heap limit of V8, the only memory limit of a run on macOS: a
        // script whose objects grow without end is ended near 512 MB. On
        // Linux the data limit ends the same script when the heap flag is
        // gone, with the same first words of V8, but only at about 1.7 GB.
        // So the test reads the size of the heap.
        #[tokio::test]
        async fn deno_ends_a_script_whose_objects_grow_past_the_heap_limit() {
            let dir = TempDir::new("tools-run-deno-heap");
            let roots = real_roots(&dir.0);
            let text = r#"
                const all: number[][] = []
                for (;;) {
                  all.push(new Array(100_000).fill(all.length))
                  if (all.length % 50 === 0) console.log(Deno.memoryUsage().heapUsed)
                }
            "#;

            let sent = finished(resolved_run(deno_run(&dir.0, "a", text), &roots).expect("a run that the rules allow")).await;

            let largest = sent.stdout.lines().filter_map(|line| line.parse::<u64>().ok()).max().expect("the size of the heap");
            assert!((400_000_000..600_000_000).contains(&largest), "the heap had {largest} bytes\n{}", sent.stderr);
            assert!(sent.stderr.contains("Fatal JavaScript out of memory"), "{}", sent.stderr);
            assert_eq!(sent.ends, [ToolRunEnd::Exited { code: None }]);
        }

        // The data limit of a Deno run (Linux). The heap limit of V8 does
        // not count the bytes of a typed array, so the data limit is their
        // end, and it is an error that the script can catch.
        #[cfg(target_os = "linux")]
        #[tokio::test]
        async fn deno_gets_no_more_memory_than_its_data_limit() {
            let dir = TempDir::new("tools-run-deno-memory");
            let roots = real_roots(&dir.0);
            let text = r#"
                const megabytes = (count: number) => new Uint8Array(count * 1024 * 1024).length > 0
                console.log(megabytes(256))
                try {
                  console.log(megabytes(3 * 1024))
                } catch (error) {
                  console.log(error instanceof RangeError ? 'refused' : String(error))
                }
            "#;

            let sent = finished(resolved_run(deno_run(&dir.0, "a", text), &roots).expect("a run that the rules allow")).await;

            assert_eq!(sent, Sent { stdout: "true\nrefused\n".to_string(), ends: exited(0), ..Sent::default() });
        }

        // The real programs read a clip of their folder by its path, and
        // cannot read or write a file outside it: not by a path in their
        // arguments, and not by a path in the content of an input (an HLS
        // playlist, which passes the argument checks of the page).
        #[tokio::test]
        async fn the_bundled_programs_cannot_open_a_file_outside_their_folder() {
            let dir = TempDir::new("tools-run-bundled-confined");
            let roots = real_roots(&dir.0);
            let inside = &roots.cache;
            let (clip, outside) = (inside.join("made").join("tone.ts"), dir.0.join("tone.ts"));
            let make = ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", "-c:a", "mp2", "tone.ts"];
            assert_eq!(finished(bundled_run(&roots, "dez-ffmpeg", &make, "made")).await.ends, exited(0));
            std::fs::copy(&clip, &outside).expect("copy");
            let path = |path: &Path| path.to_str().expect("UTF-8 path").to_string();
            let probe = |name: &str, file: &str| {
                let args = ["-v", "error", "-show_entries", "format=format_name", "-of", "csv=p=0", file];
                bundled_run(&roots, "dez-ffprobe", &args, name)
            };

            let read = finished(probe("inside", &path(&clip))).await;
            assert_eq!(read, Sent { stdout: "mpegts\n".to_string(), ends: exited(0), ..Sent::default() });
            let refused = finished(probe("outside", &path(&outside))).await;
            assert_ne!(refused.ends, exited(0), "{NOT_CONFINED}");
            assert!(refused.stderr.contains(DENIED), "{}", refused.stderr);

            let playlist = |segment: &Path| format!("#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:0.2,\n{}\n#EXT-X-ENDLIST\n", segment.display());
            let hls = inside.join("hls");
            std::fs::create_dir_all(&hls).expect("create");
            std::fs::write(hls.join("inside.m3u8"), playlist(&clip)).expect("write");
            std::fs::write(hls.join("outside.m3u8"), playlist(&outside)).expect("write");
            let copy = |list: &str, output: &str| bundled_run(&roots, "dez-ffmpeg", &["-v", "error", "-f", "hls", "-i", list, "-c", "copy", output], "hls");
            let copied = finished(copy("inside.m3u8", "inside.mkv")).await;
            assert_eq!(copied.ends, exited(0), "{}", copied.stderr);
            // The hls demuxer does not pass on the cause of a failed open:
            // the run of the same playlist with the clip inside shows it.
            let refused = finished(copy("outside.m3u8", "outside.mkv")).await;
            assert_ne!(refused.ends, exited(0));
            assert!(refused.stderr.contains("Error when loading first segment"), "{}", refused.stderr);
            assert!(!hls.join("outside.mkv").exists());

            let written = dir.0.join("written.wav");
            let write = ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", &path(&written)];
            let refused = finished(bundled_run(&roots, "dez-ffmpeg", &write, "write")).await;
            assert_ne!(refused.ends, exited(0));
            assert!(refused.stderr.contains(DENIED), "{}", refused.stderr);
            assert!(!written.exists());
        }

        // The audit of the OS rule (confinement.rs). The tests below take
        // away the guard of Deno: a script runs with every permission of
        // Deno, and then with native code, which a bug of V8 can give a
        // script. So each refusal here is one of the OS rule alone. The
        // escapes that Deno's own flags stop, and the limits of a run, are
        // in tests/e2e/js-eval-sandbox.e2e.ts.

        // A Deno run with every permission of Deno. No run of the app has
        // them: Rust builds the flags (`DENO_RULES`), and no word of the
        // page is one. Deno refuses `--allow-all` next to the other
        // `--allow` flags, so those go. The import map stays: it gives no
        // permission.
        fn with_every_permission(mut run: ProgramRun) -> ProgramRun {
            run.args.retain(|arg| !arg.starts_with("--allow-"));
            run.args.insert(1, "--allow-all".to_string());
            run
        }

        // The text of each file that no run may read.
        const PRIVATE: &str = "private text";

        // The files of an audit that are outside the places of its run
        // (the work folder `cache/work/a`, an app folder, and the folder
        // `config/work/c-1` of its conversation), as paths in the folder of
        // the test: a file of the user, the files of the Dez folder,
        // another app, another run, a temp clip, and the folder of another
        // conversation.
        const PRIVATE_FILES: [&str; 9] = [
            "private.txt",
            "config/provider_keys.json",
            "config/app_state.json",
            "config/conversations/c.md",
            "config/assets/images/a.png",
            "config/apps/other/data.txt",
            "config/work/other/data.txt",
            "cache/work/other/data.txt",
            "cache/media/clip.txt",
        ];

        // The folders of an audit that no run may list or make a file in.
        const PRIVATE_FOLDERS: [&str; 12] = [
            ".",
            "cache",
            "cache/work",
            "cache/work/other",
            "config",
            "config/apps",
            "config/apps/other",
            "config/conversations",
            "config/work",
            "config/work/other",
            "resources",
            "resources/builtin-apps",
        ];

        // The folders that Dez ships, in the resource dir of `real_roots`:
        // a run reads some of them, and changes none.
        const SHIPPED_FOLDERS: [&str; 4] = ["resources/libs", "resources/libs/test-lib", "resources/fonts", "resources/builtin-apps/dez-built-in"];

        fn write_private_files(dir: &Path) {
            for file in PRIVATE_FILES {
                let path = dir.join(file);
                std::fs::create_dir_all(path.parent().expect("a folder")).expect("create");
                std::fs::write(&path, PRIVATE).expect("write");
            }
        }

        // Every file and folder below `dir` that is not in a folder of
        // `own`, with its mode and the bytes of a file: what an audit run
        // must leave as it was.
        fn files_outside(dir: &Path, own: &[PathBuf]) -> Vec<(PathBuf, u32, Vec<u8>)> {
            let mut files = Vec::new();
            let mut folders = vec![dir.to_path_buf()];
            while let Some(folder) = folders.pop() {
                for entry in std::fs::read_dir(&folder).expect("list") {
                    let path = entry.expect("entry").path();
                    if own.contains(&path) {
                        continue;
                    }
                    let metadata = std::fs::symlink_metadata(&path).expect("stat");
                    // Only a regular file is read: the read of a named
                    // pipe would wait without end.
                    let bytes = if metadata.is_file() { std::fs::read(&path).expect("read") } else { Vec::new() };
                    if metadata.is_dir() {
                        folders.push(path.clone());
                    }
                    files.push((path, metadata.mode(), bytes));
                }
            }
            files.sort();
            files
        }

        // The probes of a Deno script that has every permission of Deno.
        // `__FILES__` is `PRIVATE_FILES`, `__FOLDERS__` `PRIVATE_FOLDERS`,
        // `__SHIPPED__` the files of `FAKE_SHIPPED_FILES`, `__SHIPPED_FOLDERS__`
        // `SHIPPED_FOLDERS`, `__APP__` the app folder of the run, and
        // `__PORT__` a TCP port of the test. A `PermissionDenied` here is a
        // refusal of the OS, as Deno refuses nothing. Every other error
        // shows as it is, so a probe with a mistake does not count as
        // refused.
        const DENO_AUDIT: &str = r#"
            // `fetch` gives the error of the OS as the cause of its own.
            const refused = (error: Error): boolean => error.name === 'PermissionDenied'
              || /Permission denied|Operation not permitted/.test(error.message)
              || (error.cause instanceof Error && refused(error.cause))
            const outcome = (work: () => unknown) => Promise.resolve().then(work).then(
              (value) => `ok ${value}`,
              (error) => refused(error) ? 'refused' : `${error.name}: ${error.message} (${error.cause})`,
            )
            // One line for the probes of a file or a folder: `refused`, or
            // each probe that the OS did not refuse.
            const report = async (name: string, probes: Record<string, () => unknown>) => {
              const open: string[] = []
              for (const [probe, work] of Object.entries(probes)) {
                const result = await outcome(work)
                if (result !== 'refused') open.push(`${probe} ${result}`)
              }
              console.log(`${name}: ${open.join(', ') || 'refused'}`)
            }
            // The probes that change the file `path`.
            const changes = (path: string) => ({
              write: () => Deno.writeTextFile(path, 'changed'),
              append: () => Deno.writeTextFile(path, 'more', { append: true }),
              truncate: () => Deno.truncate(path),
              remove: () => Deno.remove(path),
              rename: () => Deno.rename(path, `${path}.moved`),
              chmod: () => Deno.chmod(path, 0o666),
              'copy over': () => Deno.copyFile('made.txt', path),
            })
            // The folder of the test: the work folder is `cache/work/a`.
            const above = '../../..'
            const conversation = `${above}/config/work/c-1`

            console.log(`own folder: ${await outcome(() => Deno.writeTextFile('made.txt', 'made').then(() => Deno.readTextFile('made.txt')))}`)
            console.log(`app folder: ${await outcome(() => Deno.readTextFile(`${above}/__APP__/data.txt`))}`)
            console.log(`conversation folder: ${await outcome(() => Deno.writeTextFile(`${conversation}/made.txt`, 'made').then(() => Deno.readTextFile(`${conversation}/made.txt`)))}`)
            console.log(`libraries: ${await outcome(() => import('dez-test-lib').then((module) => module.text))}`)
            for (const file of __FILES__) {
              const path = `${above}/${file}`
              await report(file, {
                read: () => Deno.readTextFile(path),
                import: () => import(path, { with: { type: 'text' } }).then((module) => module.default),
                ...changes(path),
                'copy out': () => Deno.copyFile(path, 'copy.txt'),
                symlink: () => Deno.symlink(path, 'link.txt'),
              })
            }
            for (const file of __SHIPPED__) {
              const path = `${above}/${file}`
              console.log(`read ${file}: ${await outcome(() => Deno.readTextFile(path))}`)
              await report(`change ${file}`, changes(path))
            }
            for (const folder of __FOLDERS__) {
              const path = `${above}/${folder}`
              await report(`folder ${folder}`, {
                list: async () => (await Array.fromAsync(Deno.readDir(path))).map((entry) => entry.name).join(' '),
                'make a file': () => Deno.writeTextFile(`${path}/new.txt`, 'new'),
                'make a folder': () => Deno.mkdir(`${path}/new`),
              })
            }
            for (const folder of __SHIPPED_FOLDERS__) {
              const path = `${above}/${folder}`
              await report(`change folder ${folder}`, {
                'make a file': () => Deno.writeTextFile(`${path}/new.txt`, 'new'),
                'make a folder': () => Deno.mkdir(`${path}/new`),
                'make a link': () => Deno.symlink('/', `${path}/link`),
                rename: () => Deno.rename(path, `${path}-moved`),
                remove: () => Deno.remove(path, { recursive: true }),
              })
            }
            await report('imports', {
              module: () => import(`${above}/private.ts`).then((module) => module.text),
              JSON: () => import(`${above}/config/provider_keys.json`, { with: { type: 'json' } }).then((module) => JSON.stringify(module.default)),
            })
            await report('network', {
              connect: () => Deno.connect({ hostname: '127.0.0.1', port: __PORT__ }).then(() => 'connected'),
              fetch: () => fetch('http://127.0.0.1:__PORT__/', { signal: AbortSignal.timeout(2000) }).then(() => 'answered'),
            })
        "#;

        // `DENO_AUDIT` for a run whose app folder is `app`, with `port` as
        // the port of the test.
        fn deno_audit(app: &str, port: u16) -> String {
            let shipped: Vec<String> = FAKE_SHIPPED_FILES.iter().map(|(file, _)| format!("resources/{file}")).collect();
            DENO_AUDIT
                .replace("__FILES__", &json!(PRIVATE_FILES).to_string())
                .replace("__FOLDERS__", &json!(PRIVATE_FOLDERS).to_string())
                .replace("__SHIPPED_FOLDERS__", &json!(SHIPPED_FOLDERS).to_string())
                .replace("__SHIPPED__", &json!(shipped).to_string())
                .replace("__APP__", app)
                .replace("__PORT__", &port.to_string())
        }

        // The lines of `DENO_AUDIT` for a run that the OS rule holds, whose
        // app folder holds `app_data`, and which can read the files of
        // `FAKE_SHIPPED_FILES` that start with one of `readable`.
        fn deno_audit_lines(app_data: &str, readable: &[&str]) -> String {
            let mut lines = vec![
                "own folder: ok made".to_string(),
                format!("app folder: ok {app_data}"),
                "conversation folder: ok made".to_string(),
                format!("libraries: ok {FAKE_LIB_TEXT}"),
            ];
            lines.extend(PRIVATE_FILES.iter().map(|file| format!("{file}: refused")));
            for (file, text) in FAKE_SHIPPED_FILES {
                let read = if readable.iter().any(|start| file.starts_with(start)) { format!("ok {text}") } else { "refused".to_string() };
                lines.extend([format!("read resources/{file}: {read}"), format!("change resources/{file}: refused")]);
            }
            lines.extend(PRIVATE_FOLDERS.iter().map(|folder| format!("folder {folder}: refused")));
            lines.extend(SHIPPED_FOLDERS.iter().map(|folder| format!("change folder {folder}: refused")));
            lines.extend(["imports: refused".to_string(), "network: refused".to_string()]);
            lines.join("\n") + "\n"
        }

        // The end of a Deno script that ran with every permission of Deno
        // in the work folder `cache/work/a`, next to the private files. It
        // fails when the run changed a file outside its work folder, its
        // app folder of `apps/`, and the folder of its conversation, or
        // when it wrote the text of a private file.
        async fn audited(dir: &Path, run: ToolRun) -> Sent {
            let roots = real_roots(dir);
            write_private_files(dir);
            let mut own = vec![roots.cache.join("work").join("a")];
            own.extend(run.app_folder.iter().map(|name| roots.app.join(APPS_FOLDER).join(name)));
            own.extend(run.conversation_folder.iter().map(|id| roots.app.join(CONVERSATION_WORK_FOLDERS).join(id)));
            let run = with_every_permission(resolved_run(run, &roots).expect("a run that the rules allow"));
            let before = files_outside(dir, &own);

            let sent = finished(run).await;

            assert!(files_outside(dir, &own) == before, "the run changed a file outside its folders\n{}\n{}", sent.stdout, sent.stderr);
            assert!(!sent.stdout.contains(PRIVATE) && !sent.stderr.contains(PRIVATE), "{NOT_CONFINED}\n{}\n{}", sent.stdout, sent.stderr);
            sent
        }

        // A script with every permission of Deno reads and changes its work
        // folder, its app folder, and the folder of its conversation, reads
        // the libraries and the fonts, and nothing else: no file of the
        // user or of Dez, no other app, no other run or conversation, no
        // built-in app, and no server. It changes no file that Dez ships.
        #[tokio::test]
        async fn deno_with_every_permission_of_deno_stays_in_the_places_of_its_run() {
            let dir = TempDir::new("tools-audit-deno");
            let app = real_roots(&dir.0).app.join(APPS_FOLDER).join("my-app");
            std::fs::create_dir_all(&app).expect("create");
            std::fs::write(app.join("data.txt"), "app data").expect("write");
            std::fs::write(dir.0.join("private.ts"), format!("export const text = '{PRIVATE}'\n")).expect("write");
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("listen");
            listener.set_nonblocking(true).expect("non-blocking");
            let text = deno_audit("config/apps/my-app", listener.local_addr().expect("address").port());
            let run = ToolRun { app_folder: Some("my-app".to_string()), conversation_folder: Some("c-1".to_string()), ..deno_run(&dir.0, "a", &text) };

            let sent = audited(&dir.0, run).await;

            assert_eq!(sent.stdout, deno_audit_lines("app data", &["libs/", "fonts/"]), "{NOT_CONFINED}\n{}", sent.stderr);
            assert_eq!(sent.ends, exited(0), "{}", sent.stderr);
            assert_eq!(listener.accept().map(|_| ()).map_err(|error| error.kind()), Err(std::io::ErrorKind::WouldBlock));
        }

        // A built-in app is a place that a run with every permission of
        // Deno only reads.
        #[tokio::test]
        async fn deno_with_every_permission_of_deno_changes_nothing_of_a_built_in_app() {
            let dir = TempDir::new("tools-audit-deno-built-in");
            std::fs::write(dir.0.join("private.ts"), format!("export const text = '{PRIVATE}'\n")).expect("write");
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("listen");
            listener.set_nonblocking(true).expect("non-blocking");
            let text = deno_audit("resources/builtin-apps/dez-built-in", listener.local_addr().expect("address").port());
            let run = ToolRun { built_in_app: Some("dez-built-in".to_string()), conversation_folder: Some("c-1".to_string()), ..deno_run(&dir.0, "a", &text) };

            let sent = audited(&dir.0, run).await;

            assert_eq!(sent.stdout, deno_audit_lines("built-in data", &["libs/", "fonts/", "builtin-apps/"]), "{NOT_CONFINED}\n{}", sent.stderr);
            assert_eq!(sent.ends, exited(0), "{}", sent.stderr);
        }

        // One probe of an audit script on Linux: its name, its code (an
        // expression of the script), and its outcome under the OS rule.
        #[cfg(target_os = "linux")]
        type Probe = (&'static str, &'static str, &'static str);

        // The probes as an object of the script: a function for each name.
        #[cfg(target_os = "linux")]
        fn probe_object(probes: &[Probe]) -> String {
            let entries: Vec<String> = probes.iter().map(|(name, code, _)| format!("{}: () => {code}", json!(name))).collect();
            format!("{{\n{}\n}}", entries.join(",\n"))
        }

        // What the script writes when each probe has the outcome of its row.
        #[cfg(target_os = "linux")]
        fn probe_lines(probes: &[Probe]) -> String {
            probes.iter().map(|(name, _, outcome)| format!("{name}: {outcome}\n")).collect()
        }

        // The script of `LINUX_DENO_PROBES`. An outcome holds the name of
        // the error and the error number of the OS: 13 (`EACCES`) is a
        // refusal of Landlock, 1 (`EPERM`) one of the call filter, and 18
        // (`EXDEV`) the answer of Landlock to a link between two folders.
        #[cfg(target_os = "linux")]
        const LINUX_DENO_AUDIT: &str = r#"
            const outcome = (work: () => unknown) => Promise.resolve().then(work).then(
              (value) => `ok ${value}`,
              (error) => `${error.name} ${/os error (\d+)/.exec(error.message)?.[1] ?? error.message}`,
            )
            // The folder of the test: the work folder is `cache/work/a`.
            const above = '../../..'
            const output = (program: string, args: string[]) => new Deno.Command(program, { args }).output().then((output) => new TextDecoder().decode(output.stdout).trim())
            const readsPrivateFile = `Deno.readTextFile('${above}/private.txt').then(console.log, (error) => console.log(error.name))`
            await Deno.writeTextFile('made.txt', 'made')
            const probes: Record<string, () => unknown> = __PROBES__
            for (const [name, work] of Object.entries(probes)) console.log(`${name}: ${await outcome(work)}`)
        "#;

        #[cfg(target_os = "linux")]
        const LINUX_DENO_PROBES: &[Probe] = &[
            ("users of the computer", "Deno.readTextFile('/etc/passwd')", "PermissionDenied 13"),
            ("own variables file", "Deno.readTextFile('/proc/self/environ')", "PermissionDenied 13"),
            ("variables of Dez", "Deno.readTextFile(`/proc/${Deno.ppid}/environ`)", "PermissionDenied 13"),
            ("root folder", "Array.fromAsync(Deno.readDir('/'))", "PermissionDenied 13"),
            ("temp folder", "Array.fromAsync(Deno.readDir('/tmp'))", "PermissionDenied 13"),
            // What the rule gives a run next to its folder is narrow: the
            // loader reads a library by its path and lists no folder, and
            // a run has three device files.
            ("library folder", "Array.fromAsync(Deno.readDir('/usr/lib')).then((entries) => entries.length)", "PermissionDenied 13"),
            ("another device", "Deno.open('/dev/zero').then((file) => file.close())", "PermissionDenied 13"),
            // This run has no app folder, as a `js_eval` run.
            ("file of an app", "Deno.readTextFile(`${above}/config/apps/other/data.txt`)", "PermissionDenied 13"),
            ("mode of an own file", "Deno.chmod('made.txt', 0o777)", "PermissionDenied 1"),
            ("times of an own file", "Deno.utime('made.txt', 0, 0)", "PermissionDenied 1"),
            ("watch of the own folder", "Deno.watchFs('.').close()", "PermissionDenied 1"),
            ("hard link to a private file", "Deno.link(`${above}/private.txt`, 'hard.txt')", "Error 18"),
            ("move of a private file in", "Deno.rename(`${above}/private.txt`, 'moved.txt')", "PermissionDenied 13"),
            ("move of an own file out", "Deno.rename('made.txt', `${above}/moved.txt`)", "PermissionDenied 13"),
            ("Unix socket", "Deno.connect({ transport: 'unix', path: `${above}/socket` }).then(() => 'connected')", "PermissionDenied 1"),
            ("server", "Deno.listen({ port: 0 }).close()", "PermissionDenied 1"),
            ("network interfaces", "Deno.networkInterfaces().length", "PermissionDenied 1"),
            ("shell", "output('/bin/sh', ['-c', 'echo started'])", "PermissionDenied 13"),
            // Deno can start its own program. That Deno has every
            // permission of Deno too, and the same OS rule.
            ("Deno that the script started", "output(Deno.execPath(), ['eval', readsPrivateFile])", "ok PermissionDenied"),
            ("variables", "Object.keys(Deno.env.toObject()).sort().join(' ')", "ok DENO_DIR DENO_NO_UPDATE_CHECK NO_COLOR"),
        ];

        // What a script with every permission of Deno gets of the computer
        // on Linux: no file of the system, nothing of Dez's process, no
        // socket, no other program, and no variable of Dez. A Deno that it
        // starts is under the same rules.
        #[cfg(target_os = "linux")]
        #[tokio::test]
        async fn deno_with_every_permission_of_deno_gets_nothing_of_the_computer() {
            let dir = TempDir::new("tools-audit-linux");
            let socket = std::os::unix::net::UnixListener::bind(dir.0.join("socket")).expect("listen");
            socket.set_nonblocking(true).expect("non-blocking");
            let text = LINUX_DENO_AUDIT.replace("__PROBES__", &probe_object(LINUX_DENO_PROBES));

            let sent = audited(&dir.0, deno_run(&dir.0, "a", &text)).await;

            assert_eq!(sent.stdout, probe_lines(LINUX_DENO_PROBES), "{}", sent.stderr);
            assert_eq!(sent.ends, exited(0), "{}", sent.stderr);
            assert_eq!(socket.accept().map(|_| ()).map_err(|error| error.kind()), Err(std::io::ErrorKind::WouldBlock));
        }

        // The numbers of system calls, by the names of their constants, as
        // the JSON text of an object.
        #[cfg(target_os = "linux")]
        macro_rules! call_numbers {
            ($($name:ident),* $(,)?) => { json!(std::collections::BTreeMap::from([$((stringify!($name), libc::$name)),*])).to_string() };
        }

        // The script of `NATIVE_PROBES`: system calls from native code.
        // Deno loads the C library and calls its `syscall`, so no code of
        // Deno is between the script and the kernel. A bug of V8 can give a
        // script the same. An outcome is `ok` or the name of the error.
        // `__CALLS__` holds the numbers of the calls on this processor,
        // and `__OLD_CALLS__` those of `OLD_NATIVE_PROBES`.
        #[cfg(target_os = "linux")]
        const NATIVE_AUDIT: &str = r#"
            const libc = Deno.dlopen('libc.so.6', {
              __errno_location: { parameters: [], result: 'pointer' },
              syscall: { parameters: ['i64', 'i64', 'i64', 'i64', 'i64', 'i64', 'i64'], result: 'i64' },
            })
            // The calls with a number here have that number on every
            // processor, and the libc crate does not name them.
            const CALLS: Record<string, number> = {
              ...__CALLS__,
              ...__OLD_CALLS__,
              fchmodat2: 452,
              setxattrat: 463,
              getxattrat: 464,
              listxattrat: 465,
              removexattrat: 466,
              file_setattr: 469,
            }
            const ERRORS: Record<number, string> = { 1: 'EPERM', 2: 'ENOENT', 13: 'EACCES', 14: 'EFAULT', 18: 'EXDEV', 22: 'EINVAL', 38: 'ENOSYS' }
            // The kernel reads these bytes at a later call, so they must
            // stay.
            const kept: Uint8Array[] = []
            const address = (bytes: Uint8Array) => {
              kept.push(bytes)
              return Deno.UnsafePointer.value(Deno.UnsafePointer.of(bytes))
            }
            const text = (value: string) => address(new TextEncoder().encode(`${value}\0`))
            const buffer = (size: number) => address(new Uint8Array(size))
            // Two numbers of 64 bits: a memory range (`struct iovec`) or a
            // limit (`struct rlimit`).
            const pair = (first: bigint, second: bigint) => address(new Uint8Array(new BigUint64Array([first, second]).buffer))
            const raw = (name: string, ...args: (number | bigint)[]) => {
              const six = [...args, 0, 0, 0, 0, 0, 0].slice(0, 6).map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint]
              return libc.symbols.syscall(BigInt(CALLS[name]), ...six)
            }
            // The error number is the one of the last call.
            const outcome = (result: bigint) => {
              if (result !== -1n) return 'ok'
              const error = new Deno.UnsafePointerView(libc.symbols.__errno_location()!).getInt32()
              return ERRORS[error] ?? `error ${error}`
            }
            const call = (name: string, ...args: (number | bigint)[]) => outcome(raw(name, ...args))

            const AT_FDCWD = -100
            // Dez is the test program here.
            const dez = Deno.ppid
            const file = '../../../private.txt'
            const attribute = 'user.dez-audit'
            // A key that no program uses, so that no probe makes or opens
            // shared memory, a message queue, or a semaphore.
            const key = 0x64657a41
            const watches = raw('SYS_inotify_init1', 0)
            const watchesOutcome = outcome(watches)
            const dezProcess = raw('SYS_pidfd_open', dez, 0)
            const dezProcessOutcome = outcome(dezProcess)
            const probes: Record<string, () => string> = __PROBES__
            for (const [name, probe] of Object.entries(probes)) console.log(`${name}: ${probe()}`)
        "#;

        // The probes of native code.
        // - Only calls that every processor has (`openat`, not `open`); the
        //   older calls of x86_64 are in `OLD_NATIVE_PROBES`.
        // - No probe changes something outside the run when the OS rule
        //   fails: a key that no program has, the id -1, which names no
        //   shared object (the kernel itself answers `EINVAL`), a signal
        //   with the number 0, a trace that does not stop Dez
        //   (`PTRACE_SEIZE`).
        // - `EACCES` and `EXDEV` come from Landlock, and so does the `EPERM`
        //   of the probes of Dez's process from "memory of Dez" to
        //   `pidfd_send_signal`. `ENOSYS` and the other `EPERM` come from
        //   the call filter, but the one of "more memory": the kernel lets
        //   no program raise its own limit.
        // - `setsid` is not here: the kernel refuses it for the first
        //   program of a group, with or without the filter.
        #[cfg(target_os = "linux")]
        const NATIVE_PROBES: &[Probe] = &[
            ("TCP socket", "call('SYS_socket', 2, 1, 0)", "EPERM"),
            ("UDP socket", "call('SYS_socket', 2, 2, 0)", "EPERM"),
            ("Unix socket", "call('SYS_socket', 1, 1, 0)", "EPERM"),
            ("netlink socket", "call('SYS_socket', 16, 3, 0)", "EPERM"),
            ("io_uring", "call('SYS_io_uring_setup', 4, buffer(128))", "ENOSYS"),
            // Files outside the run.
            ("open for a read", "call('SYS_openat', AT_FDCWD, text(file), 0)", "EACCES"),
            ("open for a write", "call('SYS_openat', AT_FDCWD, text(file), 1)", "EACCES"),
            ("memory file of Dez", "call('SYS_openat', AT_FDCWD, text(`/proc/${dez}/mem`), 0)", "EACCES"),
            ("variables of Dez", "call('SYS_openat', AT_FDCWD, text(`/proc/${dez}/environ`), 0)", "EACCES"),
            ("folder of Dez", "call('SYS_readlinkat', AT_FDCWD, text(`/proc/${dez}/cwd`), buffer(256), 256)", "EACCES"),
            ("hard link", "call('SYS_linkat', AT_FDCWD, text(file), AT_FDCWD, text('hard.txt'), 0)", "EXDEV"),
            ("symlink", "call('SYS_symlinkat', text(file), AT_FDCWD, text('link.txt'))", "EACCES"),
            ("named pipe", "call('SYS_mknodat', AT_FDCWD, text('pipe'), 0o010600, 0)", "EACCES"),
            ("socket file", "call('SYS_mknodat', AT_FDCWD, text('socket'), 0o140600, 0)", "EACCES"),
            // The facts of a file, which need no open of the file.
            ("fchmodat", "call('SYS_fchmodat', AT_FDCWD, text(file), 0o666)", "EPERM"),
            ("fchmodat2", "call('fchmodat2', AT_FDCWD, text(file), 0o666, 0)", "EPERM"),
            ("fchownat", "call('SYS_fchownat', AT_FDCWD, text(file), -1, -1, 0)", "EPERM"),
            ("utimensat", "call('SYS_utimensat', AT_FDCWD, text(file), 0, 0)", "EPERM"),
            ("truncate", "call('SYS_truncate', text(file), 0)", "EPERM"),
            ("setxattr", "call('SYS_setxattr', text(file), text(attribute), text('value'), 5, 0)", "EPERM"),
            ("lsetxattr", "call('SYS_lsetxattr', text(file), text(attribute), text('value'), 5, 0)", "EPERM"),
            ("removexattr", "call('SYS_removexattr', text(file), text(attribute))", "EPERM"),
            ("lremovexattr", "call('SYS_lremovexattr', text(file), text(attribute))", "EPERM"),
            // The attribute as a `struct xattr_args` with no value, and
            // the facts as a `struct file_attr` of zeros.
            ("setxattrat", "call('setxattrat', AT_FDCWD, text(file), 0, text(attribute), pair(0n, 0n), 16)", "EPERM"),
            ("removexattrat", "call('removexattrat', AT_FDCWD, text(file), 0, text(attribute))", "EPERM"),
            ("file_setattr", "call('file_setattr', AT_FDCWD, text(file), buffer(24), 24, 0)", "EPERM"),
            ("getxattr", "call('SYS_getxattr', text(file), text(attribute), buffer(64), 64)", "EPERM"),
            ("lgetxattr", "call('SYS_lgetxattr', text(file), text(attribute), buffer(64), 64)", "EPERM"),
            ("listxattr", "call('SYS_listxattr', text(file), buffer(256), 256)", "EPERM"),
            ("llistxattr", "call('SYS_llistxattr', text(file), buffer(256), 256)", "EPERM"),
            ("getxattrat", "call('getxattrat', AT_FDCWD, text(file), 0, text(attribute), buffer(16), 16)", "EPERM"),
            ("listxattrat", "call('listxattrat', AT_FDCWD, text(file), 0, buffer(256), 256)", "EPERM"),
            ("inotify_init1", "watchesOutcome", "ok"),
            ("inotify_add_watch", "call('SYS_inotify_add_watch', watches, text('../../..'), 0xfff)", "EPERM"),
            // The flag (`FAN_REPORT_FID`) is the form that the kernel lets
            // a program that is not root make.
            ("fanotify_init", "call('SYS_fanotify_init', 0x200, 0)", "EPERM"),
            // The process of Dez.
            ("memory of Dez", "call('SYS_process_vm_readv', dez, pair(buffer(8), 8n), 1, pair(4096n, 8n), 1, 0)", "EPERM"),
            ("ptrace", "call('SYS_ptrace', 0x4206, dez, 0, 0)", "EPERM"),
            ("kcmp", "call('SYS_kcmp', Deno.pid, dez, 0, 0, 0)", "EPERM"),
            ("pidfd_open", "dezProcessOutcome", "ok"),
            ("pidfd_getfd", "call('SYS_pidfd_getfd', dezProcess, 0, 0)", "EPERM"),
            ("kill", "call('SYS_kill', dez, 0)", "EPERM"),
            ("pidfd_send_signal", "call('SYS_pidfd_send_signal', dezProcess, 0, 0, 0)", "EPERM"),
            ("limits of Dez", "call('SYS_prlimit64', dez, 7, 0, buffer(16))", "EPERM"),
            ("own limits", "call('SYS_prlimit64', 0, 7, 0, buffer(16))", "ok"),
            ("more memory", "call('SYS_prlimit64', 0, 2, pair(2n ** 33n, 2n ** 33n), 0)", "EPERM"),
            ("setpgid", "call('SYS_setpgid', 0, 0)", "EPERM"),
            // The shared objects of the kernel.
            ("shmget", "call('SYS_shmget', key, 4096, 0o600)", "EPERM"),
            ("shmat", "call('SYS_shmat', -1, 0, 0)", "EPERM"),
            ("shmctl", "call('SYS_shmctl', -1, 2, buffer(128))", "EPERM"),
            ("msgget", "call('SYS_msgget', key, 0o600)", "EPERM"),
            ("msgsnd", "call('SYS_msgsnd', -1, buffer(16), 8, 0x800)", "EPERM"),
            ("msgrcv", "call('SYS_msgrcv', -1, buffer(16), 8, 0, 0x800)", "EPERM"),
            ("msgctl", "call('SYS_msgctl', -1, 2, buffer(128))", "EPERM"),
            ("semget", "call('SYS_semget', key, 1, 0o600)", "EPERM"),
            ("semop", "call('SYS_semop', -1, buffer(8), 1)", "EPERM"),
            ("semtimedop", "call('SYS_semtimedop', -1, buffer(8), 1, 0)", "EPERM"),
            ("semctl", "call('SYS_semctl', -1, 0, 2, 0)", "EPERM"),
            ("mq_open", "call('SYS_mq_open', text('/dez-audit'), 0, 0, 0)", "EPERM"),
            ("mq_unlink", "call('SYS_mq_unlink', text('/dez-audit'))", "EPERM"),
            ("add_key", "call('SYS_add_key', text('user'), text('dez-audit'), text('value'), 5, -2)", "EPERM"),
            ("request_key", "call('SYS_request_key', text('user'), text('dez-audit'), 0, 0)", "EPERM"),
            ("keyctl", "call('SYS_keyctl', 0, -3, 0)", "EPERM"),
        ];

        // The probes of the older calls of x86_64, which do what a call of
        // `NATIVE_PROBES` does, and their numbers. arm64 has none of them.
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        const OLD_NATIVE_PROBES: &[Probe] = &[
            ("chmod", "call('SYS_chmod', text(file), 0o666)", "EPERM"),
            ("chown", "call('SYS_chown', text(file), -1, -1)", "EPERM"),
            ("lchown", "call('SYS_lchown', text(file), -1, -1)", "EPERM"),
            ("utime", "call('SYS_utime', text(file), 0)", "EPERM"),
            ("utimes", "call('SYS_utimes', text(file), 0)", "EPERM"),
            ("futimesat", "call('SYS_futimesat', AT_FDCWD, text(file), 0)", "EPERM"),
        ];
        #[cfg(all(target_os = "linux", not(target_arch = "x86_64")))]
        const OLD_NATIVE_PROBES: &[Probe] = &[];

        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        fn old_call_numbers() -> String {
            call_numbers!(SYS_chmod, SYS_chown, SYS_lchown, SYS_utime, SYS_utimes, SYS_futimesat)
        }
        #[cfg(all(target_os = "linux", not(target_arch = "x86_64")))]
        fn old_call_numbers() -> String {
            "{}".to_string()
        }

        // Native code in a program reaches no file outside its run, no
        // socket, nothing of Dez's process, and none of the kernel's shared
        // objects (shared memory, queues, key rings).
        #[cfg(target_os = "linux")]
        #[tokio::test]
        async fn native_code_in_a_program_reaches_nothing_outside_its_run() {
            let dir = TempDir::new("tools-audit-native");
            let calls = call_numbers!(
                SYS_socket, SYS_io_uring_setup, SYS_openat, SYS_readlinkat, SYS_linkat, SYS_symlinkat, SYS_mknodat,
                SYS_fchmodat, SYS_fchownat, SYS_utimensat, SYS_truncate,
                SYS_setxattr, SYS_lsetxattr, SYS_removexattr, SYS_lremovexattr,
                SYS_getxattr, SYS_lgetxattr, SYS_listxattr, SYS_llistxattr,
                SYS_inotify_init1, SYS_inotify_add_watch, SYS_fanotify_init,
                SYS_process_vm_readv, SYS_ptrace, SYS_kcmp, SYS_pidfd_open, SYS_pidfd_getfd, SYS_kill, SYS_pidfd_send_signal,
                SYS_prlimit64, SYS_setpgid,
                SYS_shmget, SYS_shmat, SYS_shmctl, SYS_msgget, SYS_msgsnd, SYS_msgrcv, SYS_msgctl,
                SYS_semget, SYS_semop, SYS_semtimedop, SYS_semctl, SYS_mq_open, SYS_mq_unlink,
                SYS_add_key, SYS_request_key, SYS_keyctl,
            );
            let probes: Vec<Probe> = NATIVE_PROBES.iter().chain(OLD_NATIVE_PROBES).copied().collect();
            let text = NATIVE_AUDIT.replace("__CALLS__", &calls).replace("__OLD_CALLS__", &old_call_numbers()).replace("__PROBES__", &probe_object(&probes));
            let mut lines = probe_lines(&probes);
            // Landlock keeps a program from a signal to a program outside
            // its run only since its version 6 (Linux 6.12): a limit that
            // confinement.rs states.
            if crate::confinement::tests::landlock_version() < 6 {
                lines = lines.replace("kill: EPERM", "kill: ok").replace("pidfd_send_signal: EPERM", "pidfd_send_signal: ok");
            }

            let sent = audited(&dir.0, deno_run(&dir.0, "a", &text)).await;

            assert_eq!(sent.stdout, lines, "{}", sent.stderr);
            assert_eq!(sent.ends, exited(0), "{}", sent.stderr);
        }

        // The end of a run ends the process group of its program
        // (`ProcessGroup`). So no program may leave the group, with a new
        // session (`setsid`) or a new group (`setpgid`, which the job
        // control of bash calls): it would go on after the run, and could
        // still write files.
        #[cfg(target_os = "linux")]
        #[tokio::test]
        async fn a_program_cannot_leave_the_process_group_of_its_run() {
            let dir = TempDir::new("tools-audit-group");
            let (session, group) = (dir.0.join("session"), dir.0.join("group"));
            // `setsid` starts its program only in a new session.
            let new_session = "/usr/bin/setsid /bin/true; echo \"new session: $?\"; /usr/bin/setsid /bin/sleep 60 > /dev/null 2>&1 & echo $! > pid";
            // With `set -m`, bash puts each program that it starts into a
            // group of its own, and goes on when it cannot.
            let new_group = "set -m; /bin/sleep 60 > /dev/null 2>&1 & echo $! > pid; echo started";

            let in_session = finished(script(new_session, &session)).await;
            let in_group = finished(program_run("/bin/bash", &["-c", new_group], &group)).await;

            assert_eq!((in_session.stdout.as_str(), in_session.ends), ("new session: 1\n", exited(0)), "{}", in_session.stderr);
            assert_eq!((in_group.stdout.as_str(), in_group.ends), ("started\n", exited(0)), "{}", in_group.stderr);
            for folder in [&session, &group] {
                assert!(program_ended(folder).await, "{}", folder.display());
            }
        }

        // A program gets no open file of Dez: here a socket of the test
        // that is open for the programs that the test starts.
        #[tokio::test]
        async fn a_program_gets_no_open_file_of_dez() {
            use std::io::Read;
            use std::os::fd::AsRawFd;

            let dir = TempDir::new("tools-audit-open-files");
            let (mut ours, theirs) = std::os::unix::net::UnixStream::pair().expect("a socket pair");
            ours.set_nonblocking(true).expect("non-blocking");
            // Rust opens every file with the mark that closes it at the
            // start of a program. A library of Dez can open one without.
            // SAFETY: the call changes only a flag of the test's own file.
            assert_eq!(unsafe { libc::fcntl(theirs.as_raw_fd(), libc::F_SETFD, 0) }, 0);
            // bash and not sh: dash takes only a file number of one digit.
            let write = format!("echo text >&{}; echo done", theirs.as_raw_fd());

            let sent = finished(program_run("/bin/bash", &["-c", &write], &dir.0.join("work"))).await;

            assert_eq!(sent.stdout, "done\n");
            assert!(sent.stderr.contains("Bad file descriptor"), "{}", sent.stderr);
            assert_eq!(ours.read(&mut [0; 8]).map_err(|error| error.kind()), Err(std::io::ErrorKind::WouldBlock));
        }
    }
}
