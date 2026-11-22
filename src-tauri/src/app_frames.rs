//! The frames of the apps. The page of a UI app (`apps/<name>/` of the app
//! root) is the work of a model, and Dez's page shows it in an
//! `<iframe sandbox="allow-scripts">`. Dez's own page has no content
//! security policy, and its asset protocol reads every file, so the page of
//! an app must reach nothing but the files of its own app: no server, no
//! file of the computer, no other app, and no command of Dez. The guards,
//! all in the one plugin of this module (`plugin`):
//!
//! - The scheme `dezapp://localhost/<name>/<path>` serves only a regular
//!   file below `apps/<name>/` (`scheme_file`, `serve`), and the libraries
//!   that Dez ships (`LIBS_ROUTE`). An app frame loads from this scheme
//!   only, never from the asset protocol.
//! - Dez's client script (`CLIENT_SCRIPT`) is served as `~dez.js` in the
//!   folder of each app, under the policy of that app. No file of an app
//!   can have that name (`is_app_file_segment`), so the page of an app
//!   that loads the name always gets Dez's own script.
//! - Each answer of the scheme has a `Content-Security-Policy` header
//!   (`app_policy`), which lets the page load only from the URL prefix of
//!   its own app, from Blobs, and from `data:` URLs. It also sandboxes the
//!   page, so the page has no origin: no storage, no cookies, and no reach
//!   into Dez's page.
//! - The navigation guard (`allows_navigation`): the policy does not stop a
//!   frame that navigates itself, so a page could send data out in a URL,
//!   or open an `asset:` URL. The guard lets the webview go only to Dez's
//!   own page and to the scheme.
//! - The content rule list (`RULE_LIST`): no directive of the policy stops
//!   `<link rel="preconnect">` (a TCP connection and a name lookup) and
//!   `<link rel="dns-prefetch">` (a name lookup), and a host name can
//!   carry data out. The list blocks each http(s) and ws(s) load of a
//!   child frame in the engine itself.
//! - No link preconnect (`LINK_PRECONNECT`): a click on a link that opens
//!   a new window makes WebKit connect to the server of the link at once.
//!   No other guard is asked first, also not the rule list, and the page
//!   can do the click itself. The feature is off for the whole webview.
//! - The gate (`Gate`): the two guards of the webview itself come on after
//!   the webview is made, and WebKit compiles the rule list first. The
//!   scheme answers a webview only when both are on, and serves it no
//!   file when one failed.
//!
//! What these guards leave open (the audit is tests/e2e/app-frames.e2e.ts):
//! - A frame can call `window.webkit.messageHandlers.ipc.postMessage`. Only
//!   a message with Tauri's invoke key runs a command, and a frame cannot
//!   read the key: the key is the only guard there.
//! - The navigation guard gets only the URL, not the frame. So a frame can
//!   go to the page of another app (under the policy of that app), to
//!   `about:blank`, and to `tauri://localhost/…`, which stays inert in the
//!   sandbox. The `sandbox` attribute of the `<iframe>` must stay for that
//!   reason: the policy of a page ends with the page.
//! - A frame runs on the thread of Dez's page: a page that never pauses
//!   stops Dez.
//! - The audit runs on Linux only. Its pages ran by hand on a Mac, with the
//!   outcomes of Linux; run them there again after an update of macOS,
//!   wry, or Tauri.

use std::borrow::Cow;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::sync::{Arc, Mutex, PoisonError};

use tauri::http::{Method, Request, Response, StatusCode, Uri, header, response};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime, Url, Webview};

use crate::bundled_tools::LIBS_FOLDER;
use crate::persistence::{APPS_FOLDER, FileRoot, is_app_file_segment, open_app_file};

const SCHEME: &str = "dezapp";

// The one host of the scheme, and of Tauri's own scheme on Linux and macOS.
const HOST: &str = "localhost";

// The page of a refused request: it loads nothing and runs nothing.
const LOCKED_POLICY: &str = "default-src 'none'; sandbox";

// The answer for each path that names no file that the scheme serves. It
// tells no reason and no path: the code of an app can read it.
const NO_SUCH_FILE: &str = "No such file in this app.";

// Dez's client script of the page of an app: what a page needs to work
// with the frame host of Dez's page. The host and the script change
// together, so the script is no file of an app: the scheme serves this
// text under the name `CLIENT_SCRIPT_NAME` in the folder of each app,
// which is inside the script source of the app's policy. `~` is in no
// name of a file of an app (`is_app_file_segment`).
const CLIENT_SCRIPT: &str = include_str!("app_client.js");
const CLIENT_SCRIPT_NAME: &str = "~dez.js";

// The route of the libraries that Dez ships, in the folder of each app:
// `dezapp://localhost/<name>/~libs/<path>` is `<path>` of `LIBS_FOLDER` of
// Tauri's resource dir, read only. A page imports them by the names of
// its import map (the `ui` template, src/model/tools/appTemplates.ts), as
// a run of Deno does. The route is inside the URL prefix of each app, so
// the policy of the app lets its page load them, and no new source. `~`
// is in no name of a file of an app, so no file of an app can take the
// place of a library.
const LIBS_ROUTE: &str = "~libs";

// The name of the rule list in the store of the OS.
#[cfg(any(target_os = "linux", target_os = "macos"))]
const RULE_LIST_NAME: &str = "dez-app-frames";

// The WebKit feature that connects to a server before a load asks for it:
// for `<link rel="preconnect">`, and for a click on a link whose target is
// a new window (`HTMLAnchorElement::handleClick` of WebKit). The click
// asks no content rule list, no policy of the page, and no navigation
// guard, and a sandboxed frame can do it. Dez's own page loads nothing
// from a server, so it does not need the feature.
#[cfg(any(target_os = "linux", target_os = "macos"))]
const LINK_PRECONNECT: &str = "LinkPreconnect";

// The content rule list of the webview (the JSON form of a WebKit content
// blocker). `load-context: child-frame` leaves Dez's own page alone, and
// still holds for a frame that went to `about:blank`. One rule for each
// scheme pair: the rule compiler takes no `a|b` in a `url-filter`.
// https://webkit.org/blog/3476/content-blockers-first-look/
#[cfg(any(target_os = "linux", target_os = "macos"))]
const RULE_LIST: &str = r#"[
{"trigger":{"url-filter":"^https?:","load-context":["child-frame"]},"action":{"type":"block"}},
{"trigger":{"url-filter":"^wss?:","load-context":["child-frame"]},"action":{"type":"block"}}
]"#;

