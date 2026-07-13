#!/usr/bin/env bash
# @test-kind: integration
# Runs every operation in src/scripts/godot_operations.gd against a real Godot
# instance and a throwaway fixture project.
#
# The operations are invoked exactly as the MCP server invokes them (see
# src/headless-operation-runner.ts): an absolute script path, the operation
# name, and one JSON object of snake_case params. Each check asserts the exit
# status, and — where the operation has an observable effect — its stdout
# payload and the files it left in the project.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OPERATIONS_SCRIPT="$ROOT_DIR/src/scripts/godot_operations.gd"
FIXTURE_TEMPLATE="$ROOT_DIR/tests/godot/operations-fixture"
# shellcheck source=tests/godot/godot-bin.sh
source "$ROOT_DIR/tests/godot/godot-bin.sh"

GODOT="$(require_godot)"
echo "Using Godot: $GODOT ($("$GODOT" --version | tail -n 1))"

PROJECT="$(mktemp -d)"
trap 'rm -rf "$PROJECT"' EXIT
cp -R "$FIXTURE_TEMPLATE/." "$PROJECT/"

# A 1x1 PNG, written here rather than committed so the fixture stays text-only.
# load_sprite loads it through the engine, so the project needs a real import.
base64 -d > "$PROJECT/icon.png" <<'EOF'
iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==
EOF
"$GODOT" --headless --path "$PROJECT" --import >/dev/null 2>&1

checks=0
failures=0
OUT=""
STATUS=0

init_godot_log headless-operations

run_op() {
  local operation="$1" params="$2"
  set +e
  OUT="$("$GODOT" --headless --path "$PROJECT" --script "$OPERATIONS_SCRIPT" "$operation" "$params" 2>&1)"
  STATUS=$?
  set -e
  append_godot_log "$OUT"
}

fail() {
  local label="$1" detail="$2"
  failures=$((failures + 1))
  echo "FAIL $label"
  echo "     $detail"
  echo "$OUT" | sed 's/^/     | /'
}

pass() {
  echo "  ok $1"
}

# Assert the last operation succeeded, and that its output contains each needle.
expect_ok() {
  local label="$1"
  shift
  checks=$((checks + 1))
  if [[ "$STATUS" -ne 0 ]]; then
    fail "$label" "expected exit 0, got $STATUS"
    return
  fi
  local needle
  for needle in "$@"; do
    if ! grep -qF -- "$needle" <<<"$OUT"; then
      fail "$label" "output is missing: $needle"
      return
    fi
  done
  pass "$label"
}

# Assert the last operation failed. A failing operation must exit non-zero:
# HeadlessOperationService reads the exit status to decide whether the MCP tool
# call succeeded, so an operation that reports an error and exits 0 is a bug.
expect_failure() {
  local label="$1" needle="${2:-}"
  checks=$((checks + 1))
  if [[ "$STATUS" -eq 0 ]]; then
    fail "$label" "expected a non-zero exit, got 0"
    return
  fi
  if [[ -n "$needle" ]] && ! grep -qF -- "$needle" <<<"$OUT"; then
    fail "$label" "output is missing: $needle"
    return
  fi
  pass "$label"
}

expect_file() {
  local label="$1" relative="$2"
  checks=$((checks + 1))
  if [[ ! -f "$PROJECT/$relative" ]]; then
    fail "$label" "expected the project to contain $relative"
    return
  fi
  pass "$label"
}

expect_no_file() {
  local label="$1" relative="$2"
  checks=$((checks + 1))
  if [[ -f "$PROJECT/$relative" ]]; then
    fail "$label" "expected $relative to be gone"
    return
  fi
  pass "$label"
}

# Assert a file in the project contains a string, which is how the scene-editing
# operations are checked for having actually persisted their change.
expect_in_file() {
  local label="$1" relative="$2" needle="$3"
  checks=$((checks + 1))
  if ! grep -qF -- "$needle" "$PROJECT/$relative" 2>/dev/null; then
    fail "$label" "$relative is missing: $needle"
    return
  fi
  pass "$label"
}

expect_not_in_file() {
  local label="$1" relative="$2" needle="$3"
  checks=$((checks + 1))
  if grep -qF -- "$needle" "$PROJECT/$relative" 2>/dev/null; then
    fail "$label" "$relative should not contain: $needle"
    return
  fi
  pass "$label"
}

# Assert the last operation left a file byte-for-byte unchanged. A failing
# scene edit must not rewrite the scene it was asked to edit.
expect_unchanged() {
  local label="$1" relative="$2" before="$3"
  checks=$((checks + 1))
  local after
  after="$(sha256sum "$PROJECT/$relative" | cut -d' ' -f1)"
  if [[ "$after" != "$before" ]]; then
    fail "$label" "$relative was rewritten"
    return
  fi
  pass "$label"
}

