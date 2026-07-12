#!/usr/bin/env bash
# Parses every shipped GDScript file with Godot's warnings promoted to errors.
#
# Each tier is a throwaway Godot project whose project.godot declares which
# warnings are errors; the shipped scripts are copied in and parsed with
# --check-only, which compiles the script (and everything it preloads) and exits
# non-zero on any parse error, including a promoted warning.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TYPECHECK_DIR="$ROOT_DIR/tests/godot/typecheck"
# shellcheck source=tests/godot/godot-bin.sh
source "$ROOT_DIR/tests/godot/godot-bin.sh"

GODOT="$(require_godot)"
echo "Using Godot: $GODOT ($("$GODOT" --version | tail -n 1))"

failed=0
checked=0

check_script() {
  local project="$1" script="$2" output status
  checked=$((checked + 1))
  # A promoted warning both prints SCRIPT ERROR and fails the exit status; the
  # output is captured rather than piped so pipefail cannot mask either signal.
  set +e
  output="$("$GODOT" --headless --path "$project" --check-only --script "res://$script" 2>&1)"
  status=$?
  set -e
  if [[ "$status" -ne 0 ]] || grep -q 'SCRIPT ERROR' <<<"$output"; then
    echo "FAIL $script"
    grep -v 'Godot Engine v' <<<"$output" || true
    failed=$((failed + 1))
  else
    echo "  ok $script"
  fi
}

# --- Headless operations script (full strict tier) --------------------------
HEADLESS_TIER="$TYPECHECK_DIR/headless"
cp "$ROOT_DIR/src/scripts/godot_operations.gd" "$HEADLESS_TIER/godot_operations.gd"
echo "Type-checking the headless operations script"
check_script "$HEADLESS_TIER" "godot_operations.gd"

# --- Runtime server and its domain scripts ----------------------------------
RUNTIME_TIER="$TYPECHECK_DIR/runtime"
cp "$ROOT_DIR/src/scripts/mcp_interaction_server.gd" "$RUNTIME_TIER/mcp_interaction_server.gd"
rm -rf "$RUNTIME_TIER/mcp_runtime"
cp -R "$ROOT_DIR/src/scripts/mcp_runtime" "$RUNTIME_TIER/mcp_runtime"
echo "Type-checking the runtime server and its domains"
check_script "$RUNTIME_TIER" "mcp_interaction_server.gd"
for domain in "$RUNTIME_TIER"/mcp_runtime/*.gd; do
  check_script "$RUNTIME_TIER" "mcp_runtime/$(basename "$domain")"
done

echo
if [[ "$failed" -gt 0 ]]; then
  echo "Type check failed: $failed of $checked scripts have promoted warnings or parse errors"
  exit 1
fi
echo "Type check passed: $checked scripts"