// The content type of a file by the ending of its name. Each answer has
// `nosniff`, so a script or a stylesheet with an ending that is not here
// does not load.
const CONTENT_TYPES: &[(&str, &str)] = &[
    ("html", "text/html; charset=utf-8"),
    ("htm", "text/html; charset=utf-8"),
    ("js", "text/javascript; charset=utf-8"),
    ("mjs", "text/javascript; charset=utf-8"),
    ("css", "text/css; charset=utf-8"),
    ("json", "application/json"),
    ("map", "application/json"),
    ("txt", "text/plain; charset=utf-8"),
    ("md", "text/plain; charset=utf-8"),
    ("csv", "text/csv; charset=utf-8"),
    ("xml", "application/xml"),
    ("wasm", "application/wasm"),
    ("svg", "image/svg+xml"),
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("avif", "image/avif"),
    ("bmp", "image/bmp"),
    ("ico", "image/x-icon"),
    ("woff2", "font/woff2"),
    ("woff", "font/woff"),
    ("ttf", "font/ttf"),
    ("otf", "font/otf"),
    ("mp3", "audio/mpeg"),
    ("wav", "audio/wav"),
    ("ogg", "audio/ogg"),
    ("oga", "audio/ogg"),
    ("opus", "audio/ogg"),
    ("m4a", "audio/mp4"),
    ("aac", "audio/aac"),
    ("flac", "audio/flac"),
    ("weba", "audio/webm"),
    ("mp4", "video/mp4"),
    ("m4v", "video/mp4"),
    ("webm", "video/webm"),
    ("ogv", "video/ogg"),
    ("mov", "video/quicktime"),
];

fn content_type(path: &str) -> &'static str {
    let ending = path.rsplit_once('.').map_or("", |(_, ending)| ending);
    CONTENT_TYPES
        .iter()
        .find(|(known, _)| known.eq_ignore_ascii_case(ending))
        .map_or("application/octet-stream", |(_, content_type)| content_type)
}

// The path of a URL of the scheme, without its first `/`; none for a URL
// with another authority than the one host, so a port or a user name is
// refused too. A query is no part of the path.
fn scheme_path(uri: &Uri) -> Option<&str> {
    if uri.authority().map(|authority| authority.as_str()) != Some(HOST) {
        return None;
    }
    uri.path().strip_prefix('/')
}

// The file that a URL of the scheme names.
#[derive(Debug, PartialEq)]
struct SchemeFile<'a> {
    // The folder name of the app: the answer has the policy of this app.
    app: &'a str,
    // The root of the file, and its path there: `apps/<app>/<path>` of the
    // app root, or `libs/<path>` of the resource root.
    root: FileRoot,
    path: String,
}

// The file that `uri` names; none for every URL that is not
// `dezapp://localhost/<name>/<path>` with each part a plain file name
// (`is_app_file_segment`). So a `..`, an empty part, and a `%` escape of
// one are refused and never decoded, the folder of an app is no file (no
// default page), and the name of the app is safe in a header value.
// `<path>` is a file of the folder of the app, or with the first part
// `LIBS_ROUTE` (no file name of an app), a file of the shipped libraries.
fn scheme_file(uri: &Uri) -> Option<SchemeFile<'_>> {
    let path = scheme_path(uri)?;
    let (app, in_app) = path.split_once('/')?;
    let (root, path) = match in_app.split_once('/') {
        Some((LIBS_ROUTE, in_libs)) => (FileRoot::Resource, format!("{LIBS_FOLDER}/{in_libs}")),
        _ => (FileRoot::App, format!("{APPS_FOLDER}/{path}")),
    };
    (is_app_file_segment(app) && path.split('/').all(is_app_file_segment)).then_some(SchemeFile { app, root, path })
}

// The app in whose folder `uri` names Dez's client script
// (`dezapp://localhost/<name>/~dez.js`); none for every other URL. The
// name of the app is a plain file name, as in `scheme_file`.
fn client_script_app(uri: &Uri) -> Option<&str> {
    let (app, file) = scheme_path(uri)?.split_once('/')?;
    (file == CLIENT_SCRIPT_NAME && is_app_file_segment(app)).then_some(app)
}

// The policy of each page and file of the app `app`. `own` is the URL
// prefix of the app: `'self'` matches nothing in a sandboxed page, and a
// source with no path (`dezapp:`) would let an app load the files of each
// other app. Why each part is there:
// - `default-src 'none'`: what no later part names is refused (objects,
//   manifests).
// - `sandbox allow-scripts`: the page has no origin, also when an
//   `<iframe>` has no `sandbox` attribute.
// - Scripts, styles, images, fonts, clips, and `fetch`: the app's own
//   files, Blobs, and `data:` URLs, none of which is a network load.
// - `'unsafe-inline'`, `'unsafe-eval'`, `'wasm-unsafe-eval'`: inline code,
//   `eval`, and WebAssembly. The code is the model's own in each form, so
//   these give it no new reach.
// - `worker-src blob:`: a Worker from a Blob keeps this policy, and takes
//   long work off the thread of Dez's page. A Worker from a file of the
//   app never starts in a sandboxed page.
// - No nested frame, no form target, no `<base>`.
// - `webrtc 'block'`: WebKit does not enforce it. On a Mac, the STUN
//   packets and the TURN connection of a frame reached a local server.
//   The guard of WebRTC is the switch of the webview on macOS
//   (`turn_off_peer_connection`). WebKitGTK has WebRTC off by default,
//   which the frame audit checks.
fn app_policy(app: &str) -> String {
    let own = format!("{SCHEME}://{HOST}/{app}/");
    format!(
        "default-src 'none'; sandbox allow-scripts; \
         script-src {own} blob: data: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; \
         style-src {own} blob: data: 'unsafe-inline'; \
         img-src {own} blob: data:; font-src {own} blob: data:; media-src {own} blob: data:; \
         connect-src {own} blob: data:; worker-src blob:; \
         frame-src 'none'; form-action 'none'; base-uri 'none'; webrtc 'block'"
    )
}

// The headers of every answer of the scheme, a refusal too:
// - `nosniff`: a file is only what its ending tells.
// - The policy: each file can be the page of a frame.
// - `Access-Control-Allow-Origin`: a sandboxed page sends `Origin: null`
//   with a module script, a `fetch`, and a WebAssembly stream, and they
//   fail with no such header. `*` opens nothing: the policy of each app
//   keeps the other apps out, and Dez's own page can read every file.
// - `no-store`: a file that a model changed loads as it is now.
fn answer(status: StatusCode, content_type: &str, policy: &str) -> response::Builder {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CONTENT_SECURITY_POLICY, policy)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "no-store")
}

type Answer = Response<Cow<'static, [u8]>>;

// An answer with no file: a text under the locked policy.
fn refusal(status: StatusCode, text: impl Into<Cow<'static, str>>) -> Answer {
    let body = match text.into() {
        Cow::Borrowed(text) => Cow::Borrowed(text.as_bytes()),
        Cow::Owned(text) => Cow::Owned(text.into_bytes()),
    };
    answer(status, "text/plain; charset=utf-8", LOCKED_POLICY)
        .body(body)
        .expect("each header value is a constant")
}

// A count of bytes in a `Range` header: digits only (`parse` alone also
// takes a `+`).
fn byte_count(text: &str) -> Option<u64> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

