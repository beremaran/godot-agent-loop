#!/usr/bin/env bash
# @test-kind: integration
# Proves the shipped validation runner resolves multiple project autoloads and
# forces a fresh engine compile when the same target file changes.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VALIDATOR="$ROOT_DIR/src/scripts/validate_script.gd"
# shellcheck source=tests/godot/godot-bin.sh
source "$ROOT_DIR/tests/godot/godot-bin.sh"

GODOT="$(require_godot)"
PROJECT="$(mktemp -d)"
trap 'rm -rf "$PROJECT"' EXIT
init_godot_log validate-script

mkdir -p "$PROJECT/scripts"
cat > "$PROJECT/project.godot" <<'EOF'
config_version=5

[application]

config/name="validate-script-integration"
config/features=PackedStringArray("4.4")

[autoload]

FirstAutoload="*res://first_autoload.gd"
SecondAutoload="*res://second_autoload.gd"
EOF
cat > "$PROJECT/first_autoload.gd" <<'EOF'
extends Node


func value() -> int:
	return 20
EOF
cat > "$PROJECT/second_autoload.gd" <<'EOF'
extends Node


func value() -> int:
	return 22
EOF
cat > "$PROJECT/scripts/consumer.gd" <<'EOF'
extends Node

var combined: int = FirstAutoload.value() + SecondAutoload.value()
EOF

set +e
VALID_OUTPUT="$("$GODOT" --headless --path "$PROJECT" --script "$VALIDATOR" res://scripts/consumer.gd 2>&1)"
VALID_STATUS=$?
set -e
append_godot_log "$VALID_OUTPUT"
if [[ "$VALID_STATUS" -ne 0 ]] || grep -q 'SCRIPT ERROR' <<<"$VALID_OUTPUT"; then
  echo "FAIL validator rejected references to two registered autoloads" >&2
  printf '%s\n' "$VALID_OUTPUT" >&2
  exit 1
fi
echo "  ok multiple autoloads resolve during validation"

cat >> "$PROJECT/scripts/consumer.gd" <<'EOF'
var broken: int = "not an integer"
EOF
set +e
INVALID_OUTPUT="$("$GODOT" --headless --path "$PROJECT" --script "$VALIDATOR" res://scripts/consumer.gd 2>&1)"
INVALID_STATUS=$?
set -e
append_godot_log "$INVALID_OUTPUT"
if ! grep -q 'SCRIPT ERROR: Parse Error:' <<<"$INVALID_OUTPUT" \
  || ! grep -q 'res://scripts/consumer.gd:4' <<<"$INVALID_OUTPUT"; then
  echo "FAIL validator reused stale source or missed the genuine compile error (exit $INVALID_STATUS)" >&2
  printf '%s\n' "$INVALID_OUTPUT" >&2
  exit 1
fi
echo "  ok rewritten target receives a fresh real compile"

assert_clean_godot_log validate-script
echo "Validation integration passed: 2 checks"
