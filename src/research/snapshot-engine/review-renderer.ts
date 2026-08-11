// CD-N02: deterministic, evidence-only review.html renderer.
//
// Pure function over the run's own retained artifact contract (run-manifest.json,
// url-inventory.json, pages.jsonl, interactions.jsonl, json/*.json) — no browser-automation
// import, no LLM/API/subprocess-spawning import. Replaces the CD-N01 review.html stub.
//
// Evidence-linking note (per CD-N02): json-evidence-builder.ts (CD-N06) strips per-field
// evidenceIds before writing json/*.json — a fact's exact source URL is not recoverable from
// json/*.json alone once written to disk. Rather than changing CD-N06's committed schema (out of
// scope here), each JSON category block below links to the SET of visited page URLs for the run
// (from pages.jsonl) — the closest honestly-available "evidence record" reference. This is a
// known, deliberate limitation, not a fabricated per-field URL.
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type {
  DiscoveryRunManifest,
  InteractionCandidateRecord,
  UrlInventoryDocument,
  VisitedPageRecord,
} from './types.ts';

// CD-N03 rail rule IDs (see url-rules.ts canonicalProductCategory): the only ruleIds that denote
// a product-collection RAIL entry (live-casino sub-category, sports category root) rather than an
// individual game/table/event/league/competition page.
const RAIL_RULE_IDS = new Set([
  'URLR_KEEP_LIVE_CASINO_SUBCATEGORY',
  'URLR_KEEP_SPORT_CATEGORY',
  'URLR_KEEP_SPORT_CATEGORY_NORMALIZED',
]);

// Interaction outcomes that are "interesting" for the review's exceptions section: revealed new
// evidence, or failed/timed out/remained unresolved. `state_changed_no_new_evidence` and
// `no_effect` are routine successful/no-op outcomes (excluded); `detected_candidate_only` is a
// passive candidate that was never executed at all (excluded — nothing happened to review).
const EXCEPTION_OUTCOMES = new Set(['revealed_evidence', 'blocked', 'unsafe', 'timeout']);

interface JsonCategoryFile {
  category: string;
  rows: Array<Record<string, unknown>>;
}

