#!/usr/bin/env bash
# Single sequential, failure-isolated SessionEnd path.
#   Phase 1: observability finalize (best-effort, isolated).
#   Phase 2: next-unit launcher — MUST run even if Phase 1 failed.
# Replaces the previous two parallel SessionEnd hook groups (finalize || launcher) that raced.
# Terminalization stays idempotent: finalize.sh guards every terminal event with has_event.
set -u
umask 077
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
RUNTIME_ROOT="$PROJECT_ROOT/.runtime/casino"
OBS_ROOT="$RUNTIME_ROOT/observability"
LOG="$RUNTIME_ROOT/launcher.log"
mkdir -p -m 700 "$OBS_ROOT" 2>/dev/null || mkdir -p "$OBS_ROOT" 2>/dev/null || true

INPUT="$(head -c 20971520)"   # bounded read of the SessionEnd hook payload

# ---- Phase 1: observability (isolated; its failure never blocks the launcher) ----
TR="$PROJECT_ROOT/.claude/hooks/casino-observability.sh"
if [ -x "$TR" ]; then
  if ! printf '%s' "$INPUT" | "$TR" >/dev/null 2>>"$OBS_ROOT/errors.log"; then
    printf '%s\tsession_end_observability_failed\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date)" >> "$LOG" 2>/dev/null || true
  fi
fi

# ---- Phase 2: launcher continuity (runs regardless of Phase 1 outcome) ----
# Consume the spawn-next sentinel exactly once, then start the next isolated casino unit.
SENTINEL="$RUNTIME_ROOT/spawn-next"
if [ -f "$SENTINEL" ]; then
  rm -f "$SENTINEL" 2>/dev/null || true
  nohup env -u CLAUDECODE claude -p --agent casino-session --permission-mode acceptEdits "/casino-run-next" \
    >> "$LOG" 2>&1 </dev/null &
fi
exit 0
