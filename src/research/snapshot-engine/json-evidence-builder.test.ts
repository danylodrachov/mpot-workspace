import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic, writeTextAtomic, appendJsonLine } from './io.ts';
import { runJsonEvidenceBuild, validateBuildOutput, loadJsonTemplates, loadCorpusEvidence } from './json-evidence-builder.ts';
import type { LlmJsonCliCaller, LlmJsonCliResult } from './llm-cli-adapter.ts';

function mkdtemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'json-evidence-builder-'));
}

const CASINO_TEMPLATE = {
  columns: [
    { name: 'casino_name', type: 'text' },
    { name: 'country', type: 'enum', values: ['Austria', 'Brazil'] },
    { name: 'year_of_foundation', type: 'number' },
  ],
  operator_fields: ['country'],
  category: 'casinos',
};

async function makeRunFixture(): Promise<{
  runDir: string;
  templateDir: string;
  corpusDir: string;
  pagesJsonlPath: string;
  interactionsJsonlPath: string;
  jsonDir: string;
  debugDir: string;
  evidenceId: string;
}> {
  const runDir = mkdtemp();
  const templateDir = path.join(runDir, 'templates');
  await writeJsonAtomic(path.join(templateDir, 'casinos.json'), CASINO_TEMPLATE);

  const corpusDir = path.join(runDir, 'corpus');
  const evidenceId = '0001-example-casino-test-abc123';
  await writeTextAtomic(
    path.join(corpusDir, `${evidenceId}.md`),
    [
      '# Example Casino',
      'Requested URL: https://example-casino.test/',
      'Final URL: https://example-casino.test/',
      '',
      '## Baseline Evidence',
      '',
      'Example Casino was founded in 2018 and is licensed in Austria.',
      '',
      '## Interaction-Revealed Evidence',
      '',
      '### Interaction int-1 (accordion_or_disclosure — revealed_evidence)',
      'Locator: body > div ("FAQ")',
      '',
      'Additional revealed fact: also licensed for Brazil.',
    ].join('\n'),
  );

  const pagesJsonlPath = path.join(runDir, 'pages.jsonl');
  await appendJsonLine(pagesJsonlPath, { requestedUrl: 'https://example-casino.test/', status: 'visited' });
  const interactionsJsonlPath = path.join(runDir, 'interactions.jsonl');
  await appendJsonLine(interactionsJsonlPath, { requestedUrl: 'https://example-casino.test/', candidateCount: 1 });

  const jsonDir = path.join(runDir, 'json');
  const debugDir = path.join(runDir, 'debug');

  return { runDir, templateDir, corpusDir, pagesJsonlPath, interactionsJsonlPath, jsonDir, debugDir, evidenceId };
}

function makeCaller(responses: LlmJsonCliResult[]): { caller: LlmJsonCliCaller; calls: unknown[] } {
  const calls: unknown[] = [];
  let index = 0;
  const caller: LlmJsonCliCaller = async (request) => {
    calls.push(request);
    const response = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return response;
  };
  return { caller, calls };
}

test('loadJsonTemplates skips dropdowns.json and reads category/columns', async () => {
  const { templateDir } = await makeRunFixture();
  await writeJsonAtomic(path.join(templateDir, 'dropdowns.json'), { countries: ['Austria'] });
  const templates = await loadJsonTemplates(templateDir);
  assert.equal(templates.length, 1);
  assert.equal(templates[0]!.category, 'casinos');
  assert.equal(templates[0]!.columns.length, 3);
});

test('loadCorpusEvidence extracts evidenceId + sourceUrl from each corpus file', async () => {
  const { corpusDir, evidenceId } = await makeRunFixture();
  const corpus = await loadCorpusEvidence(corpusDir);
  assert.equal(corpus.length, 1);
  assert.equal(corpus[0]!.evidenceId, evidenceId);
  assert.equal(corpus[0]!.sourceUrl, 'https://example-casino.test/');
});

test('validateBuildOutput: happy path with valid enum/number/text values and known evidence ids', async () => {
  const { templateDir, corpusDir, evidenceId } = await makeRunFixture();
  const templates = await loadJsonTemplates(templateDir);
  const corpus = await loadCorpusEvidence(corpusDir);
  const raw = JSON.stringify({
    files: {
      casinos: {
        rows: [
          {
            casino_name: { value: 'Example Casino', evidenceIds: [evidenceId] },
            country: { value: 'Austria', evidenceIds: [`${evidenceId}#int-1`] },
            year_of_foundation: { value: 2018, evidenceIds: [evidenceId] },
          },
        ],
      },
    },
  });
  const result = validateBuildOutput(templates, corpus, raw);
  assert.equal(result.valid, true);
  assert.equal(result.validatedRowsByCategory.casinos!.length, 1);
});

