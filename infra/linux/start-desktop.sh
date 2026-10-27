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
export XMODIFIERS=@im=fcitx GTK_IM_MODULE=fcitx QT_IM_MODULE=fcitx
umask 077
mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
if [ ! -e "$XDG_CONFIG_HOME/.seeded-v1" ]; then
  cp -Rn "$repo/infra/linux/desktop/." "$XDG_CONFIG_HOME/"
  touch "$XDG_CONFIG_HOME/.seeded-v1"
fi
mkdir -p "$HOME/.config/fcitx5"
for name in profile config; do
  if [ ! -e "$HOME/.config/fcitx5/$name" ]; then
    cp "$repo/infra/linux/fcitx5/$name" "$HOME/.config/fcitx5/$name"
  fi
done
if [ "${1:-}" = --prepare-only ]; then exit 0; fi
xset s off -dpms
exec dbus-run-session -- sh -c '
  xfce4-session &
  desktop=$!
  # Xfce uses a private config tree; keep the IME in the standard user config.
  XDG_CONFIG_HOME="$HOME/.config" XDG_CACHE_HOME="$HOME/.cache" fcitx5 -d
  wait "$desktop"
'
