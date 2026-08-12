import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { SeedDiscoveryResult } from './types.ts';

export interface UrlMapPersistenceOptions {
  outputRoot?: string;
  casinoName?: string;
  now?: Date;
}

export interface UrlMapWrittenArtifact {
  casinoSlug: string;
  runDate: string;
  runDir: string;
  jsonPath: string;
}

const DEFAULT_OUTPUT_ROOT = 'data/casino-partner-researches';

export function slugifyCasinoName(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!slug) throw new Error('Casino name must contain at least one alphanumeric character');
  return slug;
}

export function deriveCasinoNameFromUrl(entryUrl: string): string {
  const hostname = new URL(entryUrl).hostname.toLowerCase().replace(/^www\./, '');
  const firstLabel = hostname.split('.')[0];
  if (!firstLabel) throw new Error(`Cannot derive casino name from URL: ${entryUrl}`);
  return firstLabel;
}

export function resolveUrlMapRunPaths(
  entryUrl: string,
  options: UrlMapPersistenceOptions = {},
): UrlMapWrittenArtifact {
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error('Invalid run date');

  const casinoSlug = slugifyCasinoName(options.casinoName ?? deriveCasinoNameFromUrl(entryUrl));
  const runDate = now.toISOString().slice(0, 10);
  const outputRoot = path.resolve(options.outputRoot ?? DEFAULT_OUTPUT_ROOT);
  const runDir = path.join(outputRoot, `${casinoSlug}-${runDate}`);
  const jsonPath = path.join(runDir, 'url-map-discovery.json');

  return { casinoSlug, runDate, runDir, jsonPath };
}

export async function writeSeedDiscoveryResult(
  result: SeedDiscoveryResult,
  options: UrlMapPersistenceOptions = {},
): Promise<UrlMapWrittenArtifact> {
  const paths = resolveUrlMapRunPaths(result.entryUrl, options);
  await mkdir(paths.runDir, { recursive: true });

  const tempPath = `${paths.jsonPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await rename(tempPath, paths.jsonPath);

  return paths;
}
