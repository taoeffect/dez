//! The macOS part of the updater: which app bundle Dez runs from, and
//! whether Dez may replace that bundle in place.

use std::ffi::CString;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};

const MOVE_TO_APPLICATIONS: &str =
    "Move Dez to the Applications folder, open it from there, and try again.";

/// Why Dez cannot install an update in place, or `None` when it can. The
/// update window shows the reason and offers the release page instead.
/// `identifier` is the bundle identifier from tauri.conf.json.
pub fn install_blocked_reason(identifier: &str) -> Option<String> {
    if cfg!(debug_assertions) {
        return Some("Development builds do not install updates.".into());
    }
    // Releases have only Apple Silicon DMGs (`verify::dmg_file_name`). A
    // build made from source for an Intel Mac would install an app that it
    // cannot run.
    if !cfg!(target_arch = "aarch64") {
        return Some("Dez releases are built only for Apple Silicon Macs.".into());
    }
    let bundle = match running_bundle() {
        Ok(bundle) => bundle,
        Err(error) => return Some(error),
    };
    if let Some(problem) = location_problem(&bundle) {
        return Some(problem);
    }
    match is_on_read_only_volume(&bundle) {
        Ok(false) => {}
        Ok(true) => {
            return Some(format!(
                "Dez is on a read-only volume. {MOVE_TO_APPLICATIONS}"
            ));
        }
        Err(error) => {
            return Some(format!(
                "Dez could not check the volume it runs from: {error}"
            ));
        }
    }
    match info_plist_string(&bundle, "CFBundleIdentifier") {
        Ok(found) if found == identifier => None,
        Ok(found) => Some(format!(
            "Dez's app bundle has the identifier {found}, not {identifier}."
        )),
        Err(error) => Some(error),
    }
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
    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
