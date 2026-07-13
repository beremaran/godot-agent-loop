#!/usr/bin/env bash
# @test-kind: integration
# Runs the Godot runtime-server integration tests against a real headless
# Godot instance, driving the shipped server over loopback TCP.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE_DIR="$ROOT_DIR/tests/godot/fixture"
# shellcheck source=tests/godot/godot-bin.sh
source "$ROOT_DIR/tests/godot/godot-bin.sh"

GODOT="$(require_godot)"
echo "Using Godot: $GODOT ($("$GODOT" --version | tail -n 1))"

# Mirror the installed layout: the server, mcp_runtime domain scripts it
# preloads from res://, and the shared codec corpus consumed by both test sides.
cp "$ROOT_DIR/src/scripts/mcp_interaction_server.gd" "$FIXTURE_DIR/mcp_interaction_server.gd"
rm -rf "$FIXTURE_DIR/mcp_runtime"
cp -R "$ROOT_DIR/src/scripts/mcp_runtime" "$FIXTURE_DIR/mcp_runtime"
cp "$ROOT_DIR/tests/variant-codec-corpus.json" "$FIXTURE_DIR/variant-codec-corpus.json"

exec "$GODOT" --headless --path "$FIXTURE_DIR" --script res://test_runner.gd
