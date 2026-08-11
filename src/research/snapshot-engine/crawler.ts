import type { BrowserContext, Page } from 'playwright';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { capturePage } from './page-capture.ts';
import { decideUrl, extractLocale, URL_RULES_VERSION } from './url-rules.ts';
import {
  discoverFromPage,
  discoverRobotsAndSitemaps,
  PassiveNetworkObserver,
  scanSameDomainTextSources,
  withTimeout,
  TimeoutError,
  ROBOTS_SITEMAP_BATCH_TIMEOUT_MS,
  TEXT_SOURCE_BATCH_TIMEOUT_MS,
  type DiscoverySink,
  type SourceRunOutcome,
} from './url-discovery.ts';
import type {
  CandidateProvenance,
  DiscoveryRunManifest,
  InteractionCandidateRecord,
  PageBehaviorRecord,
  PageSnapshotRecord,
  RawUrlCandidate,
  RunContextRecord,
  RunStatus,
  SourceCoverageRecord,
  SourceFamily,
  SourceFamilyStatus,
  UrlDecisionRecord,
  VisitedPageRecord,
} from './types.ts';
import { appendJsonLine, ensureDir, makeRunId, slugify, stablePageBasename, writeJsonAtomic, writeTextAtomic } from './io.ts';
import { writeReviewInput } from './review-input.ts';
import { validateNetworkEvidenceIndex } from './post-run-review.ts';
import { renderReviewHtml } from './review-renderer.ts';
import { finalizeDebugArtifacts } from './debug-artifacts.ts';
import { buildPageCorpus } from './page-content-pruner.ts';
import { runJsonEvidenceBuild } from './json-evidence-builder.ts';
import {
  resolveRuntimeBudgets,
  ProgressWatchdog,
  NoProgressError,
  type RuntimeBudgetOverrides,
} from './runtime-config.ts';

// CD-N01: used when a caller doesn't supply --geo. Not a real ISO/geo code — a deliberate,
// consistent placeholder so a run folder name is always well-formed
// (`<casino-slug>-<geo>-<date>-<time>`) even for a geo-agnostic/global crawl.
const GEO_FALLBACK = 'xx';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

// CD-N01: run folder timestamps are always UTC, so two runs kicked off in different local
// timezones for the same casino/geo never collide or sort inconsistently on disk.
function formatRunFolderTimestamp(date: Date): string {
  return (
    `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}-` +
    `${pad2(date.getUTCHours())}-${pad2(date.getUTCMinutes())}-${pad2(date.getUTCSeconds())}`
  );
}

function readPlaywrightVersion(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    return (require('playwright/package.json') as { version?: string }).version;
  } catch {
    return undefined;
  }
}

// Serializes appends to a single JSONL file. sink.add/sink.error are called synchronously
// from within discovery helpers (no `await` at the call site), so appends made from inside
// those callbacks must be queued rather than raced — otherwise concurrent fs writes to the
// same file could interleave. `flush()` lets an awaited caller block until every queued
// append for this file has actually landed on disk.
function makeSerialAppender<T>(filePath: string) {
  let chain: Promise<void> = Promise.resolve();
  return {
    append(record: T): void {
      chain = chain.then(() => appendJsonLine(filePath, record));
    },
    flush(): Promise<void> {
      return chain;
    },
  };
}

export interface CrawlOptions {
  context: BrowserContext;
  page: Page;
  entryUrl: string;
  outputDir: string;
  // CD-N01: required — drives the user-facing run folder name (casino-slug segment). Same
  // required-ness as entryUrl/--url; there is no sensible default for a casino's display name.
  casinoName: string;
  geo?: string;
  templateDir?: string;
  settleMs?: number;
  navigationTimeoutMs?: number;
  // FIX-07: deterministic upper bounds. All overridable (fake/small values for tests), all
  // default to production-safe values so normal runs are unaffected in practice.
  pageCaptureTimeoutMs?: number;
  textSourceBatchTimeoutMs?: number;
  robotsSitemapBatchTimeoutMs?: number;
  runDeadlineMs?: number;
  // CD-N01: when true, an ordinary successful run keeps its full raw diagnostics on disk under
  // `<runDir>/debug/` instead of discarding them. Has no effect on a partial/error run, which
  // always packages `<runDir>/debug.zip` regardless of this flag.
  debugArtifacts?: boolean;
  // CD-N07: per-budget CLI/programmatic overrides layered on top of DEFAULT_RUNTIME_BUDGETS (see
  // runtime-config.ts). Any budget not explicitly listed here still falls back to its documented
  // default. The individual *TimeoutMs options already on this interface (settleMs,
  // navigationTimeoutMs, pageCaptureTimeoutMs, textSourceBatchTimeoutMs,
  // robotsSitemapBatchTimeoutMs) continue to take precedence over the corresponding entry here
  // when both are supplied, preserving existing call-site behavior.
  runtimeBudgetOverrides?: RuntimeBudgetOverrides;
}

// CD-N07: whole page-capture/profiler step (navigation + settle + DOM/behavior profiling +
// interaction expansion) per page, sourced from the centralized runtime-config default. Generous
// relative to navigationTimeoutMs/settleMs so it only fires when the step as a whole — not just
// navigation — gets stuck (e.g. a hung profiler evaluate()).
// FIX-07: run-level watchdog. Generous default so a normal multi-page crawl never hits it in
// practice; exists purely so the process can never remain silently active indefinitely.
const DEFAULT_RUN_DEADLINE_MS = 30 * 60_000;

interface AggregatedCandidate {
  rawUrl: string;
  provenance: CandidateProvenance[];
}

// A URL observed while a Stage-4 (frozen-inventory) page was visited. These are recorded
// for review/future runs only — they never re-enter the current run's accepted visit queue.
export interface PostVisitObservation {
  rawUrl: string;
  canonicalUrl?: string;
  decision: UrlDecisionRecord['decision'];
  ruleId: string;
  reason: string;
  observedDuringVisitOf: string;
  provenance: CandidateProvenance;
}

function acceptedInventoryFingerprint(urls: readonly string[]): string {
  return `${urls.length}:${urls.join('|')}`;
}

// FIX-03: deterministic route identity. Every raw candidate that decideUrl() resolved to the
// same canonicalUrl (e.g. /payments and /en/payments) is a locale/redirect alias of one research
// page, not a separate visit. Among the aliases, pick one representative resolvedUrl to actually
// navigate to:
//   1. an alias whose locale matches the run's active locale (derived from entryUrl), if any;
//   2. otherwise any localized alias (deterministic tie-break: lexicographically smallest
//      resolvedUrl), since a localized URL is preferred over the bare form whenever one was
//      discovered;
//   3. otherwise the lexicographically smallest alias (typically the sole/bare form).
// Sorting before picking makes the choice independent of DOM/discovery ordering.
function pickRepresentativeDecision(
  aliasDecisions: readonly UrlDecisionRecord[],
  activeLocale: string | undefined,
): UrlDecisionRecord {
  const sorted = [...aliasDecisions].sort((a, b) =>
    (a.resolvedUrl ?? a.rawUrl).localeCompare(b.resolvedUrl ?? b.rawUrl),
  );
  if (activeLocale) {
    const activeMatch = sorted.find((row) => row.locale?.toLowerCase() === activeLocale.toLowerCase());
    if (activeMatch) return activeMatch;
  }
  const anyLocalized = sorted.find((row) => row.locale);
  if (anyLocalized) return anyLocalized;
  return sorted[0]!;
}

