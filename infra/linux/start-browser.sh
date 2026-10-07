#!/bin/sh
set -eu
unset XDG_CONFIG_HOME XDG_CACHE_HOME
profile_root="$HOME/.config/autonomous-assistant/chrome"
profile=$(python3 -c '
import json, pathlib, sys
state = pathlib.Path(sys.argv[1]) / "Local State"
name = json.loads(state.read_text()).get("profile", {}).get("last_used", "Default") if state.exists() else "Default"
if not isinstance(name, str) or not name or pathlib.Path(name).name != name:
    raise ValueError("Invalid Chrome profile directory")
print(name)
' "$profile_root")
exec /usr/bin/google-chrome --user-data-dir="$profile_root" --profile-directory="$profile" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --no-first-run --no-default-browser-check --disable-dev-shm-usage --ozone-platform=x11 --restore-last-session "$@"
