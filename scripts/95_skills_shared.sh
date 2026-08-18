#!/usr/bin/env bash
set -euo pipefail

# Sync the shared reviewer-registry block into each feature-dev workflow script.
# Workflow scripts must be self-contained (the Workflow runtime cannot import
# files), so the shared code lives once in claude/skills/_shared/ and is copied
# verbatim between the >>>/<<< markers in each target.
#
# Usage:
#   ./scripts/95_skills_shared.sh           # sync targets from _shared
#   ./scripts/95_skills_shared.sh --check   # exit 1 if any target drifted

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_DIR/claude/skills/_shared/reviewer-registry.js"
BEGIN='// >>> shared:reviewer-registry'
END='// <<< shared:reviewer-registry'
MODE="${1:-sync}"

TARGETS=(
  "$REPO_DIR/claude/skills/work-slice/work-slice-loop.workflow.js"
  "$REPO_DIR/claude/skills/solve-ready-tickets/solve-ready-loop.workflow.js"
)

test -f "$SRC" || { echo "missing $SRC"; exit 1; }

status=0
for target in "${TARGETS[@]}"; do
  test -f "$target" || { echo "missing target $target"; exit 1; }
  grep -qF "$BEGIN" "$target" || { echo "missing '$BEGIN' marker in $target"; exit 1; }
  grep -qF "$END" "$target" || { echo "missing '$END' marker in $target"; exit 1; }

  tmp="$(mktemp)"
  awk -v src="$SRC" -v begin="$BEGIN" -v end="$END" '
    index($0, begin) == 1 {
      print
      while ((getline line < src) > 0) print line
      close(src)
      skipping = 1
      next
    }
    index($0, end) == 1 { skipping = 0 }
    skipping { next }
    { print }
  ' "$target" >"$tmp"

  if [ "$MODE" = "--check" ]; then
    if ! diff -q "$target" "$tmp" >/dev/null; then
      echo "DRIFT: $target is out of sync with _shared/reviewer-registry.js (run: make skills-shared)"
      status=1
    fi
    rm -f "$tmp"
  else
    if ! diff -q "$target" "$tmp" >/dev/null; then
      mv "$tmp" "$target"
      echo "synced: $target"
    else
      rm -f "$tmp"
      echo "up-to-date: $target"
    fi
  fi
done

exit $status
