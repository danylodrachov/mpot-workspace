// CD-N06: LLM fact extraction and JSON writing.
//
// Deterministic code (this module) stays evidence-only: it assembles the bounded LLM input
// (authoritative json-templates/, dropdown catalogue, pruned corpus/ files, pages.jsonl,
// interactions.jsonl, compact run metadata), invokes the LLM CLI adapter exactly once (plus at
// most one bounded correction pass), and deterministically validates whatever the LLM returns
// against the template shape/enum/type/duplicate rules below. It never infers a casino fact or
// writes a fact value into a template JSON itself — every value that lands in json/*.json came
// from the LLM's own output, gated by validation.
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { LlmJsonBuildStatus } from './types.ts';
import { writeJsonAtomic } from './io.ts';
import { cliLlmJsonCaller, type LlmJsonCliCaller } from './llm-cli-adapter.ts';

export interface JsonTemplateColumn {
  name: string;
  type: 'text' | 'number' | 'enum';
  values?: string[];
}

export interface JsonTemplateFile {
  category: string;
  filePath: string;
  columns: JsonTemplateColumn[];
  operator_fields?: string[];
}

export interface CorpusEvidenceFile {
  evidenceId: string;
  sourceUrl: string;
  markdown: string;
}

export type LlmFieldValue = { value: string | number; evidenceIds: string[] };
export type LlmRow = Record<string, LlmFieldValue | null>;

export interface JsonEvidenceBuildOptions {
  runId: string;
  casinoName: string;
  entryUrl: string;
  geo?: string;
  /** Directory containing the authoritative json-templates/*.json + dropdowns.json. */
  templateDir?: string;
  corpusDir: string;
  pagesJsonlPath: string;
  interactionsJsonlPath: string;
  /** Where the full required JSON set is written, one file per template category. */
  jsonDir: string;
  /** Where the invalid draft / attempt debug material is preserved on failure. */
  debugDir: string;
  /** Bounded wall-clock budget for ONE LLM CLI child-process call (runtime-config.ts). */
  llmJsonBuildTimeoutMs: number;
  /** Injectable for tests — defaults to the real subscription-CLI adapter. */
  callLlm?: LlmJsonCliCaller;
  model?: string;
}

export interface JsonEvidenceBuildResult {
  status: LlmJsonBuildStatus;
  categoriesWritten: string[];
  categoriesFailed: string[];
  errorMessage?: string;
  debugPath?: string;
}

export async function loadJsonTemplates(templateDir: string): Promise<JsonTemplateFile[]> {
  if (!existsSync(templateDir)) return [];
  const entries = await readdir(templateDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'dropdowns.json')
    .map((entry) => path.join(templateDir, entry.name))
    .sort();
  const templates: JsonTemplateFile[] = [];
  for (const filePath of files) {
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as {
      columns: JsonTemplateColumn[];
      category: string;
      operator_fields?: string[];
    };
    templates.push({ category: raw.category, filePath, columns: raw.columns, operator_fields: raw.operator_fields });
  }
  return templates;
}

export async function loadDropdownCatalogue(templateDir: string): Promise<Record<string, string[]>> {
  const dropdownPath = path.join(templateDir, 'dropdowns.json');
  if (!existsSync(dropdownPath)) return {};
  return JSON.parse(await readFile(dropdownPath, 'utf8')) as Record<string, string[]>;
}

