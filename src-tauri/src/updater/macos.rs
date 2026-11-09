//! The macOS part of the updater: which app bundle Dez runs from, whether
//! Dez may replace that bundle in place, the install from the mounted DMG,
//! and the relaunch helper that finishes the install once Dez has quit.

use std::ffi::{CString, OsStr};
use std::fs;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use objc2::rc::autoreleasepool;
use objc2_foundation::{NSFileManager, NSURL};
use semver::Version;

use super::Finish;

const MOVE_TO_APPLICATIONS: &str =
    "Move Dez to the Applications folder, open it from there, and try again.";

const APP_MANAGEMENT: &str = "macOS did not let Dez replace its app. Allow Dez in System Settings › Privacy & Security › App Management, and check that your account may change the folder Dez is in. Then try again, or install the update from its release page.";

// The app at the root of a release DMG, named after `productName` in
// tauri.conf.json.
const DMG_APP: &str = "Dez.app";

// The system tools that the installer runs, by absolute path.
const DISKUTIL: &str = "/usr/sbin/diskutil";
const DITTO: &str = "/usr/bin/ditto";
const XATTR: &str = "/usr/bin/xattr";
const CODESIGN: &str = "/usr/bin/codesign";
// Opens the app through LaunchServices, as Finder does, rather than as a
// child of a process that is about to end.
const OPEN: &str = "/usr/bin/open";

/// Why Dez cannot install an update in place, or `None` when it can. The
/// update window shows the reason and offers the release page instead.
/// `identifier` is the bundle identifier from tauri.conf.json.
pub fn install_blocked_reason(identifier: &str) -> Option<String> {
    installable_bundle(identifier).err()
}

// The app bundle of the running executable, when Dez may replace it in
// place; else why it may not. `install` replaces the path that passed these
// checks, never a second lookup of it.
fn installable_bundle(identifier: &str) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        return Err("Development builds do not install updates.".into());
    }
    // Releases have only Apple Silicon DMGs (`verify::dmg_file_name`). A
    // build made from source for an Intel Mac would install an app that it
    // cannot run.
    if !cfg!(target_arch = "aarch64") {
        return Err("Dez releases are built only for Apple Silicon Macs.".into());
    }
    let bundle = running_bundle()?;
    if let Some(problem) = location_problem(&bundle) {
        return Err(problem);
    }
    let read_only = is_on_read_only_volume(&bundle)
        .map_err(|error| format!("Dez could not check the volume it runs from: {error}"))?;
    if read_only {
        return Err(format!(
            "Dez is on a read-only volume. {MOVE_TO_APPLICATIONS}"
        ));
    }
    let found = info_plist_string(&bundle, "CFBundleIdentifier")?;
    if found != identifier {
        return Err(format!(
            "Dez's app bundle has the identifier {found}, not {identifier}."
        ));
    }
    Ok(bundle)
}

// The app bundle of the running executable. The path is canonical, so a
// path through a symlink such as `/Volumes/Macintosh HD/Applications` is
// `/Applications`, and a translocated app has its real `AppTranslocation`
// path.
fn running_bundle() -> Result<PathBuf, String> {
    let exe = std::env::current_exe()
        .and_then(std::fs::canonicalize)
        .map_err(|error| format!("Dez could not find its own executable: {error}"))?;
    bundle_of_executable(&exe)
        .map(Path::to_path_buf)
        .ok_or_else(|| "Dez is not running from an app bundle.".to_string())
}

// The executable of an app bundle is `<name>.app/Contents/MacOS/<exe>`.
fn bundle_of_executable(exe: &Path) -> Option<&Path> {
    let macos_dir = exe.parent()?;
    let contents = macos_dir.parent()?;
    let bundle = contents.parent()?;
    let is_bundle = macos_dir.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app";
    is_bundle.then_some(bundle)
}

// The places that Dez runs from but cannot replace itself in:
// - macOS runs a quarantined app that was opened where it was downloaded
//   (not moved there by Finder) from a read-only copy under
//   `AppTranslocation` in a private temp folder.
// - Under `/Volumes/` is a mounted disk image (the release DMG) or another
//   disk; the boot volume's own `/Volumes` link is resolved away by
//   `running_bundle`.
fn location_problem(bundle: &Path) -> Option<String> {
    if bundle
        .components()
        .any(|part| part == Component::Normal("AppTranslocation".as_ref()))
    {
        return Some(format!(
            "macOS runs this copy of Dez from a read-only place (App Translocation). {MOVE_TO_APPLICATIONS}"
        ));
    }
    if bundle.starts_with("/Volumes") {
        return Some(format!(
            "Dez runs from a disk image or another disk. {MOVE_TO_APPLICATIONS}"
        ));
    }
    None
}

// Whether the volume of `path` is mounted read-only. On macOS 11+ `/` is the
// sealed system volume, which is read-only, while `/Applications` resolves
// to the writable data volume; so ask about the bundle itself, never `/`.
fn is_on_read_only_volume(path: &Path) -> io::Result<bool> {
    let path = c_path(path)?;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: `path` is a NUL-terminated C string that outlives the call,
    // and `stats` points to writable memory of the type statvfs fills.
    if unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: statvfs returned 0, so it filled `stats`.
    let stats = unsafe { stats.assume_init() };
    Ok(stats.f_flag & libc::ST_RDONLY != 0)
}

