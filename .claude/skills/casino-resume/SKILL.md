---
name: casino-resume
description: Restart an interrupted batch or apply human handoff resolutions from the last durable checkpoint.
argument-hint: [batch-state=.runtime/casino/batch-state.json]
disable-model-invocation: true
allowed-tools: Read Write Edit Glob Grep Bash
disallowed-tools: AskUserQuestion WebSearch WebFetch mcp__* Agent
---
1. Read batch-state and per-casino research-state/handoff. Do not read credential contents.
2. If any handoff item has a human `resolution` not yet applied, leave casino `in_progress`; next session chooses `human_resolution_apply`.
3. If a unit is `in_progress` without terminal checkpoint, restore it to `retry_pending` when transient and attempts<2; otherwise handoff. Preserve captures/patches; never redo completed units.
4. Clear stale `spawn-next`/`batch.done`; write `batch.active` if unfinished.
5. Start exactly one fresh session:
`nohup env -u CLAUDECODE claude -p --agent casino-session --permission-mode acceptEdits "/casino-run-next" >> "$CLAUDE_PROJECT_DIR/.runtime/casino/launcher.log" 2>&1 </dev/null &`
6. Return only resumed/not-needed. Hard process death cannot self-launch without an external supervisor; this command is the allowed recovery boundary.