// One corpus/*.md file per visited page (CD-N05). The evidence ID is the file's stable basename;
// an interaction-revealed fact is cited by the LLM as "<evidenceId>#<interactionId>" where
// interactionId (e.g. "int-1") is the same label already rendered inside that page's corpus text
// (see page-content-pruner.ts's buildPageCorpus).
export async function loadCorpusEvidence(corpusDir: string): Promise<CorpusEvidenceFile[]> {
  if (!existsSync(corpusDir)) return [];
  const entries = await readdir(corpusDir, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
  const files: CorpusEvidenceFile[] = [];
  for (const name of names) {
    const markdown = await readFile(path.join(corpusDir, name), 'utf8');
    const urlMatch = markdown.match(/^Requested URL:\s*(.+)$/m);
    files.push({ evidenceId: name.replace(/\.md$/, ''), sourceUrl: urlMatch ? urlMatch[1]!.trim() : '', markdown });
  }
  return files;
}

async function readJsonl(filePath: string): Promise<unknown[]> {
  if (!existsSync(filePath)) return [];
  const raw = await readFile(filePath, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function isValidEvidenceId(id: string, knownEvidenceIds: ReadonlySet<string>): boolean {
  const base = id.split('#')[0] ?? id;
  return knownEvidenceIds.has(base);
}

/** Tolerates a ```json ... ``` fence some models still add. Never throws — a parse failure
 * becomes a validation error handed to the correction pass, exactly like any other invalid shape. */
function parseLlmJsonOutput(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = (fenced ? fenced[1] : raw)!.trim();
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface ValidationResult {
  valid: boolean;
  /** Flattened, human-readable — fed back to the LLM verbatim on the correction pass. */
  errors: string[];
  categoryErrors: Record<string, string[]>;
  /** Only present for categories that validated cleanly. */
  validatedRowsByCategory: Record<string, LlmRow[]>;
}

/**
 * Deterministic gate between "what the LLM said" and "what lands in json/*.json". Checks: every
 * required category present; every category shaped `{ rows: [...] }`; every field name exists on
 * that category's template; every populated field carries a non-empty evidenceIds array whose IDs
 * trace to this run's corpus; every value respects its column's declared type, and (for enum
 * columns) is exactly one of the declared allowed values; no two rows in the same category carry
 * identical populated field values (duplicate rule).
 */
export function validateBuildOutput(
  templates: readonly JsonTemplateFile[],
  corpus: readonly CorpusEvidenceFile[],
  rawOutput: string,
): ValidationResult {
  const parsed = parseLlmJsonOutput(rawOutput);
  if (!parsed.ok) {
    const message = `Output is not valid JSON: ${parsed.error}`;
    return { valid: false, errors: [message], categoryErrors: {}, validatedRowsByCategory: {} };
  }
  const root = parsed.value;
  if (typeof root !== 'object' || root === null || !('files' in (root as Record<string, unknown>))) {
    const message = 'Top-level output must be a JSON object with a "files" key.';
    return { valid: false, errors: [message], categoryErrors: {}, validatedRowsByCategory: {} };
  }
  const filesValue = (root as { files: unknown }).files;
  if (typeof filesValue !== 'object' || filesValue === null) {
    const message = '"files" must be an object keyed by required template category.';
    return { valid: false, errors: [message], categoryErrors: {}, validatedRowsByCategory: {} };
  }
  const filesObj = filesValue as Record<string, unknown>;

  const knownEvidenceIds = new Set(corpus.map((c) => c.evidenceId));
  const errors: string[] = [];
  const categoryErrors: Record<string, string[]> = {};
  const validatedRowsByCategory: Record<string, LlmRow[]> = {};

  for (const template of templates) {
    const catErrors: string[] = [];
    const entry = filesObj[template.category];
    if (entry === undefined) {
      catErrors.push(`Missing required category "${template.category}" in "files".`);
      categoryErrors[template.category] = catErrors;
      errors.push(...catErrors);
      continue;
    }
    if (typeof entry !== 'object' || entry === null || !Array.isArray((entry as { rows?: unknown }).rows)) {
      catErrors.push(`Category "${template.category}" must be an object with a "rows" array.`);
      categoryErrors[template.category] = catErrors;
      errors.push(...catErrors);
      continue;
    }
    const rows = (entry as { rows: unknown[] }).rows;
    const columnsByName = new Map(template.columns.map((c) => [c.name, c] as const));
    const seenSignatures = new Set<string>();
    const validatedRows: LlmRow[] = [];

    rows.forEach((row, rowIndex) => {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) {
        catErrors.push(`Category "${template.category}" row ${rowIndex}: must be an object.`);
        return;
      }
      const rowObj = row as Record<string, unknown>;
      const validatedRow: LlmRow = {};
      let rowHadFieldError = false;

      for (const [fieldName, fieldValue] of Object.entries(rowObj)) {
        const column = columnsByName.get(fieldName);
        if (!column) {
          catErrors.push(`Category "${template.category}" row ${rowIndex}: unknown field "${fieldName}" is not in this template's columns.`);
          rowHadFieldError = true;
          continue;
        }
        if (fieldValue === null) {
          validatedRow[fieldName] = null;
          continue;
        }
        if (typeof fieldValue !== 'object' || Array.isArray(fieldValue)) {
          catErrors.push(`Category "${template.category}" row ${rowIndex} field "${fieldName}": must be null (absent) or {value, evidenceIds}.`);
          rowHadFieldError = true;
          continue;
        }
        const fv = fieldValue as { value?: unknown; evidenceIds?: unknown };
        if (fv.value === undefined) {
          catErrors.push(`Category "${template.category}" row ${rowIndex} field "${fieldName}": missing "value".`);
          rowHadFieldError = true;
          continue;
        }
        if (!Array.isArray(fv.evidenceIds) || fv.evidenceIds.length === 0 || !fv.evidenceIds.every((id) => typeof id === 'string')) {
          catErrors.push(`Category "${template.category}" row ${rowIndex} field "${fieldName}": a populated field requires a non-empty "evidenceIds" array of strings.`);
          rowHadFieldError = true;
          continue;
        }
        const evidenceIds = fv.evidenceIds as string[];
        const badEvidenceIds = evidenceIds.filter((id) => !isValidEvidenceId(id, knownEvidenceIds));
        if (badEvidenceIds.length > 0) {
          catErrors.push(`Category "${template.category}" row ${rowIndex} field "${fieldName}": unknown evidenceId(s) [${badEvidenceIds.join(', ')}] — not found in this run's corpus.`);
          rowHadFieldError = true;
          continue;
        }
        if (column.type === 'number') {
          if (typeof fv.value !== 'number' || !Number.isFinite(fv.value)) {
            catErrors.push(`Category "${template.category}" row ${rowIndex} field "${fieldName}": expected a finite number.`);
            rowHadFieldError = true;
            continue;
          }
        } else if (column.type === 'enum') {
          if (typeof fv.value !== 'string' || !(column.values ?? []).includes(fv.value)) {
            catErrors.push(`Category "${template.category}" row ${rowIndex} field "${fieldName}": "${String(fv.value)}" is not one of the allowed values [${(column.values ?? []).join(', ')}].`);
            rowHadFieldError = true;
            continue;
          }
        } else {
          if (typeof fv.value !== 'string') {
            catErrors.push(`Category "${template.category}" row ${rowIndex} field "${fieldName}": expected text (a string).`);
            rowHadFieldError = true;
            continue;
          }
        }
        validatedRow[fieldName] = { value: fv.value as string | number, evidenceIds };
      }

      if (rowHadFieldError) return;

      const signature = JSON.stringify(
        Object.entries(validatedRow)
          .filter(([, v]) => v !== null)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, (v as LlmFieldValue).value]),
      );
      if (seenSignatures.has(signature)) {
        catErrors.push(`Category "${template.category}" row ${rowIndex}: duplicate of an earlier row (identical populated field values) — duplicate rule violated.`);
        return;
      }
      seenSignatures.add(signature);
      validatedRows.push(validatedRow);
    });

    if (catErrors.length > 0) {
      categoryErrors[template.category] = catErrors;
      errors.push(...catErrors);
    } else {
      validatedRowsByCategory[template.category] = validatedRows;
    }
  }

  return { valid: errors.length === 0, errors, categoryErrors, validatedRowsByCategory };
}

function stripEvidenceIds(rows: readonly LlmRow[]): Array<Record<string, string | number | null>> {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value === null ? null : value.value])));
}