// A string value from the Info.plist of an app bundle.
fn info_plist_string(bundle: &Path, key: &str) -> Result<String, String> {
    let path = bundle.join("Contents/Info.plist");
    let info = plist::Value::from_file(&path).map_err(|error| {
        // plist shows every error in its Debug form; an I/O error such as a
        // missing file reads better as itself.
        let reason = error
            .as_io()
            .map_or_else(|| error.to_string(), ToString::to_string);
        format!("Could not read {}: {reason}", path.display())
    })?;
    info.as_dictionary()
        .and_then(|info| info.get(key))
        .and_then(plist::Value::as_string)
        .map(str::to_string)
        .ok_or_else(|| format!("{} has no {key}.", path.display()))
}

fn c_path(path: &Path) -> io::Result<CString> {
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
}

/// Replaces the running app with the app in `dmg`, the verified download of
/// `version` in the private dir (`install_app` has the steps). `identifier`
/// is the bundle identifier from tauri.conf.json.
pub fn install(
    dmg: &Path,
    private_dir: &Path,
    version: &Version,
    identifier: &str,
) -> Result<Finish, String> {
    // The webview may call install_update without can_install_update first.
    let bundle = installable_bundle(identifier)?;
    install_with(dmg, &bundle, private_dir, version, identifier, trash)
}

// `install` for any app at `bundle`, so that tests can use a fake app and a
// fake Trash.
fn install_with(
    dmg: &Path,
    bundle: &Path,
    private_dir: &Path,
    version: &Version,
    identifier: &str,
    trash: impl Fn(&Path) -> Result<(), String>,
) -> Result<Finish, String> {
    // Detaches when it is dropped, after the install, on every path.
    let image = DiskImage::attach(dmg, &private_dir.join("mnt"))?;
    install_app(
        &image.mount_point.join(DMG_APP),
        bundle,
        private_dir,
        version,
        identifier,
        trash,
    )
}

// A DMG attached read-only at a folder in the private dir. Dropping it
// detaches it.
//
// It uses `diskutil`, because macOS 27 deprecates `hdiutil`. `diskutil
// image` came in macOS 13, Dez's minimum (`minimumSystemVersion` in
// tauri.conf.json). The flags have one hyphen (`-readOnly`): macOS 13 takes
// only that form, and later versions, which show two hyphens in their help,
// still take it.
struct DiskImage {
    mount_point: PathBuf,
}

impl DiskImage {
    fn attach(dmg: &Path, mount_point: &Path) -> Result<Self, String> {
        let failed = |error: String| format!("Dez could not open the update's disk image: {error}");
        // diskutil before macOS 27 needs the mount point to exist.
        fs::create_dir(mount_point).map_err(|error| failed(error.to_string()))?;
        // -nobrowse hides the volume in Finder.
        run(Command::new(DISKUTIL)
            .args(["image", "attach", "-readOnly", "-nobrowse", "-mountPoint"])
            .arg(mount_point)
            .arg(dmg))
        .map_err(failed)?;
        Ok(Self {
            mount_point: mount_point.to_path_buf(),
        })
    }

    // `diskutil image` has no detach: ejecting the image's disk detaches
    // it. A file open in the volume (Spotlight indexing it, for one) makes
    // the eject fail ("Unmount was dissented by PID …"). `diskutil eject
    // force` is newer than macOS 13, so then this forces the unmount and
    // ejects the disk, with verbs that every version has.
    fn detach(&self) -> Result<(), String> {
        let eject = |target: &OsStr| run(Command::new(DISKUTIL).arg("eject").arg(target));
        eject(self.mount_point.as_os_str()).or_else(|_| {
            let disk = whole_disk(&self.mount_point)?;
            run(Command::new(DISKUTIL).args(["unmountDisk", "force", &disk]))?;
            eject(disk.as_ref())
        })
    }
}

impl Drop for DiskImage {
    fn drop(&mut self) {
        if let Err(error) = self.detach() {
            eprintln!(
                "Dez could not detach the update's disk image at {}: {error}",
                self.mount_point.display()
            );
        }
    }
}

// The whole disk (such as `disk5`) of the volume mounted at `mount_point`.
// For an APFS image it is the container disk that APFS synthesizes;
// ejecting that one detaches the image too.
fn whole_disk(mount_point: &Path) -> Result<String, String> {
    let info = output_of(Command::new(DISKUTIL).args(["info", "-plist"]).arg(mount_point))?;
    plist::Value::from_reader_xml(info.as_slice())
        .ok()
        .as_ref()
        .and_then(plist::Value::as_dictionary)
        .and_then(|info| info.get("ParentWholeDisk"))
        .and_then(plist::Value::as_string)
        .map(str::to_string)
        .ok_or_else(|| format!("diskutil found no disk at {}.", mount_point.display()))
}

// Runs a system tool and waits for it. On failure the error is the tool's
// own message (its stderr), or its exit status when it printed none.
fn run(command: &mut Command) -> Result<(), String> {
    output_of(command).map(drop)
}