sha_of() {
  sha256sum "$PROJECT/$1" | cut -d' ' -f1
}

echo
echo "Scene operations"

run_op create_scene '{"scene_path":"scenes/main.tscn","root_node_type":"Node2D"}'
expect_ok "create_scene creates a Node2D scene" "Scene created successfully at: scenes/main.tscn"
expect_file "create_scene wrote the scene file" "scenes/main.tscn"

run_op add_node '{"scene_path":"scenes/main.tscn","parent_node_path":"root","node_type":"Sprite2D","node_name":"Player","properties":{"position":{"x":32,"y":48}}}'
expect_ok "add_node adds a Sprite2D" "Node 'Player' of type 'Sprite2D' added successfully"
expect_in_file "add_node persisted the node" "scenes/main.tscn" 'name="Player"'
expect_in_file "add_node persisted its properties" "scenes/main.tscn" "position = Vector2(32, 48)"

run_op load_sprite '{"scene_path":"scenes/main.tscn","node_path":"Player","texture_path":"icon.png"}'
expect_ok "load_sprite assigns a texture" "Sprite loaded successfully"
expect_in_file "load_sprite persisted the texture" "scenes/main.tscn" "texture ="

run_op modify_node '{"scene_path":"scenes/main.tscn","node_path":"Player","properties":{"position":{"x":10,"y":20},"visible":false}}'
expect_ok "modify_node updates properties" "Node modified successfully"
expect_in_file "modify_node persisted the change" "scenes/main.tscn" "position = Vector2(10, 20)"

run_op attach_script '{"scene_path":"scenes/main.tscn","node_path":"Player","script_path":"scripts/player.gd"}'
expect_ok "attach_script attaches a script" "attached successfully"
expect_in_file "attach_script persisted the script" "scenes/main.tscn" "scripts/player.gd"

run_op read_scene '{"scene_path":"scenes/main.tscn"}'
expect_ok "read_scene reports the tree" "SCENE_JSON_START" '"name":"Player"' '"type":"Sprite2D"' "SCENE_JSON_END"

run_op save_scene '{"scene_path":"scenes/main.tscn","new_path":"scenes/main_copy.tscn"}'
expect_ok "save_scene saves a copy to a new path" "Scene saved successfully"
expect_file "save_scene wrote the copy" "scenes/main_copy.tscn"

echo
echo "Scene structure operations"

run_op manage_scene_structure '{"scene_path":"scenes/main.tscn","action":"rename","node_path":"Player","new_name":"Hero"}'
expect_ok "manage_scene_structure renames a node" "Node renamed to 'Hero'"
expect_in_file "the rename persisted" "scenes/main.tscn" 'name="Hero"'

run_op manage_scene_structure '{"scene_path":"scenes/main.tscn","action":"duplicate","node_path":"Hero"}'
expect_ok "manage_scene_structure duplicates a node" "Node duplicated"

run_op add_node '{"scene_path":"scenes/main.tscn","parent_node_path":"root","node_type":"Node2D","node_name":"Container"}'
expect_ok "add_node adds a reparent target" "Node 'Container' of type 'Node2D' added successfully"

run_op manage_scene_structure '{"scene_path":"scenes/main.tscn","action":"move","node_path":"Hero","new_parent_path":"Container"}'
expect_ok "manage_scene_structure moves a node" "Node moved"
expect_in_file "the move persisted" "scenes/main.tscn" 'parent="Container"'

run_op remove_node '{"scene_path":"scenes/main.tscn","node_path":"Container/Hero"}'
expect_ok "remove_node removes a node" "Node 'Hero' removed successfully"
run_op read_scene '{"scene_path":"scenes/main.tscn"}'
checks=$((checks + 1))
if grep -qF '"name":"Hero"' <<<"$OUT"; then
  fail "remove_node dropped the node from the scene" "Hero is still in the tree"
else
  pass "remove_node dropped the node from the scene"
fi

echo
echo "Signal operations"

run_op manage_scene_signals '{"scene_path":"scenes/main.tscn","action":"list"}'
expect_ok "manage_scene_signals lists connections" "SIGNALS_JSON_START" '"connections":[]' "SIGNALS_JSON_END"

run_op manage_scene_signals '{"scene_path":"scenes/main.tscn","action":"add","signal_name":"visibility_changed","source_path":".","target_path":".","method":"_on_visibility_changed"}'
expect_ok "manage_scene_signals adds a connection" "Signal connection added"