function buildSystemPrompt(): string {
  return [
    'You are the CD-N06 fact-extraction step of a deterministic casino-research snapshot pipeline.',
    'You receive ONLY: authoritative JSON field templates, a dropdown/normalization catalogue, a pruned text corpus per visited page, pages.jsonl, interactions.jsonl, and compact run metadata. You never receive raw HTML.',
    '',
    'Hard rules — violating any of these makes your output invalid:',
    '- You do not browse the live site and cannot request new navigation. You do not modify URL rules or interaction recipes.',
    '- A fact absent from the corpus stays absent/unresolved: set that field to null. NEVER fabricate, guess, or infer a value that is not directly supported by the corpus text.',
    '- Every populated (non-null) field requires "evidenceIds": a non-empty array of evidence IDs (corpus file basenames provided to you, e.g. "0001-example-abc123") that support the value.',
    '- Interaction-revealed facts must cite the specific interaction that exposed them, using "<evidenceId>#<interactionId>" (the interactionId, e.g. "int-1", is the same label shown inside that page corpus\'s "## Interaction-Revealed Evidence" section).',
    '- One page may populate fields across multiple required JSON categories/files.',
    '- Field values must respect the declared column type (text/number/enum) exactly; for an "enum" column the value must be EXACTLY one of the declared allowed values, verbatim.',
    '- Never invent a field name that is not one of a category\'s declared columns. Never emit two rows in the same category with identical populated values (no duplicates).',
    '',
    'Output format — return ONLY this JSON object, no prose, no markdown code fence:',
    '{ "files": { "<category>": { "rows": [ { "<field>": { "value": <string|number>, "evidenceIds": ["<id>", ...] } | null, ... } ] } }, ... one entry per REQUIRED category, even if its rows array is empty }',
  ].join('\n');
}