test('validateBuildOutput: rejects unknown enum value, unknown field, unknown evidenceId, and duplicate rows', async () => {
  const { templateDir, corpusDir, evidenceId } = await makeRunFixture();
  const templates = await loadJsonTemplates(templateDir);
  const corpus = await loadCorpusEvidence(corpusDir);

  const badEnum = JSON.stringify({
    files: { casinos: { rows: [{ country: { value: 'Norway', evidenceIds: [evidenceId] } }] } },
  });
  assert.equal(validateBuildOutput(templates, corpus, badEnum).valid, false);

  const unknownField = JSON.stringify({
    files: { casinos: { rows: [{ made_up_field: { value: 'x', evidenceIds: [evidenceId] } }] } },
  });
  assert.equal(validateBuildOutput(templates, corpus, unknownField).valid, false);

  const unknownEvidence = JSON.stringify({
    files: { casinos: { rows: [{ casino_name: { value: 'X', evidenceIds: ['nonexistent-id'] } }] } },
  });
  assert.equal(validateBuildOutput(templates, corpus, unknownEvidence).valid, false);

  const missingCategory = JSON.stringify({ files: {} });
  assert.equal(validateBuildOutput(templates, corpus, missingCategory).valid, false);

  const duplicateRows = JSON.stringify({
    files: {
      casinos: {
        rows: [
          { casino_name: { value: 'Example Casino', evidenceIds: [evidenceId] } },
          { casino_name: { value: 'Example Casino', evidenceIds: [evidenceId] } },
        ],
      },
    },
  });
  const dupResult = validateBuildOutput(templates, corpus, duplicateRows);
  assert.equal(dupResult.valid, false);
  assert.ok(dupResult.errors.some((e) => e.includes('duplicate')));

  const notJson = 'this is not json at all {{{';
  assert.equal(validateBuildOutput(templates, corpus, notJson).valid, false);
});

test('happy path: valid LLM output on first try writes json/casinos.json and strips evidenceIds', async () => {
  const fixture = await makeRunFixture();
  const validOutput = JSON.stringify({
    files: {
      casinos: {
        rows: [
          {
            casino_name: { value: 'Example Casino', evidenceIds: [fixture.evidenceId] },
            country: { value: 'Austria', evidenceIds: [fixture.evidenceId] },
            year_of_foundation: { value: 2018, evidenceIds: [fixture.evidenceId] },
          },
        ],
      },
    },
  });
  const { caller, calls } = makeCaller([{ status: 'complete', stdout: validOutput }]);

  const result = await runJsonEvidenceBuild({
    runId: 'run-1',
    casinoName: 'Example Casino',
    entryUrl: 'https://example-casino.test/',
    templateDir: fixture.templateDir,
    corpusDir: fixture.corpusDir,
    pagesJsonlPath: fixture.pagesJsonlPath,
    interactionsJsonlPath: fixture.interactionsJsonlPath,
    jsonDir: fixture.jsonDir,
    debugDir: fixture.debugDir,
    llmJsonBuildTimeoutMs: 5000,
    callLlm: caller,
  });

  assert.equal(result.status, 'complete');
  assert.deepEqual(result.categoriesWritten, ['casinos']);
  assert.deepEqual(result.categoriesFailed, []);
  assert.equal(calls.length, 1, 'only one LLM call for a valid first-try output');

  const written = JSON.parse(fs.readFileSync(path.join(fixture.jsonDir, 'casinos.json'), 'utf8'));
  assert.equal(written.rows.length, 1);
  assert.equal(written.rows[0].casino_name, 'Example Casino');
  assert.equal(written.rows[0].country, 'Austria');
  // evidenceIds must not leak into the final written JSON.
  assert.equal(JSON.stringify(written).includes('evidenceIds'), false);
});

