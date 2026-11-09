#!/usr/bin/env bash
set -euo pipefail

# Download a verification Host independently of the SDK used to build the plugin.
if [[ $# -ne 2 ]]; then
  printf 'Usage: bash scripts/prepare-host.sh OUTPUT_DIRECTORY HOST_VERSION\n' >&2
  exit 2
fi
read -r host_version host_commit host_sha256 source_sha256 < <(node scripts/host-compatibility.js --host "$2")
readonly host_version host_commit host_sha256 source_sha256
if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  printf 'The pinned acceptance host requires Linux x86_64.\n' >&2
  exit 2
fi

mkdir -p "$1"
destination=$(cd "$1" && pwd)
readonly destination
mkdir -p "$destination/downloads" "$destination/host" "$destination/source"

download() {
  local url=$1 path=$2 checksum=$3
  if [[ ! -f "$path" ]] || ! printf '%s  %s\n' "$checksum" "$path" | sha256sum --check --status; then
    curl --fail --silent --show-error --location --retry 3 --proto '=https' \
      --output "$path" "$url"
  fi
  printf '%s  %s\n' "$checksum" "$path" | sha256sum --check
}

host_archive="$destination/downloads/codex-proxy-rs_${host_version}_linux_amd64.tar.gz"
source_archive="$destination/downloads/source-${host_commit}.tar.gz"
download "https://github.com/zyycn/codex-proxy-rs/releases/download/v${host_version}/codex-proxy-rs_${host_version}_linux_amd64.tar.gz" \
  "$host_archive" "$host_sha256"
download "https://codeload.github.com/zyycn/codex-proxy-rs/tar.gz/${host_commit}" \
  "$source_archive" "$source_sha256"

tar --extract --gzip --file "$host_archive" --strip-components=1 --directory "$destination/host"
tar --extract --gzip --file "$source_archive" --strip-components=1 --directory "$destination/source"

node scripts/host-compatibility.js --check-host "$destination/source" "$host_version"

host_binary="$destination/host/codex-proxy-rs"
host_web="$destination/host/web/dist"
test -x "$host_binary"
test -f "$host_web/index.html"
test "$("$host_binary" --version)" = "$host_version"

printf 'host-binary=%s\nhost-web=%s\n' "$host_binary" "$host_web"
if [[ -n ${GITHUB_OUTPUT:-} ]]; then
  printf 'host-binary=%s\nhost-web=%s\n' "$host_binary" "$host_web" >> "$GITHUB_OUTPUT"
fi
