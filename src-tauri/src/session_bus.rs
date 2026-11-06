//! The one D-Bus session bus connection of the app, shared by
//! notification.rs and idle.rs. Each zbus connection keeps a socket and a
//! zbus thread open, so a connection per notification would leave one open
//! for each notification that GNOME keeps in its list without a close.

use zbus::Connection;

static SESSION_BUS: tokio::sync::OnceCell<Connection> = tokio::sync::OnceCell::const_new();

/// Connects at the first call; after a failed connect, the next call tries
/// again.
pub async fn session_bus() -> zbus::Result<&'static Connection> {
    SESSION_BUS.get_or_try_init(Connection::session).await
}