// `run`, which also returns what the tool printed on stdout.
fn output_of(command: &mut Command) -> Result<Vec<u8>, String> {
    let program = command.get_program().to_string_lossy().into_owned();
    let output = command
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("{program} did not start: {error}"))?;
    if output.status.success() {
        return Ok(output.stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let message = stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    Err(if message.is_empty() {
        format!("{program} failed ({})", output.status)
    } else {
        message
    })
}

// Replaces the app at `bundle` with `new_app`, the app in the mounted DMG:
// 1. Checks that `new_app` is the requested release (`check_new_app`).
// 2. Copies it with ditto into a staging folder next to `bundle`. On the
//    same volume, the swap below is a rename.
// 3. Clears the copy's extended attributes (the README's manual
//    `xattr -cr`) and checks its code signature.
// 4. Swaps the copy and the app at `bundle` (`swap`), so there is never a
//    moment without an app at `bundle`.
// 5. Moves the old app to the Trash, or removes it.
// When macOS denies step 2 or 4 (App Management, or a folder that the user
// may not change), it stages the new executable for the relaunch helper
// instead (`stage_binary`).
fn install_app(
    new_app: &Path,
    bundle: &Path,
    private_dir: &Path,
    version: &Version,
    identifier: &str,
    trash: impl Fn(&Path) -> Result<(), String>,
) -> Result<Finish, String> {
    check_new_app(new_app, identifier, version)?;
    match replace_bundle(new_app, bundle, trash) {
        Ok(leftover) => Ok(Finish::Replaced {
            bundle: bundle.to_path_buf(),
            leftover,
        }),
        Err(Replace::Denied(error)) => {
            eprintln!("macOS did not let Dez swap its app ({error}); Dez stages the new executable.");
            stage_binary(new_app, bundle, private_dir)
        }
        Err(Replace::Failed(error)) => Err(error),
    }
}

// Whether `app`, the app at the root of the mounted DMG, is the requested
// release: a real folder (not a link out of the image) with Dez's bundle
// identifier and `version`. The signature ties the DMG to some release; the
// version check stops an older signed DMG, a downgrade, from passing as the
// requested one.
fn check_new_app(app: &Path, identifier: &str, version: &Version) -> Result<(), String> {
    if !fs::symlink_metadata(app).is_ok_and(|metadata| metadata.is_dir()) {
        return Err("The update's disk image has no Dez.app.".into());
    }
    let found = info_plist_string(app, "CFBundleIdentifier")?;
    if found != identifier {
        return Err(format!(
            "The app in the update has the identifier {found}, not {identifier}."
        ));
    }
    let found = info_plist_string(app, "CFBundleShortVersionString")?;
    if found != version.to_string() {
        return Err(format!(
            "The app in the update is Dez {found}, not Dez {version}."
        ));
    }
    Ok(())
}

// Why `replace_bundle` failed.
#[derive(Debug)]
enum Replace {
    // macOS denied a change (EACCES or EPERM), and nothing changed.
    Denied(io::Error),
    // Any other failure. When the old app is not at its place, the message
    // says where it is.
    Failed(String),
}

// EACCES and EPERM (both `PermissionDenied`) mean that App Management or the
// folder's permissions forbid the change; the binary fallback may still work.
fn denied_or_failed(error: io::Error, context: &str) -> Replace {
    if error.kind() == io::ErrorKind::PermissionDenied {
        Replace::Denied(error)
    } else {
        Replace::Failed(format!("{context}: {error}"))
    }
}

// Steps 2 to 5 of `install_app`. Returns the staging folder when the old
// app is still in it (the trash and the removal both failed), so that the
// relaunch helper removes it.
fn replace_bundle(
    new_app: &Path,
    bundle: &Path,
    trash: impl Fn(&Path) -> Result<(), String>,
) -> Result<Option<PathBuf>, Replace> {
    let (Some(folder), Some(name)) = (bundle.parent(), bundle.file_name()) else {
        return Err(Replace::Failed(format!(
            "{} is not an app bundle.",
            bundle.display()
        )));
    };
    // A dot folder, hidden in Finder. Dropping it removes the copy after a
    // failure.
    let staging = tempfile::Builder::new()
        .prefix(".dez-update-")
        .tempdir_in(folder)
        .map_err(|error| denied_or_failed(error, "Dez could not make a folder next to its app"))?;
    let staged = staging.path().join(name);
    run(Command::new(DITTO).arg(new_app).arg(&staged))
        .map_err(|error| Replace::Failed(format!("Dez could not copy the update: {error}")))?;
    // A quarantine attribute left here would make macOS refuse to open the
    // ad-hoc signed app ("damaged"). On macOS 27, xattr -c leaves
    // com.apple.provenance in place and still succeeds.
    run(Command::new(XATTR).arg("-cr").arg(&staged)).map_err(|error| {
        Replace::Failed(format!(
            "Dez could not clear the update's extended attributes: {error}"
        ))
    })?;
    check_code_signature(&staged).map_err(Replace::Failed)?;

    let old_app = match swap(&staged, bundle, &staging.path().join("old").join(name)) {
        Ok(old_app) => old_app,
        Err(error) => {
            // The two renames failed and so did the undo: the old app is
            // only in the staging folder now, so keep that folder.
            if fs::symlink_metadata(bundle).is_err() {
                let _ = staging.keep();
            }
            return Err(error);
        }
    };
    // Dez keeps running from the old app after it moves; macOS runs a moved
    // executable fine, and Dez quits soon.
    if let Err(error) = trash(&old_app) {
        eprintln!("Dez could not move its old app to the Trash, so it removes it: {error}");
    }
    let staging_path = staging.path().to_path_buf();
    // Removes the staging folder, with the old app in it when the trash
    // failed.
    match staging.close() {
        Ok(()) => Ok(None),
        Err(error) => {
            eprintln!("Dez could not remove {}: {error}", staging_path.display());
            Ok(Some(staging_path))
        }
    }
}

// Puts `staged` at `bundle`, and returns where the old app is now.
// renamex_np(RENAME_SWAP) swaps the two in one step and leaves the old app
// at `staged`. On volumes that cannot swap, `swap_by_renames` does it in
// two steps.
fn swap(staged: &Path, bundle: &Path, backup: &Path) -> Result<PathBuf, Replace> {
    match rename_swap(staged, bundle) {
        Ok(()) => Ok(staged.to_path_buf()),
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
            Err(Replace::Denied(error))
        }
        Err(error) => {
            eprintln!("Dez could not swap its app in one step ({error}); it renames it in two.");
            swap_by_renames(staged, bundle, backup)
        }
    }
}

