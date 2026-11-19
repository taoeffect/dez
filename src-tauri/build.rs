use sha2::{Digest, Sha256};
use std::{env, fs, io, path::Path, process};

/// The Tauri config. Its `bundle.externalBin` is the one list of the
/// programs that Dez ships next to its own program.
const CONFIG_PATH: &str = "tauri.conf.json";

/// A folder of src-tauri/ that a script vendors: files that are not plain
/// Git files, and a `manifest.json` that names the size and the SHA-256 of
/// each one.
struct VendoredFolder {
    folder: &'static str,
    source: FileSource,
    /// The script call that vendors the files again, for the error texts.
    vendor_step: &'static str,
}

/// Where a checkout gets the files of a vendored folder.
enum FileSource {
    /// Git LFS: a checkout without LFS has a small pointer file in the place
    /// of each file.
    GitLfs,
    /// Git ignores the files (.gitignore), and scripts/fetch-programs.js
    /// downloads the ones of a build target from the URLs of the manifest.
    /// This build script downloads nothing, so that no build needs the
    /// network: it only names that script in its error texts.
    FetchScript,
}

impl FileSource {
    /// What gets a file of the folder as its manifest names it: the first
    /// part of the advice of an error text.
    fn get_step(&self) -> String {
        match self {
            Self::GitLfs => "Install Git LFS and run `git lfs pull` to get the file of the repository".to_string(),
            Self::FetchScript => format!(
                "Run `node scripts/fetch-programs.js --target {}` in the folder of the repository to download it",
                build_target()
            ),
        }
    }
}

/// The ffmpeg and ffprobe programs of every build target.
const BINARIES: VendoredFolder = VendoredFolder {
    folder: "binaries",
    source: FileSource::FetchScript,
    vendor_step: "run `node scripts/update-ffmpeg.js <release tag>` to vendor another version",
};

/// The fonts that the programs can use, the same for every build target.
const FONTS: VendoredFolder = VendoredFolder {
    folder: "fonts",
    source: FileSource::GitLfs,
    vendor_step: "run `node scripts/update-fonts.js` to vendor the fonts of its list",
};

impl VendoredFolder {
    /// The manifest of the folder, and a `rerun-if-changed` for it.
    fn manifest(&self) -> Result<serde_json::Value, String> {
        let path = format!("{}/manifest.json", self.folder);
        println!("cargo:rerun-if-changed={path}");
        read_json(&path)
    }

    /// The manifest of the folder, as the error texts name it.
    fn shown_manifest(&self) -> String {
        format!("src-tauri/{}/manifest.json", self.folder)
    }
}

fn main() {
    let prepared = bundled_tools()
        .and_then(|tools| {
            check_bundled_tools(&tools)?;
            write_bundled_tools(&tools)
        })
        .and_then(|()| check_fonts());
    if let Err(problem) = prepared {
        eprintln!("{problem}");
        process::exit(1);
    }
    tauri_build::build()
}

/// The JSON of a file of src-tauri/.
fn read_json(path: &str) -> Result<serde_json::Value, String> {
    let text = fs::read_to_string(path).map_err(|error| format!("Cannot read src-tauri/{path}: {error}"))?;
    serde_json::from_str(&text).map_err(|error| format!("src-tauri/{path} is not JSON: {error}"))
}

/// The names of the programs that Dez ships, from `bundle.externalBin` of
/// the Tauri config: each entry is `binaries/<name>`, and the file of the
/// program for one build target is `binaries/<name>-<target triple>`.
fn bundled_tools() -> Result<Vec<String>, String> {
    println!("cargo:rerun-if-changed={CONFIG_PATH}");
    let config = read_json(CONFIG_PATH)?;
    let Some(programs) = config["bundle"]["externalBin"].as_array() else {
        return Err(format!("src-tauri/{CONFIG_PATH} has no `bundle.externalBin` list."));
    };
    programs
        .iter()
        .map(|program| {
            program
                .as_str()
                .and_then(|path| path.strip_prefix("binaries/"))
                .filter(|name| !name.is_empty() && !name.contains('/'))
                .map(str::to_string)
                .ok_or_else(|| {
                    format!(
                        "src-tauri/{CONFIG_PATH}: each entry of `bundle.externalBin` must be \
                         \"binaries/<name>\", and one is {program}."
                    )
                })
        })
        .collect()
}

/// Writes the names of the bundled programs as the constant `BUNDLED_TOOLS`
/// of src/bundled_tools.rs (its `include!`), the programs that a run can
/// name.
fn write_bundled_tools(tools: &[String]) -> Result<(), String> {
    let path = Path::new(&env::var("OUT_DIR").expect("cargo sets OUT_DIR for a build script")).join("bundled_tools.rs");
    // `{:?}` writes each name as a Rust string literal.
    let names: Vec<String> = tools.iter().map(|tool| format!("{tool:?}")).collect();
    fs::write(&path, format!("const BUNDLED_TOOLS: &[&str] = &[{}];\n", names.join(", ")))
        .map_err(|error| format!("Cannot write {}: {error}", path.display()))
}

