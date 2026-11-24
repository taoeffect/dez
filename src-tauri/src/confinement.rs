//! Keeps a bundled program inside its folders at the OS level, by the
//! `Confinement` of its run. The program can:
//! - read and write only under one folder (Dez's cache folder for ffmpeg,
//!   the work folder of the run for Deno);
//! - read and write under a few more that it owns, with no move or link of a
//!   file between two folders there (the folder of a script app, the work
//!   folder of a conversation);
//! - read, make, and change files (but not delete, move, or link them) under
//!   others (the assets folder of the Dez folder);
//! - read, but not change or start, the files of others (the libraries and
//!   the fonts that Dez ships, the folder of a built-in app);
//! - read its own file and, for a program that is not static, the library
//!   folders of the system.
//!
//! So a program that a call tricks into opening a path (an argument, or a
//! path in the content of a file, such as a playlist) gets "permission
//! denied". It can make no symlink anywhere: Dez's own file code is not
//! confined, and it would follow a link in the cache folder to any file (a
//! temp clip that names the API keys, a work folder that names a folder of
//! the user). It has no network, and it gets none of the open files of Dez.
//! - Linux: Landlock, a part of the kernel since Linux 5.13, for the files,
//!   and a seccomp filter for the system calls that Landlock does not
//!   confine (`REFUSED_CALLS`, `OWN_PROCESS_CALLS`).
//! - macOS: Seatbelt, through `/usr/bin/sandbox-exec`, which ships with the
//!   OS. It is the only program of the computer that a run starts.
//!
//! Where the OS has neither (an old or a stripped kernel, a macOS with no
//! `sandbox-exec`), a run whose confinement is `required` does not start
//! (`NO_CONFINEMENT`). Any other program then runs with no confinement of
//! its files, and the argument checks of the page (`argumentProblem` in
//! videoTool.ts) are its only guard. Dez then writes one warning to its log.
//!
//! The limits of the confinement, as an audit with native code in a program
//! found them (the audit tests of bundled_tools.rs):
//! - The program can learn the facts of a file whose path it knows (that it
//!   is there, its size, its time, its owner), not its content, its
//!   extended attributes, or the names in its folder. It can learn facts
//!   of the computer too (its name, its kernel). It can change the mode,
//!   the owner, the times, and the attributes only of a file that it could
//!   open.
//! - It can read and change no data of another program, but it can slow a
//!   program of the same user (its priority, its processors). Linux before
//!   6.12 has no Landlock scope: there it can also send that program a
//!   signal.
//! - It can start a file of the system's library folders, and one that it
//!   wrote into its folder. That program is under the same rules.
//! - `REFUSED_CALLS` is a list of calls that Dez knows, so a later kernel
//!   can add a call that it does not hold. A list of refused calls also
//!   leaves the rest of the kernel open to an attack on the kernel itself.
//! - There is no limit on the disk space of the folders or on the count of
//!   the programs that a program starts. The memory limit
//!   (`Confinement::data_limit`) is a rule of Linux only, and it counts
//!   the private memory of a program: native code can get shared memory,
//!   which it does not count.
//! - macOS: the program can also read the files of the system that a
//!   program needs to start, and the names in the root folder `/`; it can
//!   move or link a file between two of its folders, make a named pipe
//!   there, and start a file of a place that it can only read. The rules
//!   on system calls are Linux only: the profile allows what it does not
//!   deny, so native code in a program can still reach other programs of
//!   the user (their services, shared memory, signals).
//!   Dez marks its open files to close at the start of a program with a
//!   loop there (`without_open_files_of_dez`), as macOS has no
//!   `close_range`. No audit with native code ran on a Mac.

use std::path::{Path, PathBuf};

use tokio::process::Command;

// What the OS lets the program of one run do (`confined_command`). The
// default value gives the program only `folder`.
// Linux reads every field; the other systems do not.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Debug, Clone, Default)]
pub(crate) struct Confinement {
    // The folder that the program can read and write, with all below it:
    // every file right there but the make of a symlink.
    pub(crate) folder: PathBuf,
    // Folders that the program has the same rights on, but with no move or
    // link of a file from or to another folder (Linux): the folder of a
    // script app, and the work folder of a conversation. So the program can
    // leave no hard link there to a file of `folder` that Dez stores later.
    pub(crate) also_owned: Vec<PathBuf>,
    // Folders whose files the program can read, make, and change, but
    // never delete, move, or link; it can make no folder there.
    pub(crate) also_writable: Vec<PathBuf>,
    // Folders and files that the program can read, and start nothing of:
    // the libraries and the fonts that Dez ships, the folder of a built-in
    // app.
    pub(crate) also_readable: Vec<PathBuf>,
    // Folders whose files the program can read and start (only the tests,
    // whose system programs start other programs of the system).
    pub(crate) also_startable: Vec<PathBuf>,
    // Whether the program loads the shared libraries of the system: one
    // that is not a static program (Deno). Linux only; the macOS profile
    // lets every program read them.
    pub(crate) system_libraries: bool,
    // Whether the run does not start where the OS has no file rule.
    pub(crate) required: bool,
    // The most bytes of data that the program can have (Linux only). A
    // lower hard limit of Dez wins.
    pub(crate) data_limit: Option<u64>,
}

