---
title: Research synthesis design — extract-at-capture architecture
date: 2026-07-10
type: session-facts
---

## Worked

- Audited RunMedia `casino_import_template.xlsx`: 13 sheets, 5 Chile casinos, 159 payment methods, 419 games in Dropdowns. See `sessions/2026-07-10-runmedia-import-template-facts.md` for full breakdown.
- Measured raw capture sizes: Sportuna Norway ~1M tokens (53 html files, 74,333 lines), 7signs Norway ~336K tokens (29 files, 22,602 lines).
- Measured signal-to-noise: `deposit-bitcoin.md` is 2,691 lines; 10 lines contain actual deposit data, rest is page chrome. Deterministic cleaning (strip refs, extract main) achieves only 9–20% reduction.
- Grill session produced 7 confirmed decisions → ADR 0044 rewritten, ADR 0043 updated, adr-digest updated, CONTEXT.md glossary updated (Captured Evidence, Research Data).

## Decided

- **Extract-at-capture, not two-phase** — agent extracts structured data during Playwright navigation while page content is already in context (~500 token rubric overhead vs ~1M tokens to re-read). Reason: page snapshot already loaded for navigation; separate pass pays for same content twice.
- **Output: `research-data.json` + screenshots, no HTML dumps** — HTML dumps were designed as cheaper re-read path but extract-at-capture eliminates the need. Screenshots remain as evidence.
- **One `research-data.json` per casino** — all categories in one file with per-category status.
- **Deterministic script for json→xlsx** — no LLM; JSON already in canonical schema, conversion is field-to-column mapping.
- **Casino master sheet populated acumulatively** — each category pass appends master-relevant fields; operator fills Country/Priority/Login/Status.
- **Static rubric files per category** — `rubrics/<category>.json` = column schema + Dropdown enum values, generated once from xlsx template. Template changes rarely.
- **RunMedia xlsx = canonical schema** — agent maps observed values to canonical dropdown values; unmatched values flagged `"_unmapped": true` for human review.
- All decisions recorded in ADR 0044 (revised 2026-07-10).

## Verified external facts

- Deterministic cleaning of Playwright accessibility tree dumps cannot separate content from page chrome — semantic understanding required. Regex stripping of `[ref=...]`, `[cursor=pointer]`, empty elements yields only 9% reduction; extracting `<main>` section yields 20%.
- Deposit page captures include full homepage game listings because deposit modal overlays the main page — Playwright snapshots the entire DOM, not just the modal.
