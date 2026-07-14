---
name: casino-batch
description: Initialize and start end-to-end casino research batch; invocation session never researches a casino.
argument-hint: [casinos-to-research.json=./data/casino-partner-researches/casinos-to-research.json] [rubrics-dir=./data/rubrics] [output-dir=./data/casino-partner-researches]
disable-model-invocation: true
allowed-tools: Read Write Edit Glob Grep Bash
disallowed-tools: AskUserQuestion WebSearch WebFetch mcp__* Agent
---
INPUT `$1` default `./data/casino-partner-researches/casinos-to-research.json`; rubric dir `$2` default `./data/rubrics`; output dir `$3` default `./data/casino-partner-researches`. Per casino, write under `<output-dir>/<id>/` (matches existing `<casino>-<geo>` folders already in this hierarchy).
1. Validate input object: `version` + `casinos` array. Per item require `id`, `casino`, `url`, `geo` (rubric enum), boolean `registration`, `credentials_file` pointer, boolean `enabled`. Do not read credential contents. Skip `enabled:false` items but keep them in queue.
2. Validate rubric dir has exactly 12 authoritative categories listed in casino-core output contract. For each enabled casino, copy the 12 template files as-is into `<output-dir>/<id>/` (create dir if missing) — these copies become that casino's working output files; state-writer fills them in place.
3. If `.runtime/casino/batch-state.json` is active/incomplete, do not overwrite; use `/casino-resume`.
4. Write `.runtime/casino/batch-state.json`: schema/version, input/rubric/output absolute refs, queue ordered as input (`pending`), no secret values. Write `batch.active`; remove stale `batch.done`/`spawn-next`.
5. Start first fresh top-level session only; do no research here:
`nohup env -u CLAUDECODE claude -p --agent casino-session --permission-mode acceptEdits "/casino-run-next" >> "$CLAUDE_PROJECT_DIR/.runtime/casino/launcher.log" 2>&1 </dev/null &`
6. Return only batch initialized + paths.
