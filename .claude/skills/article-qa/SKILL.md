---
description: Compare a published article against its reference brief across SEO rubrics (meta, canonical, hierarchy, links) and produce a pass/fail report. Use when user wants to QA-check a published article, verify publication, audit article against brief, or says "article qa", "check article", "verify publication".
---

# Article QA

Compare a live published article against its [[Reference Brief]] across four SEO rubrics.
Produces an [[Article QA Report]] table.

## Input

`/article-qa <live-url> <brief-file-id>`

- `live-url` — the published article URL
- `brief-file-id` — Google Drive file ID of the reference brief

## Flow

### Step 1 — Fetch brief

`read_file_content` with the brief's `fileId`. Result is markdown with:

- `Meta-title:` and `Meta-description:` as labeled lines at the top
- `#` heading = H1
- `##` / `###` headings in the body
- `[anchor](url)` links in the body

### Step 2 — Extract live page

1. `browser_navigate` to the live URL.
2. Read `extract.js` from this skill's directory, pass its contents as the
   `expression` to `browser_evaluate`. Returns structured JSON with all
   QA-relevant fields (title, meta, OG, canonical, robots, headings, links).
3. `browser_take_screenshot` — viewport screenshot. Use it to distinguish article
   content from ad blocks, sidebars, and page noise when evaluating headings and links.

### Step 3 — Read rubrics

Read all four rubric files and the report template from the project root:

- `rubric-meta-og.md`
- `rubric-canonical-robots.md`
- `rubric-hierarchy.md`
- `rubric-links.md`
- `report-template.md`

### Step 4 — Compare & report

With brief, extracted JSON, screenshot, and rubrics in context:

1. Walk each rubric checklist, comparing brief fields against extracted live fields.
2. Use the screenshot to verify that extracted headings and links belong to the
   article body, not ad blocks, navigation, or sidebar widgets.
3. Generate the report table per `report-template.md`.
4. Print the summary line: `N of M checks passed`.

## Comparison overrides

- Trailing punctuation (period, comma) only differences between brief and live values
  are whitespace-class — not a Fail.
- OG fallback logic is defined in `rubric-meta-og.md` — og:title falls back to title,
  og:description to meta_description, og:type defaults to `article`.

## Rules

- **Read-only.** Never modify the published page or the brief.
- **All four rubrics, every time.** Do not skip a category because the brief seems
  incomplete — missing-source handling is defined per rubric.
- **Screenshot is context, not data.** Extract structured fields from JSON, not
  from the screenshot. Use the screenshot only to filter page noise.
- **Report verbatim.** Expected/Actual values are verbatim strings from brief and
  live page, not paraphrased.
- **No false positives from page chrome.** If a heading or link appears only in
  navigation, footer, sidebar, or ad block (confirm via screenshot), exclude it
  from the comparison — it is not article content.