// The first and the last byte that a `Range` header asks of a file of
// `size` bytes: `bytes=<first>-<last>`, `bytes=<first>-`, or `bytes=-<count>`
// (the last bytes). None for a list of ranges, a range that the file does
// not have, and each other form: the answer is then the whole file, which
// HTTP allows for every `Range` header.
fn byte_range(value: &str, size: u64) -> Option<(u64, u64)> {
    let (first, last) = value.strip_prefix("bytes=")?.split_once('-')?;
    let end = size.checked_sub(1)?;
    let (first, last) = if first.is_empty() {
        let count = byte_count(last)?;
        (size.saturating_sub(count), end)
    } else if last.is_empty() {
        (byte_count(first)?, end)
    } else {
        (byte_count(first)?, byte_count(last)?.min(end))
    };
    (first <= last).then_some((first, last))
}

// The bytes of a file that a request gets. With a `Range` header that
// `byte_range` takes, only the bytes of its span, with the first and the
// last byte and the size of the file; else the whole file. A page that
// reads a large file in parts must not cost a read of the whole file for
// each part.
fn read_span(file: &mut (impl Read + Seek), range: Option<&str>) -> std::io::Result<(Vec<u8>, Option<(u64, u64, u64)>)> {
    if let Some(range) = range {
        let size = file.seek(SeekFrom::End(0))?;
        if let Some((first, last)) = byte_range(range, size) {
            file.seek(SeekFrom::Start(first))?;
            let mut bytes = vec![0; usize::try_from(last - first + 1).map_err(|_| std::io::ErrorKind::OutOfMemory)?];
            // A file that became shorter after the size was read fails here.
            file.read_exact(&mut bytes)?;
            return Ok((bytes, Some((first, last, size))));
        }
        file.rewind()?;
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok((bytes, None))
}

// Whether the guards of a webview itself are on (no link preconnect, and
// the content rule list), or why they are not.
type WebviewGuards = Result<(), String>;

// The answer to one request of the scheme. `guards` are those of the
// webview of the request. `open` opens a file of a root (`open_app_file`:
// in the app root it refuses a path through a link and all that is no
// regular file); it gets only a path that `scheme_file` passed. The
// client script is read from no file.
fn serve<F: Read + Seek>(request: &Request<Vec<u8>>, guards: &WebviewGuards, open: impl FnOnce(FileRoot, &str) -> Result<F, String>) -> Answer {
    if let Err(problem) = guards {
        // No code of an app can read this text: with a guard off, no page
        // of an app loads. The user sees it in the frame of a shown app.
        // A restart does not help on a macOS that lacks an API of a guard
        // (`platform`), so the text tells that floor first.
        return refusal(
            StatusCode::SERVICE_UNAVAILABLE,
            format!(
                "Dez cannot show apps: a guard of the app frames did not start, and Dez shows no app without all of its guards. \
                 On a Mac, the guards need macOS 13.3 or newer: an older macOS shows no app, also after a restart of Dez. \
                 Else, start Dez again. If the error stays, report it at Help › Dez on GitHub.\n\nDetails: {problem}"
            ),
        );
    }
    if request.method() != Method::GET {
        let mut refused = refusal(StatusCode::METHOD_NOT_ALLOWED, "The files of an app can only be read.");
        refused.headers_mut().insert(header::ALLOW, header::HeaderValue::from_static("GET"));
        return refused;
    }
    if let Some(app) = client_script_app(request.uri()) {
        return answer(StatusCode::OK, content_type(CLIENT_SCRIPT_NAME), &app_policy(app))
            .body(Cow::Borrowed(CLIENT_SCRIPT.as_bytes()))
            .expect("each header value is plain ASCII");
    }
    let Some(file) = scheme_file(request.uri()) else {
        return refusal(StatusCode::NOT_FOUND, NO_SUCH_FILE);
    };
    let Ok(mut opened) = open(file.root, &file.path) else {
        return refusal(StatusCode::NOT_FOUND, NO_SUCH_FILE);
    };
    let range = request.headers().get(header::RANGE).and_then(|value| value.to_str().ok());
    let Ok((bytes, span)) = read_span(&mut opened, range) else {
        return refusal(StatusCode::NOT_FOUND, NO_SUCH_FILE);
    };
    let found = answer(StatusCode::OK, content_type(&file.path), &app_policy(file.app)).header(header::ACCEPT_RANGES, "bytes");
    let found = match span {
        Some((first, last, size)) => found
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_RANGE, format!("bytes {first}-{last}/{size}")),
        None => found,
    };
    // The name of the app is the one part of a header value that is no
    // constant and no number, and `app_file` passed it.
    found.body(Cow::Owned(bytes)).expect("each header value is plain ASCII")
}

// Whether the webview can go to `url`. Tauri asks for each navigation of
// each frame, and gives only the URL. Allowed: Dez's own page (Tauri's
// scheme on Linux and macOS, and the dev server `dev_page` of a dev build),
// the app scheme, and the empty page `about:blank`, which the webview and
// WebDriver open themselves. Refused: all else, so an http(s), `data:`,
// `blob:`, `asset:`, `ipc:`, or `file:` URL.
fn allows_navigation(url: &Url, dev_page: Option<&Url>) -> bool {
    match url.scheme() {
        "tauri" | SCHEME => url.host_str() == Some(HOST),
        "about" => url.as_str() == "about:blank",
        // Each part by itself: the `origin` of a `blob:` URL is that of the
        // URL that it holds.
        _ => dev_page.is_some_and(|page| {
            url.scheme() == page.scheme() && url.host_str() == page.host_str() && url.port_or_known_default() == page.port_or_known_default()
        }),
    }
}

// What a webview waits for, or has: the result of its guards.
enum GateState {
    Waiting(Vec<Box<dyn FnOnce(&WebviewGuards) + Send>>),
    Decided(WebviewGuards),
}

// Holds each request of the scheme until the guards of its webview are on
// or have failed, by the label of the webview. A webview that nothing is
// known of waits. So no page of an app loads in a webview that a guard is
// not on in, however early the request comes.
#[derive(Default)]
struct Gate(Mutex<HashMap<String, GateState>>);

impl Gate {
    fn states(&self) -> std::sync::MutexGuard<'_, HashMap<String, GateState>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    // Runs `work` with the result of the guards of `webview`: at once when
    // it is known, else when `decide` gets it.
    fn when_decided(&self, webview: &str, work: impl FnOnce(&WebviewGuards) + Send + 'static) {
        let guards = {
            let mut states = self.states();
            match states.get_mut(webview) {
                Some(GateState::Decided(guards)) => guards.clone(),
                Some(GateState::Waiting(waiting)) => return waiting.push(Box::new(work)),
                None => {
                    states.insert(webview.to_string(), GateState::Waiting(vec![Box::new(work)]));
                    return;
                }
            }
        };
        // Outside the lock: `work` is the code of the caller.
        work(&guards);
    }

