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
    // only when the server sent no token. On X11 (an X11 session, or the
    // AppImage, whose GTK hook sets GDK_BACKEND=x11) only `present()` raises
    // the window; an X11 startup id as the token gives it the time of the
    // click. GTK must be called on the main thread.
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

// NSUserNotificationCenter. Dez posts the notification and owns the center
// delegate, so a notification costs no thread and no timer: the click comes
// as a delegate call on the main thread. mac-notification-sys 0.6.15 only
// sets the app that notifications post as. Its `send` with `wait_for_click`
// blocks a thread and adds a 0.5 s main-run-loop timer that scans the
// delivered list, until the notification leaves Notification Center, which
// a banner that timed out does only when the user clears it.
#[cfg(target_os = "macos")]
// NSUserNotification is deprecated but works; UNUserNotificationCenter needs
// an app bundle, which a dev build does not have.
#[allow(deprecated)]
mod platform {
    use std::sync::{Mutex, Once, PoisonError};
    use std::time::{Duration, Instant};

    use objc2::rc::{Retained, autoreleasepool};
    use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{AnyThread, ClassType, define_class, msg_send};
    use objc2_foundation::{
        NSString, NSUUID, NSUserNotification, NSUserNotificationActivationType,
        NSUserNotificationCenter, NSUserNotificationCenterDelegate,
    };
    use tauri::ipc::Channel;
    use tauri::{Manager, WebviewWindow};

    // The delivery is asynchronous, so a notification can be missing from
    // the delivered list for a moment after `deliverNotification:` returns
    // (mac-notification-sys waits up to 2 s for it).
    const DELIVERY_GRACE: Duration = Duration::from_secs(60);

    // A posted notification whose click still goes to its tab.
    struct Waiting {
        identifier: String,
        posted_at: Instant,
        window: WebviewWindow,
        on_click: Channel<()>,
    }

    static SETUP: Once = Once::new();
    static WAITING: Mutex<Vec<Waiting>> = Mutex::new(Vec::new());

    pub async fn show(
        window: WebviewWindow,
        title: String,
        body: String,
        on_click: Channel<()>,
    ) -> Result<(), String> {
        autoreleasepool(|_| {
            // Notifications show under the app with this bundle id, set once
            // per process and before the first use of the center. A dev
            // build runs outside an app bundle, so it posts as Terminal, as
            // tauri-plugin-notification does.
            SETUP.call_once(|| {
                let bundle_id = if tauri::is_dev() {
                    "com.apple.Terminal"
                } else {
                    window.config().identifier.as_str()
                };
                if let Err(error) = mac_notification_sys::set_application(bundle_id) {
                    eprintln!("Failed to set the notification app to {bundle_id}: {error}");
                }
                set_delegate();
            });
            post(window, &title, &body, on_click)
        })
    }

    fn post(
        window: WebviewWindow,
        title: &str,
        body: &str,
        on_click: Channel<()>,
    ) -> Result<(), String> {
        let center = notification_center()
            .ok_or("Could not show the notification: no notification center")?;
        let identifier = NSUUID::new().UUIDString();
        let notification = NSUserNotification::new();
        notification.setTitle(Some(&NSString::from_str(title)));
        notification.setInformativeText(Some(&NSString::from_str(body)));
        notification.setIdentifier(Some(&identifier));
        // No "Show" button on an alert-style notification.
        notification.setHasActionButton(false);

        // A notification stays in the delivered list after its banner went
        // away, until the user clears it from Notification Center or clicks
        // it. Each one there stays clickable to its tab, so the list of
        // waiting clicks drops only the notifications that left.
        let delivered: Vec<String> = center
            .deliveredNotifications()
            .iter()
            .filter_map(|delivered| delivered.identifier())
            .map(|identifier| identifier.to_string())
            .collect();
        {
            let mut waiting = WAITING.lock().unwrap_or_else(PoisonError::into_inner);
            waiting.retain(|entry| {
                entry.posted_at.elapsed() < DELIVERY_GRACE || delivered.contains(&entry.identifier)
            });
            waiting.push(Waiting {
                identifier: identifier.to_string(),
                posted_at: Instant::now(),
                window,
                on_click,
            });
        }
        center.deliverNotification(&notification);
        Ok(())
    }

    // `defaultUserNotificationCenter` is nil in a process with no bundle id,
    // and the objc2-foundation binding would panic on nil.
    fn notification_center() -> Option<Retained<NSUserNotificationCenter>> {
        unsafe {
            msg_send![
                NSUserNotificationCenter::class(),
                defaultUserNotificationCenter
            ]
        }
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements, and `Delegate`
        // does not implement `Drop`.
        #[unsafe(super(NSObject))]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl NSUserNotificationCenterDelegate for Delegate {
            #[unsafe(method(userNotificationCenter:didActivateNotification:))]
            fn did_activate(
                &self,
                center: &NSUserNotificationCenter,
                notification: &NSUserNotification,
            ) {
                clicked(center, notification);
            }

            // The center sends a notification of the frontmost app only to
            // Notification Center, with no banner, unless this answers YES.
            // Dez also alerts while it is frontmost (when the user is away),
            // so it needs the banner.
            // https://developer.apple.com/documentation/foundation/nsusernotificationcenterdelegate/usernotificationcenter(_:shouldpresent:)
            #[unsafe(method(userNotificationCenter:shouldPresentNotification:))]
            fn should_present(
                &self,
                _center: &NSUserNotificationCenter,
                _notification: &NSUserNotification,
            ) -> bool {
                true
            }
        }
    );

    // The center does not retain its delegate, so the one delegate lives as
    // long as the app.
    fn set_delegate() {
        let Some(center) = notification_center() else {
            return;
        };
        let delegate: Retained<Delegate> =
            unsafe { msg_send![super(Delegate::alloc().set_ivars(())), init] };
        unsafe { center.setDelegate(Some(ProtocolObject::from_ref(&*delegate))) };
        std::mem::forget(delegate);
    }

    // Runs on the main thread. A click on the body brings the window to the
    // front, then tells the webview; that work runs on the async runtime, off
    // the AppKit callback. Any click removes the notification from
    // Notification Center, as mac-notification-sys did.
    fn clicked(center: &NSUserNotificationCenter, notification: &NSUserNotification) {
        center.removeDeliveredNotification(notification);
        let Some(identifier) = notification.identifier().map(|id| id.to_string()) else {
            return;
        };
        let entry = {
            let mut waiting = WAITING.lock().unwrap_or_else(PoisonError::into_inner);
            let index = waiting
                .iter()
                .position(|entry| entry.identifier == identifier);
            index.map(|index| waiting.swap_remove(index))
        };
        let Some(entry) = entry else {
            return;
        };
        if notification.activationType() != NSUserNotificationActivationType::ContentsClicked {
            return;
        }
        tauri::async_runtime::spawn(async move {
            bring_to_front(&entry.window);
            super::report_click(&entry.on_click);
        });
    }

    fn bring_to_front(window: &WebviewWindow) {
        for result in [window.unminimize(), window.show(), window.set_focus()] {
            if let Err(error) = result {
                eprintln!("Failed to bring the window to the front: {error}");
            }
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
