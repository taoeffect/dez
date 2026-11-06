"""A fake desktop notification server for the e2e specs, on a private bus.

It starts its own `dbus-daemon`, owns `org.freedesktop.Notifications` on it,
and records each `Notify` call. The spec gives the app the bus address, so no
real desktop shows a notification, and the spec acts as the user who clicks.

Protocol (one JSON object per stdout line; one command per stdin line):
  out {"event": "ready", "address": "<bus address>"}
  out {"event": "notify", "id": N, "appName": ..., "summary": ..., "body": ...,
       "actions": [...]}
  in  click <id> [<activation token>]   ActivationToken (with a token), then
                                        ActionInvoked(id, "default")
  in  close <id>                        NotificationClosed(id, 2: dismissed)
EOF on stdin: the bus stops and the script exits.

Needs python3-gi (PyGObject with Gio) and dbus-daemon. The bus config has no
<servicedir>, so nothing on it starts other services (at-spi, portals).
Spec: https://specifications.freedesktop.org/notification-spec/latest/
"""

import ctypes
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile

import gi

gi.require_version("Gio", "2.0")
gi.require_version("GLib", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

# GLib 2.80 moved the Unix signal watch to GLibUnix, and newer PyGObject
# warns on the old name.
try:
    gi.require_version("GLibUnix", "2.0")
    from gi.repository import GLibUnix  # noqa: E402

    add_signal_watch = GLibUnix.signal_add
except (ImportError, ValueError):
    add_signal_watch = GLib.unix_signal_add

NAME = "org.freedesktop.Notifications"
PATH = "/org/freedesktop/Notifications"
INTERFACE_XML = """
<node>
  <interface name="org.freedesktop.Notifications">
    <method name="GetCapabilities">
      <arg type="as" direction="out"/>
    </method>
    <method name="Notify">
      <arg type="s" direction="in"/>
      <arg type="u" direction="in"/>
      <arg type="s" direction="in"/>
      <arg type="s" direction="in"/>
      <arg type="s" direction="in"/>
      <arg type="as" direction="in"/>
      <arg type="a{sv}" direction="in"/>
      <arg type="i" direction="in"/>
      <arg type="u" direction="out"/>
    </method>
    <method name="CloseNotification">
      <arg type="u" direction="in"/>
    </method>
    <method name="GetServerInformation">
      <arg type="s" direction="out"/>
      <arg type="s" direction="out"/>
      <arg type="s" direction="out"/>
      <arg type="s" direction="out"/>
    </method>
    <signal name="NotificationClosed">
      <arg type="u"/>
      <arg type="u"/>
    </signal>
    <signal name="ActionInvoked">
      <arg type="u"/>
      <arg type="s"/>
    </signal>
    <signal name="ActivationToken">
      <arg type="u"/>
      <arg type="s"/>
    </signal>
  </interface>
</node>
"""
BUS_CONFIG = """<!DOCTYPE busconfig PUBLIC
 "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:path={socket}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
"""
PR_SET_PDEATHSIG = 1


def emit(event):
    print(json.dumps(event), flush=True)


# The bus dies with this script, even when the script gets SIGKILL.
def die_with_parent():
    ctypes.CDLL(None, use_errno=True).prctl(PR_SET_PDEATHSIG, signal.SIGTERM)


def start_bus(directory):
    config = os.path.join(directory, "bus.conf")
    with open(config, "w") as file:
        file.write(BUS_CONFIG.format(socket=os.path.join(directory, "bus")))
    bus = subprocess.Popen(
        ["dbus-daemon", "--config-file=" + config, "--nofork", "--print-address=1"],
        stdout=subprocess.PIPE,
        stdin=subprocess.DEVNULL,
        preexec_fn=die_with_parent,
        text=True,
    )
    address = bus.stdout.readline().strip()
    if not address:
        bus.wait()
        raise RuntimeError("dbus-daemon exited with code %s" % bus.returncode)
    return bus, address


class Server:
    def __init__(self, connection):
        self.connection = connection
        self.next_id = 1

    def on_call(self, _connection, _sender, _path, _interface, method, params, invocation):
        if method == "GetCapabilities":
            invocation.return_value(GLib.Variant("(as)", (["actions", "body"],)))
        elif method == "GetServerInformation":
            invocation.return_value(GLib.Variant("(ssss)", ("dez-e2e", "dez", "1", "1.2")))
        elif method == "CloseNotification":
            (notification_id,) = params.unpack()
            self.signal("NotificationClosed", "(uu)", (notification_id, 3))
            invocation.return_value(None)
        elif method == "Notify":
            app_name, replaces_id, _icon, summary, body, actions, _hints, _timeout = params.unpack()
            notification_id = replaces_id or self.next_id
            self.next_id = max(self.next_id, notification_id + 1)
            emit({
                "event": "notify",
                "id": notification_id,
                "appName": app_name,
                "summary": summary,
                "body": body,
                "actions": actions,
            })
            invocation.return_value(GLib.Variant("(u)", (notification_id,)))

    def signal(self, name, signature, values):
        self.connection.emit_signal(None, PATH, NAME, name, GLib.Variant(signature, values))

    def on_command(self, line):
        parts = line.split()
        if not parts:
            return
        command, notification_id = parts[0], int(parts[1])
        if command == "click":
            if len(parts) > 2:
                self.signal("ActivationToken", "(us)", (notification_id, parts[2]))
            self.signal("ActionInvoked", "(us)", (notification_id, "default"))
        elif command == "close":
            self.signal("NotificationClosed", "(uu)", (notification_id, 2))
        self.connection.flush_sync(None)


def main():
    directory = tempfile.mkdtemp(prefix="dez-e2e-bus-")
    bus = None
    loop = GLib.MainLoop()
    try:
        bus, address = start_bus(directory)
        connection = Gio.DBusConnection.new_for_address_sync(
            address,
            Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
            None,
            None,
        )
        server = Server(connection)
        interface = Gio.DBusNodeInfo.new_for_xml(INTERFACE_XML).interfaces[0]
        connection.register_object(PATH, interface, server.on_call, None, None)
        reply = connection.call_sync(
            "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName",
            GLib.Variant("(su)", (NAME, 4)), GLib.VariantType("(u)"), Gio.DBusCallFlags.NONE, -1, None,
        )
        # 1: DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER
        if reply.unpack()[0] != 1:
            raise RuntimeError("Could not own " + NAME)

        # A last line can come with the hang-up, so read before the check.
        def on_stdin(channel, condition):
            line = channel.readline() if condition & GLib.IO_IN else ""
            if not line:
                loop.quit()
                return False
            server.on_command(line)
            return True

        stdin = GLib.IOChannel.unix_new(sys.stdin.fileno())
        GLib.io_add_watch(stdin, GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, on_stdin)
        # A killed e2e run sends SIGTERM; quit so that `finally` stops the bus
        # and removes the directory.
        add_signal_watch(GLib.PRIORITY_DEFAULT, signal.SIGTERM, lambda: loop.quit() or False)
        emit({"event": "ready", "address": address})
        loop.run()
    finally:
        if bus:
            bus.terminate()
            bus.wait()
        shutil.rmtree(directory, ignore_errors=True)


if __name__ == "__main__":
    main()
