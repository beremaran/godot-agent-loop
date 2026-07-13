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

# --- Godot output gating -----------------------------------------------------
# Unexpected engine diagnostics are test failures: every suite appends the raw
# Godot output it captures to a suite log, and asserts the log clean before
# reporting success. A diagnostic may only be tolerated through an entry in
# allowed-godot-output.tsv, and only with both a reason and an issue/test
# reference, owner, and expiry; anything else fails the suite even when every
# check passed.

GODOT_DIAGNOSTIC_PATTERN='^(ERROR|SCRIPT ERROR|WARNING):|Leaked instance|ObjectDB instances? .*leaked|leaked at exit|Segmentation fault|handle_crash|=== debug print'

init_godot_log() {
  local suite="$1"
  local log_dir
  log_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/logs"
  mkdir -p "$log_dir"
  GODOT_SUITE_LOG="$log_dir/$suite.log"
  : > "$GODOT_SUITE_LOG"
  export GODOT_SUITE_LOG
}

append_godot_log() {
  printf '%s\n' "$1" >> "$GODOT_SUITE_LOG"
}

assert_clean_godot_log() {
  local suite="$1"
  local allowlist
  allowlist="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/allowed-godot-output.tsv"
  local offenders
  offenders="$(grep -E "$GODOT_DIAGNOSTIC_PATTERN" "$GODOT_SUITE_LOG" || true)"
  [[ -z "$offenders" ]] && return 0

  local unexpected=""
  local line allowed entry_suite entry_pattern entry_reason entry_issue entry_owner entry_expiry
  while IFS= read -r line; do
    allowed=0
    while IFS=$'\t' read -r entry_suite entry_pattern entry_reason entry_issue entry_owner entry_expiry; do
      [[ -z "$entry_suite" || "$entry_suite" == \#* ]] && continue
      [[ "$entry_suite" != "$suite" && "$entry_suite" != "*" ]] && continue
      # Every suppression must be accountable and temporary. Expired or
      # incomplete entries deliberately stop suppressing the diagnostic.
      [[ -z "$entry_reason" || -z "$entry_issue" || -z "$entry_owner" ]] && continue
      [[ ! "$entry_expiry" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] && continue
      [[ "$entry_expiry" < "$(date -u +%F)" ]] && continue
      if [[ "$line" =~ $entry_pattern ]]; then
        allowed=1
        break
      fi
    done < "$allowlist"
    if [[ "$allowed" -eq 0 ]]; then
      unexpected+="$line"$'\n'
    fi
  done <<< "$offenders"

  if [[ -n "$unexpected" ]]; then
    echo "error: unexpected Godot diagnostics in the $suite suite:" >&2
    printf '%s' "$unexpected" | sed 's/^/  | /' >&2
    echo "Godot ERROR/WARNING/leak output fails the suite. If a diagnostic is" >&2
    echo "genuinely expected, add a line to tests/godot/allowed-godot-output.tsv" >&2
    echo "with suite, pattern, reason, issue/test, owner, and future expiry." >&2
    return 1
  fi
}
