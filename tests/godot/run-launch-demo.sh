#!/usr/bin/env bash
# @test-kind: integration
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=tests/godot/godot-bin.sh
source "$ROOT_DIR/tests/godot/godot-bin.sh"

GODOT="$(require_godot)"
PROJECT="$ROOT_DIR/examples/launch-demo"
init_godot_log launch-demo

set +e
output="$("$GODOT" --headless --path "$PROJECT" --quit-after 2 2>&1)"
status=$?
set -e
append_godot_log "$output"

if [[ "$status" -ne 0 ]] || grep -Eq 'SCRIPT ERROR|ERROR:' <<<"$output"; then
  grep -v 'Godot Engine v' <<<"$output" || true
  echo "Launch demo failed to parse or start" >&2
  exit 1
fi
if ! grep -q '^PLAYING$' <<<"$output"; then
  echo "Launch demo did not execute its PLAYING state" >&2
  exit 1
fi

assert_clean_godot_log launch-demo
echo "Launch demo passed: parsed, started, and observed PLAYING"
