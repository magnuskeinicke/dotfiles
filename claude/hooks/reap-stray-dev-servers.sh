#!/usr/bin/env bash
# SessionEnd hook: tear down dev servers/containers this session's worktree
# brought up, so an interrupted verify / e2e / dev-loop run does not leak a
# `next dev` process (CPU/RAM) or a docker stack (ports) for hours.
#
# Scope: the CURRENT worktree only — never touches another worktree's stack.
# Trigger: REAL session exit only. `/clear` also fires SessionEnd but is not
# "leaving", so it is skipped (otherwise an active session loses its stack).
# Data safety: `docker rm -f` drops containers but keeps named volumes, so
# Postgres data survives; the stack rebuilds on the next `nx dev`.
#
# Reads the SessionEnd JSON payload on stdin: { reason, cwd, ... }.

set -uo pipefail

LOG="$HOME/.claude/hooks/reap-stray-dev-servers.log"
log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >>"$LOG" 2>/dev/null; }

input="$(cat)"
reason="$(printf '%s' "$input" | jq -r '.reason // "other"' 2>/dev/null)"
cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)"

# /clear is not a real exit — leave the active session's servers alone.
[ "$reason" = "clear" ] && exit 0
[ -n "$cwd" ] || exit 0

root="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)"
[ -n "$root" ] || exit 0
project="vtt-$(basename "$root")"

log "SessionEnd reason=$reason worktree=$root project=$project"

# 1) Reap orphaned e2e/verify next servers under THIS worktree.
#    `next dev --webpack --port` is the Playwright webServer signature — never
#    the interactive dev server (that is `nx dev`, a dynamic portless port).
for pid in $(pgrep -f 'next dev --webpack --port' 2>/dev/null); do
  pcwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  case "$pcwd" in
    "$root" | "$root"/*)
      kill "$pid" 2>/dev/null && log "killed next-dev pid=$pid cwd=$pcwd"
      ;;
  esac
done

# 2) Remove this worktree's docker containers (dev + e2e share the project name).
#    Match the exact container names — NOT a prefix: the main repo's project
#    `vtt-voice-to-text` is a prefix of worktree projects `vtt-voice-to-text-<branch>`,
#    so a prefix filter would reap other worktrees' stacks.
names=""
for svc in postgres postgres-e2e proxy mailhog; do
  names="$names --filter name=^${project}-${svc}\$"
done
# shellcheck disable=SC2086
ids="$(docker ps -aq $names 2>/dev/null)"
if [ -n "$ids" ]; then
  # shellcheck disable=SC2086
  docker rm -f $ids >/dev/null 2>&1 && log "removed containers: $(echo $ids | tr '\n' ' ')"
fi

exit 0