async function readJsonlFile<T>(filePath: string): Promise<T[]> {
  if (!existsSync(filePath)) return [];
  const raw = await readFile(filePath, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

async function readJsonCategoryFiles(jsonDir: string): Promise<JsonCategoryFile[]> {
  if (!existsSync(jsonDir)) return [];
  const entries = await readdir(jsonDir, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const files: JsonCategoryFile[] = [];
  for (const name of names) {
    const raw = JSON.parse(await readFile(path.join(jsonDir, name), 'utf8')) as {
      category: string;
      rows: Array<Record<string, unknown>>;
    };
    files.push({ category: raw.category ?? name.replace(/\.json$/, ''), rows: raw.rows ?? [] });
  }
  return files;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function countFields(rows: Array<Record<string, unknown>>): { populated: number; missing: number } {
  let populated = 0;
  let missing = 0;
  for (const row of rows) {
    for (const value of Object.values(row)) {
      if (value === null || value === undefined) missing += 1;
      else populated += 1;
    }
  }
  return { populated, missing };
}

export async function renderReviewHtml(runDir: string): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(runDir, 'run-manifest.json'), 'utf8')) as DiscoveryRunManifest;
  const urlInventory = JSON.parse(await readFile(path.join(runDir, 'url-inventory.json'), 'utf8')) as UrlInventoryDocument;
  const pages = await readJsonlFile<VisitedPageRecord>(path.join(runDir, 'pages.jsonl'));
  const interactionRecords = await readJsonlFile<InteractionCandidateRecord>(path.join(runDir, 'interactions.jsonl'));
  const jsonCategoryFiles = await readJsonCategoryFiles(path.join(runDir, 'json'));

  const blockedCount = pages.filter((p) => p.failureReason === 'blocked_suspected').length;

  let interactionSuccess = 0;
  let interactionUnresolved = 0;
  const exceptionRows: Array<{ requestedUrl: string; finalUrl?: string; tag: string; role?: string; name?: string; label: string }> = [];
  for (const record of interactionRecords) {
    for (const candidate of record.candidates) {
      if (candidate.label === 'revealed_evidence' || candidate.label === 'state_changed_no_new_evidence') interactionSuccess += 1;
      else if (candidate.label === 'blocked' || candidate.label === 'unsafe' || candidate.label === 'timeout') interactionUnresolved += 1;
      if (EXCEPTION_OUTCOMES.has(candidate.label)) {
        exceptionRows.push({
          requestedUrl: record.requestedUrl,
          finalUrl: record.finalUrl,
          tag: candidate.tag,
          role: candidate.role,
          name: candidate.name,
          label: candidate.label,
        });
      }
    }
  }
  exceptionRows.sort((a, b) => a.requestedUrl.localeCompare(b.requestedUrl) || a.label.localeCompare(b.label));

  const visitedUrls = pages
    .filter((p) => p.status === 'visited')
    .map((p) => p.finalUrl ?? p.requestedUrl)
    .sort((a, b) => a.localeCompare(b));

  const railEntries = [...urlInventory.accepted]
    .filter((row) => RAIL_RULE_IDS.has(row.ruleId))
    .map((row) => ({ url: row.resolvedUrl ?? row.rawUrl, ruleId: row.ruleId }))
    .sort((a, b) => a.url.localeCompare(b.url));

  const jsonSectionRows = [...jsonCategoryFiles]
    .sort((a, b) => a.category.localeCompare(b.category))
    .map((file) => {
      const { populated, missing } = countFields(file.rows);
      return `<tr><td>${escapeHtml(file.category)}</td><td>${file.rows.length}</td><td>${populated}</td><td>${missing}</td></tr>`;
    })
    .join('\n');

  const railRows = railEntries
    .map((entry) => `<tr><td>${escapeHtml(entry.url)}</td><td>${escapeHtml(entry.ruleId)}</td></tr>`)
    .join('\n');

  const exceptionHtmlRows = exceptionRows
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.finalUrl ?? row.requestedUrl)}</td><td>${escapeHtml(row.tag)}${row.name ? ` (${escapeHtml(row.name)})` : ''}</td><td>${escapeHtml(row.label)}</td></tr>`,
    )
    .join('\n');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Review — ${escapeHtml(manifest.casinoName)} (${escapeHtml(manifest.runFolderName)})</title>
</head>
<body>
<h1 id="run-summary">Run summary</h1>
<ul>
<li>Casino: ${escapeHtml(manifest.casinoName)}</li>
<li>Geo: ${escapeHtml(manifest.geo ?? manifest.geoSlug)}</li>
<li>Started: ${escapeHtml(manifest.startedAt)}</li>
<li>Completed: ${escapeHtml(manifest.completedAt)}</li>
<li>Accepted: ${manifest.counts.accepted}</li>
<li>Visited: ${manifest.counts.visited}</li>
<li>Failed: ${manifest.counts.failed}</li>
<li>Blocked: ${blockedCount}</li>
<li>Interaction success: ${interactionSuccess}</li>
<li>Interaction unresolved: ${interactionUnresolved}</li>
<li>Generated JSON files: ${jsonCategoryFiles.length}</li>
</ul>

<h1 id="json-results">JSON results</h1>
<table>
<thead><tr><th>Category</th><th>Rows</th><th>Populated fields</th><th>Missing fields</th></tr></thead>
<tbody>
${jsonSectionRows}
</tbody>
</table>
<p>Source: visited page URLs for this run (evidenceIds are stripped before json/*.json is written — see json-evidence-builder.ts — so per-field source URLs are not recoverable post-run; the closest honest reference is the run's full visited-page set).</p>
<ul>
${visitedUrls.map((url) => `<li>${escapeHtml(url)}</li>`).join('\n')}
</ul>

<h1 id="product-collections">Product collections</h1>
<table>
<thead><tr><th>URL</th><th>Rule</th></tr></thead>
<tbody>
${railRows}
</tbody>
</table>

<h1 id="interaction-exceptions">Interaction exceptions</h1>
<table>
<thead><tr><th>Page</th><th>Element</th><th>Outcome</th></tr></thead>
<tbody>
${exceptionHtmlRows}
</tbody>
</table>
</body>
</html>
`;
}
