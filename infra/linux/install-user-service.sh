#!/bin/sh
set -eu
if [ "$(uname -s)" != Linux ]; then
  printf '%s\n' 'This installer only runs on Ubuntu 24.04 Linux.' >&2
  exit 1
fi
os_id=$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"')
os_version=$(sed -n 's/^VERSION_ID=//p' /etc/os-release | tr -d '"')
if [ "$os_id" != ubuntu ] || [ "$os_version" != 24.04 ]; then
  printf '%s\n' 'Ubuntu 24.04 is required.' >&2
  exit 1
fi
if [ "$(id -u)" -eq 0 ]; then
  printf '%s\n' 'Run as the dedicated VM user, not root.' >&2
  exit 1
fi
case "${1:-}" in
  --install-deps)
    sudo apt-get update
    sudo apt-get install -y --no-install-recommends ca-certificates curl unzip git nodejs python3 poppler-utils ffmpeg xdotool xclip x11-utils xvfb xauth xfce4 xfce4-terminal thunar xfce4-panel xfce4-whiskermenu-plugin dbus-x11 x11-xserver-utils scrot fonts-noto-cjk mesa-utils
    sh "$(dirname -- "$0")/install-work-tools.sh"
    ;;
  '') ;;
  *) printf '%s\n' 'Usage: install-user-service.sh [--install-deps]' >&2; exit 2 ;;
esac
for binary in bun node python3 pdfinfo pdftotext pnpm ffmpeg xdotool xclip xdpyinfo xprop Xvfb xauth xfce4-session xfce4-panel xfce4-terminal thunar xset dbus-run-session scrot systemctl; do
  if ! command -v "$binary" >/dev/null 2>&1; then
    printf 'Missing required executable: %s\n' "$binary" >&2
    exit 1
  fi
done
repo=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
config_dir="$HOME/.config/autonomous-assistant"
service_dir="$HOME/.config/systemd/user"
checkout_link="$HOME/.local/share/autonomous-assistant"
umask 077
mkdir -p "$config_dir" "$service_dir" "$HOME/.local/share" "$HOME/.local/state/autonomous-assistant"
if [ -e "$checkout_link" ] || [ -L "$checkout_link" ]; then
  if [ "$(readlink -f "$checkout_link")" != "$repo" ]; then
    printf '%s\n' 'Existing checkout link points elsewhere; move it explicitly before installing.' >&2
    exit 1
  fi
else
  ln -s "$repo" "$checkout_link"
fi
cd "$repo"
pnpm install --frozen-lockfile
sh infra/linux/install-browser-runtime.sh
bun run build:browser
pnpm check
if [ ! -e "$config_dir/daemon.env" ]; then
  cp infra/linux/daemon.env.example "$config_dir/daemon.env"
  printf '\nJOURNAL_PATH=%s/.local/state/autonomous-assistant/journal.sqlite\nXAUTHORITY=%s/xauthority\n' "$HOME" "$config_dir" >> "$config_dir/daemon.env"
  chmod 600 "$config_dir/daemon.env"
fi
if [ ! -e "$config_dir/xauthority" ]; then
  touch "$config_dir/xauthority"
  chmod 600 "$config_dir/xauthority"
  cookie=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  xauth -f "$config_dir/xauthority" add :99 MIT-MAGIC-COOKIE-1 "$cookie"
  unset cookie
fi
infra/linux/start-desktop.sh --prepare-only
cp infra/linux/*.service "$service_dir/"
mkdir -p "$HOME/.local/share/applications"
cp infra/linux/assistant-browser.desktop "$HOME/.local/share/applications/assistant-browser.desktop"
xdg-mime default assistant-browser.desktop x-scheme-handler/http x-scheme-handler/https text/html
XDG_CONFIG_HOME="$config_dir/desktop" xdg-mime default assistant-browser.desktop x-scheme-handler/http x-scheme-handler/https text/html
systemctl --user daemon-reload
printf '%s\n' 'Services installed but not started.'
printf 'Edit credentials privately: %s/daemon.env\n' "$config_dir"
printf '%s\n' 'Then run: systemctl --user enable --now autonomous-assistant.service'
printf '%s\n' 'For background PDF/DOCX indexing: systemctl --user enable --now artifact-indexer.service (fails closed if cgroup limits are unavailable)'
printf '%s\n' 'For operation after logout: sudo loginctl enable-linger YOUR_USER'
