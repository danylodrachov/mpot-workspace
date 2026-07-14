# ADR 0027 — `data/` folder layout

- **Status:** Accepted
- **Date:** 2026-06-15
- **Context grill:** afk-agent — day folder and reader-scope enforcement


The builder is a stupid-simple shell script: it (re)creates the folder from scratch every run,  No merge, no read-before-write — the day folder is disposable scratch, rebuilt fresh each cycle (mirrors the [[Daily Plan]]: lives one day). Anything that must survive to tomorrow lives elsewhere, not here.

## Layout (permanent parent for the cross-day ledger)

The top folder is **`data/`** and is **permanent** — never deleted or overwritten. It is the
"elsewhere" the disposability rule points at: it holds the cross-day persistent ledger (ADR 0034
§3.4). Inside it:

```
data/                         ← permanent
├── join-map.json             ← cross-day processed-state + message→card join (ADR 0034 §3.4)
└── <date>/                   ← created once daily, disposable, lives 1 day
    ├── inputs/               ← created once daily, lives 1 day
    │   ├── raw/              ← API fetches (overwritten several times/day)
    │   └── clean/            ← cleaned, regenerable
    └── outputs/              ← created once daily, agent-produced, day-scoped
        ├── emails/           ← split <id>.json + <id>.verdict.json for Gmail / reply.io threads
        ├── tasks/            ← split <id>.json + <id>.verdict.json for ClickUp tasks
        ├── qa reports/       ← [[Article QA Report]]
        └── message-drafts/   ← outlet-facing drafts, behind the [[Approval Gate]]
```

**[MODEL DECISION] Thread vs task routing — split dirs, not a discriminator field.** The splitter
(ADR 0034 §3.2) writes Gmail / reply.io thread files into `outputs/emails/` and ClickUp task
files into `outputs/tasks/`. The orchestrator routes by folder, not by inspecting a `source` field:
- `outputs/emails/<id>.json` → messaging subagent
- `outputs/tasks/<id>.json` → ClickUp subagent (×2, board already known from task JSON)

This is consistent with 0027's "stupid-simple, disposable scratch" principle and with how 0027
already separates `qa reports/` from `message-drafts/` by audience: physical separation beats an
in-band discriminator that every consumer must parse. The `<id>` namespaces do not collide in
practice (reply.io integers vs Gmail hex vs ClickUp alphanumeric task ids) but keeping them in
separate dirs removes any coupling to that assumption.

Every `<date>` subfolder logically subordinates to this `inputs/` vs `outputs/` split; nothing is
dumped flat at the `<date>` root. The `<date>` dir keeps the disposable-scratch semantics above;
only `data/` and its ledger survive to tomorrow.

## QA output destination — split by audience, not one bucket

QA produces two distinct artifacts (per CONTEXT glossary), so they land in two places:

- **[[Article QA Report]]** (the full internal record) → `outputs/qa reports/`, its own
  directory. It is not a message and not outlet-facing, so it does not belong in
  `outputs/message-drafts/`.
- **[[Fix File]]** (the trimmed, outlet-facing slice) → `outputs/message-drafts/`, alongside every
  other gated outlet-facing message. It goes out behind the [[Approval Gate]] like any draft.

The split is the glossary's audience line — internal record vs the slice the [[Media]] sees —
made physical. (Closes the QA-output-destination question: both, by audience, not `drafts/` alone.)