function buildUserPrompt(args: {
  runId: string;
  casinoName: string;
  entryUrl: string;
  geo?: string;
  templates: JsonTemplateFile[];
  dropdowns: Record<string, string[]>;
  corpus: CorpusEvidenceFile[];
  pages: unknown[];
  interactions: unknown[];
}): string {
  const payload = {
    runMetadata: { runId: args.runId, casinoName: args.casinoName, entryUrl: args.entryUrl, geo: args.geo },
    requiredCategories: args.templates.map((t) => t.category),
    templates: args.templates.map((t) => ({ category: t.category, columns: t.columns, operator_fields: t.operator_fields })),
    dropdownCatalogue: args.dropdowns,
    pages: args.pages,
    interactions: args.interactions,
    corpus: args.corpus.map((c) => ({ evidenceId: c.evidenceId, sourceUrl: c.sourceUrl, markdown: c.markdown })),
  };
  return JSON.stringify(payload);
}

/** Bounded correction turn: validator error messages only, no new instructions beyond "fix these
 * and resend the full required shape" — per CD-N06's "no other new instructions" constraint. */
function buildCorrectionPrompt(errors: readonly string[], previousRaw: string): string {
  return JSON.stringify({
    instruction:
      'Your previous output failed deterministic validation. Fix ONLY the listed errors below and return the corrected full JSON object again, in the exact same required shape (all required categories present). Do not change any value that was not flagged as an error. Do not fabricate evidence.',
    validationErrors: errors,
    previousOutput: previousRaw,
  });
}