// The start of the error of a run that did not start because the OS has no
// file rule and its confinement is `required`.
pub(crate) const NO_CONFINEMENT: &str = "No confinement: ";

// Tells once per app run that the programs run with no confinement. A log
// line per run would only repeat it.
fn warn_unconfined(cause: &str) {
    static WARNED: std::sync::Once = std::sync::Once::new();
    WARNED.call_once(|| {
        eprintln!("Dez runs its bundled programs with no confinement, as {cause}. The argument checks of the tools are their only guard.");
    });
}

// A run on a computer whose OS has no file rule: an error for a confinement
// that is `required`, and a warning for any other.
fn without_file_rule(cause: &str, confinement: &Confinement) -> Result<(), String> {
    if confinement.required {
        return Err(format!("{NO_CONFINEMENT}{cause}, and Dez does not run this program with no confinement"));
    }
    warn_unconfined(cause);
    Ok(())
}

// A command that starts `program` with `args` under `confinement`. The
// caller sets the rest (the work folder, the environment, the pipes). An
// `Err` is a confinement that the OS has but that Dez could not set up, or
// one that is `required` on an OS that has none: the run does not start
// then.
#[cfg(target_os = "linux")]
pub(crate) fn confined_command(program: &Path, args: &[String], confinement: &Confinement) -> Result<Command, String> {
    use std::os::fd::AsRawFd;

    use libc::{c_long, c_ulong};

    let rules = landlock_rules(program, confinement).map_err(|error| format!("Failed to set up the confinement of the program: {}", error))?;
    if rules.is_none() {
        without_file_rule("this Linux kernel has no Landlock", confinement)?;
    }
    // Made here, before the fork: the child must not allocate.
    let filter = call_filter();
    // The data limit is never above the hard limit that Dez has now, which
    // the child gets at the fork: with no `CAP_SYS_RESOURCE`, `setrlimit`
    // refuses to raise it (`EPERM`), and no run would start where an
    // administrator set a lower limit. When the read fails, the limit is
    // `data_limit`.
    let data_limit = confinement.data_limit.map(|bytes| {
        let mut current = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
        // SAFETY: `current` is a valid rlimit for the call to fill.
        let hard = if unsafe { libc::getrlimit(libc::RLIMIT_DATA, &mut current) } == 0 { current.rlim_max } else { libc::RLIM_INFINITY };
        let limit = bytes.min(hard);
        libc::rlimit { rlim_cur: limit, rlim_max: limit }
    });
    let mut command = Command::new(program);
    command.args(args);
    // SAFETY: the closure runs in the child between fork and exec, where
    // only async-signal-safe calls are allowed (another thread of Dez can
    // hold the lock of the allocator at the fork). It makes system calls
    // only and does not allocate: `last_os_error` only reads errno. The
    // arguments of `prctl` and `syscall` are `unsigned long` for the kernel.
    unsafe {
        command.pre_exec(move || {
            let done = |result: c_long| if result == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) };
            // Landlock and seccomp need `no_new_privs` from a process that
            // is not root. It also keeps a setuid program from gaining
            // rights.
            done(libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1 as c_ulong, 0 as c_ulong, 0 as c_ulong, 0 as c_ulong) as c_long)?;
            // The data of a program: its heap and every other private
            // memory that it can write. A limit on the address space
            // (`RLIMIT_AS`) is no choice: Deno reserves far more than it
            // uses, and stops at its start under one.
            if let Some(limit) = &data_limit {
                done(libc::setrlimit(libc::RLIMIT_DATA, limit) as c_long)?;
            }
            // The program gets no open file of Dez but its three pipes: a
            // library of Dez can hold a socket that does not close at an
            // exec (the display, D-Bus), and that would be a way around
            // the network rule. The call marks every file from 3 on to
            // close at the exec, and does not close it now: Rust tells the
            // parent of a failed exec through a pipe. The raw call, as an
            // old glibc has no `close_range`. A kernel before 5.11 does not
            // know the call or the flag, and has no Landlock either.
            if libc::syscall(libc::SYS_close_range, 3 as c_ulong, libc::c_uint::MAX as c_ulong, libc::CLOSE_RANGE_CLOEXEC as c_ulong) != 0 {
                let error = std::io::Error::last_os_error();
                if !matches!(error.raw_os_error(), Some(libc::ENOSYS | libc::EINVAL)) {
                    return Err(error);
                }
            }
            if let Some(rules) = &rules {
                done(libc::syscall(libc::SYS_landlock_restrict_self, rules.as_raw_fd() as c_ulong, 0 as c_ulong))?;
            }
            // The last step, so that the filter is no rule of the steps
            // above. The kernel copies the filter at this call.
            let filter_program = libc::sock_fprog { len: filter.len() as libc::c_ushort, filter: filter.as_ptr().cast_mut() };
            done(libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER as c_ulong, &filter_program as *const libc::sock_fprog) as c_long)?;
            Ok(())
        });
    }
    Ok(command)
}

