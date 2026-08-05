# ADR Digest

Every ADR compressed to its load-bearing facts. The ADRs are the source of truth: read
this file first, open a full ADR only when its section is not enough. Any ADR edit
updates its section here in the same commit. (Renamed from `adr-progress.md`, 2026-07-07.)

> **Drift note.** The cross-day join-map (0034, echoed in 0039/0041) was replaced in the
> built system by message-keyed `data/registry.json`; design record =
> `sessions/2026-W27-weekly-summary.md` §"2026-07-03 — Registry & freshness filter
> design". ADRs not yet updated — where they conflict with the registry design, the
> registry design wins.

## 0020 — Stack: Node.js / TypeScript (Accepted 2026-06-14)

- AFK agent = Node/TS running **as Claude Code**; agents = native `.claude/agents/*.md`
  + hooks, on operator subscription. Agent SDK not used.
- Future shape: localhost server + inbound webhooks + Telegram two-way (grammy).
  Flat `npm install`, low friction for a non-coder.

## 0027 — `data/` folder layout (Accepted 2026-06-15)

- `data/` permanent; per day `data/<date>/inputs/{raw,clean}/` +
  `outputs/{emails,tasks,qa reports,message-drafts}/`. Builder = idempotent shell
  script, never deletes.
- raw = audit capture (overwritten per fetch); clean = regenerable. **Routing = split
  dirs** (emails → messaging, tasks → clickup), not a discriminator field.
- QA split by audience: Article QA Report → `qa reports/`; outlet-facing Fix File →
  `message-drafts/` behind the Approval Gate.

## 0034 — Orchestrator runtime spine (Accepted 2026-06-15)

- ORC = deterministic spine, NO reasoning: build → fetch raw (one file/source) →
  pre-filter (bounce) → freshness gate → clean → split + seed verdicts → tiers →
  execution. Streaming; "wait on X" = wait on a field fill.
- Tiers: **T1 classify** (haiku, threads only, labels the newest actionable turn) →
  **T2 context-formers** (sonnet ×2, messaging + clickup, both always run) →
  **T3 reconciler** (opus, global, reads formed contexts only; emits `truthful_signal`
  + boolean `signals{}` + `blocked` — never a target lane) → **write** (sonnet, drafts
  when a signal needs a send).
- Executor owns the `(lane, signals) → (move, reply.io step)` tables (0037/0038).
  Write ladder: comment free; status+assignee gated; sends gated. Subagents never
  write ClickUp.
- Signals — OKB: `defined_questions_complete`, `payment_details_received`,
  `payment_evidence_found`. CKB: `publication_submitted`, `published_link_present`,
  `corrections_present`, `corrections_cleared`. payment_terms / package_size /
  go-no-go are NOT signals (no lane gates them).
- Cleaner: top-post-only body, attachments recorded not downloaded. Splitter pre-seeds
  join keys + `media` (5-step fallback chain; extracted, never reasoned).
- **Resume by null field:** skip classify if `label≠null` → context-former if
  `reasoning≠null` → reconciler if `truthful_signal≠null` → write if `draft≠null`.
- All outbound (both boards) rides reply.io; Gmail inbound-only. Cross-day state: see
  drift note (registry).

## 0035 — Dependency stack: free, mostly raw-REST (Accepted 2026-06-16)

- Raw REST + native fetch for ClickUp (v2, 100 req/min) and reply.io (v3, Bearer).
  One SDK: `@googleapis/gmail` + `google-auth-library` (owns OAuth2 refresh +
  base64url). reply.io API plan-gated = the one paid service.
- Helpers: `email-reply-parser` (localized quote boundaries), hand-coded machine-mail
  detection (~20 lines of header checks), `postal-mime` fallback for raw
  RFC822/HTML-only.
- Dep surface: `@googleapis/gmail`, `grammy`, `p-limit`, `zod`, `email-reply-parser`
  (+ optional `postal-mime`); `telegraf` rejected (stale). Runs cost nothing on
  subscription.

## 0036 — Reply.io integration facts (Accepted 2026-06-19)

- Thread `id` (integer) = the only durable id; **no per-message id** ⇒ idempotency
  thread-keyed (`id` + `lastActivityDate`). `sequence:{id,name}` rides on the thread.
- `POST /v3/inbox/threads/filter`: native `source` (`inbox|sent|unread|aiDraft`) +
  `lastActivityDate` range; `status.state` client-side only. Media reply = presence of
  `isOutbound:false`; full body = second hop `GET /v3/inbox/threads/{id}/messages`;
  `email_replied` webhook carries no thread id.
- Enrolment = bulk-add only (`startStepId`, `startFrom`); a replied contact re-targets
  only with `removeFromExisting:true`; neither state-toggle endpoint takes a step; all
  sequence-contact endpoints beta.
- Sequence creation full-REST (`POST /v3/sequences`, steps + variants inline);
  `settings` all-or-nothing; per-contact `customFields[]` single-valued; template
  variables resolve per-recipient (`{{Field|"default"}}`).
