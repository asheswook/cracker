#!/bin/sh
set -eu
attempt=0
until /usr/bin/xdpyinfo -display "${DISPLAY:?DISPLAY is required}" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    printf '%s\n' 'X11 display did not become ready.' >&2
    exit 1
  fi
  sleep 0.25
done
