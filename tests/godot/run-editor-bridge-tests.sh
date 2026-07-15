#!/usr/bin/env bash
# @test-kind: integration
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=tests/godot/godot-bin.sh
source "$ROOT_DIR/tests/godot/godot-bin.sh"

GODOT="$(require_godot)"
PROJECT="$(mktemp -d)"
trap 'rm -rf "$PROJECT"' EXIT
mkdir -p "$PROJECT/addons/godot_agent_loop" "$PROJECT/addons/editor_bridge_test"
cp "$ROOT_DIR/tests/godot/typecheck/runtime/project.godot" "$PROJECT/project.godot"
cp "$ROOT_DIR/addons/godot_agent_loop/plugin.gd" "$ROOT_DIR/addons/godot_agent_loop/plugin.cfg" "$PROJECT/addons/godot_agent_loop/"
cp "$ROOT_DIR/tests/godot/editor_bridge_test.gd" "$PROJECT/addons/editor_bridge_test/plugin.gd"
printf '%s\n' '[plugin]' 'name="Editor Bridge Contract Tests"' 'description="Strict tests for the shipped bridge"' 'author="Godot Agent Loop"' 'version="1.0.0"' 'script="plugin.gd"' > "$PROJECT/addons/editor_bridge_test/plugin.cfg"
printf '\n[editor_plugins]\n\nenabled=PackedStringArray("editor_bridge_test")\n' >> "$PROJECT/project.godot"
init_godot_log editor-bridge

set +e
output="$("$GODOT" --verbose --headless --editor --path "$PROJECT" --quit-after 5 2>&1)"
status=$?
set -e
append_godot_log "$output"

if [[ "$status" -ne 0 ]] || ! grep -q '^EDITOR_BRIDGE_TESTS_PASSED$' <<<"$output"; then
  grep -v 'Godot Engine v' <<<"$output" || true
  echo "Editor bridge contract tests failed" >&2
  exit 1
fi

assert_clean_godot_log editor-bridge
echo "Editor bridge passed: discovery, auth, transactions, undo/redo, sync, and activity"
