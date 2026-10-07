#!/bin/sh
set -eu
unset XDG_CONFIG_HOME XDG_CACHE_HOME
systemctl --user start assistant-browser.service
if [ "$#" -eq 0 ]; then set -- about:blank; fi
exec /bin/sh "$HOME/.local/share/autonomous-assistant/infra/linux/start-browser.sh" "$@"
