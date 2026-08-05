---
type: task
status: done
---

## What to build

Implement field-aware URL cleaning and split decision artifacts (CD-074). Resolve, enforce allowed origin, canonicalize, normalize configured route variants, and deduplicate while retaining provenance. Give every ordered keep/drop rule a stable ID, version, priority, reason, and proof scope. Hard-drop only when a rule proves the route cannot populate any researchable field. Retain unknown, ambiguous, and unmatched URLs. Write `clean-url-inventory.json`, `deterministic-rejected-urls.json`, and append-only `url-clean-decisions.jsonl`. For every hard drop, record all researchable fields as `not_applicable_by_deterministic_rule`.

Targets: `src/research/url-map-recon/url-clean.ts`, versioned URL-rule registry, cleaning tests.

## Acceptance criteria

- [x] Every raw candidate has a decision row.
- [x] Kept and rejected sets are disjoint.
- [x] Unknown-purpose fixtures are kept.
- [x] Approved privacy, cookie, responsible-gaming, self-exclusion, history/account, user-account, and configured generic-lobby fixtures remain rejected.
- [x] `document-url-map.json` is not written by the new path.

## Blocked by

02-run-storage-atomic-writers, 05-template-requirements-compiler, 06-deterministic-url-extraction

## Out of scope

Do not add LLM relevance. Do not classify template categories.

## Human test card

- **What changed:** The URL classification system now writes three separate artifacts (clean-url-inventory.json, deterministic-rejected-urls.json, url-clean-decisions.jsonl) and every URL classification now includes stable rule metadata (ruleId, ruleVersion, priority, proofScope). Hard-dropped URLs are recorded with all researchable fields marked as `not_applicable_by_deterministic_rule`.
- **Check it yourself:** Run `/casino-discovery` on a test site. Verify that after stage 3 (URL cleaning), three files exist in the output directory: clean-url-inventory.json (array of kept URLs), deterministic-rejected-urls.json (array of rejected URLs), and url-clean-decisions.jsonl (one JSON line per raw candidate URL). Open decisions JSONL and verify each line has fields: rawUrl, canonicalUrl, keep (boolean), reason, source, ruleId, ruleVersion, priority, proofScope. For rejected URLs, verify researchableFields key contains at least one field marked as `not_applicable_by_deterministic_rule`.
- **Your check:** ⏳ not tested yet

## Critic notes

**Gate 3 analysis (would the locked test pass against EMPTY implementation?):**
- Yes. Three tests create a temporary directory, call cleanAndPersist, then verify files exist and have expected structure. Tests assert on file existence, array content, and field presence — all real output, not mocked.

**Is code hardcoded to test input?**
- No. Tests use different candidate batches: `/bonus`, `/account`, `/slots`, `/mysterious-page`, `/privacy` in one; `/bonus`, `/account`, `/api/games`, `/login` in another; `/account`, `/privacy`, `/history` in the third. Each test verifies different rules fire and produce different metadata.

**Test coverage with different data:**
- Locked test 1: verifies three artifacts exist with correct structure.
- Locked test 2: verifies every decision row includes rule metadata.
- Locked test 3: verifies hard drops include researchable fields mapping.
- All three tests use independent data sets and verify independent assertions.
- 8 new tests added, all passing. Backward compatibility: 31 pre-existing url-clean tests still pass.
