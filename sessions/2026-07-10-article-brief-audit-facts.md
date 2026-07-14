---
title: Article-vs-brief audit flow (manual dry run)
date: 2026-07-10
type: session-facts
---

## Worked

- Manually dry-ran the intended article-audit automation: fetched a live published page with Playwright, saved `data/publications/<slug>.html` + full-page `.png`, saved the matching source brief as `data/publication_briefs/<slug>.md`, then generated a report table per `report-template.md` scored against `rubric-canonical-robots.md`, `rubric-hierarchy.md`, `rubric-links.md`, `rubric-meta-og.md`.
- Final correct-brief run scored 19 of 20 checks passed for `noticiasambientales.com` "Slots de naturaleza" article: 1 confirmed defect (OG title tag doesn't inherit from brief title — page ships an old/different OG title string).
- Retrieved a Google Drive `.docx` brief's text content via `mcp__claude_ai_Google_Drive__read_file_content` using a `fileId` extracted from the Drive UI's `data-id` DOM attribute (via Playwright `browser_evaluate`), after `search_files` by title returned empty results for a file visibly shared and open in the browser.

## Failed

- First report run compared the live page against the wrong brief document (grabbed "Juegos rápidos en casino online" brief while the live page was actually "Slots de naturaleza..."). Root cause: didn't verify the brief's title/topic matched the live article's actual title before using it as the comparison source — went straight from folder listing to the one file present without checking topic match. Produced a false 4/17-pass report.
- `mcp__claude_ai_Google_Drive__search_files` with `title contains '<exact folder-listed name>'` returned `{}` (no results) for a file that was visibly present and shared in the same Drive folder open in the browser — title-based search is not reliable for locating a specific shared file; falling back to DOM-scraped `fileId` worked.

## Decided

- Trailing-period / punctuation-only differences between a source brief field (e.g. meta description) and the live rendered value do not count as a rubric `Fail` — user overrode the literal "any other difference is Fail" reading in `rubric-meta-og.md` checks 1–2 for this case. Treat as effectively whitespace-class, not a content mismatch.

## Open defects

- Live page `og:title` for `noticiasambientales.com/innovacion/slots-de-naturaleza-leer-rtp-y-volatilidad/` does not follow the og-title-inherits-from-title fallback rule — currently shows "Slots de naturaleza: cómo leer RTP, volatilidad y bonos antes de jugar - Noticias Ambientales" instead of the brief's title "Slots de naturaleza: leer RTP y volatilidad". Not fixed, only reported.