fn rename_swap(from: &Path, to: &Path) -> io::Result<()> {
    let (from, to) = (c_path(from)?, c_path(to)?);
    // SAFETY: both are NUL-terminated C strings that outlive the call.
    if unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_SWAP) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

// Renames the app at `bundle` to `backup`, then `staged` to `bundle`, and
// returns `backup`. When the second rename fails, it renames the old app
// back. If even that fails, the old app stays at `backup`, and the error
// says so.
fn swap_by_renames(staged: &Path, bundle: &Path, backup: &Path) -> Result<PathBuf, Replace> {
    if let Some(folder) = backup.parent() {
        fs::create_dir_all(folder).map_err(|error| {
            denied_or_failed(error, "Dez could not make a folder for its old app")
        })?;
    }
    fs::rename(bundle, backup)
        .map_err(|error| denied_or_failed(error, "Dez could not move its app aside"))?;
    if let Err(error) = fs::rename(staged, bundle) {
        return Err(match fs::rename(backup, bundle) {
            Ok(()) => denied_or_failed(error, "Dez could not move the update into place"),
            Err(undo_error) => Replace::Failed(format!(
                "Dez could not move the update into place ({error}), nor its old app back ({undo_error}). The old app is at {}.",
                backup.display()
            )),
        });
    }
    Ok(backup.to_path_buf())
}

// Moves `path` to the user's Trash, as Finder does, so that the old app can
// still be put back from there.
fn trash(path: &Path) -> Result<(), String> {
    let url = NSURL::from_file_path(path)
        .ok_or_else(|| format!("{} is not a valid path.", path.display()))?;
    autoreleasepool(|_| {
        NSFileManager::defaultManager()
            .trashItemAtURL_resultingItemURL_error(&url, None)
            .map_err(|error| error.localizedDescription().to_string())
    })
}

// The fallback when macOS denies the swap: Dez copies the new executable
// and Info.plist into the private dir, and the relaunch helper moves them
// over the old ones once Dez has quit. The frontend is inside the
// executable; the rest of the old app stays. It works only where Dez may
// add files to its own app, which a probe checks first.
fn stage_binary(new_app: &Path, bundle: &Path, private_dir: &Path) -> Result<Finish, String> {
    let executable = info_plist_string(bundle, "CFBundleExecutable")?;
    if info_plist_string(new_app, "CFBundleExecutable")? != executable {
        return Err("The update renames Dez's executable, so Dez cannot install it in place. Install it from its release page.".into());
    }
    let contents = bundle.join("Contents");
    let executable_dir = contents.join("MacOS");
    for dir in [&executable_dir, &contents] {
        if let Err(error) = probe_writable(dir) {
            eprintln!("Dez may not add files to {}: {error}", dir.display());
            return Err(APP_MANAGEMENT.into());
        }
    }
    check_code_signature(new_app)?;

    let staged_dir = private_dir.join("staged");
    let stage_error = |error: io::Error| format!("Dez could not stage the update: {error}");
    fs::create_dir(&staged_dir).map_err(stage_error)?;
    let mut files = Vec::new();
    for (source, staged_name, target) in [
        (
            new_app.join("Contents/MacOS").join(&executable),
            "executable",
            executable_dir.join(&executable),
        ),
        (
            new_app.join("Contents/Info.plist"),
            "Info.plist",
            contents.join("Info.plist"),
        ),
    ] {
        let staged = staged_dir.join(staged_name);
        fs::copy(&source, &staged).map_err(stage_error)?;
        files.push((staged, target));
    }
    Ok(Finish::Binary {
        bundle: bundle.to_path_buf(),
        files,
    })
}

// Whether the code signature of the app at `app` holds, with every file
// that it seals.
fn check_code_signature(app: &Path) -> Result<(), String> {
    run(Command::new(CODESIGN)
        .args(["--verify", "--deep", "--strict"])
        .arg(app))
    .map_err(|error| format!("The app in the update failed its code signature check: {error}"))
}

// Whether Dez may add a file to `dir`: makes one, then removes it.
fn probe_writable(dir: &Path) -> io::Result<()> {
    tempfile::Builder::new()
        .prefix(".dez-update-probe-")
        .tempfile_in(dir)?
        .close()
}

