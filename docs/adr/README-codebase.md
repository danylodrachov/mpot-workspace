# Codebase Navigation — `src/` & `bin/`

AFK agent. Node/TS, ESM, `.ts` run direct via `tsx`/node loader. Tests `node --test`. Two boards: **OKB** = outreach (revenue), **CKB** = content. Pipeline: **fetch → freshness filter (registry) → clean (machine-mail gate) → split → spine (reasoning wave → reconcile → resolve → plan) → follow-up sweep**. Deterministic code does I/O + state-machine tables; reasoning is model calls only — OKB letters via ONE direct tool-less call per letter (`src/llm/call.ts`), gmail threads + ClickUp tasks via spawned `claude -p` subagents. Gmail is live (unparked 2026-07-07): a thread with ≥1 unseen message id flows clean → split → classify/READ/WRITE; fully-seen threads sift.

## Cross-day state
- `data/registry.json` — flat map, key = always a message (`gmail:<msgId>` / `replyio:<threadId>:<lastActivityDate>`). Entry: thread_id, task_id, clickup_status, file/verdict pointers, redo_draft. Sole writer = orchestrator; atomic tmp+rename. Card linkage is **manual**: task_id only ever comes from a prior operator-written entry — never matched/created by code.

## Day-folder layout (`data/<date>/`)
- `inputs/raw/<source>.json` — one blob per source (gmail|replyio|clickup), fetch-not-extract. After the filter, `run-orc` archives the full fetch to `<source>.full.json` and trims `<source>.json` to the admitted subset.
- `inputs/clean/<source>.json` — zod-validated; `inputs/clean/_quarantine/<id>.json` for parse failures + machine mail + blocked senders.
- `outputs/emails/<gmail|replyio>/<id>.json` + `<id>.verdict.json` sidecar.
- `outputs/tasks/<id>.json` + `<id>.verdict.json` + `<id>.reconcile-verdict.json`.
- `daily-plan.md`, `approval.json`. No manifest file — spine scans `outputs/` directly (issue #04).

## Entry points (`bin/`)
- `run-day.sh` — full run: build-day → fetch-to-day → run-orc. Aborts if 0 raw files.
- `build-day.sh` — idempotent `mkdir -p` day tree; never deletes.
- `check-day.sh` — presence check of inputs/outputs subdirs (`npm run day:check`).
- `run-orc.ts` — `runOrcOnce`: load registry → freshness filter (gmail + replyio) → archive/trim raw → admit redo material (copies prior-day file/verdict in, nulls draft) → clean → split → `runSpine` → recordProcessed/recordProcessedGmail/finalizeRedo (registry write AFTER processing, at-least-once; quarantined gmail threads recorded with null pointers so they sift next run) → `runFollowupSweep` → save registry. Degraded spine → exit 1. `realSpawner` = `claude -p <prompt> --settings orc.settings.json`.
- `run-okb-e2e.sh` / `run-okb-e2e.ts` — OKB-only e2e sequencer (fetch replyio → filter → clean → split → agents → verdicts), one `[done]/[fail]/[stub]` line per stage, stops at first fail. ClickUp fully stubbed. `OKB_E2E_FIXTURE=1` = offline (tracer fixtures + canned caller).
- `check-labels.ts` — regression checker: blob `label`+`topics` vs `email-testing-table.json` (`npm run labels:check`; reads legacy `data/<date>/emails/`).

## Ingest (`src/ingest/fetch-to-day.ts`)
`fetchToRaw(root, fetchers)` — calls gmail/replyio/clickup fetchers, writes one blob per source to `inputs/raw/`. Each source independent (`tryEach` swallows failures). Guarded by `import.meta.url` so importing doesn't fire live fetches. ClickUp branch reads `clickup.config.json` + `{outreach,content}.statuses.json`, 3-day updated window.

## Sources
**Gmail** (`src/gmail/`) — READ-ONLY (`gmail.readonly`).
- `auth.ts` — one-time OAuth → `.tokens/gmail.json` refresh token (`npm run gmail:auth`).
- `client.ts` — builds authed client from saved token.
- `fetch.ts` — `fetchRecent()`: ONE `threads.list` page (q=`is:unread in:inbox`, maxResults=50) → `threads.get format:full` per thread. Messages oldest→newest, `isOutbound`=SENT label, attachments meta, full lowercased `headers` map (feeds machine-mail gate). 15s timeout. Date-independent (`refDate` kept for compat only).
- `parse.ts` — `extractText`/`extractAttachments` via `gmail-api-parse-message`; textPlain preferred, HTML fallback `stripHtml`.

**Reply.io** (`src/replyio/`) — sole OUTBOUND path for both boards; inbound read-only.
- `fetch.ts` — `fetchUnreadReplies()`: POST `/v3/inbox/threads/filter` (source:inbox, from=refDate−2d, paged) → GET `/threads/{id}/messages` drill-in for newest inbound body (falls back to bodyPreview). One `ReplyItem` per thread; carries contact + `raw` (incl. `raw.sequence.name`). Idempotency key = id+lastActivityDate. Injectable `fetcher`, 20s timeout, p-limit(6).
- `outbound.ts` — `enrolContact()` via POST `/sequences/{id}/contact-links/bulk`. Ops enrol / re_enrol (removeFromExisting+startStepId). `LOOP_GUARD_MAX=2` per step. Returns enrolled|loop_guard|already_in_sequence. (No production caller yet.)

**ClickUp** (`src/clickup/`) — GET-only, never moves cards.
- `fetch.ts` — `fetchTasks()`: paged filtered-team-task (assignees/statuses/updated-window/lists), short page = last page. `boardOf()` maps list/folder name → outreach|content; unknown board dropped (never guessed). `fetchAllComments()` pages top-level + threaded replies, deduped, oldest-first. 429 honors Retry-After. Returns items — writing is fetch-to-day's blob.
- `prune.ts` — `pruneItems()`: promotes description/tags/importance, slims comment users, content-board trims comments before first `@Danylo Drachov`. **Unwired** (test-only).
- Config: `clickup.config.json` (teamId/assigneeId/lists), `outreach.statuses.json`, `content.statuses.json`.

## LLM callers (`src/llm/call.ts`)
Direct model call = plain single-shot request, agent `.md` body as system prompt, cleaned content inlined as user turn, **no tools field** — the model can't touch the filesystem; code parses the JSON reply and writes verdict fields. `loadAgentPrompt` (frontmatter `model:` short name → pinned id), `parseModelJson` (tolerates ```json fence). `realLlmCaller` = Anthropic Messages API over fetch (needs ANTHROPIC_API_KEY); `cliLlmCaller` = same request through the logged-in `claude` CLI (`-p --system-prompt --disallowedTools "*" --exclude-dynamic-system-prompt-sections`, cwd=tmpdir); `defaultLlmCaller` = API when key set, else CLI. `LlmCaller` injectable everywhere for tests.

## Pipeline (`src/pipeline/`)
- `registry.ts` — load/save/messageKey/has/record for `data/registry.json` (see Cross-day state).
- `filter.ts` — freshness filter, runs BEFORE clean. `applyGmailFilter`: thread with ≥1 unseen message key → process, fully-seen → sift; recording deferred to run-orc (post-processing). `applyFreshnessFilter` (replyio): new → process; redo_draft:true → re-admit from registry pointers (scan registry, not today's fetch); linked card status ≠ recorded → process; else sift.
- `clean/index.ts` — `clean()`: raw → blocked-senders gate (`clean/blocked-senders.json`, operator-edited list; newest inbound sender address, exact case-insensitive → quarantine reason `blocked-sender`) → machine-mail gate (`isInboundMachineMail`, newest inbound msg headers/from/subject only) → per-source cleaner → `inputs/clean/<source>.json`; failures quarantined + flagged (never aborts source).
- `clean/{gmail,replyio,clickup}.ts` — map raw → `CleanThread`/`CleanTask` via `normalizeBody`.
- `clean/schema.ts` — zod `CleanThread` (id, subject, sequence, lastActivityDate, category, contact, messages[]) / `CleanTask` (id, name, board, status, body).
- `split.ts` — `split()`: clean blobs → one file + verdict-template sidecar per thread/task under `outputs/` (sidecar write-if-absent = resume-safe). `resolveMedia()` derives outlet (replyio contact company/domain → from-domain → subject token → first URL host; freemail excluded). Thread template seeds source/thread_id/sequence/media, nulls label/tc_covered/decision_data/reasoning/draft.
- `followups.ts` — issue #06 sweep, runs AFTER the new-letter wave. `selectFollowups`: pure, zero model calls — newest registry key per replyio thread; qualifies if verdict exists, tc_covered judged-but-incomplete, draft null, ≥2 days since lastActivityDate. `runFollowupSweep`: one write-only call per candidate (`messaging-write-outreach.md`, `who_wrote_last` passed), draft written onto the thread's OWN (possibly prior-day) verdict.

## Orchestrator spine (`src/orchestrator/`)
- `spine.ts` — `runSpine(dayRoot, spawner, concurrency=4, gateFn?, caller?, taskIdForThread?, ceiling?)`. Scans `outputs/` for worklist (no manifest). p-limit fan-out:
  - **OKB (replyio)**: no classify tier — `label:"outreach"` set deterministically. New letter (reasoning null) → ONE merged direct call (`messaging-okb-letter.md`) fills tc_covered + payment_terms + reasoning + draft; redo/follow-up (reasoning set, draft null) → write-only call; draft set → skip. Operator-mapped card content inlined when present in `outputs/tasks/`.
  - **Gmail threads**: spawn classify → read → write. **Tasks**: spawn clickup-subagent.
  - Safeguards (issue #08): model-call budget on the caller (default 40, `MODEL_CALL_BUDGET` env / ceiling arg) and empty-tier stop (wave attempted ≥1, filled 0 → retry once → halt). Either → `degraded:true`, flags, no later tiers; `modelCallCount` always reported.
  - **T3**: reconciler spawn per task (skip if truthful_signal set) → executor `resolve` per card → `focusSort` → `writeDailyPlan`. If `gateFn`: approval.json; on approve, `applyDryRun` per card. run-orc passes no gateFn — gate currently unwired from the run.
- `executor/types.ts` — Board, OkbLane/CkbLane, signals, `ReconcileVerdict`, `Action` union (lane_move | comment | replyio | flag_operator). Tables from ADR 0037 (OKB) / 0038 (CKB).
- `executor/resolve.ts` — **pure** `(lane, signals) → Action[]`, no I/O. Null gating signal → `flag_operator` (halt-never-guess). Blocked → flag. Lanes: Negotiation/Invoice Request/To Pay (OKB), To Submit/Publication/Publication Revision (CKB).
- `executor/effects.ts` — `renderIntent`, `applyDryRun` writes `dry_run[]` into reconcile verdict. **Dry-run stubs only (ADR 0042).**
- `sort.ts` — `focusSort`: action priority (lane_move>replyio>comment>flag) then board (OKB first).
- `plan.ts` — `writeDailyPlan` → `daily-plan.md` (actionable / no-action / quarantine sections).
- `orc.settings.json` — H1 effect-free-wall (PreToolUse) + H4 run-completeness (Stop), passed to ORC spawns.

## Lib (`src/lib/`)
- `body-normalize.ts` — `normalizeBody`: HTML-detect → `htmlToText` → `topPost` quote-strip.
- `html-text.ts` — `htmlToText` via `html-to-text`, crude-strip fallback, `⚠ HTML-FALLBACK:` last resort.
- `quote-strip.ts` — `topPost` via `email-reply-parser`; `⚠ QUOTE-STRIP-FAILED:` on error.
- `machine-mail.ts` — `isMachineMail`: auto-submitted/precedence/list-*/empty return-path/OOO-subject heuristics. Wired into clean's junk gate.

## Telegram (`src/telegram/`)
- `gate.ts` — `awaitApproval`/`runGate`: posts plan with Approve/Reject buttons (grammy), blocks for operator, accepts `/feedback <text>`. Only `TELEGRAM_CHAT_ID` honored. `npm run tg:gate`. Not wired into run-orc.
- `push.ts` — `pushMessage`: outbound-only Bot API sendMessage (native fetch, no SDK). `npm run tg:push`.

## Runtime guards (`.claude/hooks/`, wired via scoped settings)
- **H1** `effect-free-wall.sh` — ORC allowed only Read/Write/Edit (data/ only)/Task/Spawn; blocks Bash/WebFetch/mcp_*.
- **H2** `verdict-schema.sh` — validates thread verdict closed-vocab (label ∈ outreach|content|other|null).
- **H3** `criteria-gate.sh` — blocks write-pass draft while read-pass reasoning null.
- **H4** `run-completeness.sh` — Stop hook; blocks if verdicts missing, surfaces quarantine count.
- `emails-json-guard.sh` — blocks overwrite of raw `emails/<id>.json` (sidecar-only writes).
- `adr-guard.sh` — blocks supersession-history prose in ADRs. `notify.sh` — local notification helper.

## Agent prompts (`.claude/agents/`)
`messaging-okb-letter.md` (merged OKB judge+draft, direct call) · `messaging-write-outreach.md` (write-only continuation, direct call) · classify · clickup-subagent · messaging-read-{outreach,content} · messaging-write-content · reconciler (spawned paths).

## Env / config
`.env`: GMAIL_CLIENT_ID/SECRET, REPLY_API_KEY, CLICKUP_TOKEN, TELEGRAM_BOT_TOKEN/CHAT_ID. Optional: MODEL_CALL_BUDGET (default 40/run), OKB_E2E_FIXTURE=1 (offline e2e), ANTHROPIC_API_KEY (switches defaultLlmCaller from subscription CLI to direct API). `.tokens/gmail.json` (gitignored). npm scripts: `day`, `fetch:day`, `orc:run`, `day:build/check`, `labels:check`, `gmail:auth`, `tg:push/gate`, `typecheck`, `test`.
