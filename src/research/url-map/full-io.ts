import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { FullUrlMapDiscoveryResult } from './full-discovery.ts';
import { deriveCasinoNameFromUrl, slugifyCasinoName } from './io.ts';

export interface FullUrlMapPersistenceOptions {
  outputRoot?: string;
  casinoName?: string;
  now?: Date;
}

export interface FullUrlMapWrittenArtifacts {
  casinoSlug: string;
  runId: string;
  runDate: string;
  runDir: string;
  sourceUrlListPath: string;
  sourceCoveragePath: string;
  sourceUrlListNormalizedPath: string;
  sitemapPath: string;
  summaryPath: string;
}

const DEFAULT_OUTPUT_ROOT = 'data/casino-partner-researches';

function safeStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function atomicWrite(pathname: string, content: string): Promise<void> {
  const tempPath = `${pathname}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tempPath, content, 'utf8');
  await rename(tempPath, pathname);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function resolveFullUrlMapRunPaths(
  result: Pick<FullUrlMapDiscoveryResult, 'entryUrl' | 'runId'>,
  options: FullUrlMapPersistenceOptions = {},
): FullUrlMapWrittenArtifacts {
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error('Invalid run date');

  const casinoSlug = slugifyCasinoName(options.casinoName ?? deriveCasinoNameFromUrl(result.entryUrl));
  const runDate = now.toISOString().slice(0, 10);
  const shortRunId = result.runId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase();
  const runDir = path.resolve(
    options.outputRoot ?? DEFAULT_OUTPUT_ROOT,
    `${casinoSlug}-${safeStamp(now)}-${shortRunId}`,
  );

  return {
    casinoSlug,
    runId: result.runId,
    runDate,
    runDir,
    sourceUrlListPath: path.join(runDir, 'source-url-list.json'),
    sourceCoveragePath: path.join(runDir, 'url-source-coverage-log.json'),
    sourceUrlListNormalizedPath: path.join(runDir, 'source-url-list-normalized.json'),
    sitemapPath: path.join(runDir, 'sitemap-discovery-log.json'),
    summaryPath: path.join(runDir, 'url-map-discovery-report.json'),
  };
}

export async function writeFullUrlMapDiscoveryArtifacts(
  result: FullUrlMapDiscoveryResult,
  options: FullUrlMapPersistenceOptions = {},
): Promise<FullUrlMapWrittenArtifacts> {
  const paths = resolveFullUrlMapRunPaths(result, options);
  await mkdir(path.dirname(paths.runDir), { recursive: true });
  await mkdir(paths.runDir, { recursive: false });

  // Raw homepage/seed and all other discovery observations stay unnormalized here.
  await atomicWrite(paths.sourceUrlListPath, json(result.rawCandidates));
  await atomicWrite(paths.sourceCoveragePath, json(result.sourceCoverage));
  // Resolution, canonicalization and deduplication are persisted separately.
  await atomicWrite(paths.sourceUrlListNormalizedPath, json(result.urlMap));
  await atomicWrite(paths.sitemapPath, json(result.sitemapDiscovery));
  await atomicWrite(paths.summaryPath, json(result.summary));

  return paths;
}
