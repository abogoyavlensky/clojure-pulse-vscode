#!/usr/bin/env bash
#
# Downloads the pinned clj-pulse release for one vsce target into server/,
# where `vsce package --target <target>` picks it up and the extension finds
# it at activation. The pin is `cljPulseVersion` in package.json.
#
# Called by the CI and release workflows (once per platform build) and by
# `make fetch-server` (for the host platform). Never commit server/.
#
# Usage: scripts/fetch-server.sh <vsce-target>

set -euo pipefail

targets="darwin-arm64 darwin-x64 linux-arm64 linux-x64 win32-x64"

usage() {
  echo "usage: $0 <vsce-target>" >&2
  echo "targets: $targets" >&2
  exit 2
}

[ $# -eq 1 ] || usage
target=$1

# The one place that knows which clj-pulse archive each vsce target carries.
case "$target" in
  darwin-arm64) asset=clj-pulse-aarch64-apple-darwin.tar.gz ;;
  darwin-x64) asset=clj-pulse-x86_64-apple-darwin.tar.gz ;;
  linux-arm64) asset=clj-pulse-aarch64-unknown-linux-gnu.tar.gz ;;
  linux-x64) asset=clj-pulse-x86_64-unknown-linux-gnu.tar.gz ;;
  win32-x64) asset=clj-pulse-x86_64-pc-windows-msvc.zip ;;
  *) usage ;;
esac

case "$target" in
  win32-*) binary=clj-pulse.exe ;;
  *) binary=clj-pulse ;;
esac

cd "$(dirname "$0")/.."

version=$(node -p "require('./package.json').cljPulseVersion")
base="https://github.com/abogoyavlensky/clj-pulse/releases/download/v${version}"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "downloading clj-pulse ${version} (${asset})"
curl -fsSL --retry 3 -o "$tmp/$asset" "$base/$asset"
curl -fsSL --retry 3 -o "$tmp/checksums.txt" "$base/checksums.txt"

# macOS ships shasum but no sha256sum; both read the same `<hash>  <file>` lines.
sha=$(command -v sha256sum || echo "shasum -a 256")
if ! grep " ${asset}\$" "$tmp/checksums.txt" > "$tmp/expected.txt"; then
  echo "error: ${asset} is not listed in checksums.txt for clj-pulse ${version}" >&2
  exit 1
fi
if ! (cd "$tmp" && $sha -c expected.txt > /dev/null); then
  echo "error: checksum mismatch for ${asset}" >&2
  exit 1
fi

rm -rf server
mkdir server
case "$asset" in
  *.tar.gz) tar xzf "$tmp/$asset" -C server ;;
  *.zip) unzip -q "$tmp/$asset" -d server ;;
esac

if [ ! -f "server/$binary" ]; then
  echo "error: ${asset} did not contain ${binary}; server/ holds:" >&2
  ls -la server >&2
  exit 1
fi
case "$target" in
  win32-*) ;;
  *) chmod 755 "server/$binary" ;;
esac

echo "fetched clj-pulse ${version} for ${target} -> server/"
