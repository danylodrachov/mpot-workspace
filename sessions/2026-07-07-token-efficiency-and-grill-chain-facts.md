---
title: Token-efficiency audit + grill-chain noise — facts
date: 2026-07-07
type: session-facts
---

# 2026-07-07 — Token-efficiency audit & skill-chain noise fixes

One session, two halves: (A) repo token-efficiency audit + applied cleanup,
(B) grill→PRD→issues chain noise analysis + skill fixes. Facts verified against the
working tree on 2026-07-07, branch `ralph/issue-89`.

> **Applied 2026-07-07** — findings 1–8 fixed (commits `90863cb`, `9af3d39`):
> worktrees removed, citations repointed, clutter deleted, `data/` gitignored,
> dead configs/docs dropped (`status-vocabulary.md` kept — still load-bearing),
> housekeeping commit made. Finding 9 (ADR + adr-digest same-commit rule) is a
> standing rule, not a one-off fix. Tests after cleanup: 115/116, sole failure =
> pre-existing gmail unread-query test.

## A. What already works — keep and protect

- **CLAUDE.md is 17 lines of pointers, not content.** The knowledgebase list ("check
  before asking the user") is the correct pattern: standing cost near zero, everything
  else loaded on demand.
- **`design_docs/adr/README-codebase.md` (91 dense lines) is the single code map.** One
  read replaces dozens of exploratory file opens. It even annotates dead code
  ("No production caller", "Unwired (test-only)", "No consumer") — those annotations are
  what stops a model from wiring dead modules back in.
- **`adr-digest.md` as compressed ADR entry point** — read it first, open a full ADR
  only when its section is insufficient.
- **Per-issue "Read first" lists** (`issues/*.md`) — scoped reading instead of repo
  sweeps. `ralph/PROMPT.local.md` enforces "read exactly those files, no more".
- **Resume-by-null-field convention** (skip classify if `label≠null`, etc.) — models
  never redo finished reasoning.
- **`sessions/2026-W27-weekly-summary.md` format** — facts only, WORKED/FAILED with
  root causes and numbers. This is the template the fact-recording skill codifies.

## A. Findings — where tokens were wasted (all but 9 fixed same day)

1. **Seven stale git worktrees under `.claude/worktrees/` (~4 MB).** Each held a full
   repo copy; every repo-wide grep returned up to 8 copies of every hit. Removed +
   pruned; branches kept.
2. **Broken load-bearing pointer: `sessions/2026-07-03-registry-design-facts.md` did
   not exist**, yet issues 01, 02, 05, 07, 10 cited it in "Read first" as "the design
   source of truth". The dailies were deleted when the W27 summary compressed them, but
   citations were never repointed — a model following them fell back to exactly the repo
   sweep the ralph prompt forbids. Repointed to the W27 sections. Rule going forward:
   before deleting a session file, grep for its filename and repoint citations.
3. **Root-level clutter grep found first:** `goluchas-thread-raw.json` (87 KB raw email
   thread, PII, repo root), empty `.gitignore.tmp`, `.DS_Store` files. Deleted.
4. **Huge uncommitted git state** — dozens of deletions + untracked dirs; HEAD
   contradicted the working tree, `git grep`/`git show` returned a dead world. Recorded
   in one housekeeping commit (`90863cb`), superseded docs committed before deletion
   (`9af3d39`) so they remain recoverable.
5. **`data/` (fetched mail = PII + registry) untracked and not gitignored.** Now
   gitignored entirely.
6. **CONTEXT.md placeholder entry** ("Agent Memory: rewrite in MEMORY.md") — removed.
7. **Unindexed stale docs in `design_docs/`** (superseded agent docs, join-map template
   describing a mechanism replaced by `data/registry.json`) — deleted;
   `status-vocabulary.md` kept, still load-bearing.
8. **Dead code/config on disk** (`messaging-subagent.settings.json` — runner deleted;
   `src/lib/filename.ts` — no caller) — deleted, README-codebase updated.
   `src/clickup/prune.ts` kept: recent issue-61 work awaiting wiring.
9. **`adr-digest.md` duplicates ADR content by design** — acceptable as entry point;
   standing rule: any ADR edit updates its adr-digest section in the same commit.

## A. Session-start cost model

- CLAUDE.md (17 lines) always; CONTEXT.md (glossary) and README-codebase.md on demand —
  all correct. The real cost was searches traversing duplicates (1), pointers to deleted
  files (2), and a lying git state (4). Fixing those three removed most of the waste.

## A. Where the "record facts only" prompt lives — decided

**A skill: `.claude/skills/session-facts/SKILL.md`** + one pointer line in CLAUDE.md.
Not CLAUDE.md body (taxes every session), not a hook (no judgment), not a subagent
(starts cold, can't see the session it must compress), not user memory (per-machine;
facts other models need belong in the repo). Trigger added same day: also fires when
the user states he wants to compact the session.

## B. Worked

- Researched the `grill-with-docs` → `to-prd` → `to-issues` chain (global skills,
  `~/.claude/skills/`); deleted repo-local grill copy verified byte-identical to global,
  so nothing was lost in the cleanup.
- Edited global `grill-with-docs` (4 edits): end-of-session decision replay (numbered
  one-liners, user confirms/kills each); no mid-session ADR writes — candidates ledger,
  confirmed-only writes after replay; before each ADR write, search old ADRs + CONTEXT.md
  and overwrite/supersede conflicting entries in the same pass; resolved terms replace old
  definitions. Frontmatter description realigned so the model isn't primed to write ADRs inline.

- Compacted + renamed the ADR digest: `adr-progress.md` → `adr-digest.md` (name now
  states the function), 23.9 KB → 9.6 KB (−60%), missing 0039 section added, 0034
  section cut from near-copy to 8 bullets. Before compression, 10 sonnet
  subagents diffed each section against its full ADR and folded 4 digest-only facts
  into ADRs 0034/0037/0041/0042 — nothing was lost. Digest header now carries a drift
  note: join-map (0034/0039/0041) replaced by `data/registry.json`; ADRs not yet
  updated, registry design wins on conflict.

## B. Failed

- (cleanup half) First `git rm` used repo-root paths for files living under
  `design_docs/agents/` and no-oped silently — root cause: stderr suppressed with
  `2>/dev/null`, so the miss was invisible until `ls` disproved it.

## B. Decided

- `session-facts` stays a standalone session-compaction mechanism — sessions ≠ grill;
  it never writes ADRs, only pointer lines to them.
- `grill-with-docs` is the sole ADR/CONTEXT.md writer and owns the decision replay;
  the replay is the missing "crystallisation moment" — writing mid-session leaves dead
  entries when later branches reverse a decision.
- Clean-write principle (why it won): stale conflicting entries in ADRs/CONTEXT are
  dead information that misleads both user and model — overwriting beats appending.

## B. Verified external facts

- `to-prd` and `to-issues` synthesize from the whole conversation context, not from
  ADRs (`to-prd`: "Do NOT interview — synthesize what you already know"). Clean ADRs
  alone do not protect the PRD from a noisy transcript; the decision replay does.
- Global `grill-with-docs` hardcodes `docs/adr/`; this project uses `design_docs/adr/`
  + same-commit `adr-digest.md` rule — the old stray `docs/adr/0034` was this
  split-brain's artifact.
- `setup-matt-pocock-skills` (configures issue tracker, triage labels, ADR/CONTEXT
  location for the whole chain) had never been run here — fixed same day: the per-repo
  config was scaffolded manually following that skill's own templates (`## Agent skills`
  block in CLAUDE.md + `design_docs/agents/{issue-tracker,triage-labels,domain}.md`),
  adapted to this repo (`issues/` flat tracker, frontmatter triage, `design_docs/adr/`
  + same-commit adr-digest rule, mandatory per-issue "Read first" lists).

## B. Open defects

- None from this session. (ADR-path split-brain closed same day — see above.)