export const SOURCE_FAMILIES: SourceFamily[] = [
  'entry',
  'dom_url_attribute',
  'document_metadata',
  'performance_resource',
  'inline_script_url_token',
  'external_script_url_token',
  'network_request',
  'network_response',
  'network_body_url_token',
  'robots_sitemap',
  'sitemap_url',
  'frame_url',
  'redirect',
];

export async function crawlSite(options: CrawlOptions): Promise<DiscoveryRunManifest> {
  const runId = makeRunId();
  const startedAt = new Date();
  const entry = new URL(options.entryUrl);
  const allowedOrigin = entry.origin;
  const allowedHostname = entry.hostname.replace(/^www\./, '');

  // CD-N01: the run's user-facing folder name. `runId` (opaque) is kept only inside
  // run-manifest.json for cross-referencing; it is never used as, or embedded in, the folder
  // name itself.
  const casinoSlug = slugify(options.casinoName);
  const geoSlug = slugify(options.geo ?? GEO_FALLBACK) || GEO_FALLBACK;
  const runFolderName = `${casinoSlug}-${geoSlug}-${formatRunFolderTimestamp(startedAt)}`;
  const runDir = path.join(options.outputDir, runFolderName);

  // CD-N01: the 7-item retained artifact contract, at the run folder root.
  const runManifestPath = path.join(runDir, 'run-manifest.json');
  const urlInventoryPath = path.join(runDir, 'url-inventory.json');
  const pagesJsonlPath = path.join(runDir, 'pages.jsonl');
  const interactionsJsonlPath = path.join(runDir, 'interactions.jsonl');
  const corpusDir = path.join(runDir, 'corpus');
  const jsonDir = path.join(runDir, 'json');
  const reviewHtmlPath = path.join(runDir, 'review.html');
  // CF-02: run-scoped network evidence sink — bounded same-origin xhr/fetch response bodies
  // observed while visiting accepted document pages, persisted alongside (not instead of) the
  // existing URL-token discovery. Never a new navigation target.
  const networkEvidenceDir = path.join(runDir, 'network');
  const networkEvidenceIndexPath = path.join(runDir, 'network-evidence.jsonl');
  await ensureDir(corpusDir);
  await ensureDir(jsonDir);
  await ensureDir(networkEvidenceDir);
  // CD-N01: pages.jsonl/interactions.jsonl are part of the retained 7-item contract and must
  // exist (possibly empty) as soon as the run folder is created — not only once the first page
  // visit/interaction-candidate happens to append a line, so a run with zero accepted URLs (or
  // zero pages with a detected interactive candidate) still satisfies the contract.
  await writeTextAtomic(pagesJsonlPath, '');
  await writeTextAtomic(interactionsJsonlPath, '');

  // CD-N01: everything below is DEBUG-ONLY material — raw URL candidates, per-decision JSONL,
  // internal source-coverage snapshots, raw HTML/trace per page, the review-input.ts payload,
  // and verbose run-event logs. None of it is a permanent top-level artifact any more; it lives
  // under `<runDir>/debug` for the duration of the run and is discarded/kept/zipped once the
  // run reaches a terminal state (see finalizeDebugArtifacts below).
  // CD-N01: named `debug` (not a hidden dot-directory) from the start, so a run kept via
  // --debug-artifacts never needs a rename that would invalidate htmlPath/tracePath references
  // already recorded in pages.jsonl/interactions.jsonl/page-snapshots.jsonl.
  // CD-N07: set once runCrawl() creates its ProgressWatchdog, so the outer cleanup wrapper below
  // can always stop its timer regardless of how runCrawl() exits.
  let noProgressWatchdogHandle: ProgressWatchdog | undefined;

  const debugWorkDir = path.join(runDir, 'debug');
  const pagesDir = path.join(debugWorkDir, 'pages');
  await ensureDir(pagesDir);
  const runContextPath = path.join(debugWorkDir, 'run-context.json');
  const rawUrlCandidatesPath = path.join(debugWorkDir, 'raw-url-candidates.json');
  const urlSourceCoveragePath = path.join(debugWorkDir, 'url-source-coverage.json');
  const acceptedUrlInventoryPath = path.join(debugWorkDir, 'accepted-url-inventory.json');
  const deterministicRejectedUrlsPath = path.join(debugWorkDir, 'deterministic-rejected-urls.json');
  const urlCleanDecisionsPath = path.join(debugWorkDir, 'url-clean-decisions.jsonl');
  const pageVisitsPath = path.join(debugWorkDir, 'page-visits.jsonl');
  const pageSnapshotsPath = path.join(debugWorkDir, 'page-snapshots.jsonl');
  const pageBehaviorPath = path.join(debugWorkDir, 'page-behavior.jsonl');
  const runEventsPath = path.join(debugWorkDir, 'run-events.jsonl');
  const reviewInputPath = path.join(debugWorkDir, 'review-input.json');
  const postVisitObservationsPath = path.join(debugWorkDir, 'post-visit-observations.json');

  const runEvents = makeSerialAppender<Record<string, unknown>>(runEventsPath);
  const logEvent = (event: string, details?: Record<string, unknown>): void => {
    runEvents.append({ timestamp: new Date().toISOString(), event, ...(details ? { details } : {}) });
  };
  logEvent('run_start', { runId, entryUrl: options.entryUrl, geo: options.geo });

  // CD-N01: everything from here through the manifest write is wrapped so that ANY uncaught
  // exception (a real bug/crash, or the Stage 4/5 freeze-invariant check below) still packages
  // whatever debug diagnostics were captured so far into debug.zip before the error propagates —
  // never silently loses the raw diagnostics for a run that broke mid-crawl. The 7 retained-
  // contract artifacts already on disk at crash time (pages.jsonl/interactions.jsonl entries
  // appended incrementally inside the loop below) are left exactly as they are; only the
  // debug-only working directory is touched here.
  try {
    return await runCrawlWithWatchdogCleanup();
  } catch (error) {
    await finalizeDebugArtifacts({ runDir, debugWorkDir, runTerminatedCleanly: false, debugArtifacts: Boolean(options.debugArtifacts) });
    throw error;
  }

  // CD-N07: guarantees the no-progress watchdog's internal timer is always cleared — success,
  // thrown error, or invariant-violation throw alike — so it can never keep the Node process
  // alive past run completion (an unresolved timer would otherwise block terminal completion of
  // the process even though the run's own promise already settled).
  async function runCrawlWithWatchdogCleanup(): Promise<DiscoveryRunManifest> {
    try {
      return await runCrawl();
    } finally {
      noProgressWatchdogHandle?.stop();
    }
  }

  async function runCrawl(): Promise<DiscoveryRunManifest> {
  // CD-N07: single resolved set of time budgets for this run, layering options.runtimeBudgetOverrides
  // on top of the documented defaults. Individual legacy *TimeoutMs options below still take
  // precedence over their corresponding budget when both are supplied.
  const budgets = resolveRuntimeBudgets(options.runtimeBudgetOverrides);
  // CD-N07: no-progress watchdog — touched on every observed stage/page/action progress event
  // below. If it fires, the current bounded page-processing operation is abandoned (raced via
  // Promise.race, never left dangling as something the run waits on) and every remaining
  // accepted URL is finalized as not-attempted, same as the existing run-deadline watchdog.
  const noProgressWatchdog = new ProgressWatchdog(budgets.noProgressWatchdogMs);
  noProgressWatchdogHandle = noProgressWatchdog;
  noProgressWatchdog.start();
  let noProgressWatchdogFired = false;

  const urlCleanDecisions = makeSerialAppender<UrlDecisionRecord>(urlCleanDecisionsPath);

  const aggregate = new Map<string, AggregatedCandidate>();
  const decisionsByCanonical = new Map<string, UrlDecisionRecord>();
  const decisionsOther = new Map<string, UrlDecisionRecord>();
  const provenanceByCanonical = new Map<string, CandidateProvenance[]>();
  // FIX-03: every raw decision seen for a given canonicalUrl, kept until discovery freeze so the
  // representative (visited) URL can be chosen deterministically from the full alias set instead
  // of last-write-wins order.
  const aliasDecisionsByCanonical = new Map<string, UrlDecisionRecord[]>();
  const visitedRequested = new Set<string>();
  const visited: VisitedPageRecord[] = [];
  const sourceErrors = new Map<SourceFamily, string[]>();
  const sourceErrorDetails = new Map<SourceFamily, Array<{ name: string; message: string }>>();
  // FIX-06: last-recorded explicit run outcome per source family, populated by
  // DiscoverySink.recordRun() calls from url-discovery.ts extractors. Shared by the
  // discovery-phase sink and the post-visit (crawl-phase) sink so a family whose only
  // signal comes from the crawl phase (e.g. 'redirect', or a live network body scan) still
  // resolves to an explicit terminal state rather than defaulting to 'unsupported'.
  const sourceRunOutcomes = new Map<SourceFamily, SourceRunOutcome>();
  const textSourceUrls = new Set<string>();
  const scannedTextSourceUrls = new Set<string>();
  const postVisitObservations: PostVisitObservation[] = [];

  const sink: DiscoverySink = {
    add(candidate: RawUrlCandidate) {
      const key = `${candidate.rawUrl}\u0000${candidate.provenance.sourceFamily}\u0000${candidate.provenance.discoveredOn}\u0000${candidate.provenance.sourceUrl ?? ''}`;
      const current = aggregate.get(key) ?? { rawUrl: candidate.rawUrl, provenance: [] };
      if (!current.provenance.some((p) =>
        p.sourceFamily === candidate.provenance.sourceFamily &&
        p.discoveredOn === candidate.provenance.discoveredOn &&
        p.sourceUrl === candidate.provenance.sourceUrl &&
        p.attribute === candidate.provenance.attribute
      )) {
        current.provenance.push(candidate.provenance);
      }
      aggregate.set(key, current);

      const decision = decideUrl(candidate.rawUrl, candidate.provenance.discoveredOn || options.entryUrl, allowedHostname, current.provenance);
      // Appended as each decision is made (not batched) so a crash mid-discovery still leaves
      // a factual, in-order record of every URL decision attempted so far.
      urlCleanDecisions.append(decision);
      if (decision.canonicalUrl) {
        const canonicalKey = decision.canonicalUrl;
        const provenance = provenanceByCanonical.get(canonicalKey) ?? [];
        for (const p of current.provenance) {
          if (!provenance.some((existing) =>
            existing.sourceFamily === p.sourceFamily && existing.discoveredOn === p.discoveredOn && existing.sourceUrl === p.sourceUrl && existing.attribute === p.attribute
          )) provenance.push(p);
        }
        provenanceByCanonical.set(canonicalKey, provenance);
        // FIX-03: accumulate rather than overwrite — decisionsByCanonical is populated
        // deterministically from this list at freeze time (see pickRepresentativeDecision), so a
        // later-discovered alias can never silently displace an already-chosen representative.
        const aliasList = aliasDecisionsByCanonical.get(canonicalKey) ?? [];
        aliasList.push(decision);
        aliasDecisionsByCanonical.set(canonicalKey, aliasList);
      } else {
        decisionsOther.set(`${candidate.rawUrl}\u0000${decision.ruleId}`, decision);
      }

      try {
        const resolved = new URL(candidate.rawUrl, candidate.provenance.discoveredOn || options.entryUrl);
        const scopedHost = resolved.hostname.replace(/^www\./, '');
        const inScope = scopedHost === allowedHostname || scopedHost.endsWith(`.${allowedHostname}`);
        const textLikeSource = /\.(?:js|mjs|json|xml)(?:$|\?)/i.test(resolved.pathname) ||
          /(?:^|\/)(?:api|config|manifest|graphql)(?:\/|$)/i.test(resolved.pathname);
        if (inScope && textLikeSource) textSourceUrls.add(resolved.href);
      } catch {
        // Already represented by URL decision.
      }
    },
    error(sourceFamily, message) {
      const errors = sourceErrors.get(sourceFamily) ?? [];
      errors.push(message);
      sourceErrors.set(sourceFamily, errors);
      const details = sourceErrorDetails.get(sourceFamily) ?? [];
      details.push({ name: 'Error', message });
      sourceErrorDetails.set(sourceFamily, details);
      logEvent('discovery_source_error', { sourceFamily, message });
    },
    recordRun(sourceFamily, outcome) {
      sourceRunOutcomes.set(sourceFamily, outcome);
    },
  };

  const textSourceBatchTimeoutMs = options.textSourceBatchTimeoutMs ?? TEXT_SOURCE_BATCH_TIMEOUT_MS;
  const robotsSitemapBatchTimeoutMs = options.robotsSitemapBatchTimeoutMs ?? ROBOTS_SITEMAP_BATCH_TIMEOUT_MS;

  // FIX-07: the text-source scan batch can otherwise loop indefinitely if a single fetch never
  // resolves. Each batch attempt is bounded; on timeout the still-unscanned URLs for this
  // attempt are marked scanned (so the outer loop can't retry them forever) and the affected
  // families get an explicit terminal error rather than a silently truncated/empty result.
  const drainTextSources = async (): Promise<void> => {
    while (true) {
      const unscanned = [...textSourceUrls].filter((url) => !scannedTextSourceUrls.has(url)).sort();
      if (unscanned.length === 0) return;
      try {
        await withTimeout(
          scanSameDomainTextSources(options.context, unscanned, allowedHostname, sink, scannedTextSourceUrls),
          textSourceBatchTimeoutMs,
          `Text-source scan batch exceeded ${textSourceBatchTimeoutMs}ms deadline with ${unscanned.length} url(s) pending`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const url of unscanned) scannedTextSourceUrls.add(url);
        sink.error('external_script_url_token', message);
        sink.error('network_body_url_token', message);
        logEvent('text_source_batch_timeout', { message, pendingCount: unscanned.length });
        return;
      }
    }
  };

  // --- Phase 1-3: terminal URL discovery, then canonicalize/filter every candidate. ---
  // This must run to completion — including draining every same-domain text source it
  // uncovers — before a single page is visited, so discovery/filtering can never be
  // re-entered by a page visit made later in this function.
  sink.add({
    rawUrl: options.entryUrl,
    provenance: { sourceFamily: 'entry', discoveredOn: options.entryUrl, sourceUrl: options.entryUrl, label: 'entry' },
  });
  sourceRunOutcomes.set('entry', { status: 'complete' });

  // Bootstrap discovery uses the already-authenticated page state without creating a research-page
  // visit record for an entry/root URL that URL Rules may explicitly reject.
  // CD-N07: bounded by sourceFamilyDiscoveryTimeoutMs — a single stuck discoverFromPage() pass
  // (e.g. a hung frame.evaluate()) must not stall the whole run before a single page is visited.
  try {
    await withTimeout(
      discoverFromPage(options.page, sink),
      budgets.sourceFamilyDiscoveryTimeoutMs,
      `Bootstrap source-family discovery exceeded ${budgets.sourceFamilyDiscoveryTimeoutMs}ms deadline`,
    );
  } catch (error) {
    if (!(error instanceof TimeoutError)) throw error;
    logEvent('source_family_discovery_timeout', { stage: 'bootstrap', message: error.message });
  }
  noProgressWatchdog.touch();
  // FIX-07: robots.txt/sitemap.xml discovery is an unbounded fetch-follow loop (sitemap index
  // files can reference further sitemaps); bound the whole batch so a stuck fetch can't hang
  // discovery forever. On timeout both source families it can produce get an explicit terminal
  // error rather than silently short-circuiting to 'absent'/'unsupported'.
  try {
    await withTimeout(
      discoverRobotsAndSitemaps(options.context, allowedOrigin, sink),
      robotsSitemapBatchTimeoutMs,
      `robots/sitemap discovery batch exceeded ${robotsSitemapBatchTimeoutMs}ms deadline`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sink.error('robots_sitemap', message);
    sink.error('sitemap_url', message);
    logEvent('robots_sitemap_batch_timeout', { message });
  }
  noProgressWatchdog.touch();
  await drainTextSources();
  noProgressWatchdog.touch();

  // FIX-03: resolve every canonical route's alias set into exactly one merged decision before
  // the inventory is frozen, so /payments + /en/payments (etc.) collapse into a single accepted
  // target with combined provenance instead of two. The chosen representative's resolvedUrl
  // (preferring a localized alias — see pickRepresentativeDecision) becomes the actual page-visit
  // navigation target; canonicalUrl remains the locale-agnostic route identity used for dedup.
  const activeLocale = extractLocale(entry.pathname);
  for (const [canonicalKey, aliasDecisions] of aliasDecisionsByCanonical) {
    const representative = pickRepresentativeDecision(aliasDecisions, activeLocale);
    const aliasUrls = [...new Set(aliasDecisions.map((row) => row.resolvedUrl ?? row.rawUrl))]
      .filter((url) => url !== (representative.resolvedUrl ?? representative.rawUrl))
      .sort();
    decisionsByCanonical.set(canonicalKey, {
      ...representative,
      provenance: provenanceByCanonical.get(canonicalKey) ?? representative.provenance,
      aliasUrls: aliasUrls.length > 0 ? aliasUrls : undefined,
    });
  }

  // --- Phase 4: freeze the accepted-URL inventory. ---
  // From this point on, decisionsByCanonical/decisionsOther/provenanceByCanonical are read-only:
  // nothing below this line is permitted to call `sink.add`/`sink.error` again.
  const acceptedInventory: readonly string[] = Object.freeze(
    [...decisionsByCanonical.values()]
      .filter((row): row is UrlDecisionRecord & { canonicalUrl: string } => row.decision === 'accepted' && Boolean(row.canonicalUrl))
      .map((row) => row.canonicalUrl)
      .sort(),
  );
  const frozenFingerprint = acceptedInventoryFingerprint(acceptedInventory);
  logEvent('discovery_complete', {
    candidateCount: aggregate.size,
    acceptedCount: acceptedInventory.length,
  });

  // --- FIX-05: write immutable discovery artifacts (canonical names 1-5) before a single
  // page is visited. Everything read here (decisionsByCanonical/decisionsOther/aggregate/
  // sourceErrors) is frozen as of Phase 4 above, so these files are guaranteed to describe
  // exactly what was discovered/accepted/rejected even if the crawl loop below hangs or crashes. ---
  await urlCleanDecisions.flush();

  const allDiscoveryDecisions = [...decisionsByCanonical.values(), ...decisionsOther.values()]
    .sort((a, b) => (a.canonicalUrl ?? a.rawUrl).localeCompare(b.canonicalUrl ?? b.rawUrl));
  const acceptedDecisions = allDiscoveryDecisions.filter((row) => row.decision === 'accepted');
  const nonAcceptedDecisions = allDiscoveryDecisions.filter((row) => row.decision !== 'accepted');

  // FIX-06: exactly one terminal status per configured source family. Resolution order:
  //   1. any recorded error for the family forces 'error' (a bounded operation that threw or
  //      blew through its deadline — e.g. FIX-01's response-body-scan timeout — can never
  //      resolve to a silent empty-success state);
  //   2. otherwise the extractor's own explicitly-recorded outcome (complete/absent/blocked/
  //      unsupported) from DiscoverySink.recordRun() is used verbatim;
  //   3. a family with neither is one whose extractor never actually ran this run, and is
  //      reported 'unsupported' rather than inferring 'complete' from silence.
  const buildCoverage = (decisionsForCounts: UrlDecisionRecord[]): SourceCoverageRecord[] =>
    SOURCE_FAMILIES.map((sourceFamily) => {
      const rows = decisionsForCounts.filter((row) => row.provenance.some((p) => p.sourceFamily === sourceFamily));
      const errors = sourceErrors.get(sourceFamily) ?? [];
      const outcome = sourceRunOutcomes.get(sourceFamily);
      const status: SourceFamilyStatus = errors.length > 0 ? 'error' : outcome?.status ?? 'unsupported';
      return {
        sourceFamily,
        status,
        candidateCount: rows.length,
        acceptedCount: rows.filter((row) => row.decision === 'accepted').length,
        rejectedCount: rows.filter((row) => row.decision === 'rejected').length,
        tbdCount: rows.filter((row) => row.decision === 'tbd').length,
        errors,
        errorDetails: sourceErrorDetails.get(sourceFamily) ?? [],
        durationMs: outcome?.durationMs,
      };
    });

  const frozenCoverage: SourceCoverageRecord[] = buildCoverage(allDiscoveryDecisions);

  const runContext: RunContextRecord = {
    schemaVersion: '1.0',
    runId,
    entryUrl: options.entryUrl,
    allowedOrigin,
    geo: options.geo,
    templateDir: options.templateDir,
    startedAt: startedAt.toISOString(),
    urlRulesVersion: URL_RULES_VERSION,
    browserMode: 'cdp',
    interactionMode: 'passive_only',
  };
  await writeJsonAtomic(runContextPath, runContext);
  await writeJsonAtomic(
    rawUrlCandidatesPath,
    [...aggregate.values()].sort((a, b) => a.rawUrl.localeCompare(b.rawUrl)),
  );
  await writeJsonAtomic(urlSourceCoveragePath, frozenCoverage);
  await writeJsonAtomic(acceptedUrlInventoryPath, acceptedDecisions);
  await writeJsonAtomic(deterministicRejectedUrlsPath, nonAcceptedDecisions);
  logEvent('discovery_artifacts_written', {
    runContextPath,
    rawUrlCandidatesPath,
    urlSourceCoveragePath,
    acceptedUrlInventoryPath,
    deterministicRejectedUrlsPath,
  });
  await runEvents.flush();

  // --- Phase 5: crawl the frozen inventory exactly once per canonical URL. ---
  // Passive network/DOM evidence observed during these visits is recorded via
  // `postVisitSink` below as review-only observations; it can never mutate
  // `decisionsByCanonical`/`acceptedInventory`, so it can never trigger an extra
  // same-run navigation.
  const postVisitSink: DiscoverySink = {
    add(candidate: RawUrlCandidate) {
      const decision = decideUrl(
        candidate.rawUrl,
        candidate.provenance.discoveredOn || options.entryUrl,
        allowedHostname,
        [candidate.provenance],
      );
      postVisitObservations.push({
        rawUrl: candidate.rawUrl,
        canonicalUrl: decision.canonicalUrl,
        decision: decision.decision,
        ruleId: decision.ruleId,
        reason: decision.reason,
        observedDuringVisitOf: currentVisitUrl,
        provenance: candidate.provenance,
      });
    },
    error(sourceFamily, message) {
      const errors = sourceErrors.get(sourceFamily) ?? [];
      errors.push(message);
      sourceErrors.set(sourceFamily, errors);
      const details = sourceErrorDetails.get(sourceFamily) ?? [];
      details.push({ name: 'Error', message });
      sourceErrorDetails.set(sourceFamily, details);
    },
    recordRun(sourceFamily, outcome) {
      sourceRunOutcomes.set(sourceFamily, outcome);
    },
  };

  logEvent('crawl_start', { acceptedCount: acceptedInventory.length });
  await runEvents.flush();

  // FIX-03: one target per canonical route identity. visitUrl is the representative (locale-
  // preferring) alias chosen above — the single URL actually navigated to for this route;
  // aliasUrls are the other discovered forms, preserved as history rather than re-visited.
  interface AcceptedTarget {
    canonicalUrl: string;
    visitUrl: string;
    aliasUrls: string[];
  }
  const acceptedTargets: AcceptedTarget[] = [...decisionsByCanonical.values()]
    .filter((row): row is UrlDecisionRecord & { canonicalUrl: string } => row.decision === 'accepted' && Boolean(row.canonicalUrl))
    .map((row) => ({
      canonicalUrl: row.canonicalUrl,
      visitUrl: row.resolvedUrl ?? row.canonicalUrl,
      aliasUrls: row.aliasUrls ?? [],
    }))
    .sort((a, b) => a.canonicalUrl.localeCompare(b.canonicalUrl));
  const targetsByCanonical = new Map(acceptedTargets.map((target) => [target.canonicalUrl, target]));

  const pageCaptureTimeoutMs = options.pageCaptureTimeoutMs ?? budgets.pageProcessingTimeoutMs;
  const runDeadlineMs = options.runDeadlineMs ?? DEFAULT_RUN_DEADLINE_MS;
  const runStartedAtMs = Date.now();
  let runDeadlineReached = false;
  // CD-N01: number of pages that produced at least one interactions.jsonl candidate row —
  // reconciled against interactions.jsonl's own line count in the manifest counts below.
  let interactionRecords = 0;

  let currentVisitUrl = '';
  let pageIndex = 0;
  for (const target of acceptedTargets) {
    if (visitedRequested.has(target.canonicalUrl)) continue;

    // FIX-07: run-level watchdog. Checked before every page attempt (never mid-attempt, so an
    // in-flight page always gets its own terminal record from the per-page bound above rather
    // than being silently abandoned). Once the deadline is reached, every remaining accepted URL
    // is marked with an explicit "not attempted, run deadline reached" terminal record — never
    // marked successful and never silently dropped.
    if (Date.now() - runStartedAtMs > runDeadlineMs) {
      runDeadlineReached = true;
      logEvent('run_deadline_reached', { remaining: acceptedInventory.length - visitedRequested.size, runDeadlineMs });
      await runEvents.flush();
      break;
    }
    // CD-N07: no-progress watchdog checked before every page attempt, same as the run-level
    // deadline above — never mid-attempt on this side of the check, so an in-flight page always
    // gets its own terminal record from the race below rather than being silently abandoned here.
    if (noProgressWatchdog.hasTriggered) {
      noProgressWatchdogFired = true;
      logEvent('no_progress_watchdog_triggered', { remaining: acceptedInventory.length - visitedRequested.size, budgetMs: budgets.noProgressWatchdogMs });
      await runEvents.flush();
      break;
    }

    visitedRequested.add(target.canonicalUrl);
    currentVisitUrl = target.canonicalUrl;
    const requestedUrl = target.visitUrl;

    const network = new PassiveNetworkObserver(
      options.page,
      postVisitSink,
      allowedHostname,
      budgets.networkObserverFlushTimeoutMs,
      budgets.responseBodyScanTimeoutMs,
      { evidenceDir: networkEvidenceDir, evidenceIndexPath: networkEvidenceIndexPath },
    );
    network.start();
    pageIndex += 1;
    logEvent('page_attempt', { requestedUrl, canonicalUrl: target.canonicalUrl, pageIndex });
    await runEvents.flush();
    noProgressWatchdog.touch();
    const discoveredBy = provenanceByCanonical.get(target.canonicalUrl) ?? [{ sourceFamily: 'entry', discoveredOn: options.entryUrl }];
    const pageStarted = new Date();
    let record: VisitedPageRecord;
    try {
      // FIX-07/CD-N07: bound the whole capture/profiler step (navigation, settle, DOM/behavior
      // profiling, interaction expansion) — a synthetic never-resolving capturePage() must still
      // produce a terminal error record rather than hang the crawl loop forever. Also raced
      // against the no-progress watchdog: a page stuck on this step for longer than the
      // no-progress budget (with no other progress observed elsewhere) is abandoned the same way.
      record = await Promise.race([
        withTimeout(
          capturePage({
            page: options.page,
            requestedUrl,
            pageIndex,
            pagesDir,
            // FIX-09: bumped from 1_500ms — real-world SPAs (ongoing WebSocket/analytics traffic,
            // animations) routinely keep mutating the DOM well past a short settle window even
            // though navigation itself already succeeded. A settle timeout is no longer fatal to
            // the page visit (see page-capture.ts), so this is purely a best-effort observation
            // budget, not a pass/fail gate — widening it just means more real pages settle
            // cleanly (settleStatus: 'settled') instead of falling through to a best-effort
            // ('timeout') capture.
            settleMs: options.settleMs ?? budgets.pageSettleMs,
            navigationTimeoutMs: options.navigationTimeoutMs ?? budgets.navigationTimeoutMs,
            interactionExpansionTimeoutMs: budgets.interactionExpansionTimeoutMs,
            discoveredBy,
            networkObserver: network,
          }),
          pageCaptureTimeoutMs,
          `Page capture exceeded ${pageCaptureTimeoutMs}ms deadline for ${requestedUrl}`,
        ),
        noProgressWatchdog.whenTriggered,
      ]);
      // Passive DOM observation from the visited page is recorded as a post-visit
      // observation only — it must never feed back into this run's accepted queue.
      if (record.status === 'visited') {
        try {
          await withTimeout(
            discoverFromPage(options.page, postVisitSink),
            budgets.sourceFamilyDiscoveryTimeoutMs,
            `Post-visit source-family discovery exceeded ${budgets.sourceFamilyDiscoveryTimeoutMs}ms deadline for ${requestedUrl}`,
          );
        } catch (discoveryError) {
          if (!(discoveryError instanceof TimeoutError)) throw discoveryError;
          logEvent('source_family_discovery_timeout', { stage: 'post_visit', requestedUrl, message: discoveryError.message });
        }
      }
      await network.flush();
      noProgressWatchdog.touch();
    } catch (error) {
      if (error instanceof NoProgressError) {
        // The no-progress watchdog fired while this page's capture was still in flight. The
        // capture promise is abandoned (never awaited further) — whatever it eventually resolves
        // to is discarded; only this typed timeout record is kept for this page.
        noProgressWatchdogFired = true;
        const message = error.message;
        const completed = new Date();
        record = {
          requestedUrl,
          finalUrl: undefined,
          status: 'failed',
          failureReason: 'no_progress_watchdog',
          discoveredBy,
          startedAt: pageStarted.toISOString(),
          completedAt: completed.toISOString(),
          durationMs: completed.getTime() - pageStarted.getTime(),
          error: { name: error.name, message },
        };
        logEvent('no_progress_watchdog_triggered', { requestedUrl, message });
        await runEvents.flush();
      } else if (!(error instanceof TimeoutError)) {
        // Only a bounded-deadline timeout (or the no-progress watchdog above) is turned into a
        // terminal per-page error record here. Any other exception (a genuine bug/crash) must
        // keep propagating uncaught, unchanged from pre-FIX-07 behavior, so a real crash
        // mid-crawl still aborts the run rather than being silently downgraded to a page failure.
        throw error;
      } else {
        const message = error.message;
        const completed = new Date();
        record = {
          requestedUrl,
          finalUrl: undefined,
          status: 'failed',
          failureReason: 'page_capture_timeout',
          discoveredBy,
          startedAt: pageStarted.toISOString(),
          completedAt: completed.toISOString(),
          durationMs: completed.getTime() - pageStarted.getTime(),
          error: { name: error.name, message },
        };
        logEvent('page_capture_timeout', { requestedUrl, message });
        await runEvents.flush();
      }
    } finally {
      // Listener cleanup must run even if capture/flush/discovery threw, so a stuck
      // response-body task never leaks listeners into the next page's observer.
      network.stop();
    }

    if (noProgressWatchdogFired) {
      record.canonicalUrl = target.canonicalUrl;
      if (target.aliasUrls.length > 0) record.aliasUrls = [...target.aliasUrls];
      visited.push(record);
      await appendJsonLine(pagesJsonlPath, record);
      await appendJsonLine(pageVisitsPath, record);
      logEvent('page_complete', { requestedUrl, status: record.status, failureReason: record.failureReason });
      await runEvents.flush();
      break;
    }

    record.canonicalUrl = target.canonicalUrl;
    if (target.aliasUrls.length > 0) record.aliasUrls = [...target.aliasUrls];

    if (record.finalUrl && record.finalUrl !== requestedUrl) {
      const finalDecision = decideUrl(record.finalUrl, requestedUrl, allowedHostname, [
        { sourceFamily: 'redirect', discoveredOn: requestedUrl, sourceUrl: requestedUrl, label: 'navigation-final-url' },
      ]);
      if (finalDecision.canonicalUrl === target.canonicalUrl) {
        // FIX-03: the redirect landed on the same canonical route this visit already
        // represents (e.g. requested /rules, browser followed a redirect to /en/rules). Merge
        // the redirect's provenance into this canonical target's combined provenance and record
        // the final URL as alias history — never enqueue/recapture the page a second time.
        const provenance = provenanceByCanonical.get(target.canonicalUrl) ?? [];
        provenance.push(finalDecision.provenance[0]!);
        provenanceByCanonical.set(target.canonicalUrl, provenance);
        record.aliasUrls = [...new Set([...(record.aliasUrls ?? []), record.finalUrl])];
      } else {
        // Redirected to a genuinely different route — recorded as a post-visit observation
        // only; it can never re-enter this run's frozen accepted queue (Phase 4/5 boundary).
        postVisitSink.add({
          rawUrl: record.finalUrl,
          provenance: { sourceFamily: 'redirect', discoveredOn: requestedUrl, sourceUrl: requestedUrl, label: 'navigation-final-url' },
        });
      }
      sourceRunOutcomes.set('redirect', { status: 'complete' });
    } else if (!sourceRunOutcomes.has('redirect')) {
      // Ran (a page was visited/attempted) but produced no redirect for this URL yet;
      // may still be upgraded to 'complete' by a later page's redirect in this same run.
      sourceRunOutcomes.set('redirect', { status: 'absent' });
    }
    visited.push(record);

    // FIX-05/CD-N01: append terminal per-page artifacts immediately (not batched at end of run)
    // so a hang/crash on a later page never erases the factual ledger for pages already
    // attempted. pages.jsonl is the retained, top-level contract file — it carries the exact
    // same record that used to go only to the debug-only page-visits.jsonl, which is still
    // written alongside it for debug reconciliation.
    await appendJsonLine(pagesJsonlPath, record);
    await appendJsonLine(pageVisitsPath, record);
    if (record.status === 'visited' && record.htmlPath && record.tracePath && record.htmlSha256) {
      const snapshotRecord: PageSnapshotRecord = {
        requestedUrl: record.requestedUrl,
        finalUrl: record.finalUrl ?? record.requestedUrl,
        httpStatus: record.httpStatus,
        settleStatus: record.settleStatus,
        title: record.title,
        htmlPath: record.htmlPath,
        tracePath: record.tracePath,
        htmlSha256: record.htmlSha256,
        capturedAt: record.completedAt,
      };
      await appendJsonLine(pageSnapshotsPath, snapshotRecord);

      try {
        const traceRaw = await readFile(record.tracePath, 'utf8');
        const behaviorRecord: PageBehaviorRecord = JSON.parse(traceRaw);
        await appendJsonLine(pageBehaviorPath, behaviorRecord);

        // CD-N01/CD-N04: interactions.jsonl (retained) carries the bounded per-candidate summary
        // derived from the full passive trace above (which stays debug-only in page-behavior.jsonl/
        // the raw per-page trace JSON file) — one row per page that had at least one detected
        // candidate. A candidate that CD-N04's interaction-delta-profiler actually executed
        // carries its real terminal InteractionOutcome (and actionClass) instead of the generic
        // 'detected_candidate_only' label; a candidate that was never eligible for automatic
        // execution keeps that generic label — it is never upgraded to an outcome label without a
        // real recorded action.
        const executedByDomPath = new Map(
          (behaviorRecord.interactionExecutions ?? []).map((execution) => [`${execution.frameUrl} ${execution.domPath}`, execution]),
        );
        const candidates = behaviorRecord.interactiveElements.map((el) => {
          const execution = executedByDomPath.get(`${el.frameUrl} ${el.domPath}`);
          return execution
            ? {
                tag: el.tag,
                role: el.role,
                name: el.name,
                domPath: el.domPath,
                label: execution.outcome,
                actionClass: execution.actionClass,
              }
            : {
                tag: el.tag,
                role: el.role,
                name: el.name,
                domPath: el.domPath,
                label: 'detected_candidate_only' as const,
              };
        });
        if (candidates.length > 0) {
          const interactionRecord: InteractionCandidateRecord = {
            requestedUrl: record.requestedUrl,
            finalUrl: record.finalUrl,
            capturedAt: record.completedAt,
            candidateCount: candidates.length,
            candidates,
          };
          await appendJsonLine(interactionsJsonlPath, interactionRecord);
          interactionRecords += 1;
        }

        // CD-N05: build the pruned, text-first LLM evidence corpus for this page from the same
        // baseline HTML + interaction-execution evidence used above — never raw HTML. One file
        // per visited page under corpus/, named after the same stable basename as its pages/
        // html+trace files for easy cross-referencing.
        try {
          const rawHtml = await readFile(record.htmlPath, 'utf8');
          const corpusText = buildPageCorpus({
            requestedUrl: record.requestedUrl,
            finalUrl: record.finalUrl ?? record.requestedUrl,
            title: record.title,
            html: rawHtml,
            interactionExecutions: behaviorRecord.interactionExecutions,
          });
          const corpusBasename = stablePageBasename(pageIndex, record.finalUrl ?? record.requestedUrl);
          const corpusPath = path.join(corpusDir, `${corpusBasename}.md`);
          await writeTextAtomic(corpusPath, corpusText);
        } catch (error) {
          logEvent('page_corpus_write_failed', {
            requestedUrl,
            message: error instanceof Error ? error.message : String(error),
          });
          await runEvents.flush();
        }
      } catch (error) {
        logEvent('page_behavior_write_failed', {
          requestedUrl,
          message: error instanceof Error ? error.message : String(error),
        });
        await runEvents.flush();
      }
    }
    logEvent('page_complete', { requestedUrl, status: record.status, httpStatus: record.httpStatus });
    await runEvents.flush();
  }

  // FIX-07/CD-N07: if the run-level deadline or the no-progress watchdog fired, every accepted
  // URL that was never attempted must still receive an explicit terminal record — never marked
  // successful, never silently dropped. This keeps the "every accepted URL gets a terminal
  // visited/failed record" invariant below true even when either watchdog cuts the crawl short.
  if (runDeadlineReached || noProgressWatchdogFired) {
    const failureReason = runDeadlineReached ? 'run_deadline_reached' : 'no_progress_watchdog';
    const errorName = runDeadlineReached ? 'RunDeadlineError' : 'NoProgressError';
    const errorMessage = runDeadlineReached
      ? `Not attempted: run deadline of ${runDeadlineMs}ms was reached before this URL could be visited`
      : `Not attempted: no-progress watchdog budget of ${budgets.noProgressWatchdogMs}ms was reached before this URL could be visited`;
    for (const canonicalUrl of acceptedInventory) {
      if (visitedRequested.has(canonicalUrl)) continue;
      visitedRequested.add(canonicalUrl);
      const target = targetsByCanonical.get(canonicalUrl);
      const now = new Date();
      const notAttemptedRecord: VisitedPageRecord = {
        requestedUrl: target?.visitUrl ?? canonicalUrl,
        canonicalUrl,
        aliasUrls: target && target.aliasUrls.length > 0 ? [...target.aliasUrls] : undefined,
        status: 'failed',
        failureReason,
        discoveredBy: provenanceByCanonical.get(canonicalUrl) ?? [{ sourceFamily: 'entry', discoveredOn: options.entryUrl }],
        startedAt: now.toISOString(),
        completedAt: now.toISOString(),
        durationMs: 0,
        error: { name: errorName, message: errorMessage },
      };
      visited.push(notAttemptedRecord);
      await appendJsonLine(pagesJsonlPath, notAttemptedRecord);
      await appendJsonLine(pageVisitsPath, notAttemptedRecord);
    }
  }

  // Acceptance invariant: the frozen inventory must be byte-for-byte identical to what was
  // computed right after Phase 4, from the first navigation attempt through run completion.
  const inventoryAfterCrawl = [...decisionsByCanonical.values()]
    .filter((row): row is UrlDecisionRecord & { canonicalUrl: string } => row.decision === 'accepted' && Boolean(row.canonicalUrl))
    .map((row) => row.canonicalUrl)
    .sort();
  if (acceptedInventoryFingerprint(inventoryAfterCrawl) !== frozenFingerprint) {
    throw new Error('Crawl invariant violated: accepted URL inventory changed after freeze (Stage 4/5 boundary was breached).');
  }

  const decisions = [...decisionsByCanonical.values(), ...decisionsOther.values()]
    .sort((a, b) => (a.canonicalUrl ?? a.rawUrl).localeCompare(b.canonicalUrl ?? b.rawUrl));

  const accepted = decisions.filter((row) => row.decision === 'accepted');
  const rejected = decisions.filter((row) => row.decision === 'rejected');
  const tbd = decisions.filter((row) => row.decision === 'tbd');
  const visitedSuccess = visited.filter((row) => row.status === 'visited');
  const visitedFailed = visited.filter((row) => row.status === 'failed');
  // FIX-03: keyed by canonicalUrl (route identity), not requestedUrl, since the URL actually
  // navigated to for an accepted route may be a localized alias rather than the bare
  // canonicalUrl string that appears in `accepted`.
  const terminalRequested = new Set(visited.map((row) => row.canonicalUrl ?? row.requestedUrl));
  const unterminatedAccepted = accepted
    .map((row) => row.canonicalUrl)
    .filter((url): url is string => Boolean(url))
    .filter((url) => !terminalRequested.has(url));
  if (unterminatedAccepted.length > 0) {
    throw new Error(`Crawl invariant violated: accepted URLs missing visited/failed terminal records: ${unterminatedAccepted.join(', ')}`);
  }

  // FIX-07/CD-N07: the run must always resolve to one explicit terminal status — never leave
  // run-manifest.json implying "still running". A watchdog (run-deadline or no-progress) is the
  // only thing that can produce 'partial'/'error'; a run that never hits either watchdog is
  // always 'complete' even if individual pages/sources failed (those have their own terminal
  // states via FIX-02/FIX-06). A timeout is never itself treated as a success.
  const watchdogFired = runDeadlineReached || noProgressWatchdogFired;
  const runStatus: RunStatus = !watchdogFired
    ? 'complete'
    : visitedSuccess.length > 0
      ? 'partial'
      : 'error';

  // FIX-06: on a clean run completion, overwrite url-source-coverage.json with the final,
  // fully-informed coverage snapshot — this is the only place crawl-phase (Phase 5) signals
  // (e.g. a live PassiveNetworkObserver body-scan timeout, or 'redirect' observations) can be
  // reflected, since they occur after the Phase-4 immutable snapshot was already written for
  // crash-safety. The Phase-4 snapshot on disk is left untouched if the run crashes before
  // reaching this point, so the crash-safety guarantee for that file is unchanged.
  const finalCoverage: SourceCoverageRecord[] = buildCoverage(decisions);
  await writeJsonAtomic(urlSourceCoveragePath, finalCoverage);

  // Review/future-run material only: URLs observed while a Stage-4 page was visited never
  // fed back into this run's accepted queue (see the Phase 5 loop above). Debug-only.
  await writeJsonAtomic(postVisitObservationsPath, postVisitObservations);
  // CF-03: validate CF-02's network-evidence.jsonl (when present) before it is handed to the
  // reviewer — every 'captured' record must point at a body file that actually exists on disk.
  // Absent entirely (no eligible network traffic, or a pre-CF-02 run) is a backward-compatible
  // no-op. A missing body throws and fails the whole run rather than handing the reviewer a
  // dangling reference.
  const networkEvidenceGate = await validateNetworkEvidenceIndex(networkEvidenceIndexPath);
  // CD-N01: url-inventory.json (the retained, consolidated accepted/rejected/tbd decision
  // ledger with full provenance) is written to the run folder root; review-input.json (the
  // bounded LLM-reviewer control payload derived from it) stays debug-only.
  await writeReviewInput(reviewInputPath, {
    runId,
    entryUrl: options.entryUrl,
    geo: options.geo,
    templateDir: options.templateDir,
    visited,
    decisions,
    urlInventoryPath,
    // CF-03: only referenced when the index actually exists for this run — the index/bodies
    // themselves are never inlined into review-input.json.
    networkEvidenceIndexPath: networkEvidenceGate.present ? networkEvidenceIndexPath : undefined,
  });

  // CD-N06: exactly one LLM invocation for the whole run, over the deterministic evidence
  // assembled above (json-templates/, corpus/, pages.jsonl, interactions.jsonl, compact run
  // metadata) — never the raw acquisition JSONL/HTML. Deterministic code never writes a fact
  // value itself; it only validates/gates what the LLM returns. A failed/timed-out/still-invalid
  // build never crashes the run — it is recorded and the run still reaches a terminal manifest.
  try {
    const jsonBuildResult = await runJsonEvidenceBuild({
      runId,
      casinoName: options.casinoName,
      entryUrl: options.entryUrl,
      geo: options.geo,
      templateDir: options.templateDir,
      corpusDir,
      pagesJsonlPath,
      interactionsJsonlPath,
      jsonDir,
      debugDir: debugWorkDir,
      llmJsonBuildTimeoutMs: budgets.llmJsonBuildTimeoutMs,
    });
    logEvent('llm_json_build_complete', {
      status: jsonBuildResult.status,
      categoriesWritten: jsonBuildResult.categoriesWritten,
      categoriesFailed: jsonBuildResult.categoriesFailed,
      errorMessage: jsonBuildResult.errorMessage,
    });
  } catch (error) {
    logEvent('llm_json_build_failed', { message: error instanceof Error ? error.message : String(error) });
  }
  await runEvents.flush();

  // CD-N02: review.html is now a pure deterministic render over the run's own retained
  // artifacts (run-manifest.json, url-inventory.json, pages.jsonl, interactions.jsonl,
  // json/*.json). run-manifest.json itself is written further below (it needs runStatus/counts
  // computed above this point), so the renderer reads a manifest object built in-memory here
  // rather than round-tripping through disk.

  logEvent('run_complete', {
    status: runStatus,
    accepted: accepted.length,
    rejected: rejected.length,
    tbd: tbd.length,
    visited: visitedSuccess.length,
    failed: visitedFailed.length,
  });
  await runEvents.flush();

  const completedAt = new Date();
  const manifest: DiscoveryRunManifest = {
    schemaVersion: '1.1',
    runId,
    runFolderName,
    casinoName: options.casinoName,
    casinoSlug,
    entryUrl: options.entryUrl,
    allowedOrigin,
    geoSlug,
    geo: options.geo,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    browserMode: 'cdp',
    urlRulesVersion: URL_RULES_VERSION,
    interactionMode: 'passive_only',
    status: runStatus,
    toolVersions: {
      playwright: readPlaywrightVersion(),
      node: process.version,
    },
    counts: {
      discovered: decisions.length,
      accepted: accepted.length,
      rejected: rejected.length,
      tbd: tbd.length,
      visited: visitedSuccess.length,
      failed: visitedFailed.length,
      interactionRecords,
    },
    artifacts: {
      runManifest: runManifestPath,
      urlInventory: urlInventoryPath,
      pages: pagesJsonlPath,
      interactions: interactionsJsonlPath,
      corpusDir,
      jsonDir,
      reviewHtml: reviewHtmlPath,
    },
  };

  // CD-N01: decide the debug directory's fate (discard/keep/zip) before the manifest is
  // finalized, and reflect the outcome on the manifest itself so a consumer never has to guess
  // whether debug/ or debug.zip exists.
  const debugOutcome = await finalizeDebugArtifacts({
    runDir,
    debugWorkDir,
    runTerminatedCleanly: runStatus === 'complete',
    debugArtifacts: Boolean(options.debugArtifacts),
  });
  if (debugOutcome.debugDir) manifest.artifacts.debugDir = debugOutcome.debugDir;
  if (debugOutcome.debugZip) manifest.artifacts.debugZip = debugOutcome.debugZip;

  await writeJsonAtomic(runManifestPath, manifest);

  // CD-N02: review.html must be rendered only once every other retained artifact (url-inventory,
  // pages, interactions, json/*.json, run-manifest.json) is fully written to disk.
  await writeTextAtomic(reviewHtmlPath, await renderReviewHtml(runDir));

  return manifest;
  }
}