test('correction pass: invalid first, valid second — writes json only after correction', async () => {
  const fixture = await makeRunFixture();
  const invalidOutput = JSON.stringify({ files: { casinos: { rows: [{ country: { value: 'Norway', evidenceIds: [fixture.evidenceId] } }] } } });
  const validOutput = JSON.stringify({
    files: { casinos: { rows: [{ casino_name: { value: 'Example Casino', evidenceIds: [fixture.evidenceId] } }] } },
  });
  const { caller, calls } = makeCaller([
    { status: 'complete', stdout: invalidOutput },
    { status: 'complete', stdout: validOutput },
  ]);

  const result = await runJsonEvidenceBuild({
    runId: 'run-2',
    casinoName: 'Example Casino',
    entryUrl: 'https://example-casino.test/',
    templateDir: fixture.templateDir,
    corpusDir: fixture.corpusDir,
    pagesJsonlPath: fixture.pagesJsonlPath,
    interactionsJsonlPath: fixture.interactionsJsonlPath,
    jsonDir: fixture.jsonDir,
    debugDir: fixture.debugDir,
    llmJsonBuildTimeoutMs: 5000,
    callLlm: caller,
  });

  assert.equal(result.status, 'complete');
  assert.deepEqual(result.categoriesWritten, ['casinos']);
  assert.equal(calls.length, 2, 'exactly one bounded correction pass');
  // Correction turn carries the validator errors, not free-form new instructions.
  const correctionUser = JSON.parse((calls[1] as { user: string }).user);
  assert.ok(Array.isArray(correctionUser.validationErrors) && correctionUser.validationErrors.length > 0);

  const written = JSON.parse(fs.readFileSync(path.join(fixture.jsonDir, 'casinos.json'), 'utf8'));
  assert.equal(written.rows[0].casino_name, 'Example Casino');
});

test('still invalid after correction: marks category failed, preserves debug material, does not crash', async () => {
  const fixture = await makeRunFixture();
  const invalidOutput = JSON.stringify({ files: { casinos: { rows: [{ country: { value: 'Norway', evidenceIds: [fixture.evidenceId] } }] } } });
  const { caller, calls } = makeCaller([
    { status: 'complete', stdout: invalidOutput },
    { status: 'complete', stdout: invalidOutput },
  ]);

  const result = await runJsonEvidenceBuild({
    runId: 'run-3',
    casinoName: 'Example Casino',
    entryUrl: 'https://example-casino.test/',
    templateDir: fixture.templateDir,
    corpusDir: fixture.corpusDir,
    pagesJsonlPath: fixture.pagesJsonlPath,
    interactionsJsonlPath: fixture.interactionsJsonlPath,
    jsonDir: fixture.jsonDir,
    debugDir: fixture.debugDir,
    llmJsonBuildTimeoutMs: 5000,
    callLlm: caller,
  });

  assert.equal(result.status, 'error');
  assert.deepEqual(result.categoriesWritten, []);
  assert.deepEqual(result.categoriesFailed, ['casinos']);
  assert.equal(calls.length, 2);
  assert.equal(fs.existsSync(path.join(fixture.jsonDir, 'casinos.json')), false, 'invalid category must never be written to json/');

  assert.ok(result.debugPath && fs.existsSync(result.debugPath));
  const debugContent = JSON.parse(fs.readFileSync(result.debugPath!, 'utf8'));
  assert.equal(debugContent.attempts.length, 2);
  assert.ok(debugContent.attempts[1].errors.length > 0);
});

test('timeout: kills child process semantics surfaced as llm_timeout, no json written, run not crashed', async () => {
  const fixture = await makeRunFixture();
  const { caller, calls } = makeCaller([{ status: 'llm_timeout', errorMessage: 'claude -p killed after exceeding the 5000ms llmJsonBuildTimeoutMs budget' }]);

  const result = await runJsonEvidenceBuild({
    runId: 'run-4',
    casinoName: 'Example Casino',
    entryUrl: 'https://example-casino.test/',
    templateDir: fixture.templateDir,
    corpusDir: fixture.corpusDir,
    pagesJsonlPath: fixture.pagesJsonlPath,
    interactionsJsonlPath: fixture.interactionsJsonlPath,
    jsonDir: fixture.jsonDir,
    debugDir: fixture.debugDir,
    llmJsonBuildTimeoutMs: 5000,
    callLlm: caller,
  });

  assert.equal(result.status, 'llm_timeout');
  assert.deepEqual(result.categoriesWritten, []);
  assert.deepEqual(result.categoriesFailed, ['casinos']);
  assert.equal(calls.length, 1, 'a timeout on the first call never triggers a correction pass');
  assert.equal(fs.existsSync(path.join(fixture.jsonDir, 'casinos.json')), false);
  assert.ok(result.debugPath && fs.existsSync(result.debugPath));
});

test('does not call any raw model/API SDK or reference ANTHROPIC_API_KEY', async () => {
  for (const file of ['json-evidence-builder.ts', 'llm-cli-adapter.ts']) {
    const source = fs.readFileSync(path.join(import.meta.dirname, file), 'utf8');
    assert.doesNotMatch(source, /@anthropic-ai\/sdk/);
    assert.doesNotMatch(source, /ANTHROPIC_API_KEY/);
    assert.doesNotMatch(source, /api\.anthropic\.com/);
  }
});