    // A new webview has no guards yet, whatever an earlier webview of the
    // same label had.
    fn close(&self, webview: &str) {
        let mut states = self.states();
        if let Some(GateState::Decided(_)) = states.get(webview) {
            states.remove(webview);
        }
    }

    // Keeps the result of the guards of `webview`, and runs the work that
    // waited for it.
    fn decide(&self, webview: &str, guards: WebviewGuards) {
        let earlier = self.states().insert(webview.to_string(), GateState::Decided(guards.clone()));
        if let Some(GateState::Waiting(waiting)) = earlier {
            for work in waiting {
                work(&guards);
            }
        }
    }
}

// Puts the guards of a webview itself on: no link preconnect, on macOS no
// WebRTC, and the content rule list. `decide` gets the result. WebKit
// compiles the list first, so the result comes later, on the main thread.
// A failure of `with_webview` means that the event loop is gone (Dez
// quits): `decide` then never runs, and the gate stays shut.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn guard_webview<R: Runtime>(webview: &Webview<R>, decide: impl FnOnce(WebviewGuards) + Send + 'static) {
    // The store of the compiled list on Linux: a folder of the webview's
    // own cache. Not Dez's cache folder (`<OS cache>/dez/`): a bundled
    // program can write there, and the cleanup of unused files reads it.
    #[cfg(target_os = "linux")]
    let store = match webview.path().app_cache_dir() {
        Ok(cache) => cache.join("app-frame-rules"),
        Err(error) => return decide(Err(error.to_string())),
    };
    let guarded = webview.with_webview(move |webview| {
        let web_view = webview.inner();
        #[cfg(target_os = "linux")]
        let web_view = &web_view;
        let turned_off = platform::turn_off_link_preconnect(web_view);
        #[cfg(target_os = "macos")]
        let turned_off = turned_off.and_then(|()| platform::turn_off_peer_connection(web_view));
        match turned_off {
            #[cfg(target_os = "linux")]
            Ok(()) => platform::add_rule_list(web_view, &store, Box::new(decide)),
            #[cfg(target_os = "macos")]
            Ok(()) => platform::add_rule_list(webview.controller(), Box::new(decide)),
            Err(problem) => decide(Err(problem)),
        }
    });
    if let Err(error) = guarded {
        eprintln!("The webview did not take the guards of the app frames: {error}");
    }
}

// Dez ships for Linux and macOS only. On another system no app shows.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn guard_webview<R: Runtime>(_webview: &Webview<R>, decide: impl FnOnce(WebviewGuards) + Send + 'static) {
    decide(Err("Dez has no guards of the app frames on this system".to_string()));
}

// WebKitGTK. The webkit2gtk crate has no safe binding for the two guards,
// so both are C functions of the library.
#[cfg(target_os = "linux")]
mod platform {
    use std::ffi::{CStr, CString, c_char};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr;

    use webkit2gtk::glib::translate::{ToGlibPtr, from_glib_full};
    use webkit2gtk::glib::{self, gobject_ffi};
    use webkit2gtk::{UserContentManager, WebView, WebViewExt, ffi, gio};

    use super::{LINK_PRECONNECT, RULE_LIST, RULE_LIST_NAME, WebviewGuards};

    // The feature list of the library (`WebKitFeature`, WebKitGTK 2.42).
    // The webkit2gtk crate ends at WebKitGTK 2.40, so it does not declare
    // these functions of the library that it links.
    #[repr(C)]
    struct Feature {
        _opaque: [u8; 0],
    }
    #[repr(C)]
    struct FeatureList {
        _opaque: [u8; 0],
    }
    unsafe extern "C" {
        fn webkit_settings_get_all_features() -> *mut FeatureList;
        fn webkit_feature_list_get_length(list: *mut FeatureList) -> usize;
        fn webkit_feature_list_get(list: *mut FeatureList, index: usize) -> *mut Feature;
        fn webkit_feature_list_unref(list: *mut FeatureList);
        fn webkit_feature_get_identifier(feature: *mut Feature) -> *const c_char;
        fn webkit_settings_get_feature_enabled(settings: *mut ffi::WebKitSettings, feature: *mut Feature) -> glib::ffi::gboolean;
        fn webkit_settings_set_feature_enabled(settings: *mut ffi::WebKitSettings, feature: *mut Feature, enabled: glib::ffi::gboolean);
    }

    // Turns the feature `LINK_PRECONNECT` of the webview off, and checks
    // that it is off. Runs on the main thread.
    pub(super) fn turn_off_link_preconnect(web_view: &WebView) -> WebviewGuards {
        let Some(settings) = web_view.settings() else {
            return Err("the webview has no settings".to_string());
        };
        let settings = settings.to_glib_none();
        // SAFETY: the list is this code's own from its call to the unref,
        // and holds each feature that it gives. The identifier of a feature
        // is a C text of the library. `settings` is a live object.
        unsafe {
            let features = webkit_settings_get_all_features();
            let mut turned_off = Err(format!("WebKit has no feature `{LINK_PRECONNECT}`"));
            for index in 0..webkit_feature_list_get_length(features) {
                let feature = webkit_feature_list_get(features, index);
                if CStr::from_ptr(webkit_feature_get_identifier(feature)).to_bytes() != LINK_PRECONNECT.as_bytes() {
                    continue;
                }
                webkit_settings_set_feature_enabled(settings.0, feature, glib::ffi::GFALSE);
                turned_off = if webkit_settings_get_feature_enabled(settings.0, feature) == glib::ffi::GFALSE {
                    Ok(())
                } else {
                    Err(format!("WebKit did not turn the feature `{LINK_PRECONNECT}` off"))
                };
                break;
            }
            webkit_feature_list_unref(features);
            turned_off
        }
    }

    // What `saved` needs. It is on the heap from the start of the compile
    // to its end, as the `user_data` of the C call.
    struct Pending {
        manager: UserContentManager,
        decide: Box<dyn FnOnce(WebviewGuards) + Send>,
    }

    // The content rule list: `WebKitUserContentFilterStore` compiles it
    // into a file of the folder `store`, which WebKit makes, and the user
    // content manager of the webview takes the compiled filter (`saved`).
    // The list is compiled anew at each start, so a store that an older
    // Dez left is never used. Runs on the main thread.
    pub(super) fn add_rule_list(web_view: &WebView, store: &Path, decide: Box<dyn FnOnce(WebviewGuards) + Send>) {
        let Some(manager) = web_view.user_content_manager() else {
            return decide(Err("the webview has no user content manager".to_string()));
        };
        let (Ok(store), Ok(name)) = (CString::new(store.as_os_str().as_bytes()), CString::new(RULE_LIST_NAME)) else {
            return decide(Err("the folder of the rule list has a NUL in its path".to_string()));
        };
        let source = glib::Bytes::from_static(RULE_LIST.as_bytes());
        let pending = Box::into_raw(Box::new(Pending { manager, decide }));
        // SAFETY: each pointer is valid for its call. WebKit takes its own
        // reference to `source`, copies the two texts, and calls `saved`
        // one time with `pending`. The task of the save holds the store
        // object until `saved` returns, so this code can let go of it.
        unsafe {
            let store = ffi::webkit_user_content_filter_store_new(store.as_ptr());
            ffi::webkit_user_content_filter_store_save(store, name.as_ptr(), source.to_glib_none().0, ptr::null_mut(), Some(saved), pending.cast());
            gobject_ffi::g_object_unref(store.cast());
        }
    }

