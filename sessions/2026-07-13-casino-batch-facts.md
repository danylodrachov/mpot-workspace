---
title: Casino batch run — slotoro-norway auth hang
date: 2026-07-13
type: session-facts
---

## Worked

- Started casino-batch for 6 Norway casinos (slotoro, lolajack, mafiacasino, azurslot, sportuna, 7signs); coverage_plan for slotoro-norway completed in ~13 min, producing a 66-unit frontier.
- Ran casino-resume after the batch-active session hit the weekly limit: found `slotoro-norway` mid-research (surface-browser had completed the `entry-homepage` capture — screenshots + DOM manifest on disk — but state-writer never merged it into `research-state.json`/`casinos.json` before the process died). Restored the `auth-login` frontier item from `handoff` to `retry_pending` (attempts=1<2, reason judged transient/tool-permission, not site-side) and top-level `auth.status` back to `pending`, bumped checkpoint to seq 3, marked the casino `in_progress` in `batch-state.json`, relaunched casino-session (pid 32202).
- Confirmed `data/casino-partner-researches/{lolajack,mafiacasino}-norway`'s pre-existing manual capture folders (html/pdf/screenshots from before issue 08) have no `rows` key in their 12 rubric json files yet — casino-batch's template-recopy step is safe/idempotent there, no manual research data at risk.

## Failed

- casino-session (pid 18706) produced zero progress on the `auth-browser` subagent call for slotoro-norway for 6+ minutes: the `@playwright/mcp` server process spawned (npm exec + node child) but no `chromium`/`headless_shell` browser process ever appeared, `research-state.json` checkpoint stayed at `next_unit: auth`, process tree at 0% CPU. Killed and relaunched (pid 24502) with the same command.
- Same silent-hang symptom recurred on pid 36138 for the `surface-browser` subagent (`entry-footer-link-inventory` unit), ~5-6 min after the fix that resolved the auth-browser case: `npm exec @playwright/mcp` + node child spawned, 0% CPU, no Chrome process ever appeared, no lock file in `~/Library/Caches/ms-playwright-mcp/mcp-chrome-a964f63` — the `mcp__playwright__*` permission fix did not prevent this occurrence, so the hang is intermittent/not fully explained by the earlier root cause. Killed the tree (pid 36138/36167/36192) and relaunched (pid 38294); checkpoint (seq 5, `entry-homepage` completed, `next_unit: entry-footer-link-inventory`) was unaffected by the kill.
- Root cause found after the second run (pid 24502) self-resolved in ~4 min and wrote a `blocked_auth` handoff: `--permission-mode acceptEdits` does not grant `mcp__playwright__*` MCP tool calls (it only auto-approves file edits), so every `browser_navigate`/`browser_snapshot` call was rejected before any navigation occurred. `auth-browser` correctly reported this as `blocked_auth` per the casino-research handoff rule rather than retrying indefinitely — the first run's 6-minute silence was this same rejection loop, just slower to conclude.
- Confirmed the post-permission-fix run (pid 26797) did not auto-retry `auth-login`: it left the `blocked_auth` handoff open and moved on to `entry-homepage` per `checkpoint.next_unit`, then hit the weekly limit mid-unit — the entry-homepage capture completed on disk but its state-writer merge never ran/committed.
- `research-state.json` checkpoint lags real browser progress: mid-unit, a live screenshot showed slotoro1.bet in an authenticated state (balance/deposit/inbox/gift icons) several minutes before the checkpoint file updated to reflect it — polling the checkpoint alone during an active unit undercounts progress by that lag.

## Decided

- Added `"mcp__playwright__*"` to `permissions.allow` in `.claude/settings.json` (project-level, checked in) so headless `--permission-mode acceptEdits` batch runs can call Playwright MCP tools without a prompt. Chosen over switching the 3 launch sites (`casino-batch`, `casino-resume`, the `SessionEnd` spawn-next hook) to `bypassPermissions`, to keep the narrower per-tool allowlist rather than a blanket permission bypass.
- On a stuck/silent casino-session, kill the full process tree (parent `claude -p` pid + npm exec + node playwright-mcp child) and relaunch via the same `nohup ... claude -p --agent casino-session ... "/casino-run-next"` command rather than resetting batch-state; the per-casino checkpoint in `research-state.json` survives the kill and resumes from there instead of redoing completed units.

## Verified external facts

- The `mcp__playwright__*` fix worked: after the third relaunch (pid 26797, 16:18), Playwright MCP spawned a real headful Google Chrome process (`--user-data-dir=~/Library/Caches/ms-playwright-mcp/mcp-chrome-a964f63`, `--remote-debugging-pipe`) and navigated to `slotoro1.bet/en`, confirmed via user screenshot at 16:23. Playwright MCP automates the installed Google Chrome, not a bundled headless Chromium/headless_shell binary — `ps` greps for `chromium|headless_shell` miss it; grep for `ms-playwright-mcp` or the `Google Chrome` process with `--remote-debugging-pipe` instead.

## Open defects

- `claude -p` piped through `nohup` gives no streaming visibility into subagent/tool progress — `launcher.log` stays empty until final result. The only way to check liveness during a run is polling `research-state.json` checkpoint mtime + `ps` for the `ms-playwright-mcp` Chrome process.
- The `npm exec @playwright/mcp` silent-hang (server + node child spawn, 0% CPU, no browser process, no checkpoint progress) is intermittent and not fully root-caused — it recurred once after the `mcp__playwright__*` permission fix, on a different subagent (`surface-browser` vs `auth-browser`). No fix beyond kill-tree-and-relaunch exists yet; each recurrence costs one full unit's wall-clock time undetected until manually checked.
- slotoro-norway's `entry-homepage` frontier item is still `status: pending` despite a completed `work/entry-homepage/capture-manifest.json` on disk (surface-browser ran, snapshot-extractor/state-writer never did) — casino-resume left it untouched since the state-contract has no "captured, pending extraction" status and per casino-session's design a "surface" unit is atomic (browse+extract+patch in one shot), so the next time this unit is selected it will re-run surface-browser rather than resuming from the existing manifest.

- Added `"Write(.claude/runtime/spawn-next)"` and `"Write(.claude/runtime/batch.done)"` to `permissions.allow` in `.claude/settings.json` — these sentinel writes were being gated as "sensitive file" prompts even under `--permission-mode acceptEdits`, forcing a manual approval every session-end before the batch could self-continue. User confirmed no per-run approval is needed going forward.

## Decided (update)

- The retry_pending `auth-login` restored via casino-resume was resolved by pid 32202 (attempt 2 of 2): authenticated login succeeded on the official site with no CAPTCHA/2FA/handoff, confirmed both by user screenshot and by `research-state.json` (`auth.status: completed`, checkpoint seq 4, `next_unit: entry-homepage`) — the transient-blocker judgment from casino-resume was correct. `handoff.json`'s open `blocked_auth` item is now superseded by this outcome, closing that prior open defect.
- Ran `/casino-resume` a second time (16:44): no restore needed (checkpoint already terminal, `handoff.json` already `status: resolved` with a `superseded` resolution note, no stale sentinels) — launched fresh casino-session pid 36138 for the `entry-homepage` unit, still in progress as of 16:47.
