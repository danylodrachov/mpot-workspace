---
title: Weekly summary — facts only
week: 2026-W27
dates: 2026-07-02..2026-07-05
sources:
  - 2026-07-02-solution-audit-results.md
  - 2026-07-03-registry-design-facts.md
  - 2026-07-05-live-test-findings.md
type: session-facts
---

# Weekly Summary 2026-W27 — Compressed Facts

## Approaches that WORKED — results

- **Direct tool-less model calls (`cliLlmCaller`, subscription `claude -p`)** replaced spawned sessions: 168 input tokens/call vs 18,640 plain session (~110× cheaper). 7 live letters judged+drafted in 121 s, one call each.
- **Registry + freshness filter (message-keyed, status-compared)**: immediate re-run after production kept 0 items, 0 model calls — resume/skip proven live. Status-compare (not date_updated) immune to ClickUp bot-reminder noise.
- **Synthesized reply.io key `thread_id + lastActivityDate`**: works around missing per-message ids; new activity = new key, verified against raw blob.
- **Flat-JSON output contract for write-only prompts** (`{ "draft": "..." }`, `tools: none`): re-run produced a real English follow-up chasing only uncovered points — fixed the silently-null draft.
- **`stripNoise()` body cleaner**: 67× nbsp/BOM/emoji/smart-punct → 0 noise chars post-clean; accents + € intact; unsubscribe footers + tracking images stripped on 7/7 live threads, quote chains kept.
- **Full production e2e (`run-okb-e2e.sh 2026-07-05`)**: exit 0, ~2.5 min, 7/7 verdicts fully filled, registry created with exactly 7 keys, spot-checks match actual letter content (todoboda 180 €, infogate pricing ask).
- **Crash-recovery order "work first, registry write after"**: at-least-once; unwritten registry on crash = safe duplicate work, never lost mail.
- **Manual `task_id` mapping by operator** (decision, not code): avoids broken domain-matching (cards carry media domain, no contact email, personal mailboxes).

## Approaches that FAILED — why

- **Parent-session-per-step spawner (`realSpawner`)**: full top-tier Claude Code session booted per one-sentence delegation, ~100k+ tokens/letter, ~54+ boots for Tier 1 on one day; spawn exiting 0 without writing its field was silent, later tiers ran anyway. Deleted.
- **Whole pipeline on 2026-06-25 produced nothing actionable**: labels filled but 0 reasoning, 0 drafts, 0 reconcile-verdicts, plan said "0 cards" — Tier-2 failure invisible to the pipeline, caught only by operator eyes.
- **Freshness gate ADR 0034 (join-map)**: designed, never wired — join-map.json absent, `gate()` uncalled, module orphaned. Result: same ~50 unread gmail threads re-fetched + re-classified daily, cost never shrank.
- **File-writing contract in write-only prompt** (`messaging-write-outreach.md` "write the file back"): tool-less model echoed the whole envelope, code read `parsed['draft']` → undefined → draft silently null. Follow-up + redo paths could never draft with a real model; fake test callers masked it until first live call.
- **Prompt without business context**: agent didn't know casino/iGaming niche → interrogated an existing customer as cold prospect, chased outlets that exclude the niche, marked topics "covered" without casino confirmation. 4/7 verdicts rejected by operator; fixed with business-context block + gating casino question + Close/Existing-partner modes.
- **Gmail fetch spec churn**: rewritten 3× in 3 commits (brace-OR → 3-day window → no window); locked #49 test re-locked twice — spec instability forced test+impl redone each time.
- **Local ralph loop over `issues/`**: 14 issue files gone, only README left → loop finds zero issues, prints COMPLETE immediately; numbering diverged from git (00–13 vs issue-49..89).
- **Automated card↔letter matching**: killed before build — OKB card names carry media domain, no contact email on cards, personal-mailbox donors break domain match; ambiguity left to human.
- **Still failing (open)**: caller exception crashes the process raw (bypasses `[fail]` line + no-crash guard contracts, invisible on operator surface); e2e filter trims raw fetch in place, audit copy lost.

## 2026-07-02 — Solution audit (data/2026-06-25 run)