run_op manage_scene_signals '{"scene_path":"scenes/main.tscn","action":"list"}'
expect_ok "the added connection is listed" "visibility_changed" "_on_visibility_changed"

run_op manage_scene_signals '{"scene_path":"scenes/main.tscn","action":"remove","signal_name":"visibility_changed"}'
expect_ok "manage_scene_signals removes a connection" "removed"

run_op manage_scene_signals '{"scene_path":"scenes/main.tscn","action":"list"}'
expect_ok "the removed connection is gone" '"connections":[]'

echo
echo "Scene edit invariants (regressions from 29bf0b2)"

# These are the end-to-end cases 29bf0b2 fixed by hand; they are kept here as
# permanent fixtures. They assert the two invariants the scene-editing
# operations rest on: an edited scene still reloads as a valid tree with its
# ownership intact, and a rejected edit never rewrites the file.

run_op create_scene '{"scene_path":"scenes/regress.tscn","root_node_type":"Node2D"}'
expect_ok "regression: a scene for the edit invariants" "Scene created successfully"

# TYPE_OBJECT properties: a res:// path given for an Object-typed property must
# be loaded and persisted as an ext_resource, not silently dropped.
run_op add_node '{"scene_path":"scenes/regress.tscn","parent_node_path":"root","node_type":"Sprite2D","node_name":"Enemy","properties":{"texture":"res://icon.png","modulate":{"r":1,"g":0,"b":0,"a":1}}}'
expect_ok "regression: add_node accepts a resource-valued property" "added successfully"
expect_in_file "regression: the resource property persisted as an ext_resource" \
  "scenes/regress.tscn" 'ext_resource type="Texture2D"'
expect_in_file "regression: add_node converted a non-resource property too" \
  "scenes/regress.tscn" "modulate = Color(1, 0, 0, 1)"

run_op add_node '{"scene_path":"scenes/regress.tscn","parent_node_path":"Enemy","node_type":"Node2D","node_name":"Weapon"}'
expect_ok "regression: a child to carry through the reparent" "added successfully"
run_op add_node '{"scene_path":"scenes/regress.tscn","parent_node_path":"root","node_type":"Node2D","node_name":"Enemies"}'
expect_ok "regression: a reparent target" "added successfully"

# duplicate must produce an addressable name (Enemy2), not the engine's
# auto-generated @Enemy@2, which no later operation could target.
run_op manage_scene_structure '{"scene_path":"scenes/regress.tscn","action":"duplicate","node_path":"Enemy"}'
expect_ok "regression: duplicate names the copy readably" "(as 'Enemy2')"
expect_not_in_file "regression: the copy has no auto-generated name" "scenes/regress.tscn" "@Enemy@"
expect_in_file "regression: the copy kept the original's children" "scenes/regress.tscn" 'parent="Enemy2"'

# move must carry descendants with the node and leave every path valid.
run_op manage_scene_structure '{"scene_path":"scenes/regress.tscn","action":"move","node_path":"Enemy","new_parent_path":"Enemies"}'
expect_ok "regression: move reparents the node" "Node moved"
expect_in_file "regression: the moved node sits under its new parent" \
  "scenes/regress.tscn" 'parent="Enemies"'
expect_in_file "regression: the descendant moved with it" \
  "scenes/regress.tscn" 'parent="Enemies/Enemy"'

# The scene must still load: read_scene instantiates the PackedScene, so a tree
# with broken ownership or dangling paths would not report back.
run_op read_scene '{"scene_path":"scenes/regress.tscn"}'
expect_ok "regression: the edited scene still reloads as a valid tree" \
  "SCENE_JSON_START" '"name":"Weapon"' '"name":"Enemy2"' "SCENE_JSON_END"

# A rejected edit must leave the scene byte-for-byte alone.
before_sha="$(sha_of scenes/regress.tscn)"
run_op manage_scene_structure '{"scene_path":"scenes/regress.tscn","action":"teleport","node_path":"Enemies/Enemy"}'
expect_failure "regression: an unknown structure action fails" "Allowed actions"
expect_unchanged "regression: the failed edit did not rewrite the scene" \
  "scenes/regress.tscn" "$before_sha"

run_op manage_scene_structure '{"scene_path":"scenes/regress.tscn","action":"move","node_path":"Ghost","new_parent_path":"Enemies"}'
expect_failure "regression: moving a missing node fails" "not found"
expect_unchanged "regression: the failed move did not rewrite the scene" \
  "scenes/regress.tscn" "$before_sha"

echo
echo "Resource operations"

