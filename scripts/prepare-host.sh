#!/usr/bin/env bash
set -euo pipefail

# Keep the acceptance host and packaging CLI on the plugin's SDK baseline.
readonly host_version='3.29.0'
readonly host_commit='45954899e53081a2e775fb9351e22908e85221c7'
readonly host_sha256='0e1552e63252c817db9e9c20063d090efbb00a83ddc220b7a0d54a0251d07106'
readonly source_sha256='1d76fb0b60ea6fcc72fa31ffe169dec48bdbac0e3f7b6b4321b91296d56d7afb'

if [[ $# -ne 1 ]]; then
  printf 'Usage: bash scripts/prepare-host.sh OUTPUT_DIRECTORY\n' >&2
  exit 2
fi
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

# Upstream ships the host and web assets, but no standalone cpr-plugin binary.
cargo build --manifest-path "$destination/source/backend/Cargo.toml" --locked \
  --package codex-proxy-plugin-cli --bin cpr-plugin --target-dir "$destination/cli-target"

host_binary="$destination/host/codex-proxy-rs"
host_web="$destination/host/web/dist"
plugin_cli="$destination/cli-target/debug/cpr-plugin"
test -x "$host_binary"
test -f "$host_web/index.html"
test -x "$plugin_cli"
test "$("$host_binary" --version)" = "$host_version"
"$plugin_cli" --version

printf 'host-binary=%s\nhost-web=%s\nplugin-cli=%s\n' "$host_binary" "$host_web" "$plugin_cli"
if [[ -n ${GITHUB_OUTPUT:-} ]]; then
  printf 'host-binary=%s\nhost-web=%s\nplugin-cli=%s\n' "$host_binary" "$host_web" "$plugin_cli" >> "$GITHUB_OUTPUT"
fi
