//! Keeps a bundled program inside its folders at the OS level: the program
//! can read and write only under one folder (Dez's cache folder for a
//! bundled program, `run_bundled_tool`), read, make, and change files (but
//! not delete, move, or link them) under a few more (the assets folder of
//! the Dez folder), and read its own file. So a program that a call tricks
//! into opening a path (an argument, or a path in the content of a file,
//! such as a playlist) gets "permission denied". It can make no symlink
//! anywhere: Dez's own file code is not confined, and it would follow a
//! link in the cache folder to any file (a temp clip that names the API
//! keys, a work folder that names a folder of the user).
//! - Linux: Landlock, a part of the kernel since Linux 5.13.
//! - macOS: Seatbelt, through `/usr/bin/sandbox-exec`, which ships with the
//!   OS. It is the only program of the computer that a run starts.
//!
//! Where the OS has neither (an old or a stripped kernel, a macOS with no
//! `sandbox-exec`), the program runs with no confinement, and the argument
//! checks of the page (`argumentProblem` in videoTool.ts) are its only
//! guard. Dez then writes one warning to its log.
//!
//! The limits of the confinement: the network is not confined (the argument
//! checks refuse its protocols); the program can read the facts of any file
//! (size, time, owner, and extended attributes), not its content; on macOS
//! it can also read the files of the system that a program needs to start.

use std::path::{Path, PathBuf};

use tokio::process::Command;

// Tells once per app run that the programs run with no confinement. A log
// line per run would only repeat it.
fn warn_unconfined(cause: &str) {
    static WARNED: std::sync::Once = std::sync::Once::new();
    WARNED.call_once(|| {
        eprintln!("Dez runs its bundled programs with no confinement, as {cause}. The argument checks of the tools are their only guard.");
    });
}

