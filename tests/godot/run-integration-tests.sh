#!/usr/bin/env bash
# Runs the Godot runtime-server integration tests against a real headless
# Godot instance. Resolution order for the engine binary:
#   1. $GODOT_BIN
#   2. godot4 / godot on PATH
#   3. the first executable matching godot* inside $GODOT_PATH
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE_DIR="$ROOT_DIR/tests/godot/fixture"

resolve_godot() {
  if [[ -n "${GODOT_BIN:-}" ]]; then
    echo "$GODOT_BIN"
    return
  fi
  local candidate
  for candidate in godot4 godot; do
    if command -v "$candidate" >/dev/null 2>&1; then
      echo "$candidate"
      return
    fi
  done
  if [[ -n "${GODOT_PATH:-}" && -d "$GODOT_PATH" ]]; then
    find "$GODOT_PATH" -maxdepth 1 -type f -name 'godot*' -executable | head -n 1
  fi
}

GODOT="$(resolve_godot)"
if [[ -z "$GODOT" ]]; then
  echo "error: no Godot binary found; set GODOT_BIN or GODOT_PATH" >&2
  exit 1
fi

echo "Using Godot: $GODOT ($("$GODOT" --version | tail -n 1))"

cp "$ROOT_DIR/src/scripts/mcp_interaction_server.gd" "$FIXTURE_DIR/mcp_interaction_server.gd"

exec "$GODOT" --headless --path "$FIXTURE_DIR" --script res://test_runner.gd