- 63 files in fetch-manifest: ~50 gmail threads, 4 reply.io, 9 clickup tasks. All 50 gmail labels filled (32 content / 13 outreach / 5 other); 0/45 thread `reasoning`, 0 `draft`, 0/9 task `reasoning`, 0 reconcile-verdicts, daily-plan "Cards requiring action (0)". Tier-2 failure noticed only manually (operator note in a verdict); pipeline never halted or flagged.
- Freshness gate designed (ADR 0034) but not wired: `data/join-map.json` absent; no run-path code calls `gate()`; `src/pipeline/join-map.ts` orphaned. Gmail fetch = `is:unread in:inbox`, no window, read-only → same ~50 threads re-fetched + re-split with null verdicts every day; Tier-1 spawns repeat daily, cost never shrinks.
- Spawn model: `realSpawner` boots a full top-tier Claude Code parent session per pipeline step just to delegate one sentence to a subagent; up to 3 spawns per thread; ~54+ parent boots for Tier 1 alone on 2026-06-25. Spawn exiting 0 without writing its field is silent; later tiers spawn anyway. Spawner failure rejects whole run (Promise.all).
- Duplicates: `src/clickup/fetch.ts` writes `data/<date>/clickup tasks/` that spine never reads (spine reads `outputs/tasks/`); `bin/run-messaging-flow.sh` reads legacy flat `emails/` layout — two spawn flows, same data, different layouts/settings. `src/lib/machine-mail.ts` has no caller.
- Ralph: `issues/` holds only README.md, the 14 linked issue files (00–13) gone → local loop prints COMPLETE immediately. Numbering diverged (README 00–13 vs git issue-49..61, branch ralph/issue-89); two ralph variants. README status self-contradictory (#02 blocked, dependents done). Gmail fetch rewritten 3× in 3 commits, locked #49 test re-locked twice.
- No per-run budget, spawn cap, or token accounting anywhere (ADR 0035 "costs nothing on subscription").

## 2026-07-03 — Registry & freshness filter design (decided)

- Registry = only cross-day memory of "already handled" + only store of message→card linkage. One flat JSON (`data/registry.json`) outside day folders; sole writer = Orchestrator; work first, registry write after (at-least-once; duplicate work over lost mail).
- Key = always a message, never thread/card/comment. Gmail: native message id. reply.io: no per-message id in raw blob (verified; one record per thread, latest body only) → key synthesized `thread_id + lastActivityDate`; new activity = new key. ClickUp never a key — cards are reactive, values only.
- Entry fields, fixed order: `thread_id`, `task_id`, `clickup_status`, `file`, `verdict`, `redo_draft`. `task_id` backfilled MANUALLY by operator (decision: no automated card matching / find-or-create; OKB card names carry media domain, no contact email, personal-mailbox donors break domain match). `clickup_status` = card lane at processing time (board-change detector). `file`/`verdict` = repo-relative paths to cleaned copy + sidecar (day-scoped, registry global — only road back; model never reads raw); null for parked gmail stubs. `redo_draft` true|null|false.
- Filter (wired before `clean()`; raw fetch stays full audit copy): 1) key absent → process; 2) `redo_draft:true` → pass, re-run write pass only; 3) card status ≠ recorded → verdict reset (archived), reprocess — catches manual board moves; 4) else sifted out. Status-compare (not date_updated) makes filter immune to ClickUp bot-reminder timestamp noise.
- Draft rejection (case 9): no re-classify/re-context. Gate archives draft→`AI_feedback`, comment→`user_feedback`, nulls only `draft`. Immediate: re-spawn write pass with feedback, cap 2 attempts then handback. Deferred: `redo_draft:true`, next run carries prior label+reasoning, write pass only, flips false on new draft.
- Verdict reset: new external event or status mismatch → reset+archive. Crash-incomplete verdict (no registry key) → kept as resume point, only null fields re-run.
- Agent economy: "subagent" = DIRECT tool-less model call (code inlines cleaned file into prompt, model returns JSON fields, code writes). New letter = ONE merged read+write call (`tc_covered`, `payment_terms`, `reasoning`, `draft`); redo/follow-up = one write-only call returning only `draft`. Prompts in `.claude/agents/*.md`, model pinned in frontmatter. `realSpawner` double-session deleted.
- Cleaned reply.io file = the ONLY agent input. Keep top-level: id, lastActivityDate, subject, sequence, category, contact {name,email,company,title}; per message: date, from, isOutbound (derived from own-domain config), body, attachment names. Body: HTML→text, tracking/signature images + unsubscribe footer stripped, quoted chain KEPT (only place history lives). Everything else dropped.