- Consequences: fetch window `lastActivityDate ≥ today−2d`; reply.io owns all outbound
  chasing for both boards; `source:"unread"` is sticky.

## 0037 — OKB: pipeline + status logic (Accepted 2026-06-19)

- OKB = acquiring + paying a Media Outlet. Entry **message-first** (reply.io inbox
  list) — inverts 0034's board-first pattern, OKB-only.
- Lanes: To Contact → Contacted (auto follow-up) → Negotiation (reason over reply,
  chase Defined Questions; all covered → **Completed**) · Invoice Request (created
  externally by SEO; agent sends invoice template) → To Pay (find payment evidence,
  comment + tag Alina; **terminal — agent stops**).
- No go/no-go wait: creator "go" = SEO creating the Invoice Request task. Contacted →
  Negotiation = gate-detected reply, not a signal.
- Agent output NL-only (Defined-Question coverage; payment details/evidence);
  halt-never-guess. Deterministic script owns every lane move.

## 0038 — CKB: pipeline + status logic (Accepted 2026-06-20)

- CKB = article placement + QA with an already-onboarded outlet. 10 lanes; agent acts
  on 3: **To Submit** (enrol 0041 sequence Step 1; template + customFields, gated) →
  **Publication** (chase Step 2; link present → stop + flag, verification out of
  scope) → **Publication Revision** (relay QA comments via Step 3; cleared → Step 4
  thank-you + Completed).
- Agent never QA-checks — QA lands as card comments; agent reads + relays verbatim.
- Entry at To Submit: SEO checker tags the operator, final doc posted, task
  reassigned. All CKB outbound rides reply.io; Gmail inbound-only.

## 0039 — Gmail integration facts (Accepted 2026-06-21)

- Discovery ≠ bodies: `threads.list` returns stubs only (default 100 / max 500,
  newest-first); full history = `threads.get(format:"full")` per thread ⇒ one paged
  list + N gets, bodies inline (the extra hop is at discovery — opposite of reply.io).
