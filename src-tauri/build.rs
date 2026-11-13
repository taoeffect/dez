use sha2::{Digest, Sha256};
use std::{env, fs, io, path::Path, process};

/// The programs that Dez ships next to its own program (`bundle.externalBin`
/// in tauri.conf.json). The file of a program for one build target is
/// `binaries/<name>-<target triple>`.
const BUNDLED_TOOLS: [&str; 2] = ["dez-ffmpeg", "dez-ffprobe"];

const MANIFEST_PATH: &str = "binaries/manifest.json";

fn main() {
    if let Err(problem) = check_bundled_tools() {
        eprintln!("{problem}");
        process::exit(1);
    }
    tauri_build::build()
}

/// Checks that the bundled tools of the build target are the files that
/// binaries/manifest.json names (size and SHA-256), before tauri-build
/// copies them next to the Dez program.
///
/// Why: the files are in Git LFS, so a checkout without LFS has a small
/// pointer file in the place of each one, and Tauri would bundle that with
/// no error. And a program that Dez runs must be the one that
/// scripts/update-ffmpeg.js checked and vendored.
///
/// Cargo runs the build script again only when a file that it names with
/// `rerun-if-changed` changes (tauri-build names the config files), so most
/// builds do not hash the programs.
fn check_bundled_tools() -> Result<(), String> {
    println!("cargo:rerun-if-changed={MANIFEST_PATH}");
    let manifest = fs::read_to_string(MANIFEST_PATH)
        .map_err(|error| format!("Cannot read src-tauri/{MANIFEST_PATH}: {error}"))?;
    let manifest: serde_json::Value = serde_json::from_str(&manifest)
        .map_err(|error| format!("src-tauri/{MANIFEST_PATH} is not JSON: {error}"))?;
    let target = env::var("TARGET").expect("cargo sets TARGET for a build script");

    for tool in BUNDLED_TOOLS {
        let name = format!("{tool}-{target}");
        let path = Path::new("binaries").join(&name);
        println!("cargo:rerun-if-changed={}", path.display());
        let entry = &manifest["files"][&name];
        let (Some(size), Some(sha256)) = (entry["size"].as_u64(), entry["sha256"].as_str())
        else {
            return Err(format!(
                "Dez has no {tool} program for the build target {target}: \
                 src-tauri/{MANIFEST_PATH} does not name {name}. \
                 scripts/update-ffmpeg.js has the platforms that Dez ships programs for."
            ));
        };
        check_tool(&path, size, sha256)?;
    }
    Ok(())
}

/// Checks one program file against the size and the SHA-256 of the manifest.
/// The size comes first: it needs no read of the file, and it finds a Git LFS
/// pointer file.
fn check_tool(path: &Path, size: u64, sha256: &str) -> Result<(), String> {
    const GET_FILE: &str = "Install Git LFS and run `git lfs pull` to get the file of the \
                            repository, or run `node scripts/update-ffmpeg.js <release tag>` \
                            to vendor another version.";
    let shown = format!("src-tauri/{}", path.display());

    let found_size = fs::metadata(path)
        .map_err(|error| format!("{shown} is missing ({error}). {GET_FILE}"))?
        .len();
    if found_size != size {
        if found_size < 1024 && is_lfs_pointer(path) {
            return Err(format!(
                "{shown} is a Git LFS pointer file, not the program. \
                 Install Git LFS and run `git lfs pull`."
            ));
        }
        return Err(format!(
            "{shown} has {found_size} bytes, and src-tauri/{MANIFEST_PATH} names {size}. {GET_FILE}"
        ));
    }

    let mut hasher = Sha256::new();
    fs::File::open(path)
        .and_then(|mut file| io::copy(&mut file, &mut hasher))
        .map_err(|error| format!("Cannot read {shown}: {error}"))?;
    let found_sha256 = format!("{:x}", hasher.finalize());
    if found_sha256 != sha256 {
        return Err(format!(
            "{shown} has the SHA-256 {found_sha256}, and src-tauri/{MANIFEST_PATH} names {sha256}. \
             {GET_FILE}"
        ));
    }
    Ok(())
}

/// Whether a file is the text that Git LFS leaves in the place of a file
/// that it did not download.
fn is_lfs_pointer(path: &Path) -> bool {
    fs::read(path).is_ok_and(|bytes| bytes.starts_with(b"version https://git-lfs.github.com/spec/"))
}