// The relaunch helper. /bin/sh runs it with these positional parameters:
//   <pid> <private dir> <bundle> <opener> replaced [<leftover>]
//   <pid> <private dir> <bundle> <opener> binary [<staged> <target>]...
// It waits up to 30 s for Dez (`pid`) to quit, finishes the install, removes
// the private dir, and opens the app with `opener`. It logs each step, as
// nobody sees its errors otherwise. `log` uses `printf`, as `sh`'s `echo`
// reads backslashes in a path as escapes (`\c` cuts the line off).
//
// Binary mode first copies each staged file next to its target, so that a
// failed copy changes nothing, then renames the copies over the targets. A
// rename gives the target a new inode: writing into the old executable
// instead gets a process that still runs it killed (`Killed: 9`). Then it
// clears the app's extended attributes and signs the app again ad hoc,
// since the new files broke the old signature's seal. The new executable's
// own signature has the release's flags (hardened runtime) and
// entitlements; `--preserve-metadata` keeps them, which a plain
// `--sign -` drops.
//
// `kill -0` sees a zombie as running; launchd reaps Dez as soon as it ends.
const HELPER_SCRIPT: &str = r#"
log() { printf '%s %s\n' "$(/bin/date '+%Y-%m-%d %H:%M:%S')" "$*"; }
pid=$1 private=$2 bundle=$3 opener=$4 mode=$5
shift 5
log "Finishing the update of $bundle ($mode mode). Waiting for Dez (process $pid) to quit."
tries=0
while kill -0 "$pid" 2>/dev/null; do
  if [ "$tries" -ge 300 ]; then
    log "Dez did not quit within 30 seconds. Going on."
    break
  fi
  /bin/sleep 0.1
  tries=$((tries + 1))
done

copy_staged() {
  while [ "$#" -ge 2 ]; do
    log "Copying $1 to $2.dez-update"
    /bin/cp -p "$1" "$2.dez-update" || return 1
    shift 2
  done
}
move_copies() {
  while [ "$#" -ge 2 ]; do
    log "Moving $2.dez-update over $2"
    /bin/mv -f "$2.dez-update" "$2" || return 1
    shift 2
  done
}
remove_copies() {
  while [ "$#" -ge 2 ]; do
    /bin/rm -f "$2.dez-update"
    shift 2
  done
}

case $mode in
binary)
  if copy_staged "$@"; then
    move_copies "$@" || log "A move failed."
    log "Clearing the extended attributes of $bundle and signing it again."
    /usr/bin/xattr -cr "$bundle" || log "xattr failed."
    /usr/bin/codesign --force --sign - --preserve-metadata=entitlements,flags,runtime "$bundle" || log "codesign failed."
  else
    log "A copy failed, so Dez stays at its old version."
  fi
  remove_copies "$@"
  ;;
replaced)
  for leftover in "$@"; do
    log "Removing $leftover"
    /bin/rm -rf "$leftover" || log "Could not remove $leftover."
  done
  ;;
esac

log "Removing $private"
/bin/rm -rf "$private" || log "Could not remove $private."
log "Opening $bundle"
"$opener" "$bundle" || log "Could not open $bundle."
log "Done."
"#;

/// Starts the relaunch helper for `finish` and leaves it running; it waits
/// for this process to end. Its output goes to a new file at `log`.
pub fn spawn_helper(finish: &Finish, private_dir: &Path, log: &Path) -> Result<(), String> {
    let failed = |error: io::Error| format!("Dez could not start its update helper: {error}");
    let log = open_log(log).map_err(failed)?;
    let mut command = helper_command(finish, std::process::id(), private_dir, Path::new(OPEN));
    command
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(failed)?)
        .stderr(log);
    // In a session of its own, the helper is out of Dez's process group and
    // terminal, so nothing sent to those as Dez quits reaches it.
    // SAFETY: setsid is async-signal-safe, so it may run between fork and
    // exec.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    // Nobody waits for the helper: it outlives Dez, and launchd reaps it.
    command.spawn().map(drop).map_err(failed)
}

// A private file, emptied for each update.
fn open_log(path: &Path) -> io::Result<fs::File> {
    if let Some(folder) = path.parent() {
        fs::create_dir_all(folder)?;
    }
    fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
}