- **A per-message id exists** (finer than reply.io's thread-only); thread id = stable
  hex join key; outbound = `SENT` in `labelIds[]` (no isOutbound flag).
- Fetch = `labelIds:["INBOX","UNREAD"]`, freshest page only, **no date window**
  (decision 2026-06-22) — "already processed" is decided downstream per message id.
- `internalDate` (epoch ms) = authoritative ordering; headers live in
  `payload.headers[]`; attachment bodies = second hop via `attachmentId`.

## 0040 — ClickUp subagent verdict (Accepted 2026-06-21)

- Sidecar, not in-place: subagent fills `<task_id>.verdict.json` in `outputs/tasks/`
  (the separate folder IS the routing discriminator); never mutates the source task
  JSON.
- Splitter pre-seeds (extracted, never reasoned): `board`, `task_id`, `task_name`,
  `current_lane`; write-once, rest null.
- Shape: `decision_data{package_size, payment_terms, correction_items}` board-scoped
  (unused = null, not absent) + `reasoning` (NL). **No next-action field** —
  transition booleans live only in the reconcile-verdict.
- Fan-out gated on every task having a sibling verdict; resume: skip when
  `reasoning≠null`.

## 0041 — Content-board follow-up sequence (Accepted 2026-06-23)

- One shared Spanish reply.io sequence; personalisation via customFields
  (`article_draft_url` = Drive **folder** link, `article_title` → subject,
  `corrections_body`). Steps: 1 ask → 2 chase (+2bd; also the re-landing for a reply
  without a link) → 3 corrections → 4 thank-you. Loop cap ≤2 runs per follow-up step.
- Content join key = **Drive folder id**, extracted deterministically from
  operator-pasted card comment/description + own SENT top-post; miss ⇒ sentinel
  `DRIVE URL NOT FOUND`; fallback = unique `article_title` match, else handback.
  No spreadsheet / Sheets API / service-account.
- Replies finish the sequence (`markAsFinished`); the script re-enrols by agent
  verdict bool (published link present?) — re-enrol needs `removeFromExisting:true` +
  `startStepId`.
- Settings: step delays 0 / +2bd / +2bd; `daysToFinishProspect` 8; ≤1 email/outlet/day.
  Agent returns the verdict only; the script owns every effect.

## 0042 — Executor: action model + dry-run stubs (Accepted 2026-06-24)

- Two halves, never blurred: **resolver** = pure `(current_lane, signals) → Action[]`
  (0037/0038 tables as code; null gating signal → `flag_operator`, never guess);
  **effects** = the only functions doing I/O.
- Stubs first: effects render each Action to an intent-string into reconcile-verdict
  `dry_run[]` — a no-effect run is fully auditable; real APIs drop in behind the same
  signatures.
- Action union: `lane_move` · `comment` · `replyio{enrol|re_enrol|send|none}` ·
  `flag_operator`. Helpers: `buildInvoiceRequestEmail(packageSize)`, the 0041
  folder-id extractor. Files: `src/orchestrator/executor/{types,resolve,effects}.ts`
  (only types.ts written so far).


## 0045 — Article QA: token-efficient input architecture (Accepted 2026-07-10)

- Brief via `read_file_content` (~5k tokens markdown) not HTML export (~150k CSS soup).
  Brief = article text only (meta, headings, body, links), no copywriter instructions.
- Live page via `browser_evaluate` JS snippet → structured JSON (~1k tokens) not raw
  `browser_snapshot` (~100k). Extracts: title, meta description, og:*, canonical, robots,
  h1, heading outline, all `<a>`.
- Screenshot stays (~1-2k image tokens) — model needs it to filter ad blocks / sidebar
  noise on unpredictable CMS layouts (dozens of different media sites).
- Model does all comparison (exact match + fuzzy + report). No deterministic script —
  25x savings come from smaller inputs, not from moving logic out.
- Brief discovery manual (user provides fileId/link); Drive `search_files` unreliable
  for shared `.docx`.
- Per-article cost: ~300k → ~12k input tokens (25x reduction).

## 0046 — Research automation: architecture (Accepted 2026-07-11)

- Authority: `rubrics.zip` > plan > ADR > spec > issues. `rubrics.zip` sole authority for
  fields/types/enums/conditionals/operator fields; `schema.json`/example rows/workbook
  inference non-authoritative.
- 5 components: rubric compiler, Playwright collector, evidence/state/merge, Claude
  resolver+usage, validator/finalizer. MCP (`@playwright/mcp`) excluded from hot path —
  discovery/repair/assisted-auth only; collection is direct Playwright. Excluded: model
  APIs, Agent SDK, autonomous browsing, DB/queue/dashboard/object storage, distributed
  workers, browser farms, proxy/CAPTCHA bypass, OCR, broad adapter framework, learned
  routing.
- All filesystem, no DB: `data/research/<casino>-<geo>/{run-state,research-data,
  conflicts,auth-state,terminal-status,final-report}.json` + `evidence.jsonl` +
  `usage.jsonl` + `research-data.xlsx`. Atomic tmp+rename (pattern from
  `src/pipeline/registry.ts`) for whole-file JSON; JSONL append-only.
- Auth: login once, persist `storageState()`; expiry check >24h; re-auth bounded max 2;
  credentials from `data/research/credentials.json`, runtime read-only, never in
  output/logs/evidence; `auth-state.json` 0o600. Evidence priority DOM > XHR > download >
  ARIA > screenshot; hash-verifiable; deterministic id =
  `sha256(url+method+content_hash).slice(0,12)`.
- Merge: null-fill-only; identical non-null coalesces; differing non-null → explicit
  conflict, never silent overwrite; dedup by rubric-defined logical key per category; FK
  consistency (`casino_name`/`country`) checked by validator.
- Claude: CLI only (`claude -p` via `cliLlmCaller`), tools disabled; scope = unresolved
  `not_found_after_budget`/`conflict` fields only, narrowed input; ≤1 retry; patch ops
  schema-validated against compiled rubric, unknown paths/types/enums/keys rejected.
- Usage: one `usage.jsonl` row/operation; deterministic ops exact `0`; Claude
  runtime-reported only; missing → `null`; classify
  `exact|partial|estimated|unavailable`; MCP session totals never fabricated as
  per-operation; estimated excluded from exact totals.
- **Scope (2026-07-22):** discovery limited to slots, live-casino, sports. All other
  categories out of scope. Anonymous-first — agent starts unauthenticated, escalates to
  human login only when a mandatory source is confirmed gated (revised 2026-07-24, see
  ADR-001 §8: login is not a hard precondition and does not reliably expose compliance
  links). `url-map-recon` MCP agent discovers URLs/routes only (revised 2026-07-24 — it
  no longer extracts titles); a separate deterministic collector
  (`src/research/url-map-recon/product-collector.ts`) extracts product names from
  already-distilled inputs. Live-casino = category names only. Sports = sport titles
  only. About/Legal excluded.
- Validation gates (full list in `final-report.json.gate_results`): rubric completeness,
  terminal coverage, types/enums, logical-key/FK, duplicates/orphans, unsupported
  inference, conflict/no-silent-overwrite, evidence coverage + hash integrity, Claude
  scope/patch/retry compliance, resume/idempotency, usage classification. PASS iff all
  gates pass.
- Dead references: `schema_dump.py`/`snippets.py`/`validate.py`/
  `data/templates/casino_import_template.xlsx`/`data/surfaces/catalog.json`/Research MCP
  10-tool server/`research-capture-stop.sh` hook — all deleted (never existed or never
  built). `src/research/*.ts` — implemented (was dead imports). `bin/extract-category.sh`,
  `bin/merge-extract.sh` — retained, imports fixed.