// The system calls that no bundled program can make, each with the error
// that the program gets in its place. All but the first two are here
// because Landlock does not confine them: it guards the open of a file,
// and each of these reaches data with no open.
//
// - `socket`: no socket of any kind, so no network (TCP, UDP, raw), no Unix
//   socket (D-Bus, the display), and no netlink. The Landlock rule covers
//   TCP only. A `socketpair` stays: it reaches no other program.
// - `io_uring_setup`: an io_uring makes sockets with no `socket` call.
//   `ENOSYS` is the answer of a kernel that has no io_uring, so a program
//   uses its other way.
// - The calls that change the facts of a file by its path (its mode, its
//   owner, its times, its extended attributes): without this, a program
//   could make the API keys file readable for every user. The forms that
//   take an open file stay (`fchmod`, `fchown`, `fsetxattr`), as a program
//   opens only what Landlock lets it open. `futimens` does not stay: it is
//   `utimensat` with no path.
// - `truncate`: Landlock confines it only since Linux 6.2. A program cuts
//   a file that it opened (`ftruncate`).
// - The calls that read the extended attributes of a file by its path: an
//   attribute can hold private text (the URL that a browser got a file
//   from). `fgetxattr` and `flistxattr`, which take an open file, stay.
// - `inotify_add_watch` and `fanotify_init`: a watch tells the names of the
//   files of a folder as other programs change them, and needs no open.
// - The shared memory, the message queues, and the semaphores of System V:
//   a program of the user opens them by a number, not by a path, so it
//   could read and change the memory that other programs share (the
//   pictures that an X11 program draws). A segment also stays after the
//   end of its program, outside of every limit.
// - `mq_open` and `mq_unlink`, the message queues of POSIX, which a
//   program names by a name and not by a path. Landlock stops the open of
//   a queue of another program, but not its delete.
// - The key rings of the kernel, which hold secrets of the user's session.
// - `setsid` and `setpgid`: a program cannot leave the process group of
//   its run, so the end of a run ends every program that it started
//   (`ProcessGroup` in bundled_tools.rs). Rust puts the program into its
//   group before this filter is in place.
//
// Deno, ffmpeg, and ffprobe run with this list; only `Deno.chmod`,
// `Deno.utime`, and `Deno.watchFs` fail.
// Linux gives each call that is newer than 5.1 one number on every
// machine, so the ones that the libc crate does not know for both machines
// are numbers here (`asm-generic/unistd.h`).
#[cfg(target_os = "linux")]
const REFUSED_CALLS: &[(libc::c_long, libc::c_int)] = &[
    (libc::SYS_socket, libc::EPERM),
    (libc::SYS_io_uring_setup, libc::ENOSYS),
    (libc::SYS_fchmodat, libc::EPERM),
    // fchmodat2
    (452, libc::EPERM),
    (libc::SYS_fchownat, libc::EPERM),
    (libc::SYS_utimensat, libc::EPERM),
    (libc::SYS_setxattr, libc::EPERM),
    (libc::SYS_lsetxattr, libc::EPERM),
    (libc::SYS_removexattr, libc::EPERM),
    (libc::SYS_lremovexattr, libc::EPERM),
    // setxattrat, removexattrat, file_setattr
    (463, libc::EPERM),
    (466, libc::EPERM),
    (469, libc::EPERM),
    (libc::SYS_truncate, libc::EPERM),
    (libc::SYS_getxattr, libc::EPERM),
    (libc::SYS_lgetxattr, libc::EPERM),
    (libc::SYS_listxattr, libc::EPERM),
    (libc::SYS_llistxattr, libc::EPERM),
    // getxattrat, listxattrat
    (464, libc::EPERM),
    (465, libc::EPERM),
    (libc::SYS_inotify_add_watch, libc::EPERM),
    (libc::SYS_fanotify_init, libc::EPERM),
    (libc::SYS_shmget, libc::EPERM),
    (libc::SYS_shmat, libc::EPERM),
    (libc::SYS_shmctl, libc::EPERM),
    (libc::SYS_msgget, libc::EPERM),
    (libc::SYS_msgsnd, libc::EPERM),
    (libc::SYS_msgrcv, libc::EPERM),
    (libc::SYS_msgctl, libc::EPERM),
    (libc::SYS_semget, libc::EPERM),
    (libc::SYS_semop, libc::EPERM),
    (libc::SYS_semtimedop, libc::EPERM),
    (libc::SYS_semctl, libc::EPERM),
    (libc::SYS_mq_open, libc::EPERM),
    (libc::SYS_mq_unlink, libc::EPERM),
    (libc::SYS_add_key, libc::EPERM),
    (libc::SYS_request_key, libc::EPERM),
    (libc::SYS_keyctl, libc::EPERM),
    (libc::SYS_setsid, libc::EPERM),
    (libc::SYS_setpgid, libc::EPERM),
];