## 2026-07-05 — Live test, production run, prompt fixes

- No ANTHROPIC_API_KEY — subscription caller. `cliLlmCaller` (`src/llm/call.ts`): single-shot tool-less `claude -p`, `--system-prompt`, `--disallowedTools "*"`, `--exclude-dynamic-system-prompt-sections`, stdin content, cwd=tmpdir (no CLAUDE.md leak). Overhead 168 input tokens/call vs 18,640 plain session (~110×). `defaultLlmCaller` prefers API key if present, else CLI; wired into spine, run-orc, run-okb-e2e.
- Real defect fixed: write-only draft silently null. `messaging-write-outreach.md` still had file-writing contract → real model echoed whole envelope → `parsed['draft']` undefined → `draft: null`. Follow-ups (issue 06) + redo (issue 07) could NEVER draft with a real model; fake test callers masked it. Fix: `tools: none` frontmatter, input as one JSON message, output = flat `{ "draft": "..." }`. Lesson: write-only prompts feeding direct callers must demand flat JSON.
- Live e2e (scratch): 7 real reply.io threads, full path, 7 model calls, 121 s, all verdicts filled; trecebits.com payment_terms extracted correctly. Immediate re-run: 0 kept, 0 calls — resume skip works live. Body hygiene: 6/7 unsubscribe footers + 1 tracking image stripped, quotes kept.
- First production run (repo root, `bin/run-okb-e2e.sh 2026-07-05`, exit 0, ~2.5 min): 7 fetched → 7 kept (empty registry) → 7 cleaned → 7 split+seeds → 7 clickup stubs (no mappings) → 7 judged+drafted → 7 verdicts full. `data/registry.json` created, exactly 7 keys, all task_id/clickup_status null. Spot-checks match letters (todoboda 180 €/publication, infogate asks pricing+dofollow). Re-run today keeps 0. Operator next: map task_ids by hand; drafts await approval gate (issue 07).
- Operator feedback (4/7 verdicts), one root cause: prompt had zero business context — didn't know Marketing Pot places casino/iGaming. infogate = existing customer interrogated like cold prospect; todoboda (weddings-only) + antojoentucocina ("no casino/crypto/CBD") chased instead of thank+close; cenasdecinema marked topics "covered" without casino confirmation. Fix: business-context block in `messaging-okb-letter.md` + `messaging-write-outreach.md`; casino acceptance = GATING Defined Question (true only on explicit confirmation; refusal/exclusive niche kills deal; unmentioned → first question). New draft modes: C Close (refused → thank+close, reasoning `CLOSED:`), D Existing partner, then A chase (casino first), B invoice.
- Cleaner: `\n` in JSON = legit newline encoding, kept. Real noise measured (67× nbsp, BOM, narrow nbsp, emoji, smart punctuation) → new `stripNoise()` in `src/lib/body-normalize.ts`, wired into gmail/clickup normalize + reply.io clean (had no noise pass). Verified: 0 noise chars post-clean, accents + € intact; tests 115/116 (pre-existing gmail failure).
- Note: 2026-07-05 verdicts predate prompt fixes; next fresh day exercises new rules.
- Open defects (documented, unfixed): caller exception = raw process crash (bypasses `[fail]` line + no-crash guard contracts, no daily-plan flag; registry unwritten = safe but invisible); `run-okb-e2e.ts` trims raw replyio.json in place without `replyio.full.json` audit copy (unlike run-orc).
- Still needs human: issue 07 live Telegram approve+reject; issue 10 steps 5–6 (verdict review + fetch-count cross-check vs reply.io UI, expected 7).
