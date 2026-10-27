#!/bin/sh
set -eu
unset XDG_CONFIG_HOME XDG_CACHE_HOME
export XMODIFIERS=@im=fcitx GTK_IM_MODULE=fcitx QT_IM_MODULE=fcitx
# The browser is a separate systemd service, not a child of the desktop.
# Join its DISPLAY/D-Bus session so GTK and XIM use the same fcitx instance.
if DBUS_SESSION_BUS_ADDRESS=$(python3 -c '
import os, pathlib, time
for attempt in range(100):
    for process in pathlib.Path("/proc").glob("[0-9]*"):
        try:
            if process.joinpath("comm").read_text().strip() != "xfce4-session":
                continue
            env = dict(item.split(b"=", 1) for item in process.joinpath("environ").read_bytes().split(b"\0") if b"=" in item)
            if env.get(b"DISPLAY", b"").decode() == os.environ.get("DISPLAY", "") and b"DBUS_SESSION_BUS_ADDRESS" in env:
                print(env[b"DBUS_SESSION_BUS_ADDRESS"].decode())
                raise SystemExit(0)
        except (OSError, ValueError):
            continue
    time.sleep(0.1)
raise SystemExit(1)
'); then
  export DBUS_SESSION_BUS_ADDRESS
else
  printf '%s\n' 'Assistant desktop D-Bus session unavailable; starting Chrome without IME session.' >&2
  unset DBUS_SESSION_BUS_ADDRESS
fi
profile_root="$HOME/.config/autonomous-assistant/chrome"
profile=$(python3 -c '
import json, pathlib, sys
state = pathlib.Path(sys.argv[1]) / "Local State"
name = json.loads(state.read_text()).get("profile", {}).get("last_used", "Default") if state.exists() else "Default"
if not isinstance(name, str) or not name or pathlib.Path(name).name != name:
    raise ValueError("Invalid Chrome profile directory")
print(name)
' "$profile_root")
exec /usr/bin/google-chrome --user-data-dir="$profile_root" --profile-directory="$profile" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --no-first-run --no-default-browser-check --disable-dev-shm-usage --ozone-platform=x11 --force-renderer-accessibility --restore-last-session "$@"
