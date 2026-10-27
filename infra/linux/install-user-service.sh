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
    sudo apt-get install -y --no-install-recommends ca-certificates curl openssl unzip git nodejs python3 poppler-utils ffmpeg xdotool xclip x11-utils xvfb xauth xfce4 xfce4-terminal thunar xfce4-panel xfce4-whiskermenu-plugin dbus-x11 x11-xserver-utils scrot fonts-noto-cjk mesa-utils fcitx5 fcitx5-hangul fcitx5-frontend-gtk3
    sh "$(dirname -- "$0")/install-work-tools.sh"
    sudo apt-get install -y gir1.2-atspi-2.0 gir1.2-gtk-3.0 at-spi2-core python3-gi npm
    # Match autonomous-assistant.service's Node lookup; install the CLI on its PATH.
    PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" npm_config_prefix="$HOME/.local" npm i -g --allow-scripts=open-computer-use open-computer-use@1.1.0
    ;;
  '') ;;
  *) printf '%s\n' 'Usage: install-user-service.sh [--install-deps]' >&2; exit 2 ;;
esac
for binary in bun node python3 pdfinfo pdftotext pnpm ffmpeg xdotool xclip xdpyinfo xprop Xvfb xauth xfce4-session xfce4-panel xfce4-terminal thunar xset dbus-run-session scrot systemctl curl openssl tar; do
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
# CLIProxyAPI v8.0.28 (MIT, Luis Pater; https://github.com/router-for-me/CLIProxyAPI): the official release
# binary of that tag is installed with its LICENSE; keys never leave this VM.
proxy_dir="$HOME/.local/share/cliproxyapi"
proxy_config="$config_dir/cliproxy"
case "$(uname -m)" in
  x86_64) proxy_arch=amd64 ;;
  aarch64|arm64) proxy_arch=arm64 ;;
  *) printf '%s\n' 'Unsupported CLIProxyAPI architecture' >&2; exit 1 ;;
esac
mkdir -p "$proxy_dir" "$proxy_config/auth"
proxy_download=$(mktemp -d)
trap 'rm -rf "$proxy_download"' EXIT HUP INT TERM
curl --fail --location --connect-timeout 10 --max-time 180 \
  "https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.28/CLIProxyAPI_8.0.28_linux_${proxy_arch}_no-plugin.tar.gz" \
  -o "$proxy_download/release.tar.gz"
tar -xzf "$proxy_download/release.tar.gz" -C "$proxy_download"
install -m 700 "$proxy_download/cli-proxy-api" "$proxy_dir/cli-proxy-api"
if [ -f "$proxy_download/LICENSE" ]; then install -m 600 "$proxy_download/LICENSE" "$proxy_dir/LICENSE"; fi
rm -rf "$proxy_download"
trap - EXIT HUP INT TERM
for key in client-key management-key; do
  if [ ! -e "$proxy_config/$key" ]; then openssl rand -hex 24 > "$proxy_config/$key"; fi
  chmod 600 "$proxy_config/$key"
done
if [ ! -e "$proxy_config/config.yaml" ]; then
  # JSON string quoting is also valid YAML, including unusual home directory names.
  python3 - "$proxy_config" <<'PY'
import json, pathlib, sys
directory = pathlib.Path(sys.argv[1])
client = (directory / 'client-key').read_text().strip()
management = (directory / 'management-key').read_text().strip()
(directory / 'config.yaml').write_text('\n'.join([
    'config-version: 8', 'server:', '  host: "127.0.0.1"', '  port: 8317',
    'management:', '  allow-remote: false', '  secret-key: ' + json.dumps(management),
    '  disable-control-panel: true', 'access:', '  api-keys: [' + json.dumps(client) + ']',
    'oauth:', '  auth-dir: ' + json.dumps(str(directory / 'auth')), '',
]))
PY
  chmod 600 "$proxy_config/config.yaml"
fi
if [ ! -e "$config_dir/daemon.env" ]; then
  cp infra/linux/daemon.env.example "$config_dir/daemon.env"
  printf '\nJOURNAL_PATH=%s/.local/state/autonomous-assistant/journal.sqlite\nXAUTHORITY=%s/xauthority\n' "$HOME" "$config_dir" >> "$config_dir/daemon.env"
  chmod 600 "$config_dir/daemon.env"
fi
if ! grep -q '^CLIPROXY_URL=' "$config_dir/daemon.env"; then
  printf '\nCLIPROXY_URL=http://127.0.0.1:8317\n' >> "$config_dir/daemon.env"
fi
if ! grep -q '^CLIPROXY_CLIENT_KEY_FILE=' "$config_dir/daemon.env"; then
  printf 'CLIPROXY_CLIENT_KEY_FILE="%s/client-key"\n' "$proxy_config" >> "$config_dir/daemon.env"
fi
if ! grep -q '^CLIPROXY_MANAGEMENT_KEY_FILE=' "$config_dir/daemon.env"; then
  printf 'CLIPROXY_MANAGEMENT_KEY_FILE="%s/management-key"\n' "$proxy_config" >> "$config_dir/daemon.env"
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
systemctl --user enable assistant-cliproxy.service
printf '%s\n' 'Services installed but not started.'
printf 'Edit credentials privately: %s/daemon.env\n' "$config_dir"
printf '%s\n' 'Then run: systemctl --user enable --now autonomous-assistant.service'
printf '%s\n' 'For background PDF/DOCX indexing: systemctl --user enable --now artifact-indexer.service (fails closed if cgroup limits are unavailable)'
printf '%s\n' 'For operation after logout: sudo loginctl enable-linger YOUR_USER'