    // The end of the compile: adds the filter to the webview.
    unsafe extern "C" fn saved(store: *mut gobject_ffi::GObject, result: *mut gio::ffi::GAsyncResult, pending: glib::ffi::gpointer) {
        // SAFETY: `pending` is the box that `add` made, and WebKit calls
        // this function one time.
        let Pending { manager, decide } = *unsafe { Box::from_raw(pending.cast::<Pending>()) };
        let mut error = ptr::null_mut();
        // SAFETY: `store` and `result` are those of this save. The call
        // gives a filter that this code owns, or sets `error`.
        let filter = unsafe { ffi::webkit_user_content_filter_store_save_finish(store.cast(), result, &mut error) };
        let rule_list = if !filter.is_null() {
            // SAFETY: the manager takes its own hold of the rules, so this
            // code gives up the filter.
            unsafe {
                ffi::webkit_user_content_manager_add_filter(manager.to_glib_none().0, filter);
                ffi::webkit_user_content_filter_unref(filter);
            }
            Ok(())
        } else if error.is_null() {
            Err("WebKit gave no filter and no error".to_string())
        } else {
            // SAFETY: the call set `error` to an error that this code owns.
            let error: glib::Error = unsafe { from_glib_full(error) };
            Err(error.to_string())
        };
        decide(rule_list);
    }
}

// WKWebView. No CI runs the frame audit on macOS (see the top of this
// file).
#[cfg(target_os = "macos")]
mod platform {
    use std::cell::Cell;
    use std::ffi::c_void;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::{MainThreadMarker, msg_send, sel};
    use objc2_foundation::{NSArray, NSError, NSString};
    use objc2_web_kit::{WKContentRuleList, WKContentRuleListStore, WKUserContentController};

    use super::{LINK_PRECONNECT, RULE_LIST, RULE_LIST_NAME, WebviewGuards};

    // The `WKPreferences` of the webview `web_view` (a `WKWebView`): those
    // of the live webview, not a copy.
    fn preferences(web_view: *mut c_void) -> Result<Retained<AnyObject>, String> {
        // SAFETY: Tauri gives a live `WKWebView`, or null.
        let Some(web_view) = (unsafe { web_view.cast::<AnyObject>().as_ref() }) else {
            return Err("Tauri gave no webview".to_string());
        };
        // SAFETY: two public properties, each an object or nil. A copy of
        // the configuration holds the same preferences object.
        let preferences: Option<Retained<AnyObject>> = unsafe {
            let configuration: Option<Retained<AnyObject>> = msg_send![web_view, configuration];
            match configuration {
                Some(configuration) => msg_send![&*configuration, preferences],
                None => None,
            }
        };
        preferences.ok_or_else(|| "the webview has no preferences".to_string())
    }

    // Turns the feature `LINK_PRECONNECT` of the webview `web_view` (a
    // `WKWebView`) off, and checks that it is off. WebKit has no public
    // switch for it. These are the private methods of the feature list of
    // `WKPreferences` (`WKPreferencesPrivate.h` of WebKit, macOS 13.3):
    // `+_features`, `-_setEnabled:forFeature:`, `-_isEnabledForFeature:`,
    // and the `key` of a `_WKFeature`. An older macOS has none of them,
    // and then no app shows. Runs on the main thread.
    pub(super) fn turn_off_link_preconnect(web_view: *mut c_void) -> WebviewGuards {
        let preferences = preferences(web_view)?;
        let class = preferences.class();
        // A private method can go away: ask for each one before its call.
        let has_feature_list = AnyClass::get(c"_WKFeature").is_some()
            && class.class_method(sel!(_features)).is_some()
            && class.responds_to(sel!(_setEnabled:forFeature:))
            && class.responds_to(sel!(_isEnabledForFeature:));
        if !has_feature_list {
            return Err("WebKit has no feature list on this macOS (it is there from macOS 13.3)".to_string());
        }
        // SAFETY: the class has the method, which gives an array of
        // `_WKFeature` objects.
        let features: Retained<NSArray<AnyObject>> = unsafe { msg_send![class, _features] };
        for feature in features.iter() {
            // SAFETY: `key` of a `_WKFeature` is a text, never nil.
            let key: Retained<NSString> = unsafe { msg_send![&*feature, key] };
            if key.to_string() != LINK_PRECONNECT {
                continue;
            }
            // SAFETY: the preferences have both methods; the first takes a
            // BOOL and a feature, the second a feature and gives a BOOL.
            let still_on: bool = unsafe {
                let () = msg_send![&*preferences, _setEnabled: false, forFeature: &*feature];
                msg_send![&*preferences, _isEnabledForFeature: &*feature]
            };
            return if still_on { Err(format!("WebKit did not turn the feature `{LINK_PRECONNECT}` off")) } else { Ok(()) };
        }
        Err(format!("WebKit has no feature `{LINK_PRECONNECT}`"))
    }

    // Turns WebRTC of the webview `web_view` (a `WKWebView`) off, and
    // checks that it is off. With WebRTC, the page of an app sends packets
    // to any server (STUN over UDP, TURN over TCP), and no policy, content
    // rule list, or navigation guard sees them. Dez's own page does not use
    // WebRTC. The switch is a private property of `WKPreferences`
    // (`_peerConnectionEnabled`, `WKPreferencesPrivate.h`, macOS 10.13.4),
    // not the feature list: an older feature list does not hold every
    // feature. A frame that loads after the switch has no
    // `RTCPeerConnection`. Runs on the main thread.
    pub(super) fn turn_off_peer_connection(web_view: *mut c_void) -> WebviewGuards {
        let preferences = preferences(web_view)?;
        let class = preferences.class();
        // A private method can go away: ask for each one before its call.
        if !class.responds_to(sel!(_setPeerConnectionEnabled:)) || !class.responds_to(sel!(_peerConnectionEnabled)) {
            return Err("WebKit has no switch for WebRTC on this macOS".to_string());
        }
        // SAFETY: the preferences have both methods; the first takes a
        // BOOL, the second gives one.
        let still_on: bool = unsafe {
            let () = msg_send![&*preferences, _setPeerConnectionEnabled: false];
            msg_send![&*preferences, _peerConnectionEnabled]
        };
        if still_on { Err("WebKit did not turn WebRTC off".to_string()) } else { Ok(()) }
    }

