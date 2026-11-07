//! The user idle time: how long ago the last keyboard, mouse, or touch input
//! came, anywhere on the computer, not only in Dez. The webview sees only
//! the input to its own window, so the OS must tell. The rule that uses the
//! time stays in TypeScript (`dez.native/userIdleMs`).

/// Milliseconds since the last user input, or `None` when no source on this
/// desktop gives the idle time.
#[tauri::command]
pub async fn user_idle_ms() -> Option<u64> {
    platform::user_idle_ms().await
}

#[cfg(target_os = "linux")]
pub use wayland::watch as watch_wayland_idle;

#[cfg(target_os = "macos")]
mod platform {
    // The time since the last input event in the login session. Chromium
    // reads its idle time the same way (ui/base/idle/idle_mac.mm), with no
    // permission prompt.
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        safe fn CGEventSourceSecondsSinceLastEventType(state_id: i32, event_type: u32) -> f64;
    }
    // kCGEventSourceStateCombinedSessionState and kCGAnyInputEventType.
    const COMBINED_SESSION_STATE: i32 = 0;
    const ANY_INPUT_EVENT: u32 = !0;

    pub async fn user_idle_ms() -> Option<u64> {
        let seconds =
            CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION_STATE, ANY_INPUT_EVENT);
        (seconds >= 0.0).then_some((seconds * 1000.0) as u64)
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::env;

    const MUTTER_IDLE_MONITOR: &str = "org.gnome.Mutter.IdleMonitor";

    // Each source answers only where it works, so the first answer wins:
    // a compositor with ext-idle-notify (KDE Plasma, wlroots, niri), then
    // GNOME's own D-Bus API (for Mutter versions with no ext-idle-notify),
    // then an X11 session.
    pub async fn user_idle_ms() -> Option<u64> {
        if let Some(idle_ms) = super::wayland::idle_ms() {
            return Some(idle_ms);
        }
        if let Some(idle_ms) = mutter_idle_ms().await {
            return Some(idle_ms);
        }
        // In a Wayland session the X server is Xwayland, which counts only
        // the input to X windows: the user would look idle while typing in a
        // Wayland window, such as Dez itself in a Wayland session. The
        // AppImage runs as an X window, but it still has WAYLAND_DISPLAY.
        if env::var_os("WAYLAND_DISPLAY").is_some() {
            return None;
        }
        tauri::async_runtime::spawn_blocking(x11_idle_ms)
            .await
            .ok()
            .flatten()
    }

    // A desktop that is not GNOME has no such service, so a failed call is
    // normal and not logged.
    // https://gitlab.gnome.org/GNOME/mutter/-/blob/main/data/dbus-interfaces/org.gnome.Mutter.IdleMonitor.xml
    async fn mutter_idle_ms() -> Option<u64> {
        let connection = crate::session_bus::session_bus().await.ok()?;
        let reply = connection
            .call_method(
                Some(MUTTER_IDLE_MONITOR),
                "/org/gnome/Mutter/IdleMonitor/Core",
                Some(MUTTER_IDLE_MONITOR),
                "GetIdletime",
                &(),
            )
            .await
            .ok()?;
        reply.body().deserialize::<u64>().ok()
    }

    // The XScreenSaver extension's time since the last input to the X
    // server. No X server (DISPLAY unset) is normal and not logged.
    fn x11_idle_ms() -> Option<u64> {
        use x11rb::connection::Connection;
        use x11rb::protocol::screensaver::ConnectionExt;

        let (connection, screen) = x11rb::connect(None).ok()?;
        let root = connection.setup().roots.get(screen)?.root;
        let reply = connection
            .screensaver_query_info(root)
            .map_err(x11rb::errors::ReplyError::from)
            .and_then(|cookie| cookie.reply());
        match reply {
            Ok(info) => Some(info.ms_since_user_input.into()),
            Err(error) => {
                eprintln!("Failed to read the X11 idle time: {error}");
                None
            }
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod platform {
    pub async fn user_idle_ms() -> Option<u64> {
        None
    }
}

// ext-idle-notify has no "idle for how long" request: the compositor only
// says when the seat has had no input for a timeout (`idled`) and when input
// comes back (`resumed`). So a thread watches from the app start (the
// timeout counts from the creation of the notification object), keeps the
// last state, and a read adds the time since `idled` to the timeout.
// https://wayland.app/protocols/ext-idle-notify-v1
#[cfg(target_os = "linux")]
mod wayland {
    use std::env;
    use std::error::Error;
    use std::os::unix::net::UnixStream;
    use std::path::PathBuf;
    use std::sync::{Mutex, MutexGuard, PoisonError};
    use std::time::{Duration, Instant};

    use wayland_client::globals::{GlobalListContents, registry_queue_init};
    use wayland_client::protocol::wl_registry::WlRegistry;
    use wayland_client::protocol::wl_seat::WlSeat;
    use wayland_client::{Connection, Dispatch, Proxy, QueueHandle, delegate_noop};
    use wayland_protocols::ext::idle_notify::v1::client::ext_idle_notification_v1::{
        self, ExtIdleNotificationV1,
    };
    use wayland_protocols::ext::idle_notify::v1::client::ext_idle_notifier_v1::ExtIdleNotifierV1;

    // A read while the seat is not idle gives 0, so this is the resolution
    // of the idle time. Each pause in the input longer than this costs one
    // `idled` and one `resumed` event.
    const IDLE_TIMEOUT_MS: u32 = 1_000;
    const IDLE_TIMEOUT: Duration = Duration::from_millis(IDLE_TIMEOUT_MS as u64);

    #[derive(Clone, Copy)]
    pub(super) enum Seat {
        // No watcher: no compositor, no ext-idle-notify, or a broken
        // connection.
        Unwatched,
        // Input came within the timeout.
        Active,
        // No input since the `idled` event at this instant.
        IdleSince(Instant),
    }

    static SEAT: Mutex<Seat> = Mutex::new(Seat::Unwatched);

    fn seat() -> MutexGuard<'static, Seat> {
        SEAT.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn idle_ms() -> Option<u64> {
        idle_ms_at(*seat(), Instant::now())
    }

    pub(super) fn idle_ms_at(seat: Seat, now: Instant) -> Option<u64> {
        match seat {
            Seat::Unwatched => None,
            Seat::Active => Some(0),
            // The compositor sends `idled` at least the timeout after the
            // last input.
            Seat::IdleSince(idled_at) => {
                let idle = now.saturating_duration_since(idled_at) + IDLE_TIMEOUT;
                Some(u64::try_from(idle.as_millis()).unwrap_or(u64::MAX))
            }
        }
    }

    /// Starts the watcher thread. With no compositor or no ext-idle-notify,
    /// the thread ends at once and the other sources answer.
    pub fn watch() {
        let spawned = std::thread::Builder::new()
            .name("wayland-idle".into())
            .spawn(|| {
                if let Err(error) = run() {
                    eprintln!("The Wayland idle watcher stopped: {error}");
                }
                *seat() = Seat::Unwatched;
            });
        if let Err(error) = spawned {
            eprintln!("Failed to start the Wayland idle watcher: {error}");
        }
    }

    // Returns only when the compositor or ext-idle-notify is missing, or
    // with the error that ends the connection.
    fn run() -> Result<(), Box<dyn Error>> {
        let Some(connection) = connect() else {
            return Ok(());
        };
        let (globals, mut queue) = registry_queue_init::<Watcher>(&connection)?;
        let handle = queue.handle();
        let (Ok(seat_proxy), Ok(notifier)) = (
            globals.bind::<WlSeat, _, _>(&handle, 1..=1, ()),
            globals.bind::<ExtIdleNotifierV1, _, _>(&handle, 1..=2, ()),
        ) else {
            return Ok(());
        };
        // Version 2 counts only input and ignores idle inhibitors, such as a
        // playing video, which would hide that the user is away.
        if notifier.version() >= 2 {
            notifier.get_input_idle_notification(IDLE_TIMEOUT_MS, &seat_proxy, &handle, ());
        } else {
            notifier.get_idle_notification(IDLE_TIMEOUT_MS, &seat_proxy, &handle, ());
        }
        *seat() = Seat::Active;
        loop {
            queue.blocking_dispatch(&mut Watcher)?;
        }
    }

    // Not `Connection::connect_to_env`: it would also take WAYLAND_SOCKET, a
    // socket that a launcher passes to the app's GUI, and remove it from
    // the environment while other threads run.
    fn connect() -> Option<Connection> {
        let display = PathBuf::from(env::var_os("WAYLAND_DISPLAY")?);
        let path = if display.is_absolute() {
            display
        } else {
            PathBuf::from(env::var_os("XDG_RUNTIME_DIR")?).join(display)
        };
        let stream = UnixStream::connect(path).ok()?;
        Connection::from_socket(stream).ok()
    }

    struct Watcher;

    impl Dispatch<ExtIdleNotificationV1, ()> for Watcher {
        fn event(
            _: &mut Self,
            _: &ExtIdleNotificationV1,
            event: ext_idle_notification_v1::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
            match event {
                ext_idle_notification_v1::Event::Idled => *seat() = Seat::IdleSince(Instant::now()),
                ext_idle_notification_v1::Event::Resumed => *seat() = Seat::Active,
                _ => {}
            }
        }
    }

    // The globals are read once at the start; later changes do not matter.
    impl Dispatch<WlRegistry, GlobalListContents> for Watcher {
        fn event(
            _: &mut Self,
            _: &WlRegistry,
            _: <WlRegistry as Proxy>::Event,
            _: &GlobalListContents,
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
        }
    }

    delegate_noop!(Watcher: ignore WlSeat);
    delegate_noop!(Watcher: ExtIdleNotifierV1);
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use std::time::{Duration, Instant};

    use super::wayland::{Seat, idle_ms_at};

    #[test]
    fn wayland_idle_time_includes_the_timeout_before_idled() {
        let idled_at = Instant::now();
        let read_at = idled_at + Duration::from_millis(2_500);
        assert_eq!(idle_ms_at(Seat::IdleSince(idled_at), read_at), Some(3_500));
        assert_eq!(idle_ms_at(Seat::Active, read_at), Some(0));
    }

    // `None` lets the other sources answer; 0 would hide them.
    #[test]
    fn unwatched_wayland_seat_has_no_idle_time() {
        assert_eq!(idle_ms_at(Seat::Unwatched, Instant::now()), None);
    }
}
