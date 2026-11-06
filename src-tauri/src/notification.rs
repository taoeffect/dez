//! System notifications whose body click brings Dez to the front and then
//! tells the webview (`dez.native/showNotification`).
//!
//! Not tauri-plugin-notification: its desktop `show()` gives no click
//! callback, and its releases from 2.5.0 need tauri 2.12. Not notify-rust
//! either: on Linux it drops the `ActivationToken` signal that a Wayland
//! activation needs, and on macOS it reports a body click only for a
//! notification with an action, which macOS shows as an extra button.

use tauri::ipc::Channel;
use tauri::WebviewWindow;

/// Shows a notification. `on_click` gets one message when the user clicks
/// the notification body, after the window came to the front. The command
/// returns when the notification server took the notification (Linux), or
/// at once (macOS); the wait for a click goes on in the background.
#[tauri::command]
pub async fn show_notification(
    window: WebviewWindow,
    title: String,
    body: String,
    on_click: Channel<()>,
) -> Result<(), String> {
    platform::show(window, title, body, on_click).await
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn report_click(on_click: &Channel<()>) {
    if let Err(error) = on_click.send(()) {
        eprintln!("Failed to report a notification click: {error}");
    }
}

// The Desktop Notifications spec over D-Bus:
// https://specifications.freedesktop.org/notification-spec/latest/
#[cfg(target_os = "linux")]
mod platform {
    use std::collections::HashMap;

    use futures::StreamExt;
    use tauri::ipc::Channel;
    use tauri::WebviewWindow;
    use zbus::message::Type;
    use zbus::zvariant::Value;
    use zbus::{MatchRule, MessageStream};

    const SERVER: &str = "org.freedesktop.Notifications";
    const PATH: &str = "/org/freedesktop/Notifications";
    // A click on the notification body invokes the action with this key.
    const BODY_CLICK_ACTION: &str = "default";

    struct Click {
        // Spec 1.2 servers (plasmashell, GNOME Shell) send an xdg-activation
        // token or an X11 startup id just before `ActionInvoked`.
        activation_token: Option<String>,
    }

    pub async fn show(
        window: WebviewWindow,
        title: String,
        body: String,
        on_click: Channel<()>,
    ) -> Result<(), String> {
        let (signals, id) = notify(&title, &body)
            .await
            .map_err(|error| format!("Could not show the notification: {error}"))?;
        tauri::async_runtime::spawn(async move {
            if let Some(click) = wait_for_click(signals, id).await {
                bring_to_front(&window, click.activation_token);
                super::report_click(&on_click);
            }
        });
        Ok(())
    }

    // The signal stream ends the wait for a click when the server reports a
    // close of that notification (an expiry, a dismiss, or a server limit of
    // notifications per app), or when the bus goes away.
    async fn notify(title: &str, body: &str) -> zbus::Result<(MessageStream, u32)> {
        let connection = crate::session_bus::session_bus().await?;
        // Subscribe before `Notify`, so that no signal for the new id is lost.
        let rule = MatchRule::builder()
            .msg_type(Type::Signal)
            .sender(SERVER)?
            .interface(SERVER)?
            .path(PATH)?
            .build();
        let signals = MessageStream::for_match_rule(rule, connection, None).await?;
        let actions = [BODY_CLICK_ACTION, "Open"];
        let hints: HashMap<&str, Value> = HashMap::new();
        // Notify(app_name, replaces_id, app_icon, summary, body, actions,
        // hints, expire_timeout); -1 is the server's default timeout.
        let reply = connection
            .call_method(
                Some(SERVER),
                PATH,
                Some(SERVER),
                "Notify",
                &("Dez", 0u32, "", title, body, actions.as_slice(), hints, -1i32),
            )
            .await?;
        Ok((signals, reply.body().deserialize()?))
    }

    // `None`: the notification closed with no click, or the bus went away.
    async fn wait_for_click(mut signals: MessageStream, id: u32) -> Option<Click> {
        let mut activation_token = None;
        while let Some(Ok(message)) = signals.next().await {
            let header = message.header();
            let Some(member) = header.member() else {
                continue;
            };
            let body = message.body();
            match member.as_str() {
                "ActivationToken" => {
                    if let Ok((signal_id, token)) = body.deserialize::<(u32, String)>()
                        && signal_id == id
                    {
                        activation_token = Some(token);
                    }
                }
                "ActionInvoked" => {
                    if let Ok((signal_id, action)) = body.deserialize::<(u32, String)>()
                        && signal_id == id
                    {
                        return (action == BODY_CLICK_ACTION).then_some(Click { activation_token });
                    }
                }
                "NotificationClosed" => {
                    if let Ok((signal_id, _reason)) = body.deserialize::<(u32, u32)>()
                        && signal_id == id
                    {
                        return None;
                    }
                }
                _ => {}
            }
        }
        None
    }

    // On Wayland a window may take the focus only with an xdg-activation
    // token from the compositor. For a click, the server's token is right:
    // GTK activates a shown window with it at once when it becomes the
    // startup id. `present()` would ask the compositor for a token of Dez's
    // own, which KWin may refuse while another app has the focus, so it runs
    // only when the server sent no token. On X11 (the default GTK backend,
    // see lib.rs) only `present()` raises the window; an X11 startup id
    // as the token gives it the time of the click. GTK must be called on the
    // main thread.
    fn bring_to_front(window: &WebviewWindow, activation_token: Option<String>) {
        let target = window.clone();
        let result = window.run_on_main_thread(move || {
            use gtk::prelude::{DisplayExtManual, GtkWindowExt, WidgetExt};
            let gtk_window = match target.gtk_window() {
                Ok(gtk_window) => gtk_window,
                Err(error) => {
                    eprintln!("Failed to bring the window to the front: {error}");
                    return;
                }
            };
            let on_wayland = gtk_window.display().backend().is_wayland();
            if let Some(token) = &activation_token {
                gtk_window.set_startup_id(token);
            }
            if !(on_wayland && activation_token.is_some()) {
                gtk_window.present();
            }
        });
        if let Err(error) = result {
            eprintln!("Failed to bring the window to the front: {error}");
        }
    }
}

// NSUserNotificationCenter through mac-notification-sys.
#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::CString;
    use std::sync::Once;

    use mac_notification_sys::{Notification, NotificationResponse};
    use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
    use objc2::{Encode, sel};
    use tauri::ipc::Channel;
    use tauri::{Manager, WebviewWindow};

    static SETUP: Once = Once::new();

    pub async fn show(
        window: WebviewWindow,
        title: String,
        body: String,
        on_click: Channel<()>,
    ) -> Result<(), String> {
        // Notifications show under the app with this bundle id, set once per
        // process. A dev build runs outside an app bundle, so it posts as
        // Terminal, as tauri-plugin-notification does.
        SETUP.call_once(|| {
            let bundle_id = if tauri::is_dev() {
                "com.apple.Terminal"
            } else {
                window.config().identifier.as_str()
            };
            if let Err(error) = mac_notification_sys::set_application(bundle_id) {
                eprintln!("Failed to set the notification app to {bundle_id}: {error}");
            }
            present_while_frontmost();
        });
        // `send` blocks until the user clicks or dismisses the notification,
        // and the main run loop must run meanwhile (Tauri runs it). A send
        // error also comes out only then, so it is logged here and does not
        // reach the caller.
        std::thread::spawn(move || {
            match Notification::new()
                .title(&title)
                .message(&body)
                .wait_for_click(true)
                .send()
            {
                Ok(NotificationResponse::Click) => {
                    bring_to_front(&window);
                    super::report_click(&on_click);
                }
                Ok(_) => {}
                Err(error) => eprintln!("Failed to show a notification: {error}"),
            }
        });
        Ok(())
    }

    fn bring_to_front(window: &WebviewWindow) {
        for result in [window.unminimize(), window.show(), window.set_focus()] {
            if let Err(error) = result {
                eprintln!("Failed to bring the window to the front: {error}");
            }
        }
    }

    // NSUserNotificationCenter sends a notification of the frontmost app only
    // to Notification Center, with no banner, unless the center's delegate
    // answers YES to `userNotificationCenter:shouldPresentNotification:`.
    // Dez also alerts while it is frontmost (when the user is away), so it
    // needs the banner. mac-notification-sys 0.6.15 makes its own delegate
    // (`NotificationCenterDelegate`, objc/notify.m) at its first send, and
    // that class has no such method. So this adds the method to the class
    // before the first send: the class is then complete when the center gets
    // the delegate. `class_addMethod` keeps a method that the class already
    // has, so a later mac-notification-sys that adds one wins.
    // https://developer.apple.com/documentation/foundation/nsusernotificationcenterdelegate/usernotificationcenter(_:shouldpresent:)
    fn present_while_frontmost() {
        extern "C-unwind" fn should_present(
            _delegate: *mut AnyObject,
            _cmd: Sel,
            _center: *mut AnyObject,
            _notification: *mut AnyObject,
        ) -> Bool {
            Bool::YES
        }
        type ShouldPresent =
            extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject) -> Bool;

        let Some(class) = AnyClass::get(c"NotificationCenterDelegate") else {
            eprintln!(
                "No NotificationCenterDelegate class: banners will not show while Dez is in front"
            );
            return;
        };
        // The Objective-C type string of the method: the return type, then
        // self, the selector, and the two arguments.
        let (boolean, object, selector) =
            (Bool::ENCODING, <*mut AnyObject>::ENCODING, Sel::ENCODING);
        let types = CString::new(format!("{boolean}{object}{selector}{object}{object}"))
            .expect("an Objective-C type string has no NUL byte");
        // SAFETY: the function matches the selector's arguments and return
        // type, as the type string says. The runtime calls an `Imp` with the
        // real arguments, so its declared type does not matter.
        let added = unsafe {
            let implementation = std::mem::transmute::<ShouldPresent, Imp>(should_present);
            objc2::ffi::class_addMethod(
                std::ptr::from_ref(class).cast_mut(),
                sel!(userNotificationCenter:shouldPresentNotification:),
                implementation,
                types.as_ptr(),
            )
        };
        if !added.as_bool() {
            eprintln!(
                "The notification delegate already has shouldPresentNotification; Dez left it as is"
            );
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod platform {
    use tauri::ipc::Channel;
    use tauri::WebviewWindow;

    pub async fn show(
        _window: WebviewWindow,
        _title: String,
        _body: String,
        _on_click: Channel<()>,
    ) -> Result<(), String> {
        Err("System notifications are not supported on this platform".into())
    }
}