// A command that starts `program` with `args`, confined to `folder` (every
// file right there but the make of a symlink), with the file rights of
// `also_writable` (read, make, and change a file; never delete, move, or
// link one, nor make a folder) and read rights on `also_readable` too (only
// the tests, whose system programs need the system's folders). The caller
// sets the rest (the work folder, the environment, the pipes). An `Err` is
// a confinement that the OS has but that Dez could not set up: the run
// does not start then.
#[cfg(target_os = "linux")]
pub(crate) fn confined_command(program: &Path, args: &[String], folder: &Path, also_writable: &[PathBuf], also_readable: &[PathBuf]) -> Result<Command, String> {
    use std::os::fd::AsRawFd;

    let mut command = Command::new(program);
    command.args(args);
    match landlock_rules(program, folder, also_writable, also_readable).map_err(|error| format!("Failed to set up the confinement of the program: {}", error))? {
        // SAFETY: the closure runs in the child between fork and exec, where
        // only async-signal-safe calls are allowed (another thread of Dez can
        // hold the lock of the allocator at the fork). It makes two system
        // calls and does not allocate: `last_os_error` only reads errno.
        Some(rules) => unsafe {
            command.pre_exec(move || {
                // Landlock needs `no_new_privs` from a process that is not
                // root. It also keeps a setuid program from gaining rights.
                // The arguments are `unsigned long` for the kernel.
                if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::syscall(libc::SYS_landlock_restrict_self, rules.as_raw_fd(), 0 as libc::c_uint) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        },
        None => warn_unconfined("this Linux kernel has no Landlock"),
    }
    Ok(command)
}

#[cfg(target_os = "linux")]
#[derive(Debug, thiserror::Error)]
enum RulesError {
    #[error(transparent)]
    Ruleset(#[from] landlock::RulesetError),
    #[error(transparent)]
    Path(#[from] landlock::PathFdError),
}

// The Landlock rules of a run, as the file of a ruleset, or `None` when the
// kernel has no Landlock. Dez builds them in its own process: the child only
// applies them (`confined_command`). The ruleset handles every file right
// that the crate knows (ABI 9); the crate drops the ones that the kernel
// does not know (its default "best effort" mode), and every kernel with
// Landlock confines reads and writes. The file has `O_CLOEXEC`, so the
// program does not get it.
#[cfg(target_os = "linux")]
fn landlock_rules(program: &Path, folder: &Path, also_writable: &[PathBuf], also_readable: &[PathBuf]) -> Result<Option<std::os::fd::OwnedFd>, RulesError> {
    use landlock::{ABI, Access, AccessFs, PathBeneath, PathFd, Ruleset, RulesetAttr, RulesetCreatedAttr};

    let every_right = AccessFs::from_all(ABI::V9);
    // No `MakeSym` in the folder: see the comment of the module.
    let mut folder_rights = every_right;
    folder_rights.remove(AccessFs::MakeSym);
    // An exec needs the read right of the program too.
    let start_right = AccessFs::Execute | AccessFs::ReadFile;
    let mut ruleset = Ruleset::default()
        .handle_access(every_right)?
        .create()?
        .add_rule(PathBeneath::new(PathFd::new(folder)?, folder_rights))?
        .add_rule(PathBeneath::new(PathFd::new(program)?, start_right))?;
    // The device files that a run can use, as in `SEATBELT_PROFILE`; one
    // that the computer lacks is left out.
    // ffmpeg reads a random seed from /dev/urandom (the hls demuxer does):
    // with no read right on it, the Linux arm64 build died of SIGILL.
    let devices = [
        ("/dev/null", AccessFs::ReadFile | AccessFs::WriteFile | AccessFs::Truncate),
        ("/dev/random", AccessFs::ReadFile.into()),
        ("/dev/urandom", AccessFs::ReadFile.into()),
    ];
    for (device, rights) in devices.into_iter().filter(|(device, _)| Path::new(device).exists()) {
        ruleset = ruleset.add_rule(PathBeneath::new(PathFd::new(device)?, rights))?;
    }
    // With no `RemoveFile`, `MakeDir`, or `Refer`, a program cannot delete,
    // move, or hard-link a file there, nor make a folder; with no `Execute`
    // or `MakeSym`, it cannot start a file there or make a link to another
    // file. Landlock checks the real path of each open, so a symlink or
    // `..` from there reaches nothing else.
    let file_rights = AccessFs::ReadFile | AccessFs::ReadDir | AccessFs::WriteFile | AccessFs::MakeReg | AccessFs::Truncate;
    for path in also_writable {
        ruleset = ruleset.add_rule(PathBeneath::new(PathFd::new(path)?, file_rights))?;
    }
    for path in also_readable {
        // The crate drops the folder rights of a rule on a file.
        ruleset = ruleset.add_rule(PathBeneath::new(PathFd::new(path)?, AccessFs::from_read(ABI::V9)))?;
    }
    Ok(ruleset.into())
}

// Seatbelt runs `program` under a profile, and `sandbox-exec` execs it, so
// the program keeps the process (its id, a kill).
#[cfg(target_os = "macos")]
const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

// The Seatbelt profile of a run (SBPL: the last rule that matches wins).
// - `(allow default)` with a deny of all file reads and writes, and not a
//   `(deny default)` profile: the programs load AppKit, AVFoundation, and
//   more frameworks, which need much that a full list would miss.
// - The deny has no filter: an allow of a path wins over it, which a deny
//   of a `subpath` would not.
// - The reads of the system: the frameworks and libraries (with the dyld
//   cache in the cryptexes), their data, and the time zone.
// - The read of the root folder `/` (a `literal`: the names in `/`, and no
//   file below it): on macOS 27, dyld reads it before `main` to find its
//   cache, and a deny makes dyld abort every program (SIGABRT).
// - The paths come as parameters (`-D`), never as text of the profile, so a
//   path cannot change the profile. Seatbelt matches resolved paths
//   (`/private/var/…`), so they are canonical.
// - File facts, extended attributes, and maps of the libraries stay
//   allowed: dyld needs them, and Landlock does not confine them either.
// - The rules of `also_writable` (added in `confined_command`) give read,
//   write, and the create of a regular file, as `file_rights` of
//   `landlock_rules`: no unlink, rename away, folder, or symlink there.
// - The deny of a symlink create (the rule of WebKit's WebProcess profile)
//   comes after the allow of the cache folder, so it wins there: no symlink
//   in the cache folder either (see the comment of the module).
#[cfg(target_os = "macos")]
const SEATBELT_PROFILE: &str = r#"(version 1)
(allow default)
(deny file-read-data file-write*)
(allow file-read-data
  (literal "/")
  (subpath "/System")
  (subpath "/usr/lib")
  (subpath "/usr/share")
  (subpath "/Library/Apple")
  (subpath "/private/var/db/timezone")
  (literal "/private/etc/localtime")
  (literal "/dev/null")
  (literal "/dev/random")
  (literal "/dev/urandom")
  (literal (param "PROGRAM")))
(allow file-write-data (literal "/dev/null"))
(allow file-read-data file-write* (subpath (param "FOLDER")))
(deny file-write-create (vnode-type SYMLINK))
"#;

#[cfg(target_os = "macos")]
pub(crate) fn confined_command(program: &Path, args: &[String], folder: &Path, also_writable: &[PathBuf], also_readable: &[PathBuf]) -> Result<Command, String> {
    if !Path::new(SANDBOX_EXEC).is_file() {
        warn_unconfined("this Mac has no /usr/bin/sandbox-exec");
        let mut command = Command::new(program);
        command.args(args);
        return Ok(command);
    }
    let canonical = |path: &Path| std::fs::canonicalize(path).map_err(|error| format!("Failed to find {}: {}", path.display(), error));
    let parameter = |name: &str, path: &Path| {
        let mut text = std::ffi::OsString::from(format!("{name}="));
        text.push(path);
        text
    };
    // Only the count of the extra paths goes into the profile text.
    let mut profile = SEATBELT_PROFILE.to_string();
    for index in 0..also_writable.len() {
        profile.push_str(&format!("(allow file-read-data file-write-data (subpath (param \"WRITE_{index}\")))\n"));
        profile.push_str(&format!("(allow file-write-create (require-all (subpath (param \"WRITE_{index}\")) (vnode-type REGULAR-FILE)))\n"));
    }
    if !also_readable.is_empty() {
        let paths: Vec<String> = (0..also_readable.len()).map(|index| format!("(subpath (param \"READ_{index}\"))")).collect();
        profile.push_str(&format!("(allow file-read-data {})\n", paths.join(" ")));
    }
    let program = canonical(program)?;
    let mut command = Command::new(SANDBOX_EXEC);
    command.arg("-p").arg(profile);
    command.arg("-D").arg(parameter("FOLDER", &canonical(folder)?));
    command.arg("-D").arg(parameter("PROGRAM", &program));
    for (index, path) in also_writable.iter().enumerate() {
        command.arg("-D").arg(parameter(&format!("WRITE_{index}"), &canonical(path)?));
    }
    for (index, path) in also_readable.iter().enumerate() {
        command.arg("-D").arg(parameter(&format!("READ_{index}"), &canonical(path)?));
    }
    // The program path is absolute, so `sandbox-exec` takes no word of
    // `args` as its own option: its option list ends at the program.
    command.arg(&program).args(args);
    Ok(command)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(crate) fn confined_command(program: &Path, args: &[String], _folder: &Path, _also_writable: &[PathBuf], _also_readable: &[PathBuf]) -> Result<Command, String> {
    warn_unconfined("Dez knows no confinement of this OS");
    let mut command = Command::new(program);
    command.args(args);
    Ok(command)
}