// The helper's command. Every value is a positional parameter, never part
// of the script text, so no path can inject a command. Tests pass another
// `opener` than `OPEN`, so that they open no app.
fn helper_command(finish: &Finish, pid: u32, private_dir: &Path, opener: &Path) -> Command {
    let mut command = Command::new("/bin/sh");
    command
        .args(["-c", HELPER_SCRIPT, "sh"])
        .arg(pid.to_string())
        .arg(private_dir);
    match finish {
        Finish::Replaced { bundle, leftover } => {
            command
                .arg(bundle)
                .arg(opener)
                .arg("replaced")
                .args(leftover);
        }
        Finish::Binary { bundle, files } => {
            command.arg(bundle).arg(opener).arg("binary");
            for (staged, target) in files {
                command.arg(staged).arg(target);
            }
        }
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
    use tempfile::TempDir;

    const ID: &str = "com.taoeffect.dez";

    #[test]
    fn finds_the_bundle_of_an_executable() {
        let bundle = |exe: &str| bundle_of_executable(Path::new(exe)).map(Path::to_path_buf);

        assert_eq!(
            bundle("/Applications/Dez.app/Contents/MacOS/dez"),
            Some("/Applications/Dez.app".into())
        );
        assert_eq!(
            bundle("/Users/me/My Apps/Dez 2.app/Contents/MacOS/dez"),
            Some("/Users/me/My Apps/Dez 2.app".into())
        );
        for not_in_a_bundle in [
            "/Users/me/dez/src-tauri/target/release/dez",
            "/Applications/Dez/Contents/MacOS/dez",
            "/Applications/Dez.app/Contents/Resources/dez",
            "/Applications/Dez.app/MacOS/dez",
            "/Contents/MacOS/dez",
            "dez",
        ] {
            assert_eq!(bundle(not_in_a_bundle), None, "{not_in_a_bundle}");
        }
    }

    #[test]
    fn refuses_translocated_and_mounted_bundles() {
        let problem = |bundle: &str| location_problem(Path::new(bundle));

        let translocated = "/private/var/folders/x1/abc/T/AppTranslocation/0A1B-2C3D/d/Dez.app";
        assert!(problem(translocated).is_some_and(|reason| reason.contains("App Translocation")));
        assert!(
            problem("/Volumes/Dez/Dez.app").is_some_and(|reason| reason.contains("disk image"))
        );
        assert!(problem("/Volumes/Backup/Applications/Dez.app").is_some());

        for allowed in [
            "/Applications/Dez.app",
            "/Users/me/Applications/Dez.app",
            "/VolumesBackup/Dez.app",
            "/Users/me/AppTranslocations/Dez.app",
        ] {
            assert_eq!(problem(allowed), None, "{allowed}");
        }
    }

    #[test]
    fn tells_read_only_volumes_apart() {
        // The sealed system volume, read-only since macOS 11.
        assert!(is_on_read_only_volume(Path::new("/System")).expect("statvfs /System"));
        let dir = tempfile::tempdir().expect("temp dir");
        assert!(!is_on_read_only_volume(dir.path()).expect("statvfs temp dir"));
        assert!(is_on_read_only_volume(&dir.path().join("missing")).is_err());
    }

    #[test]
    fn reads_strings_from_the_info_plist_of_a_bundle() {
        let dir = tempfile::tempdir().expect("temp dir");
        let bundle = dir.path().join("Dez.app");
        assert!(info_plist_string(&bundle, "CFBundleIdentifier").is_err());

        std::fs::create_dir_all(bundle.join("Contents")).expect("bundle dir");
        let mut info = plist::Dictionary::new();
        info.insert("CFBundleIdentifier".into(), "com.taoeffect.dez".into());
        info.insert("CFBundleVersion".into(), 7.into());
        plist::Value::Dictionary(info)
            .to_file_xml(bundle.join("Contents/Info.plist"))
            .expect("write Info.plist");

        assert_eq!(
            info_plist_string(&bundle, "CFBundleIdentifier"),
            Ok("com.taoeffect.dez".into())
        );
        assert!(info_plist_string(&bundle, "CFBundleVersion").is_err());
        assert!(info_plist_string(&bundle, "CFBundleShortVersionString").is_err());
    }

    // A fake Dez at `app`, built as release apps are: an Info.plist, a copy
    // of /usr/bin/true as its executable, and an ad-hoc signature with the
    // hardened runtime (Tauri's bundler signs with `--options runtime`).
    fn make_app(app: &Path, identifier: &str, version: &str) {
        fs::create_dir_all(app.join("Contents/MacOS")).expect("app folders");
        fs::copy("/usr/bin/true", app.join("Contents/MacOS/dez")).expect("executable");
        let mut info = plist::Dictionary::new();
        for (key, value) in [
            ("CFBundleIdentifier", identifier),
            ("CFBundleShortVersionString", version),
            ("CFBundleExecutable", "dez"),
            ("CFBundlePackageType", "APPL"),
        ] {
            info.insert(key.into(), value.into());
        }
        plist::Value::Dictionary(info)
            .to_file_xml(app.join("Contents/Info.plist"))
            .expect("Info.plist");
        run(Command::new(CODESIGN)
            .args(["--force", "--sign", "-", "--options", "runtime"])
            .arg(app))
        .expect("sign");
    }

    // Whether the code signature of `app` turns on the hardened runtime.
    fn has_hardened_runtime(app: &Path) -> bool {
        let output = Command::new(CODESIGN)
            .arg("--display")
            .arg("--verbose")
            .arg(app)
            .output()
            .expect("codesign");
        // codesign prints the details on stderr, e.g.
        // `CodeDirectory v=20500 … flags=0x10002(adhoc,runtime) …`.
        String::from_utf8_lossy(&output.stderr)
            .lines()
            .any(|line| line.starts_with("CodeDirectory") && line.contains("runtime"))
    }

    fn short_version(app: &Path) -> String {
        info_plist_string(app, "CFBundleShortVersionString").expect("version")
    }

    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .expect("list")
            .map(|entry| entry.expect("entry").file_name().to_string_lossy().into())
            .collect();
        names.sort();
        names
    }

    // Dez 0.15.1 installed in a fake Applications folder, Dez 0.16.0 in a
    // folder laid out as the release DMG, the private dir, and a fake Trash.
    struct Setup {
        root: TempDir,
        bundle: PathBuf,
        image: PathBuf,
        new_app: PathBuf,
        private_dir: PathBuf,
        trash: PathBuf,
    }

    impl Setup {
        fn new() -> Self {
            let root = tempfile::tempdir().expect("temp dir");
            let bundle = root.path().join("Applications/Dez.app");
            make_app(&bundle, ID, "0.15.1");
            let image = root.path().join("image");
            let new_app = image.join(DMG_APP);
            make_app(&new_app, ID, "0.16.0");
            symlink("/Applications", image.join("Applications")).expect("link");
            let private_dir = root.path().join("private");
            let trash = root.path().join("Trash");
            for dir in [&private_dir, &trash] {
                fs::create_dir(dir).expect("folder");
            }
            Self {
                root,
                bundle,
                image,
                new_app,
                private_dir,
                trash,
            }
        }

        // Moves the item into the fake Trash.
        fn trash(&self) -> impl Fn(&Path) -> Result<(), String> {
            let trash = self.trash.clone();
            move |path| {
                fs::rename(path, trash.join(path.file_name().expect("name")))
                    .map_err(|error| error.to_string())
            }
        }

        // A DMG of the image folder. `diskutil image create` needs macOS
        // 14; these tests run only on developer Macs.
        fn make_dmg(&self) -> PathBuf {
            let dmg = self.root.path().join("Dez_0.16.0_aarch64.dmg");
            run(Command::new(DISKUTIL)
                .args(["image", "create", "from"])
                .arg(&self.image)
                .arg(&dmg))
            .expect("make DMG");
            dmg
        }

        fn install(&self, app: &Path, version: &str) -> Result<Finish, String> {
            let version = Version::parse(version).expect("version");
            install_app(app, &self.bundle, &self.private_dir, &version, ID, self.trash())
        }

        fn applications(&self) -> Vec<String> {
            names_in(self.bundle.parent().expect("folder"))
        }

        // Runs the relaunch helper for `finish` while a stand-in for Dez
        // quits after a moment, and returns the helper's log. The opener is
        // echo, so the log shows what the helper would open.
        fn run_helper(&self, finish: &Finish) -> String {
            let log = self.root.path().join("update.log");
            let output = fs::File::create(&log).expect("log");
            let mut dez = Command::new("/bin/sleep")
                .arg("0.3")
                .spawn()
                .expect("start Dez");
            let mut helper =
                helper_command(finish, dez.id(), &self.private_dir, Path::new("/bin/echo"))
                    .stdout(output.try_clone().expect("log"))
                    .stderr(output)
                    .spawn()
                    .expect("start the helper");
            // Reaps Dez as it quits, as launchd does for the real one.
            assert!(dez.wait().expect("Dez").success());
            assert!(helper.wait().expect("helper").success());
            fs::read_to_string(&log).expect("read log")
        }
    }

    // Takes the write permission of `dir` away until dropped, as for a
    // folder that the user may not change.
    struct ReadOnly(PathBuf);

    impl ReadOnly {
        fn new(dir: &Path) -> Self {
            fs::set_permissions(dir, fs::Permissions::from_mode(0o555)).expect("chmod");
            Self(dir.to_path_buf())
        }
    }

    impl Drop for ReadOnly {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o755));
        }
    }

    #[test]
    fn installs_the_app_of_a_disk_image_in_place_of_the_old_one() {
        let setup = Setup::new();
        let dmg = setup.make_dmg();

        let finish = install_with(
            &dmg,
            &setup.bundle,
            &setup.private_dir,
            &Version::new(0, 16, 0),
            ID,
            setup.trash(),
        );

        assert_eq!(
            finish,
            Ok(Finish::Replaced {
                bundle: setup.bundle.clone(),
                leftover: None
            })
        );
        assert_eq!(short_version(&setup.bundle), "0.16.0");
        check_code_signature(&setup.bundle).expect("signature");
        assert_eq!(short_version(&setup.trash.join("Dez.app")), "0.15.1");
        // No staging folder is left, and the image is detached.
        assert_eq!(setup.applications(), ["Dez.app"]);
        assert_eq!(names_in(&setup.private_dir.join("mnt")), Vec::<String>::new());
    }

    #[test]
    fn detaches_a_disk_image_with_a_file_open_in_it() {
        let setup = Setup::new();
        let dmg = setup.make_dmg();
        let mount_point = setup.private_dir.join("mnt");
        let image = DiskImage::attach(&dmg, &mount_point).expect("attach");
        let device = |path: &Path| fs::metadata(path).expect("stat").dev();
        assert_ne!(device(&mount_point), device(&setup.private_dir), "mounted");
        // The open file makes the plain eject fail.
        let _open = fs::File::open(mount_point.join(DMG_APP).join("Contents/Info.plist"))
            .expect("open");

        image.detach().expect("detach");

        assert_eq!(device(&mount_point), device(&setup.private_dir));
        // Detached already: Drop would only fail again.
        std::mem::forget(image);
    }

    #[test]
    fn refuses_an_app_that_is_not_the_requested_release() {
        let setup = Setup::new();
        let other = setup.image.join("Other.app");
        make_app(&other, "com.example.other", "0.16.0");
        let link = setup.image.join("Link.app");
        symlink(&setup.new_app, &link).expect("link");

        let no_app = Err("The update's disk image has no Dez.app.".to_string());
        assert_eq!(
            setup.install(&setup.image.join("Missing.app"), "0.16.0"),
            no_app
        );
        // A link out of the image, even to a real app.
        assert_eq!(setup.install(&link, "0.16.0"), no_app);
        assert_eq!(
            setup.install(&other, "0.16.0"),
            Err("The app in the update has the identifier com.example.other, not com.taoeffect.dez.".into())
        );
        // A signed release other than the requested one, such as an older
        // one replayed as a downgrade.
        assert_eq!(
            setup.install(&setup.new_app, "0.16.1"),
            Err("The app in the update is Dez 0.16.0, not Dez 0.16.1.".into())
        );

        assert_eq!(short_version(&setup.bundle), "0.15.1");
        assert_eq!(setup.applications(), ["Dez.app"]);
    }

    #[test]
    fn refuses_an_app_whose_code_signature_is_broken() {
        let setup = Setup::new();
        // Changed after signing, as a damaged or altered app is.
        let info_path = setup.new_app.join("Contents/Info.plist");
        let mut info = plist::Value::from_file(&info_path).expect("read");
        info.as_dictionary_mut()
            .expect("dictionary")
            .insert("Changed".into(), true.into());
        info.to_file_xml(&info_path).expect("write");

        let result = setup.install(&setup.new_app, "0.16.0");

        assert!(
            result.as_ref().is_err_and(|error| error
                .starts_with("The app in the update failed its code signature check")),
            "{result:?}"
        );
        assert_eq!(short_version(&setup.bundle), "0.15.1");
        assert_eq!(setup.applications(), ["Dez.app"]);
    }

    #[test]
    fn stages_the_new_executable_when_the_app_folder_is_read_only() {
        let setup = Setup::new();
        let _folder = ReadOnly::new(setup.bundle.parent().expect("folder"));

        let finish = setup.install(&setup.new_app, "0.16.0");

        let staged = setup.private_dir.join("staged");
        assert_eq!(
            finish,
            Ok(Finish::Binary {
                bundle: setup.bundle.clone(),
                files: vec![
                    (
                        staged.join("executable"),
                        setup.bundle.join("Contents/MacOS/dez")
                    ),
                    (
                        staged.join("Info.plist"),
                        setup.bundle.join("Contents/Info.plist")
                    ),
                ],
            })
        );
        for (staged_name, new_file) in [
            ("executable", "Contents/MacOS/dez"),
            ("Info.plist", "Contents/Info.plist"),
        ] {
            assert_eq!(
                fs::read(staged.join(staged_name)).ok(),
                fs::read(setup.new_app.join(new_file)).ok(),
                "{staged_name}"
            );
        }
        assert_eq!(short_version(&setup.bundle), "0.15.1");
        assert_eq!(setup.applications(), ["Dez.app"]);
    }

    #[test]
    fn asks_for_app_management_when_dez_may_not_change_its_own_app() {
        let setup = Setup::new();
        let _folder = ReadOnly::new(setup.bundle.parent().expect("folder"));
        let _executables = ReadOnly::new(&setup.bundle.join("Contents/MacOS"));

        assert_eq!(
            setup.install(&setup.new_app, "0.16.0"),
            Err(APP_MANAGEMENT.into())
        );
        assert!(!setup.private_dir.join("staged").exists());
        assert_eq!(short_version(&setup.bundle), "0.15.1");
    }

    #[test]
    fn swaps_in_two_renames_and_undoes_the_first_when_the_second_fails() {
        let setup = Setup::new();
        let backup = setup.private_dir.join("old/Dez.app");

        let missing = setup.image.join("Missing.app");
        assert!(matches!(
            swap_by_renames(&missing, &setup.bundle, &backup),
            Err(Replace::Failed(_))
        ));
        assert_eq!(short_version(&setup.bundle), "0.15.1");
        assert!(!backup.exists());

        assert_eq!(
            swap_by_renames(&setup.new_app, &setup.bundle, &backup).ok(),
            Some(backup.clone())
        );
        assert_eq!(short_version(&setup.bundle), "0.16.0");
        assert_eq!(short_version(&backup), "0.15.1");
    }

    #[test]
    fn helper_moves_the_staged_files_into_the_app_once_dez_has_quit() {
        let setup = Setup::new();
        let executable = setup.bundle.join("Contents/MacOS/dez");
        let old_inode = fs::metadata(&executable).expect("stat").ino();
        let finish = stage_binary(&setup.new_app, &setup.bundle, &setup.private_dir)
            .expect("stage");

        let log = setup.run_helper(&finish);

        assert_eq!(short_version(&setup.bundle), "0.16.0");
        // A new file in place of the old one, not the old one written over.
        assert_ne!(fs::metadata(&executable).expect("stat").ino(), old_inode);
        check_code_signature(&setup.bundle).expect("signed again");
        // As the release signed it, not a plain `--sign -`.
        assert!(has_hardened_runtime(&setup.bundle));
        assert_eq!(names_in(&setup.bundle.join("Contents/MacOS")), ["dez"]);
        assert!(!setup.private_dir.exists());
        assert!(
            log.lines().any(|line| Path::new(line) == setup.bundle),
            "{log}"
        );
    }

    #[test]
    fn helper_removes_an_old_app_that_dez_could_not_remove() {
        let setup = Setup::new();
        let leftover = setup.bundle.with_file_name(".dez-update-test");
        make_app(&leftover.join("Dez.app"), ID, "0.15.0");
        let finish = Finish::Replaced {
            bundle: setup.bundle.clone(),
            leftover: Some(leftover.clone()),
        };

        let log = setup.run_helper(&finish);

        assert!(!leftover.exists());
        assert!(!setup.private_dir.exists());
        assert_eq!(short_version(&setup.bundle), "0.15.1");
        assert!(
            log.lines().any(|line| Path::new(line) == setup.bundle),
            "{log}"
        );
    }

    #[test]
    fn helper_logs_paths_with_backslashes_as_they_are() {
        let setup = Setup::new();
        // `echo` in `sh` reads `\t` as a tab and `\c` as "print no more".
        let leftover = setup.bundle.with_file_name(r".dez-update-a\tb\cc");
        fs::create_dir(&leftover).expect("folder");
        let finish = Finish::Replaced {
            bundle: setup.bundle.clone(),
            leftover: Some(leftover.clone()),
        };

        let log = setup.run_helper(&finish);

        let removing = format!(" Removing {}", leftover.display());
        assert!(log.lines().any(|line| line.ends_with(&removing)), "{log}");
    }
}
