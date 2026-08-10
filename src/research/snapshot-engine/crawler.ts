import type { BrowserContext, Page } from 'playwright';
import path from 'node:path';
import { capturePage } from './page-capture.ts';
import { decideUrl, URL_RULES_VERSION } from './url-rules.ts';
import {
  discoverFromPage,
  discoverRobotsAndSitemaps,
  PassiveNetworkObserver,
  scanSameDomainTextSources,
  type DiscoverySink,
} from './url-discovery.ts';
import type {
  CandidateProvenance,
  DiscoveryRunManifest,
  RawUrlCandidate,
  SourceCoverageRecord,
  SourceFamily,
  UrlDecisionRecord,
  VisitedPageRecord,
} from './types.ts';
import { ensureDir, makeRunId, writeJsonAtomic } from './io.ts';
import { writeReviewInput } from './review-input.ts';

export interface CrawlOptions {
  context: BrowserContext;
  page: Page;
  entryUrl: string;
  outputDir: string;
  geo?: string;
  templateDir?: string;
  settleMs?: number;
  navigationTimeoutMs?: number;
}

interface AggregatedCandidate {
  rawUrl: string;
  provenance: CandidateProvenance[];
}

const SOURCE_FAMILIES: SourceFamily[] = [
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

  const aggregate = new Map<string, AggregatedCandidate>();
  const decisionsByCanonical = new Map<string, UrlDecisionRecord>();
  const decisionsOther = new Map<string, UrlDecisionRecord>();
  const provenanceByCanonical = new Map<string, CandidateProvenance[]>();
  const pendingAccepted = new Set<string>();
  const visitedRequested = new Set<string>();
  const visited: VisitedPageRecord[] = [];
  const sourceErrors = new Map<SourceFamily, string[]>();
  const textSourceUrls = new Set<string>();
  const scannedTextSourceUrls = new Set<string>();

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
      if (decision.canonicalUrl) {
        const canonicalKey = decision.canonicalUrl;
        const provenance = provenanceByCanonical.get(canonicalKey) ?? [];
        for (const p of current.provenance) {
          if (!provenance.some((existing) =>
            existing.sourceFamily === p.sourceFamily && existing.discoveredOn === p.discoveredOn && existing.sourceUrl === p.sourceUrl && existing.attribute === p.attribute
          )) provenance.push(p);
        }
        provenanceByCanonical.set(canonicalKey, provenance);
        const merged = { ...decision, provenance };
        decisionsByCanonical.set(canonicalKey, merged);
        if (merged.decision === 'accepted') pendingAccepted.add(canonicalKey);
        if (merged.decision !== 'accepted') pendingAccepted.delete(canonicalKey);
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
    },
  };

  const drainTextSources = async (): Promise<void> => {
    while (true) {
      const unscanned = [...textSourceUrls].filter((url) => !scannedTextSourceUrls.has(url)).sort();
      if (unscanned.length === 0) return;
      await scanSameDomainTextSources(options.context, unscanned, allowedHostname, sink, scannedTextSourceUrls);
    }
  };

  sink.add({
    rawUrl: options.entryUrl,
    provenance: { sourceFamily: 'entry', discoveredOn: options.entryUrl, sourceUrl: options.entryUrl, label: 'entry' },
  });

  // Bootstrap discovery uses the already-authenticated page state without creating a research-page
  // visit record for an entry/root URL that URL Rules may explicitly reject.
  await discoverFromPage(options.page, sink);
  await discoverRobotsAndSitemaps(options.context, allowedOrigin, sink);
  await drainTextSources();

  let pageIndex = 0;
  while (pendingAccepted.size > 0) {
    const next = [...pendingAccepted].filter((url) => !visitedRequested.has(url)).sort()[0];
    if (!next) break;
    const requestedUrl = next;
    if (visitedRequested.has(requestedUrl)) continue;
    visitedRequested.add(requestedUrl);
    pendingAccepted.delete(requestedUrl);

    const network = new PassiveNetworkObserver(options.page, sink, allowedHostname);
    network.start();
    pageIndex += 1;
    const discoveredBy = provenanceByCanonical.get(requestedUrl) ?? [{ sourceFamily: 'entry', discoveredOn: options.entryUrl }];
    const record = await capturePage({
      page: options.page,
      requestedUrl,
      pageIndex,
      pagesDir,
      settleMs: options.settleMs ?? 1_500,
      navigationTimeoutMs: options.navigationTimeoutMs ?? 30_000,
      discoveredBy,
      networkObserver: network,
    });
    if (record.status === 'visited') await discoverFromPage(options.page, sink);
    await network.flush();
    network.stop();

    if (record.finalUrl && record.finalUrl !== requestedUrl) {
      sink.add({
        rawUrl: record.finalUrl,
        provenance: { sourceFamily: 'redirect', discoveredOn: requestedUrl, sourceUrl: requestedUrl, label: 'navigation-final-url' },
      });
    }
    visited.push(record);

    // Hidden route registries often live in hashed same-domain JS bundles. Scan newly observed
    // script URLs after each page; only URL/path tokens escape the scanner.
    await drainTextSources();
  }

  const decisions = [...decisionsByCanonical.values(), ...decisionsOther.values()]
    .sort((a, b) => (a.canonicalUrl ?? a.rawUrl).localeCompare(b.canonicalUrl ?? b.rawUrl));

  const accepted = decisions.filter((row) => row.decision === 'accepted');
  const rejected = decisions.filter((row) => row.decision === 'rejected');
  const tbd = decisions.filter((row) => row.decision === 'tbd');
  const visitedSuccess = visited.filter((row) => row.status === 'visited');
  const visitedFailed = visited.filter((row) => row.status === 'failed');
  const terminalRequested = new Set(visited.map((row) => row.requestedUrl));
  const unterminatedAccepted = accepted
    .map((row) => row.canonicalUrl)
    .filter((url): url is string => Boolean(url))
    .filter((url) => !terminalRequested.has(url));
  if (unterminatedAccepted.length > 0) {
    throw new Error(`Crawl invariant violated: accepted URLs missing visited/failed terminal records: ${unterminatedAccepted.join(', ')}`);
  }

  const coverage: SourceCoverageRecord[] = SOURCE_FAMILIES.map((sourceFamily) => {
    const rows = decisions.filter((row) => row.provenance.some((p) => p.sourceFamily === sourceFamily));
    return {
      sourceFamily,
      observed: rows.length > 0 || (sourceErrors.get(sourceFamily)?.length ?? 0) > 0,
      candidateCount: rows.length,
      acceptedCount: rows.filter((row) => row.decision === 'accepted').length,
      rejectedCount: rows.filter((row) => row.decision === 'rejected').length,
      tbdCount: rows.filter((row) => row.decision === 'tbd').length,
      errors: sourceErrors.get(sourceFamily) ?? [],
    };
  });

  const urlInventoryPath = path.join(runDir, 'url-inventory.json');
  const visitedPagesPath = path.join(runDir, 'visited-pages.json');
  const sourceCoveragePath = path.join(runDir, 'url-source-coverage.json');
  const reviewInputPath = path.join(runDir, 'review-input.json');
  await writeJsonAtomic(urlInventoryPath, {
    schemaVersion: '1.0',
    urlRulesVersion: URL_RULES_VERSION,
    allowedOrigin,
    accepted,
    rejected,
    tbd,
  });
  await writeJsonAtomic(visitedPagesPath, visited);
  await writeJsonAtomic(sourceCoveragePath, coverage);
  await writeReviewInput(reviewInputPath, {
    runId,
    entryUrl: options.entryUrl,
    geo: options.geo,
    templateDir: options.templateDir,
    visited,
    decisions,
  });

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
    counts: {
      discovered: decisions.length,
      accepted: accepted.length,
      rejected: rejected.length,
      tbd: tbd.length,
      visited: visitedSuccess.length,
      failed: visitedFailed.length,
    },
    artifacts: {
      urlInventory: urlInventoryPath,
      visitedPages: visitedPagesPath,
      sourceCoverage: sourceCoveragePath,
      reviewInput: reviewInputPath,
      pagesDirectory: pagesDir,
    },
  };
  await writeJsonAtomic(path.join(runDir, 'run-manifest.json'), manifest);
  return manifest;
}