export async function runJsonEvidenceBuild(options: JsonEvidenceBuildOptions): Promise<JsonEvidenceBuildResult> {
  const callLlm = options.callLlm ?? cliLlmJsonCaller;
  const debugPath = path.join(options.debugDir, 'llm-json-build-debug.json');

  if (!options.templateDir) {
    const result: JsonEvidenceBuildResult = {
      status: 'error',
      categoriesWritten: [],
      categoriesFailed: [],
      errorMessage: 'No templateDir configured for this run — LLM JSON build skipped.',
    };
    await writeJsonAtomic(debugPath, { runId: options.runId, ...result });
    return { ...result, debugPath };
  }

  const templates = await loadJsonTemplates(options.templateDir);
  if (templates.length === 0) {
    const result: JsonEvidenceBuildResult = {
      status: 'error',
      categoriesWritten: [],
      categoriesFailed: [],
      errorMessage: `No JSON templates found under ${options.templateDir}.`,
    };
    await writeJsonAtomic(debugPath, { runId: options.runId, ...result });
    return { ...result, debugPath };
  }

  const dropdowns = await loadDropdownCatalogue(options.templateDir);
  const corpus = await loadCorpusEvidence(options.corpusDir);
  const pages = await readJsonl(options.pagesJsonlPath);
  const interactions = await readJsonl(options.interactionsJsonlPath);

  const system = buildSystemPrompt();
  const user = buildUserPrompt({
    runId: options.runId,
    casinoName: options.casinoName,
    entryUrl: options.entryUrl,
    geo: options.geo,
    templates,
    dropdowns,
    corpus,
    pages,
    interactions,
  });

  const attempts: Array<{ attempt: number; status: LlmJsonBuildStatus; raw?: string; errors?: string[]; errorMessage?: string }> = [];
  const allCategories = templates.map((t) => t.category);

  const first = await callLlm({ system, user, timeoutMs: options.llmJsonBuildTimeoutMs, model: options.model });
  if (first.status !== 'complete') {
    attempts.push({ attempt: 1, status: first.status, errorMessage: first.errorMessage });
    await writeJsonAtomic(debugPath, { runId: options.runId, attempts });
    return { status: first.status, categoriesWritten: [], categoriesFailed: allCategories, errorMessage: first.errorMessage, debugPath };
  }

  let validation = validateBuildOutput(templates, corpus, first.stdout!);
  attempts.push({ attempt: 1, status: 'complete', raw: first.stdout, errors: validation.errors });

  if (!validation.valid) {
    const correctionUser = buildCorrectionPrompt(validation.errors, first.stdout!);
    const second = await callLlm({ system, user: correctionUser, timeoutMs: options.llmJsonBuildTimeoutMs, model: options.model });
    if (second.status !== 'complete') {
      attempts.push({ attempt: 2, status: second.status, errorMessage: second.errorMessage });
      await writeJsonAtomic(debugPath, { runId: options.runId, attempts });
      return { status: second.status, categoriesWritten: [], categoriesFailed: allCategories, errorMessage: second.errorMessage, debugPath };
    }
    validation = validateBuildOutput(templates, corpus, second.stdout!);
    attempts.push({ attempt: 2, status: 'complete', raw: second.stdout, errors: validation.errors });
  }

  const categoriesWritten: string[] = [];
  const categoriesFailed: string[] = [];

  for (const template of templates) {
    const rows = validation.validatedRowsByCategory[template.category];
    if (rows === undefined) {
      // Still invalid after the bounded correction pass: preserve the invalid draft in debug
      // material (already captured in `attempts` above), mark this category's JSON as failed,
      // and keep going — never crash the whole run over one bad category.
      categoriesFailed.push(template.category);
      continue;
    }
    await writeJsonAtomic(path.join(options.jsonDir, `${template.category}.json`), {
      schemaVersion: '1.0',
      runId: options.runId,
      category: template.category,
      generatedAt: new Date().toISOString(),
      rows: stripEvidenceIds(rows),
    });
    categoriesWritten.push(template.category);
  }

  await writeJsonAtomic(debugPath, { runId: options.runId, attempts, categoriesWritten, categoriesFailed });

  const status: LlmJsonBuildStatus = categoriesFailed.length > 0 ? 'error' : 'complete';
  return {
    status,
    categoriesWritten,
    categoriesFailed,
    errorMessage: categoriesFailed.length > 0 ? `Categories failed validation after the correction pass: ${categoriesFailed.join(', ')}` : undefined,
    debugPath,
  };
}
