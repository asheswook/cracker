#!/bin/sh
set -eu
repo=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64) arch=arm64 ;;
  *) printf '%s\n' 'Unsupported browser runtime architecture' >&2; exit 1 ;;
esac
version=v24.7.0
if [ -x "$repo/var/browser-runtime/bin/node" ] && [ "$("$repo/var/browser-runtime/bin/node" --version)" = "$version" ]; then exit 0; fi
mkdir -p "$repo/var"
staging=$(mktemp -d "$repo/var/browser-runtime-install.XXXXXX")
trap 'rm -rf "$staging"' EXIT
archive="node-$version-linux-$arch.tar.xz"
curl --fail --location --max-time 120 "https://nodejs.org/dist/$version/$archive" -o "$staging/$archive"
curl --fail --location --max-time 30 "https://nodejs.org/dist/$version/SHASUMS256.txt" -o "$staging/SHASUMS256.txt"
(cd "$staging"; awk -v name="$archive" '$2==name' SHASUMS256.txt | sha256sum --check --strict)
tar -xJf "$staging/$archive" -C "$staging"
test ! -e "$repo/var/browser-runtime"
mv "$staging/node-$version-linux-$arch" "$repo/var/browser-runtime"
