import type { BrowserContext, Page } from 'playwright';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
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
import { appendJsonLine, ensureDir, makeRunId, writeJsonAtomic } from './io.ts';
import { writeReviewInput } from './review-input.ts';

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
}

// FIX-07: whole page-capture/profiler step (navigation + settle + DOM/behavior profiling) per
// page. Generous relative to navigationTimeoutMs/settleMs so it only fires when the step as a
// whole — not just navigation — gets stuck (e.g. a hung profiler evaluate()).
const DEFAULT_PAGE_CAPTURE_TIMEOUT_MS = 60_000;
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
  const runDir = path.join(options.outputDir, runId);
  const pagesDir = path.join(runDir, 'pages');
  await ensureDir(pagesDir);

  // Canonical FIX-05 artifact paths. Discovery artifacts (1-5) are written immutable/frozen
  // right after Stage 4 (freeze), before the crawl loop begins. url-clean-decisions.jsonl is
  // appended live as each decision is made during discovery. page-visits/snapshots/behavior
  // are appended per page inside the crawl loop. run-events.jsonl is appended for lifecycle
  // milestones throughout. run-manifest.json is finalized at the end.
  const runContextPath = path.join(runDir, 'run-context.json');
  const rawUrlCandidatesPath = path.join(runDir, 'raw-url-candidates.json');
  const urlSourceCoveragePath = path.join(runDir, 'url-source-coverage.json');
  const acceptedUrlInventoryPath = path.join(runDir, 'accepted-url-inventory.json');
  const deterministicRejectedUrlsPath = path.join(runDir, 'deterministic-rejected-urls.json');
  const urlCleanDecisionsPath = path.join(runDir, 'url-clean-decisions.jsonl');
  const pageVisitsPath = path.join(runDir, 'page-visits.jsonl');
  const pageSnapshotsPath = path.join(runDir, 'page-snapshots.jsonl');
  const pageBehaviorPath = path.join(runDir, 'page-behavior.jsonl');
  const runEventsPath = path.join(runDir, 'run-events.jsonl');
  const reviewInputPath = path.join(runDir, 'review-input.json');
  const postVisitObservationsPath = path.join(runDir, 'post-visit-observations.json');
  const runManifestPath = path.join(runDir, 'run-manifest.json');

  const runEvents = makeSerialAppender<Record<string, unknown>>(runEventsPath);
  const logEvent = (event: string, details?: Record<string, unknown>): void => {
    runEvents.append({ timestamp: new Date().toISOString(), event, ...(details ? { details } : {}) });
  };
  logEvent('run_start', { runId, entryUrl: options.entryUrl, geo: options.geo });

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
  await discoverFromPage(options.page, sink);
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
  await drainTextSources();

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

  const pageCaptureTimeoutMs = options.pageCaptureTimeoutMs ?? DEFAULT_PAGE_CAPTURE_TIMEOUT_MS;
  const runDeadlineMs = options.runDeadlineMs ?? DEFAULT_RUN_DEADLINE_MS;
  const runStartedAtMs = Date.now();
  let runDeadlineReached = false;

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

    visitedRequested.add(target.canonicalUrl);
    currentVisitUrl = target.canonicalUrl;
    const requestedUrl = target.visitUrl;

    const network = new PassiveNetworkObserver(options.page, postVisitSink, allowedHostname);
    network.start();
    pageIndex += 1;
    logEvent('page_attempt', { requestedUrl, canonicalUrl: target.canonicalUrl, pageIndex });
    await runEvents.flush();
    const discoveredBy = provenanceByCanonical.get(target.canonicalUrl) ?? [{ sourceFamily: 'entry', discoveredOn: options.entryUrl }];
    const pageStarted = new Date();
    let record: VisitedPageRecord;
    try {
      // FIX-07: bound the whole capture/profiler step (navigation, settle, DOM/behavior
      // profiling) — a synthetic never-resolving capturePage() must still produce a terminal
      // error record rather than hang the crawl loop forever.
      record = await withTimeout(
        capturePage({
          page: options.page,
          requestedUrl,
          pageIndex,
          pagesDir,
          settleMs: options.settleMs ?? 1_500,
          navigationTimeoutMs: options.navigationTimeoutMs ?? 30_000,
          discoveredBy,
          networkObserver: network,
        }),
        pageCaptureTimeoutMs,
        `Page capture exceeded ${pageCaptureTimeoutMs}ms deadline for ${requestedUrl}`,
      );
      // Passive DOM observation from the visited page is recorded as a post-visit
      // observation only — it must never feed back into this run's accepted queue.
      if (record.status === 'visited') await discoverFromPage(options.page, postVisitSink);
      await network.flush();
    } catch (error) {
      // Only a bounded-deadline timeout is turned into a terminal per-page error record here.
      // Any other exception (a genuine bug/crash) must keep propagating uncaught, unchanged
      // from pre-FIX-07 behavior, so a real crash mid-crawl still aborts the run rather than
      // being silently downgraded to a page failure.
      if (!(error instanceof TimeoutError)) throw error;
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
    } finally {
      // Listener cleanup must run even if capture/flush/discovery threw, so a stuck
      // response-body task never leaks listeners into the next page's observer.
      network.stop();
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

    // FIX-05: append terminal per-page artifacts immediately (not batched at end of run) so a
    // hang/crash on a later page never erases the factual ledger for pages already attempted.
    await appendJsonLine(pageVisitsPath, record);
    if (record.status === 'visited' && record.htmlPath && record.tracePath && record.htmlSha256) {
      const snapshotRecord: PageSnapshotRecord = {
        requestedUrl: record.requestedUrl,
        finalUrl: record.finalUrl ?? record.requestedUrl,
        httpStatus: record.httpStatus,
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

  // FIX-07: if the run-level watchdog fired, every accepted URL that was never attempted must
  // still receive an explicit terminal record — never marked successful, never silently
  // dropped. This keeps the "every accepted URL gets a terminal visited/failed record"
  // invariant below true even when the watchdog cuts the crawl short.
  if (runDeadlineReached) {
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
        failureReason: 'run_deadline_reached',
        discoveredBy: provenanceByCanonical.get(canonicalUrl) ?? [{ sourceFamily: 'entry', discoveredOn: options.entryUrl }],
        startedAt: now.toISOString(),
        completedAt: now.toISOString(),
        durationMs: 0,
        error: { name: 'RunDeadlineError', message: `Not attempted: run deadline of ${runDeadlineMs}ms was reached before this URL could be visited` },
      };
      visited.push(notAttemptedRecord);
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

  // FIX-07: the run must always resolve to one explicit terminal status — never leave
  // run-manifest.json implying "still running". The watchdog is the only thing that can
  // produce 'partial'/'error'; a run that never hits the deadline is always 'complete' even if
  // individual pages/sources failed (those have their own terminal states via FIX-02/FIX-06).
  const runStatus: RunStatus = !runDeadlineReached
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
  // fed back into this run's accepted queue (see the Phase 5 loop above). Not one of the 11
  // canonical FIX-05 artifacts, kept alongside them for downstream review tooling.
  await writeJsonAtomic(postVisitObservationsPath, postVisitObservations);
  await writeReviewInput(reviewInputPath, {
    runId,
    entryUrl: options.entryUrl,
    geo: options.geo,
    templateDir: options.templateDir,
    visited,
    decisions,
  });
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
    schemaVersion: '1.0',
    runId,
    entryUrl: options.entryUrl,
    allowedOrigin,
    geo: options.geo,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    browserMode: 'cdp',
    urlRulesVersion: URL_RULES_VERSION,
    interactionMode: 'passive_only',
    status: runStatus,
    counts: {
      discovered: decisions.length,
      accepted: accepted.length,
      rejected: rejected.length,
      tbd: tbd.length,
      visited: visitedSuccess.length,
      failed: visitedFailed.length,
    },
    artifacts: {
      runContext: runContextPath,
      rawUrlCandidates: rawUrlCandidatesPath,
      urlSourceCoverage: urlSourceCoveragePath,
      acceptedUrlInventory: acceptedUrlInventoryPath,
      deterministicRejectedUrls: deterministicRejectedUrlsPath,
      urlCleanDecisions: urlCleanDecisionsPath,
      pageVisits: pageVisitsPath,
      pageSnapshots: pageSnapshotsPath,
      pageBehavior: pageBehaviorPath,
      runEvents: runEventsPath,
      reviewInput: reviewInputPath,
      postVisitObservations: postVisitObservationsPath,
      pagesDirectory: pagesDir,
    },
  };
  await writeJsonAtomic(runManifestPath, manifest);
  return manifest;
}