// The older calls of x86_64 that do the same as a call of `REFUSED_CALLS`.
// arm64 never had them.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const OLD_REFUSED_CALLS: &[(libc::c_long, libc::c_int)] = &[
    (libc::SYS_chmod, libc::EPERM),
    (libc::SYS_chown, libc::EPERM),
    (libc::SYS_lchown, libc::EPERM),
    (libc::SYS_utime, libc::EPERM),
    (libc::SYS_utimes, libc::EPERM),
    (libc::SYS_futimesat, libc::EPERM),
];
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const OLD_REFUSED_CALLS: &[(libc::c_long, libc::c_int)] = &[];

// The system calls that a program can make only on itself: their first
// argument names a process, and it must be 0, "this process". With a
// process id there, `prlimit64` sets the limits of another program of the
// user, and a limit of 0 ends that program. Landlock does not confine it.
// The C library always makes the call with 0 (`getrlimit`, `setrlimit`).
#[cfg(target_os = "linux")]
const OWN_PROCESS_CALLS: &[libc::c_long] = &[libc::SYS_prlimit64];

// The machine of the programs that Dez ships, as seccomp names it
// (`linux/audit.h`: the ELF machine with the 64-bit and little-endian
// flags). A system call number means a call only together with it.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const CALL_MACHINE: u32 = 0xC000_003E;
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const CALL_MACHINE: u32 = 0xC000_00B7;
#[cfg(all(target_os = "linux", not(any(target_arch = "x86_64", target_arch = "aarch64"))))]
compile_error!("The seccomp filter of confinement.rs knows only x86_64 and aarch64: add the machine and its system calls.");

// The seccomp filter of a run: a small program (classic BPF) that the
// kernel runs at each system call of the confined program, and of every
// program that it starts. A call of `REFUSED_CALLS` fails with its error,
// a call of `OWN_PROCESS_CALLS` on another process fails too, and every
// other call goes on.
//
// A program can also make its calls in the form of another machine, where
// each call has another number: 32-bit calls on x86_64, and there also the
// x32 form, which has the machine of x86_64 and one more bit in the number.
// The list would not name those calls, so they end the program. No
// bundled program makes one.
#[cfg(target_os = "linux")]
fn call_filter() -> Vec<libc::sock_filter> {
    use std::mem::offset_of;

    // Load a field of the call (`seccomp_data`); jump over `jt` steps when
    // the loaded value is `k`, else over `jf`; end with the answer `k`.
    const LOAD: u32 = libc::BPF_LD | libc::BPF_W | libc::BPF_ABS;
    const JUMP_IF_EQUAL: u32 = libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K;
    const ANSWER: u32 = libc::BPF_RET | libc::BPF_K;
    let step = |code: u32, jt: u8, jf: u8, k: u32| libc::sock_filter { code: code as u16, jt, jf, k };

    let mut filter = vec![
        step(LOAD, 0, 0, offset_of!(libc::seccomp_data, arch) as u32),
        step(JUMP_IF_EQUAL, 1, 0, CALL_MACHINE),
        step(ANSWER, 0, 0, libc::SECCOMP_RET_KILL_PROCESS),
        step(LOAD, 0, 0, offset_of!(libc::seccomp_data, nr) as u32),
    ];
    // The bit of an x32 call (`__X32_SYSCALL_BIT`): every number from it on.
    #[cfg(target_arch = "x86_64")]
    filter.extend([
        step(libc::BPF_JMP | libc::BPF_JGE | libc::BPF_K, 0, 1, 0x4000_0000),
        step(ANSWER, 0, 0, libc::SECCOMP_RET_KILL_PROCESS),
    ]);
    for (call, error) in REFUSED_CALLS.iter().chain(OLD_REFUSED_CALLS) {
        filter.push(step(JUMP_IF_EQUAL, 0, 1, *call as u32));
        filter.push(step(ANSWER, 0, 0, libc::SECCOMP_RET_ERRNO | *error as u32));
    }
    // The first argument is a process id, which is 32 bits: the kernel
    // drops the high half of the 64-bit value, so the low half is the
    // whole test (both machines are little-endian). The load replaces the
    // call number, so each way ends with an answer.
    for call in OWN_PROCESS_CALLS {
        filter.extend([
            step(JUMP_IF_EQUAL, 0, 4, *call as u32),
            step(LOAD, 0, 0, offset_of!(libc::seccomp_data, args) as u32),
            step(JUMP_IF_EQUAL, 0, 1, 0),
            step(ANSWER, 0, 0, libc::SECCOMP_RET_ALLOW),
            step(ANSWER, 0, 0, libc::SECCOMP_RET_ERRNO | libc::EPERM as u32),
        ]);
    }
    filter.push(step(ANSWER, 0, 0, libc::SECCOMP_RET_ALLOW));
    filter
}