run_op create_resource '{"resource_type":"BoxMesh","resource_path":"resources/box.tres","properties":{"size":{"x":2,"y":2,"z":2}}}'
expect_ok "create_resource creates a BoxMesh" "Resource created successfully"
expect_file "create_resource wrote the resource" "resources/box.tres"

run_op manage_resource '{"resource_path":"resources/box.tres","action":"read"}'
expect_ok "manage_resource reads a resource" "RESOURCE_JSON_START" '"type":"BoxMesh"' "RESOURCE_JSON_END"

run_op manage_resource '{"resource_path":"resources/box.tres","action":"modify","properties":{"size":{"x":4,"y":4,"z":4}}}'
expect_ok "manage_resource modifies a resource" "Resource modified"
expect_in_file "the modification persisted" "resources/box.tres" "size = Vector3(4, 4, 4)"

run_op manage_theme_resource '{"resource_path":"resources/ui.tres","action":"create"}'
expect_ok "manage_theme_resource creates a theme" "Theme created"
expect_file "manage_theme_resource wrote the theme" "resources/ui.tres"

run_op manage_theme_resource '{"resource_path":"resources/ui.tres","action":"read"}'
expect_ok "manage_theme_resource reads a theme" "THEME_JSON_START" '"type":"Theme"' "THEME_JSON_END"

run_op manage_theme_resource '{"resource_path":"resources/ui.tres","action":"modify","properties":{"default_font_size":24}}'
expect_ok "manage_theme_resource modifies a theme" "Theme modified"
expect_in_file "the theme modification persisted" "resources/ui.tres" "default_font_size = 24"

echo
echo "MeshLibrary export"

run_op create_scene '{"scene_path":"scenes/blocks.tscn","root_node_type":"Node3D"}'
expect_ok "create_scene creates a 3D scene" "Scene created successfully at: scenes/blocks.tscn"

run_op add_node '{"scene_path":"scenes/blocks.tscn","parent_node_path":"root","node_type":"MeshInstance3D","node_name":"Box","properties":{"mesh":"res://resources/box.tres"}}'
expect_ok "add_node adds a mesh instance" "Node 'Box' of type 'MeshInstance3D' added successfully"

run_op export_mesh_library '{"scene_path":"scenes/blocks.tscn","output_path":"resources/blocks.tres"}'
expect_ok "export_mesh_library exports the meshes" "MeshLibrary exported successfully with 1 items"
expect_file "export_mesh_library wrote the library" "resources/blocks.tres"

echo
echo "UID operations"

run_op get_uid '{"file_path":"scripts/player.gd"}'
expect_ok "get_uid reports a file's UID" '"file":"res://scripts/player.gd"' '"exists":'

run_op resave_resources '{}'
expect_ok "resave_resources resaves the project" "Resave operation complete"

run_op get_uid '{"file_path":"scripts/player.gd"}'
expect_ok "get_uid reports the UID generated by the resave" '"exists":true' '"uid":"uid://'

echo
echo "Failure handling"

run_op create_scene '{"scene_path":"scenes/main.tscn","root_node_type":"NotARealClass"}'
expect_failure "an uninstantiable root type fails" "NotARealClass"

run_op add_node '{"scene_path":"scenes/missing.tscn","parent_node_path":"root","node_type":"Node2D","node_name":"Orphan"}'
expect_failure "adding to a missing scene fails" "does not exist"

run_op modify_node '{"scene_path":"scenes/main.tscn","node_path":"NoSuchNode","properties":{"visible":false}}'
expect_failure "modifying a missing node fails" "Node not found"

run_op manage_resource '{"resource_path":"resources/box.tres","action":"explode"}'
expect_failure "an unknown action fails" "Allowed actions"

run_op not_an_operation '{}'
expect_failure "an unknown operation fails" "Unknown operation"

run_op create_scene 'not json'
expect_failure "malformed params JSON fails" "Failed to parse JSON parameters"

run_op create_scene '[1,2,3]'
expect_failure "a non-object params JSON fails" "Parameters must be a JSON object"

# The operations must not leave diagnostics probe files behind: --debug-godot is
# off by default, and a probe that does run is removed on every branch.
expect_no_file "no write probe is left in the project" "godot_mcp_test_write.tmp"
checks=$((checks + 1))
if compgen -G "$PROJECT/godot_mcp_write_probe_*.tmp" >/dev/null; then
  OUT=""
  fail "no debug write probe is left in the project" "a godot_mcp_write_probe_*.tmp file remains"
else
  pass "no debug write probe is left in the project"
fi

echo
if [[ "$failures" -gt 0 ]]; then
  echo "Headless operations: $failures of $checks checks failed"
  exit 1
fi
assert_clean_godot_log headless-operations
echo "Headless operations: $checks checks passed"