/// The target triple of the build.
fn build_target() -> String {
    env::var("TARGET").expect("cargo sets TARGET for a build script")
}

/// Checks that the bundled tools of the build target are the files that
/// binaries/manifest.json names (size and SHA-256), before tauri-build
/// copies them next to the Dez program.
///
/// Why: the programs are not in Git, so a new checkout has none until
/// scripts/fetch-programs.js downloads them (`FileSource::FetchScript`).
/// And a program that Dez runs must be the one that scripts/update-ffmpeg.js
/// checked and pinned, whatever put the file there.
///
/// Cargo runs the build script again only when a file that it names with
/// `rerun-if-changed` changes (tauri-build names the config files), so most
/// builds do not hash the programs.
fn check_bundled_tools(tools: &[String]) -> Result<(), String> {
    let manifest = BINARIES.manifest()?;
    let target = build_target();

    for tool in tools {
        let name = format!("{tool}-{target}");
        let Some((size, sha256)) = size_and_sha256(&manifest["files"][&name]) else {
            return Err(format!(
                "Dez has no {tool} program for the build target {target}: \
                 {} does not name {name}. \
                 scripts/update-ffmpeg.js has the platforms that Dez ships programs for.",
                BINARIES.shown_manifest()
            ));
        };
        check_file(&BINARIES, &name, size, sha256)?;
    }
    Ok(())
}

/// Checks that the fonts are the files that fonts/manifest.json names, as
/// `check_bundled_tools` checks the programs: `bundle.resources` ships the
/// folder, and a Git LFS pointer file in the place of a font is a font that
/// ffmpeg cannot open.
fn check_fonts() -> Result<(), String> {
    let manifest = FONTS.manifest()?;
    // manifest.json is plain Git, not Git LFS: only the vendor step fixes it.
    let shown_manifest = FONTS.shown_manifest();
    let vendor_step = FONTS.vendor_step;
    let Some(fonts) = manifest["fonts"].as_object() else {
        return Err(format!("{shown_manifest} has no `fonts` object: {vendor_step}."));
    };
    for (name, entry) in fonts {
        let Some((size, sha256)) = size_and_sha256(entry) else {
            return Err(format!(
                "{shown_manifest} names no size or SHA-256 for {name}: {vendor_step}."
            ));
        };
        check_file(&FONTS, name, size, sha256)?;
    }
    Ok(())
}

/// Checks one file of a vendored folder against the size and the SHA-256 of
/// its manifest. The size comes first: it needs no read of the file, and it
/// finds a Git LFS pointer file.
fn check_file(
    vendored: &VendoredFolder,
    name: &str,
    size: u64,
    sha256: &str,
) -> Result<(), String> {
    let path = Path::new(vendored.folder).join(name);
    println!("cargo:rerun-if-changed={}", path.display());
    let shown = format!("src-tauri/{}", path.display());
    let manifest = vendored.shown_manifest();
    let advice = format!("{}, or {}.", vendored.source.get_step(), vendored.vendor_step);

    let found_size = fs::metadata(&path)
        .map_err(|error| format!("{shown} is missing ({error}). {advice}"))?
        .len();
    if found_size != size {
        if matches!(vendored.source, FileSource::GitLfs) && found_size < 1024 && is_lfs_pointer(&path) {
            return Err(format!(
                "{shown} is a Git LFS pointer file, not the file that {manifest} names. \
                 Install Git LFS and run `git lfs pull`."
            ));
        }
        return Err(format!(
            "{shown} has {found_size} bytes, and {manifest} names {size}. {advice}"
        ));
    }

    let mut hasher = Sha256::new();
    fs::File::open(&path)
        .and_then(|mut file| io::copy(&mut file, &mut hasher))
        .map_err(|error| format!("Cannot read {shown}: {error}"))?;
    let found_sha256 = format!("{:x}", hasher.finalize());
    if found_sha256 != sha256 {
        return Err(format!(
            "{shown} has the SHA-256 {found_sha256}, and {manifest} names {sha256}. {advice}"
        ));
    }
    Ok(())
}

/// The size and the SHA-256 that an entry of a manifest names.
fn size_and_sha256(entry: &serde_json::Value) -> Option<(u64, &str)> {
    Some((entry["size"].as_u64()?, entry["sha256"].as_str()?))
}

/// Whether a file is the text that Git LFS leaves in the place of a file
/// that it did not download.
fn is_lfs_pointer(path: &Path) -> bool {
    fs::read(path).is_ok_and(|bytes| bytes.starts_with(b"version https://git-lfs.github.com/spec/"))
}