    // The content rule list: `WKContentRuleListStore` compiles it, and the
    // user content controller of the webview (`controller`, a
    // `WKUserContentController`) takes it. The trigger `load-context`
    // needs macOS 12. Runs on the main thread.
    pub(super) fn add_rule_list(controller: *mut c_void, decide: Box<dyn FnOnce(WebviewGuards) + Send>) {
        let Some(main_thread) = MainThreadMarker::new() else {
            return decide(Err("the rule list was not added on the main thread".to_string()));
        };
        // SAFETY: Tauri gives the controller of a live webview, or null.
        // The hold keeps it until the compile ends.
        let Some(controller) = (unsafe { Retained::retain(controller.cast::<WKUserContentController>()) }) else {
            return decide(Err("the webview has no user content controller".to_string()));
        };
        // SAFETY: a class method with no arguments, on the main thread.
        let Some(store) = (unsafe { WKContentRuleListStore::defaultStore(main_thread) }) else {
            return decide(Err("WebKit has no content rule list store".to_string()));
        };
        // A block is an `Fn`, and `decide` runs one time.
        let decide = Cell::new(Some(decide));
        let compiled = RcBlock::new(move |list: *mut WKContentRuleList, error: *mut NSError| {
            let Some(decide) = decide.take() else { return };
            // SAFETY: WebKit gives a valid rule list or a valid error, each
            // for the time of this call, on the main thread.
            let rule_list = match unsafe { (list.as_ref(), error.as_ref()) } {
                (Some(list), _) => {
                    // SAFETY: both objects are valid, on the main thread.
                    unsafe { controller.addContentRuleList(list) };
                    Ok(())
                }
                (None, Some(error)) => Err(error.localizedDescription().to_string()),
                (None, None) => Err("WebKit gave no rule list and no error".to_string()),
            };
            decide(rule_list);
        });
        // SAFETY: the three arguments are valid objects, none of them nil.
        unsafe {
            store.compileContentRuleListForIdentifier_encodedContentRuleList_completionHandler(
                Some(&NSString::from_str(RULE_LIST_NAME)),
                Some(&NSString::from_str(RULE_LIST)),
                Some(&compiled),
            );
        }
    }
}

