import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { DiscoveryResult } from './types.ts';

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await rename(temp, filePath);
}

export async function writeUrlMapArtifacts(outputDir: string, result: DiscoveryResult): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await atomicJson(path.join(outputDir, 'raw-url-candidates.json'), { candidates: result.rawCandidates });
  await atomicJson(path.join(outputDir, 'url-source-coverage.json'), { sources: result.sourceCoverage });
  await atomicJson(path.join(outputDir, 'accepted-url-inventory.json'), {
    urls: result.accepted.map(d => ({ canonicalUrl: d.canonicalUrl, resolvedUrl: d.resolvedUrl, ruleId: d.ruleId, provenance: d.provenance })),
  });
  await atomicJson(path.join(outputDir, 'deterministic-rejected-urls.json'), { urls: result.rejected });
  await atomicJson(path.join(outputDir, 'tbd-url-inventory.json'), { urls: result.tbd });
  await writeFile(path.join(outputDir, 'url-clean-decisions.jsonl'), result.decisions.map(d => JSON.stringify(d)).join('\n') + (result.decisions.length ? '\n' : ''), 'utf8');
  await atomicJson(path.join(outputDir, 'url-map-discovery-summary.json'), {
    entryUrl: result.entryUrl,
    finalEntryUrl: result.finalEntryUrl,
    allowedHosts: result.allowedHosts,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    rawObservationCount: result.rawCandidates.length,
    acceptedCount: result.accepted.length,
    rejectedCount: result.rejected.length,
    tbdCount: result.tbd.length,
    technicalSourceUrlCount: result.technicalSourceUrls.length,
    recursiveFallback: false,
    sourceCoverage: result.sourceCoverage,
  });
}
