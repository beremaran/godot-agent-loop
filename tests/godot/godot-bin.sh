# Shared Godot binary resolution for the Godot-side test scripts. Sourced, not
# executed. Resolution order:
#   1. $GODOT_BIN
#   2. godot4 / godot on PATH
#   3. the first executable matching godot* inside $GODOT_PATH

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

require_godot() {
  local godot
  godot="$(resolve_godot)"
  if [[ -z "$godot" ]]; then
    echo "error: no Godot binary found; set GODOT_BIN or GODOT_PATH" >&2
    exit 1
  fi
  echo "$godot"
}