#[cfg(target_os = "linux")]
#[derive(Debug, thiserror::Error)]
enum RulesError {
    #[error(transparent)]
    Ruleset(#[from] landlock::RulesetError),
    #[error(transparent)]
    Path(#[from] landlock::PathFdError),
}

// The folders of the shared libraries of a Linux system, and of the loader
// that starts every program that is not static (`ld-linux-*.so`). On a
// system that keeps them deeper (Debian: `/usr/lib/<machine>-linux-gnu`),
// they are still below one of these.
#[cfg(target_os = "linux")]
const SYSTEM_LIBRARY_FOLDERS: [&str; 4] = ["/usr/lib", "/usr/lib64", "/lib", "/lib64"];

// The Landlock rules of a run, as the file of a ruleset, or `None` when the
// kernel has no Landlock. Dez builds them in its own process: the child only
// applies them (`confined_command`). The ruleset handles every right that
// the crate knows (ABI 9); the crate drops the ones that the kernel does
// not know (its default "best effort" mode), and every kernel with Landlock
// confines reads and writes. The file has `O_CLOEXEC`, so the program does
// not get it.
#[cfg(target_os = "linux")]
fn landlock_rules(program: &Path, confinement: &Confinement) -> Result<Option<std::os::fd::OwnedFd>, RulesError> {
    use landlock::{ABI, Access, AccessFs, AccessNet, PathBeneath, PathFd, Ruleset, RulesetAttr, RulesetCreatedAttr, Scope};

    let every_right = AccessFs::from_all(ABI::V9);
    // A program makes only regular files and folders in the folder.
    // - No `MakeSym`: see the comment of the module.
    // - No named pipe, socket, or device file: Dez's own file code would
    //   wait without end at the open of a named pipe that a program left
    //   in the place of a file.
    let mut folder_rights = every_right;
    folder_rights.remove(AccessFs::MakeSym | AccessFs::MakeFifo | AccessFs::MakeSock | AccessFs::MakeChar | AccessFs::MakeBlock);
    // With no `Refer`, a move or a link of a file between two folders fails
    // (`EXDEV`), also between two folders below this one. A move in one
    // folder works.
    let mut owned_rights = folder_rights;
    owned_rights.remove(AccessFs::Refer);
    // An exec needs the read right of the program too.
    let start_right = AccessFs::Execute | AccessFs::ReadFile;
    let mut ruleset = Ruleset::default()
        .handle_access(every_right)?
        // The second guard of the network, after `REFUSED_CALLS`: no rule
        // gives a port, so every TCP bind and connect fails (Linux 6.7),
        // and the program can send no signal to a program outside the run
        // and connect to no abstract Unix socket (Linux 6.12).
        .handle_access(AccessNet::from_all(ABI::V9))?
        .scope(Scope::from_all(ABI::V9))?
        .create()?
        .add_rule(PathBeneath::new(PathFd::new(&confinement.folder)?, folder_rights))?
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
    // The kernel starts a program that is not static through the loader of
    // the system, and wants the `Execute` right on the loader for that: with
    // the read right alone, the exec fails. The loader then reads the
    // libraries. So the program can also start a file of these folders;
    // that program is under the same rules, and `no_new_privs` gives it no
    // right of a setuid file. No `ReadDir`: the loader lists no folder.
    if confinement.system_libraries {
        for folder in SYSTEM_LIBRARY_FOLDERS.iter().map(Path::new).filter(|folder| folder.exists()) {
            ruleset = ruleset.add_rule(PathBeneath::new(PathFd::new(folder)?, start_right))?;
        }
    }
    for path in &confinement.also_owned {
        ruleset = ruleset.add_rule(PathBeneath::new(PathFd::new(path)?, owned_rights))?;
    }
    // With no `RemoveFile`, `MakeDir`, or `Refer`, a program cannot delete,
    // move, or hard-link a file there, nor make a folder; with no `Execute`
    // or `MakeSym`, it cannot start a file there or make a link to another
    // file. Landlock checks the real path of each open, so a symlink or
    // `..` from there reaches nothing else.
    let file_rights = AccessFs::ReadFile | AccessFs::ReadDir | AccessFs::WriteFile | AccessFs::MakeReg | AccessFs::Truncate;
    for path in &confinement.also_writable {
        ruleset = ruleset.add_rule(PathBeneath::new(PathFd::new(path)?, file_rights))?;
    }
    // `from_read` holds `Execute`, which a read-only place does not need.
    // A `dlopen` needs no `Execute`: Landlock checks it only at an exec,
    // and not at the map of a library's code.
    let read_rights = AccessFs::ReadFile | AccessFs::ReadDir;
    // The crate drops the folder rights of a rule on a file.
    for path in &confinement.also_readable {
        ruleset = ruleset.add_rule(PathBeneath::new(PathFd::new(path)?, read_rights))?;
    }
    for path in &confinement.also_startable {
        ruleset = ruleset.add_rule(PathBeneath::new(PathFd::new(path)?, read_rights | AccessFs::Execute))?;
    }
    Ok(ruleset.into())
}

// Seatbelt runs `program` under a profile, and `sandbox-exec` execs it, so
// the program keeps the process (its id, a kill).
#[cfg(target_os = "macos")]
const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

// The Seatbelt profile of a run (SBPL: the last rule that matches wins), in
// two parts: `confined_command` puts the rules of the other folders of the
// run between them.
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
// - The rules of `also_owned` give what the rule of the folder gives. A
//   move or a link between two folders stays possible here: Seatbelt has
//   no rule like the `Refer` right of Landlock.
// - The rules of `also_writable` give read, write, and the create of a
//   regular file, as `file_rights` of `landlock_rules`: no unlink, rename
//   away, folder, or symlink there.
// - The deny of a symlink create (the rule of WebKit's WebProcess profile)
//   comes after every allow of a folder, so it wins there: no symlink in
//   the cache folder or in the folder of an app (see the comment of the
//   module).
// - The deny of the network covers every socket that is not a pair of the
//   program itself: no connect, bind, or listen, also on a Unix socket.
// - The kernel logs a deny of `/dev/dtracehelper`, `/dev/autofs_nowait`,
//   and `~/.CFUserTextEncoding` at each start of a program: the system
//   libraries (dyld, CoreFoundation) try to open them and go on without
//   them. They stay denied, so the home folder stays closed. The sandbox of
//   Nix allows the same three files, for the same libraries.
//   https://gist.github.com/LnL7/017a37a6f45d289fdf4f48023aed1112
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
"#;

#[cfg(target_os = "macos")]
const SEATBELT_PROFILE_END: &str = r#"(deny file-write-create (vnode-type SYMLINK))
(deny network*)
"#;

// The command of a run on macOS: Seatbelt where the Mac has
// `sandbox-exec`, and a program with no OS rule where it has none and the
// confinement allows that.
#[cfg(target_os = "macos")]
pub(crate) fn confined_command(program: &Path, args: &[String], confinement: &Confinement) -> Result<Command, String> {
    let mut command = seatbelt_command(program, args, confinement)?;
    without_open_files_of_dez(&mut command);
    Ok(command)
}

// The program gets no open file of Dez but its three pipes, as on Linux: a
// library of Dez can hold a file that does not close at an exec, and
// `sandbox-exec` keeps every open file for the program that it execs.
// macOS has no `close_range`, so a loop marks each file from 3 on to close
// at the exec, up to the size of the file table of the process. A number
// that is no open file gives EBADF, which the loop skips. It closes no
// file now: Rust tells the parent of a failed exec through a pipe, and
// macOS stops a process that closes a guarded file.
#[cfg(target_os = "macos")]
fn without_open_files_of_dez(command: &mut Command) {
    // SAFETY: a plain call with no arguments, in Dez's process before the
    // fork.
    let table_size = unsafe { libc::getdtablesize() };
    // SAFETY: the closure runs in the child between fork and exec, where
    // only async-signal-safe calls are allowed. `fcntl` is one, and the
    // closure does not allocate.
    unsafe {
        command.pre_exec(move || {
            for file in 3..table_size {
                libc::fcntl(file, libc::F_SETFD, libc::FD_CLOEXEC);
            }
            Ok(())
        });
    }
}

#[cfg(target_os = "macos")]
fn seatbelt_command(program: &Path, args: &[String], confinement: &Confinement) -> Result<Command, String> {
    if !Path::new(SANDBOX_EXEC).is_file() {
        without_file_rule("this Mac has no /usr/bin/sandbox-exec", confinement)?;
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
    for index in 0..confinement.also_owned.len() {
        profile.push_str(&format!("(allow file-read-data file-write* (subpath (param \"OWN_{index}\")))\n"));
    }
    for index in 0..confinement.also_writable.len() {
        profile.push_str(&format!("(allow file-read-data file-write-data (subpath (param \"WRITE_{index}\")))\n"));
        profile.push_str(&format!("(allow file-write-create (require-all (subpath (param \"WRITE_{index}\")) (vnode-type REGULAR-FILE)))\n"));
    }
    // The profile refuses no start of a program (its `allow default`), so
    // on macOS a place to read is also a place to start files of.
    let readable: Vec<&PathBuf> = confinement.also_readable.iter().chain(&confinement.also_startable).collect();
    if !readable.is_empty() {
        let paths: Vec<String> = (0..readable.len()).map(|index| format!("(subpath (param \"READ_{index}\"))")).collect();
        profile.push_str(&format!("(allow file-read-data {})\n", paths.join(" ")));
    }
    profile.push_str(SEATBELT_PROFILE_END);
    let program = canonical(program)?;
    let mut command = Command::new(SANDBOX_EXEC);
    command.arg("-p").arg(profile);
    command.arg("-D").arg(parameter("FOLDER", &canonical(&confinement.folder)?));
    command.arg("-D").arg(parameter("PROGRAM", &program));
    let owned: Vec<&PathBuf> = confinement.also_owned.iter().collect();
    let writable: Vec<&PathBuf> = confinement.also_writable.iter().collect();
    let path_lists = [("OWN", &owned), ("WRITE", &writable), ("READ", &readable)];
    for (name, paths) in path_lists {
        for (index, path) in paths.iter().enumerate() {
            command.arg("-D").arg(parameter(&format!("{name}_{index}"), &canonical(path)?));
        }
    }
    // The program path is absolute, so `sandbox-exec` takes no word of
    // `args` as its own option: its option list ends at the program.
    command.arg(&program).args(args);
    Ok(command)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(crate) fn confined_command(program: &Path, args: &[String], confinement: &Confinement) -> Result<Command, String> {
    without_file_rule("Dez knows no confinement of this OS", confinement)?;
    let mut command = Command::new(program);
    command.args(args);
    Ok(command)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    // The version of the Landlock of this kernel (1 is Linux 5.13, 4 is
    // 6.7, 6 is 6.12), or a number below 1 for a kernel with none. The call
    // with these arguments gives it.
    #[cfg(target_os = "linux")]
    pub(crate) fn landlock_version() -> libc::c_long {
        // SAFETY: the kernel reads no memory for this flag.
        unsafe { libc::syscall(libc::SYS_landlock_create_ruleset, 0 as libc::c_ulong, 0 as libc::c_ulong, 1 as libc::c_ulong) }
    }

    // The page tells such an error from the others by its start.
    #[test]
    fn a_required_confinement_is_an_error_where_the_os_has_no_file_rule() {
        let required = Confinement { required: true, ..Confinement::default() };

        let error = without_file_rule("this kernel has no Landlock", &required).expect_err("refused");

        assert!(error.starts_with(NO_CONFINEMENT), "{error}");
        assert_eq!(without_file_rule("this kernel has no Landlock", &Confinement::default()), Ok(()));
    }

    // What the call filter answers to the system call `call` of a program
    // of the machine `machine`, with `first_argument`. It runs the steps of
    // the filter as the kernel does (classic BPF): a jump counts from the
    // step after it. A step that `call_filter` does not use is a panic.
    #[cfg(target_os = "linux")]
    fn filter_answer(machine: u32, call: libc::c_long, first_argument: u64) -> u32 {
        const LOAD: u32 = libc::BPF_LD | libc::BPF_W | libc::BPF_ABS;
        const JUMP_IF_EQUAL: u32 = libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K;
        const JUMP_IF_NOT_BELOW: u32 = libc::BPF_JMP | libc::BPF_JGE | libc::BPF_K;
        const ANSWER: u32 = libc::BPF_RET | libc::BPF_K;

        let data = libc::seccomp_data { nr: call as libc::c_int, arch: machine, instruction_pointer: 0, args: [first_argument, 0, 0, 0, 0, 0] };
        // SAFETY: the struct is plain numbers with no gap between them.
        let bytes: [u8; size_of::<libc::seccomp_data>()] = unsafe { std::mem::transmute(data) };
        let filter = call_filter();
        let (mut next, mut loaded) = (0, 0);
        loop {
            let step = filter[next];
            next += 1;
            let jump = |taken: bool| usize::from(if taken { step.jt } else { step.jf });
            match u32::from(step.code) {
                LOAD => loaded = u32::from_ne_bytes(bytes[step.k as usize..][..4].try_into().expect("four bytes")),
                JUMP_IF_EQUAL => next += jump(loaded == step.k),
                JUMP_IF_NOT_BELOW => next += jump(loaded >= step.k),
                ANSWER => return step.k,
                code => panic!("the filter has a step that this test does not know: {code:#x}"),
            }
        }
    }

    // The parts of the filter that no run of a program can show on this
    // computer (a call of another machine), and the jumps of each row: a
    // jump that is off by one gives a call the answer of its neighbor.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_call_filter_answers_each_call_by_its_row() {
        let refused = |error: libc::c_int| libc::SECCOMP_RET_ERRNO | error as u32;
        let other_process = 0x1234;

        for (call, error) in REFUSED_CALLS.iter().chain(OLD_REFUSED_CALLS) {
            assert_eq!(filter_answer(CALL_MACHINE, *call, 0), refused(*error), "the call {call}");
        }
        for call in [libc::SYS_read, libc::SYS_openat, libc::SYS_socketpair, libc::SYS_fchmod, libc::SYS_getpid] {
            assert_eq!(filter_answer(CALL_MACHINE, call, other_process), libc::SECCOMP_RET_ALLOW, "the call {call}");
        }
        for call in OWN_PROCESS_CALLS {
            assert_eq!(filter_answer(CALL_MACHINE, *call, 0), libc::SECCOMP_RET_ALLOW, "the call {call} on itself");
            assert_eq!(filter_answer(CALL_MACHINE, *call, other_process), refused(libc::EPERM), "the call {call} on another process");
            // The kernel reads only the low half of a process id.
            assert_eq!(filter_answer(CALL_MACHINE, *call, 1 << 32), libc::SECCOMP_RET_ALLOW, "the call {call} with a high half");
        }
        // The machines of the two processors, and the 32-bit ones of each
        // (i386, arm): a call in the form of any machine but the own one.
        for machine in [0xC000_003E, 0xC000_00B7, 0x4000_0003, 0x4000_0028].into_iter().filter(|machine| *machine != CALL_MACHINE) {
            for call in [libc::SYS_read, libc::SYS_socket] {
                assert_eq!(filter_answer(machine, call, 0), libc::SECCOMP_RET_KILL_PROCESS, "the call {call} of the machine {machine:#x}");
            }
        }
        // An x32 call: the number of a call that is allowed, with the bit.
        #[cfg(target_arch = "x86_64")]
        assert_eq!(filter_answer(CALL_MACHINE, 0x4000_0000 + libc::SYS_read, 0), libc::SECCOMP_RET_KILL_PROCESS);
    }

    // The network rules of Landlock by themselves. In a run, the call
    // filter refuses each socket before Landlock sees it (`REFUSED_CALLS`),
    // so no run shows these rules. Here a thread of the test takes the
    // rules of a run and no filter: Landlock holds only the thread that
    // takes it, and the thread ends in the test.
    #[cfg(target_os = "linux")]
    #[test]
    fn landlock_alone_refuses_tcp_and_the_abstract_sockets_of_other_programs() {
        use std::os::fd::AsRawFd;
        use std::os::linux::net::SocketAddrExt;
        use std::os::unix::net::{SocketAddr, UnixListener, UnixStream};

        let version = landlock_version();
        if version < 4 {
            eprintln!("Not checked: the Landlock of this kernel (version {version}) has no network rule.");
            return;
        }
        let dir = crate::persistence::tests::TempDir::new("confinement-network");
        let tcp = std::net::TcpListener::bind("127.0.0.1:0").expect("listen");
        let tcp_address = tcp.local_addr().expect("address");
        // A socket with a name and no file (Linux), which no file rule
        // covers.
        let unix_address = SocketAddr::from_abstract_name(format!("dez-test-{}", std::process::id())).expect("address");
        let _unix = UnixListener::bind_addr(&unix_address).expect("listen");
        let kind = |error: std::io::Error| error.kind();
        let connects = move || (std::net::TcpStream::connect(tcp_address).map(drop).map_err(kind), UnixStream::connect_addr(&unix_address).map(drop).map_err(kind));
        let rules = landlock_rules(&std::env::current_exe().expect("the test program"), &Confinement { folder: dir.0.clone(), ..Confinement::default() })
            .expect("rules")
            .expect("a kernel with Landlock");

        // A thread with no rule reaches both servers.
        let free = std::thread::spawn(connects.clone()).join().expect("a thread");
        let confined = std::thread::spawn(move || {
            // SAFETY: both calls change only this thread, and read no
            // memory of the test.
            unsafe {
                assert_eq!(libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong), 0);
                assert_eq!(libc::syscall(libc::SYS_landlock_restrict_self, rules.as_raw_fd() as libc::c_ulong, 0 as libc::c_ulong), 0);
            }
            connects()
        })
        .join()
        .expect("a thread");

        let refused = Err(std::io::ErrorKind::PermissionDenied);
        assert_eq!(free, (Ok(()), Ok(())));
        assert_eq!(confined.0, refused);
        // The scope of the abstract sockets is newer (Linux 6.12).
        assert_eq!(confined.1, if version >= 6 { refused } else { Ok(()) });
    }
}