/// The plugin of the app frames: the scheme, the navigation guard, and the
/// guards of each webview.
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    let gate = Arc::new(Gate::default());
    let scheme_gate = gate.clone();
    Builder::new("app-frames")
        .register_asynchronous_uri_scheme_protocol(SCHEME, move |context, request, responder| {
            scheme_gate.when_decided(context.webview_label(), move |guards| {
                // WebKit asks for each request on the main thread, and
                // `decide` runs there too. A file of an app can be large,
                // and a read there would stop the UI of Dez until it ends.
                // WebKit still takes the bytes of the answer on the main
                // thread, so a large answer stops the UI for a while.
                let guards = guards.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    responder.respond(serve(&request, &guards, open_app_file));
                });
            });
        })
        .on_navigation(|webview, url| {
            // `tauri dev` loads Dez's page from the dev server. Every other
            // build has the page in it.
            let dev_page = if tauri::is_dev() { webview.config().build.dev_url.as_ref() } else { None };
            let allowed = allows_navigation(url, dev_page);
            if !allowed {
                // Only the scheme: the rest of the URL can hold data.
                eprintln!("Refused a navigation of the webview to a `{}:` URL", url.scheme());
            }
            allowed
        })
        .on_webview_ready(move |webview| {
            let label = webview.label().to_string();
            gate.close(&label);
            let gate = gate.clone();
            guard_webview(&webview, move |guards| {
                if let Err(problem) = &guards {
                    eprintln!("A guard of the app frames is not on, so Dez shows no app: {problem}");
                }
                gate.decide(&label, guards);
            });
        })
        .build()
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    // A file of an app, in memory.
    type MemoryFile = Cursor<&'static [u8]>;

    fn get(uri: &str) -> Request<Vec<u8>> {
        Request::builder().uri(uri).body(Vec::new()).expect("request")
    }

    fn file_of(uri: &str) -> Option<(String, FileRoot, String)> {
        let uri: Uri = uri.parse().ok()?;
        scheme_file(&uri).map(|file| (file.app.to_string(), file.root, file.path))
    }

    fn header_of<'a>(answer: &'a Answer, name: header::HeaderName) -> &'a str {
        answer.headers().get(name).expect("header").to_str().expect("header text")
    }

    // An open that must not run: the request is refused before a file opens.
    fn no_read(_root: FileRoot, path: &str) -> Result<MemoryFile, String> {
        panic!("read of {path}")
    }

    // A file in memory that counts the bytes that reads take from it.
    struct CountedFile {
        file: MemoryFile,
        read: usize,
    }

    impl Read for CountedFile {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let count = self.file.read(buffer)?;
            self.read += count;
            Ok(count)
        }
    }

    impl Seek for CountedFile {
        fn seek(&mut self, to: SeekFrom) -> std::io::Result<u64> {
            self.file.seek(to)
        }
    }

    #[test]
    fn a_url_names_a_file_only_below_the_folder_of_one_app_or_of_the_libraries() {
        let named = |app: &str, root: FileRoot, path: &str| Some((app.to_string(), root, path.to_string()));
        assert_eq!(file_of("dezapp://localhost/my-app/index.html"), named("my-app", FileRoot::App, "apps/my-app/index.html"));
        assert_eq!(file_of("dezapp://localhost/a/js/lib/x.js?v=1"), named("a", FileRoot::App, "apps/a/js/lib/x.js"));
        assert_eq!(
            file_of("dezapp://localhost/my-app/~libs/three/build/three.module.js"),
            named("my-app", FileRoot::Resource, "libs/three/build/three.module.js")
        );
        assert_eq!(file_of("dezapp://localhost/a/~libs/fft.js/lib/fft.esm.js?v=1"), named("a", FileRoot::Resource, "libs/fft.js/lib/fft.esm.js"));
        for refused in [
            "dezapp://localhost/",
            "dezapp://localhost/my-app",
            "dezapp://localhost/my-app/",
            "dezapp://localhost//index.html",
            "dezapp://localhost/my-app//index.html",
            "dezapp://localhost/my-app/../other/secret.txt",
            "dezapp://localhost/../provider_keys.json",
            "dezapp://localhost/my-app/./index.html",
            "dezapp://localhost/my-app/%2e%2e/other/secret.txt",
            "dezapp://localhost/my-app/a%2Fb.js",
            "dezapp://localhost/my-app/a%20b.js",
            "dezapp://other/my-app/index.html",
            "dezapp://localhost:8080/my-app/index.html",
            "dezapp://user@localhost/my-app/index.html",
            "dezapp://LOCALHOST.evil/my-app/index.html",
            // The libraries: only below the route, in the folder of an app
            // whose name is a plain file name, and never above `libs/`.
            "dezapp://localhost/my-app/~libs",
            "dezapp://localhost/my-app/~libs/",
            "dezapp://localhost/my-app/~libs//three/build/three.module.js",
            "dezapp://localhost/my-app/~libs/../fonts/manifest.json",
            "dezapp://localhost/my-app/~libs/%2e%2e/fonts/manifest.json",
            "dezapp://localhost/my-app/~libs/..%2Ffonts%2Fmanifest.json",
            "dezapp://localhost/my-app/~libs%2Fthree/build/three.module.js",
            "dezapp://localhost/my-app/js/~libs/fft.js/lib/fft.esm.js",
            "dezapp://localhost/my-app/~LIBS/fft.js/lib/fft.esm.js",
            "dezapp://localhost/my-app/%7Elibs/fft.js/lib/fft.esm.js",
            "dezapp://localhost/~libs/fft.js/lib/fft.esm.js",
            "dezapp://localhost/../~libs/fft.js/lib/fft.esm.js",
            "dezapp://localhost/my%2Dapp/~libs/fft.js/lib/fft.esm.js",
            "dezapp://other/my-app/~libs/fft.js/lib/fft.esm.js",
        ] {
            assert_eq!(file_of(refused), None, "{refused}");
        }
    }

    // With `nosniff`, a script or a stylesheet loads only with its type.
    #[test]
    fn the_ending_of_a_file_gives_its_content_type() {
        assert_eq!(content_type("a/index.html"), "text/html; charset=utf-8");
        assert_eq!(content_type("a/main.js"), "text/javascript; charset=utf-8");
        assert_eq!(content_type("a/lib/module.MJS"), "text/javascript; charset=utf-8");
        assert_eq!(content_type("a/style.css"), "text/css; charset=utf-8");
        assert_eq!(content_type("a/add.wasm"), "application/wasm");
        assert_eq!(content_type("a/data.bin"), "application/octet-stream");
        assert_eq!(content_type("a/README"), "application/octet-stream");
        assert_eq!(content_type("a.html/README"), "application/octet-stream");
    }

    #[test]
    fn a_range_is_one_span_of_bytes_that_the_file_has() {
        assert_eq!(byte_range("bytes=0-3", 10), Some((0, 3)));
        assert_eq!(byte_range("bytes=4-", 10), Some((4, 9)));
        assert_eq!(byte_range("bytes=-3", 10), Some((7, 9)));
        assert_eq!(byte_range("bytes=-30", 10), Some((0, 9)));
        assert_eq!(byte_range("bytes=9-9", 10), Some((9, 9)));
        assert_eq!(byte_range("bytes=2-99", 10), Some((2, 9)));
        for whole in ["bytes=10-", "bytes=5-4", "bytes=-0", "bytes=-", "bytes=0-1,4-5", "bytes=+1-2", "bytes=a-b", "items=0-3", "0-3"] {
            assert_eq!(byte_range(whole, 10), None, "{whole}");
        }
        assert_eq!(byte_range("bytes=0-", 0), None);
    }

    #[test]
    fn a_file_is_served_under_the_policy_of_its_own_app() {
        let answer = serve(&get("dezapp://localhost/my-app/js/main.js?v=2"), &Ok(()), |root, path| {
            assert_eq!((root, path), (FileRoot::App, "apps/my-app/js/main.js"));
            Ok(MemoryFile::new(b"let a = 1"))
        });

        assert_eq!(answer.status(), StatusCode::OK);
        assert_eq!(answer.body().as_ref(), b"let a = 1");
        assert_eq!(header_of(&answer, header::CONTENT_TYPE), "text/javascript; charset=utf-8");
        assert_eq!(header_of(&answer, header::X_CONTENT_TYPE_OPTIONS), "nosniff");
        assert_eq!(header_of(&answer, header::ACCESS_CONTROL_ALLOW_ORIGIN), "*");
        assert_eq!(header_of(&answer, header::CACHE_CONTROL), "no-store");
        let policy = header_of(&answer, header::CONTENT_SECURITY_POLICY);
        assert!(policy.starts_with("default-src 'none'; sandbox allow-scripts;"), "{policy}");
        // Each source of the scheme is the prefix of this app.
        let sources: Vec<&str> = policy.split([' ', ';']).filter(|part| part.contains(':')).collect();
        assert!(sources.contains(&"dezapp://localhost/my-app/"), "{policy}");
        for source in sources {
            assert!(["dezapp://localhost/my-app/", "blob:", "data:"].contains(&source), "{source} in {policy}");
        }
    }

    // A page imports the libraries that Dez ships from the folder of its
    // own app, so they load under its policy, which names no other source.
    #[test]
    fn a_shipped_library_is_served_in_the_folder_of_each_app_under_its_policy() {
        assert!(!is_app_file_segment(LIBS_ROUTE));
        let url = "dezapp://localhost/my-app/~libs/three/build/three.module.js";
        let answer = serve(&get(url), &Ok(()), |root, path| {
            assert_eq!((root, path), (FileRoot::Resource, "libs/three/build/three.module.js"));
            Ok(MemoryFile::new(b"export const REVISION = '187'"))
        });

        assert_eq!(answer.status(), StatusCode::OK);
        assert_eq!(answer.body().as_ref(), b"export const REVISION = '187'");
        assert_eq!(header_of(&answer, header::CONTENT_TYPE), "text/javascript; charset=utf-8");
        assert_eq!(header_of(&answer, header::ACCESS_CONTROL_ALLOW_ORIGIN), "*");
        assert_eq!(header_of(&answer, header::CONTENT_SECURITY_POLICY), app_policy("my-app"));

        let mut post = get(url);
        *post.method_mut() = Method::POST;
        assert_eq!(serve(&post, &Ok(()), no_read).status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    // The script of Dez comes from no file, so no file of an app can take
    // its place: its name is no name of a file of an app.
    #[test]
    fn the_client_script_is_served_in_the_folder_of_each_app_from_no_file() {
        assert!(!is_app_file_segment(CLIENT_SCRIPT_NAME));

        let answer = serve(&get("dezapp://localhost/my-app/~dez.js?v=2"), &Ok(()), no_read);

        assert_eq!(answer.status(), StatusCode::OK);
        assert_eq!(answer.body().as_ref(), CLIENT_SCRIPT.as_bytes());
        assert_eq!(header_of(&answer, header::CONTENT_TYPE), "text/javascript; charset=utf-8");
        assert_eq!(header_of(&answer, header::X_CONTENT_TYPE_OPTIONS), "nosniff");
        assert_eq!(header_of(&answer, header::CONTENT_SECURITY_POLICY), app_policy("my-app"));
    }

    #[test]
    fn the_client_script_has_its_one_name_in_the_folder_of_an_app_only() {
        for refused in [
            "dezapp://localhost/~dez.js",
            "dezapp://localhost//~dez.js",
            "dezapp://localhost/my-app/js/~dez.js",
            "dezapp://localhost/../~dez.js",
            "dezapp://localhost/my%2Dapp/~dez.js",
            "dezapp://localhost/my-app/~dez.js/",
            "dezapp://localhost/my-app/~DEZ.js",
            "dezapp://other/my-app/~dez.js",
            "dezapp://localhost:8080/my-app/~dez.js",
        ] {
            let answer = serve(&get(refused), &Ok(()), no_read);
            assert_eq!(answer.status(), StatusCode::NOT_FOUND, "{refused}");
            assert_eq!(header_of(&answer, header::CONTENT_SECURITY_POLICY), LOCKED_POLICY, "{refused}");
        }
        let mut post = get("dezapp://localhost/my-app/~dez.js");
        *post.method_mut() = Method::POST;
        assert_eq!(serve(&post, &Ok(()), no_read).status(), StatusCode::METHOD_NOT_ALLOWED);
        let unguarded = serve(&get("dezapp://localhost/my-app/~dez.js"), &Err("no store".to_string()), no_read);
        assert_eq!(unguarded.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn a_range_request_reads_and_gets_only_its_bytes() {
        // The answer to `range` for a file of 10 bytes, and the count of
        // the bytes that it read.
        let ranged = |range: &'static str| {
            let mut request = get("dezapp://localhost/my-app/clip.webm");
            request.headers_mut().insert(header::RANGE, header::HeaderValue::from_static(range));
            let mut file = CountedFile { file: MemoryFile::new(b"0123456789"), read: 0 };
            let opened = &mut file;
            let answer = serve(&request, &Ok(()), move |_, _| Ok(opened));
            (answer, file.read)
        };

        let (answer, read) = ranged("bytes=2-4");
        assert_eq!(answer.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(answer.body().as_ref(), b"234");
        assert_eq!(read, 3, "a range must not cost a read of the whole file");
        assert_eq!(header_of(&answer, header::CONTENT_RANGE), "bytes 2-4/10");
        assert_eq!(header_of(&answer, header::CONTENT_TYPE), "video/webm");

        // A range that the file does not have gets the whole file.
        let (answer, _) = ranged("bytes=10-");
        assert_eq!(answer.status(), StatusCode::OK);
        assert_eq!(answer.body().as_ref(), b"0123456789");
        assert!(answer.headers().get(header::CONTENT_RANGE).is_none());
    }

    // A refusal is a page too: it must load and run nothing, and it tells
    // the code of an app no path and no reason.
    #[test]
    fn a_refusal_is_a_locked_page_that_tells_no_path() {
        let missing = serve(&get("dezapp://localhost/my-app/gone.js"), &Ok(()), |_, path| {
            Err::<MemoryFile, _>(format!("Failed to read /home/user/.config/dez/{path}"))
        });
        let outside = serve(&get("dezapp://localhost/my-app/../../provider_keys.json"), &Ok(()), no_read);
        let mut post = get("dezapp://localhost/my-app/index.html");
        *post.method_mut() = Method::POST;
        let written = serve(&post, &Ok(()), no_read);
        let unguarded = serve(&get("dezapp://localhost/my-app/index.html"), &Err("no store".to_string()), no_read);

        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        assert_eq!(missing.body().as_ref(), NO_SUCH_FILE.as_bytes());
        assert_eq!(outside.status(), StatusCode::NOT_FOUND);
        assert_eq!(outside.body().as_ref(), NO_SUCH_FILE.as_bytes());
        assert_eq!(written.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(unguarded.status(), StatusCode::SERVICE_UNAVAILABLE);
        for refused in [&missing, &outside, &written, &unguarded] {
            assert_eq!(header_of(refused, header::CONTENT_SECURITY_POLICY), LOCKED_POLICY);
            assert_eq!(header_of(refused, header::CONTENT_TYPE), "text/plain; charset=utf-8");
            assert_eq!(header_of(refused, header::X_CONTENT_TYPE_OPTIONS), "nosniff");
        }
    }

    #[test]
    fn the_webview_goes_only_to_the_page_of_dez_and_to_the_app_scheme() {
        let url = |text: &str| Url::parse(text).expect("url");
        let dev_page = url("http://localhost:1420/");
        for allowed in ["tauri://localhost", "tauri://localhost/index.html", "dezapp://localhost/my-app/index.html#a", "about:blank"] {
            assert!(allows_navigation(&url(allowed), None), "{allowed}");
        }
        for refused in [
            "https://example.com/?data=1",
            "http://localhost:1420/",
            "http://127.0.0.1:8080/hit",
            "data:text/html,<script>1</script>",
            "blob:null/0b0e3e1c-8f0e-4a36-9d3c-0d3f1c1b2a3d",
            "asset://localhost/%2Fhome%2Fuser%2F.config%2Fdez%2Fprovider_keys.json",
            "ipc://localhost/delete_app_file",
            "file:///etc/hostname",
            "about:srcdoc",
            "javascript:alert(1)",
            "tauri://example.com/index.html",
            "dezapp://example.com/my-app/index.html",
        ] {
            assert!(!allows_navigation(&url(refused), None), "{refused}");
        }
        // A dev build loads Dez's page from the dev server, and from no
        // other server.
        assert!(allows_navigation(&url("http://localhost:1420/index.html"), Some(&dev_page)));
        for refused in ["http://localhost:1421/", "https://localhost:1420/", "http://example.com:1420/", "blob:http://localhost:1420/0b0e3e1c"] {
            assert!(!allows_navigation(&url(refused), Some(&dev_page)), "{refused}");
        }
    }

    #[test]
    fn a_request_waits_for_the_guards_of_its_own_webview() {
        let gate = Gate::default();
        let ran = Arc::new(AtomicUsize::new(0));
        let count = |expected: WebviewGuards| {
            let ran = ran.clone();
            move |guards: &WebviewGuards| {
                assert_eq!(guards, &expected);
                ran.fetch_add(1, Ordering::SeqCst);
            }
        };

        gate.when_decided("main", count(Ok(())));
        gate.when_decided("main", count(Ok(())));
        gate.decide("other", Err("no store".to_string()));
        assert_eq!(ran.load(Ordering::SeqCst), 0, "the list of another webview opens nothing");

        gate.decide("main", Ok(()));
        assert_eq!(ran.load(Ordering::SeqCst), 2);
        gate.when_decided("main", count(Ok(())));
        gate.when_decided("other", count(Err("no store".to_string())));
        assert_eq!(ran.load(Ordering::SeqCst), 4, "a known result answers at once");

        // A new webview of the same label waits for its own list.
        gate.close("main");
        gate.when_decided("main", count(Err("failed".to_string())));
        assert_eq!(ran.load(Ordering::SeqCst), 4);
        gate.decide("main", Err("failed".to_string()));
        assert_eq!(ran.load(Ordering::SeqCst), 5);
    }
}
