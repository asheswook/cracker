#!/bin/sh
set -eu
case "${1:-}" in
  ''|--prepare-only) ;;
  *) printf '%s\n' 'Usage: start-desktop.sh [--prepare-only]' >&2; exit 2 ;;
esac
repo=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
export XDG_CONFIG_HOME="$HOME/.config/autonomous-assistant/desktop"
export XDG_CACHE_HOME="$HOME/.cache/autonomous-assistant/desktop"
export XDG_CURRENT_DESKTOP=XFCE
export DESKTOP_SESSION=xfce
umask 077
mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
if [ ! -e "$XDG_CONFIG_HOME/.seeded-v1" ]; then
  cp -Rn "$repo/infra/linux/desktop/." "$XDG_CONFIG_HOME/"
  touch "$XDG_CONFIG_HOME/.seeded-v1"
fi
if [ "${1:-}" = --prepare-only ]; then exit 0; fi
xset s off -dpms
exec dbus-run-session -- xfce4-session
