import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { UrlDecisionRecord, VisitedPageRecord } from './types.ts';
import { writeJsonAtomic } from './io.ts';

export async function listTemplateFiles(templateDir?: string): Promise<string[]> {
  if (!templateDir) return [];
  try {
    const names = await readdir(templateDir, { withFileTypes: true });
    return names
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'dropdowns.json')
      .map((entry) => path.join(templateDir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

export async function writeReviewInput(
  filePath: string,
  args: {
    runId: string;
    entryUrl: string;
    geo?: string;
    templateDir?: string;
    visited: VisitedPageRecord[];
    decisions: UrlDecisionRecord[];
  },
): Promise<void> {
  const templates = await listTemplateFiles(args.templateDir);
  const accepted = args.decisions.filter((row) => row.decision === 'accepted');
  const rejected = args.decisions.filter((row) => row.decision === 'rejected');
  const tbd = args.decisions.filter((row) => row.decision === 'tbd');

  await writeJsonAtomic(filePath, {
    schemaVersion: '1.0',
    runId: args.runId,
    entryUrl: args.entryUrl,
    geo: args.geo,
    artifactBuilderMode: 'llm_post_run_only',
    templateFiles: templates,
    visitedPages: args.visited,
    urlInventory: {
      accepted,
      rejected,
      tbd,
    },
    instructions: {
      requiredCategorySource: 'Use the repository JSON templates as the authoritative category/field definitions.',
      visitedUrlRule: 'A URL may appear in a template table only if visitedPages contains status=visited for that exact requested/final URL and the saved HTML/trace supports the mapping.',
      noScoring: 'Do not produce relevance probability, confidence scoring, or a visit plan. Browser navigation is already complete.',
      evidence: 'Use saved page HTML and passive trace files as the evidence basis. Do not browse the live site.',
      interactivity: 'Report detected interactive candidates as candidates only. No interaction effect may be claimed because this run performs no element interactions.',
      urlSections: 'Show discovered/accepted/rejected/TBD/visited/failed URL sets separately.',
    },
  });
}
