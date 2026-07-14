#!/usr/bin/env bash
# H4 — run-completeness (Stop).
# Checks that every file in fetch-manifest.json has a non-null verdict.
# Surfaces quarantined-item count (degraded run visible, not hidden).
# Blocks ORC from stopping if verdicts are still missing (prevents partial-run confusion).
set -euo pipefail

# Find the most recent day folder with a fetch-manifest.json
manifest_path="$(ls -t data/*/fetch-manifest.json 2>/dev/null | head -1)"
if [ -z "$manifest_path" ]; then
  exit 0  # No manifest — nothing to validate
fi

day_root="$(dirname "$manifest_path")"
quarantine_dir="${day_root}/inputs/clean/_quarantine"

# Count quarantined items (always surface — even if 0)
quarantine_count=0
if [ -d "$quarantine_dir" ]; then
  quarantine_count=$(find "$quarantine_dir" -maxdepth 1 -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
fi

if [ "$quarantine_count" -gt 0 ]; then
  printf "H4 run-completeness: ⚠ %d item(s) quarantined in %s — run is degraded (not failed).\n" \
    "$quarantine_count" "$quarantine_dir" >&2
fi

# Verify all files[] have verdicts
missing=0
total=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  total=$((total + 1))
  if echo "$f" | grep -q '/tasks/'; then
    rpath="${f%.json}.reconcile-verdict.json"
    if [ ! -f "$rpath" ] || [ "$(jq -r '.truthful_signal // empty' "$rpath" 2>/dev/null)" = "" ]; then
      missing=$((missing + 1))
    fi
  else
    vpath="${f%.json}.verdict.json"
    if [ ! -f "$vpath" ] || [ "$(jq -r '.label // empty' "$vpath" 2>/dev/null)" = "" ]; then
      missing=$((missing + 1))
    fi
  fi
done < <(jq -r '.files[]' "$manifest_path" 2>/dev/null)

if [ "$missing" -gt 0 ]; then
  printf "H4 run-completeness: %d/%d item(s) still missing verdicts — complete all items before stopping.\n" \
    "$missing" "$total" >&2
  exit 2
fi

exit 0
