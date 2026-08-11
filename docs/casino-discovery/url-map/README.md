# URL Map Module

## Boundary

This module has two owners:

1. Playwright/TypeScript: broad URL discovery + deterministic technical cleanup only.
2. Claude Code `url-map-classifier`: business relevance classification + `clean-url-map.md`.

The deterministic filter MUST NOT reject a URL because it looks like a lobby, homepage, cashier route, promotion, sports page, game category, terms page, VIP page, or any other business class. That decision belongs to the classifier.

Static JS/font/CSS/image/media URLs are removed from the LLM candidate list only after entry-page browser/network responses have had a chance to contribute URL tokens.

## Default discovery order

The module is sitemap-first. It does not recursively browse every sitemap URL by default.

1. Fetch `/robots.txt` with Playwright's request context.
2. Read every `Sitemap:` declaration.
3. Recursively fetch sitemap indexes and terminal sitemap documents.
4. Probe configured fallback sitemap paths (`/sitemap.xml`, `/sitemap_index.xml`, etc.).
5. Add sitemap page URLs to the candidate set without visiting them.
6. Open the entry page once with Playwright.
7. Passively supplement the candidate set from the entry page:
   - DOM links and metadata across frames/open Shadow DOM;
   - forms/frames/embed URLs;
   - `data-*` and inline-event route values;
   - inline JS/bootstrap route strings;
   - network request/response URLs;
   - same-scope URL tokens from textual JS/JSON/XML response bodies;
   - Performance API resources;
   - History API / SPA route instrumentation;
   - localStorage/sessionStorage route strings;
   - manifest URL.
8. Run deterministic technical filtering.
9. Pass the canonical technical candidates to the LLM classifier.

## Recursive fallback

Default `--recursive-mode fallback` starts recursive same-scope Playwright traversal only when sitemap discovery produced **zero page URLs**.

Modes:

- `fallback` — default; crawl only if no sitemap page URLs exist.
- `never` — never recursively crawl; robots/sitemaps + one entry-page inspection only.
- `always` — explicitly force recursive browser traversal after sitemap + entry-page discovery.

`--max-pages` applies only when recursive traversal is active. `--max-pages 0` means no page-count cap.

A sitemap can be incomplete, so the entry-page browser reconnaissance supplements it. Recursive browsing remains a fallback rather than the normal URL-map mechanism.

## Run

Default:

```bash
node --experimental-strip-types src/research/url-map/cli.ts \
  --url https://example.com \
  --headed
```

Guarantee no recursive crawl:

```bash
node --experimental-strip-types src/research/url-map/cli.ts \
  --url https://example.com \
  --recursive-mode never \
  --headed
```

Force recursive crawl:

```bash
node --experimental-strip-types src/research/url-map/cli.ts \
  --url https://example.com \
  --recursive-mode always \
  --max-pages 5000 \
  --headed
```

Manual authenticated entry-page reconnaissance:

```bash
node --experimental-strip-types src/research/url-map/cli.ts \
  --url https://example.com \
  --manual-login
```

Optional scope expansion for an explicitly approved brand host:

```bash
--allow-host mirror.example.com
```

## Deterministic outputs

Each run writes:

- `raw-url-candidates.jsonl` — every raw URL observation with provenance;
- `technical-rejected-urls.jsonl` — static assets, non-HTTP, invalid and out-of-scope URLs;
- `technical-url-candidates.md` — canonical in-scope candidates passed to the LLM;
- `url-map-run.json` — counts, source coverage/errors, sitemap coverage and fallback state.

Important `url-map-run.json` fields:

- `sitemapUrlObservationCount`;
- `usableSitemapUrlCount`;
- `recursiveFallbackTriggered`;
- `recursiveFallbackReason`;
- `recursivePagesAttempted`;
- `sourceFamilyObservationCounts`.

The classifier then writes:

- `clean-url-map.md` — research-relevant browser page map.

## Claude Code

Project subagent:

`.claude/agents/url-map-classifier.md`

Project skill:

`.claude/skills/url-map/SKILL.md`

Invoke from Claude Code:

```text
/url-map https://example.com --headed
```

## Tests

```bash
node --test --experimental-strip-types \
  src/research/url-map/technical-filter.test.ts \
  src/research/url-map/discovery-policy.test.ts
```
