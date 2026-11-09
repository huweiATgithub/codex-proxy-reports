#!/usr/bin/env bash
set -euo pipefail

: "${HOST_VERSION:?HOST_VERSION is required}"
: "${PLUGIN_ARCHIVE:?PLUGIN_ARCHIVE is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
[[ -f "$PLUGIN_ARCHIVE" ]]

bash scripts/prepare-host.sh "$RUNNER_TEMP/host-$HOST_VERSION" "$HOST_VERSION"
TMPDIR=$(mktemp -d "$RUNNER_TEMP/integration-$HOST_VERSION.XXXXXX")
export TMPDIR
evidence_dir="dist/verification/$HOST_VERSION"
mkdir -p "$evidence_dir"
collect_evidence() {
  local status=$?
  trap - EXIT
  shopt -s nullglob
  local evidence
  for evidence in "$TMPDIR"/codex-reports-integration-*/result.json "$TMPDIR"/codex-reports-integration-*/host.log "$TMPDIR"/codex-reports-integration-*/*.png; do
    cp -- "$evidence" "$evidence_dir/" || status=1
  done
  if [[ "$status" == 0 && ! -s "$evidence_dir/result.json" ]]; then
    echo "Successful integration did not produce result.json for Host $HOST_VERSION" >&2
    status=1
  fi
  exit "$status"
}
trap collect_evidence EXIT

node scripts/integration.js \
  --host-binary "$RUNNER_TEMP/host-$HOST_VERSION/host/codex-proxy-rs" \
  --host-web "$RUNNER_TEMP/host-$HOST_VERSION/host/web/dist" \
  --package "$PLUGIN_ARCHIVE" --host-version "$HOST_VERSION" --browser
