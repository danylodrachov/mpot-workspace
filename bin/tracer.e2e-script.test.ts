/**
 * tracer.e2e-script (issue #10) — locked from the acceptance criteria before the run script
 * existed. Black-box: drives the REAL `runOkbE2E` (the function `bin/run-okb-e2e.sh` wraps) end
 * to end — fetch -> filter -> clean -> split -> agents -> verdict collection — over the tracer
 * fixture day, with an injected fetch (offline, same fixtures the other tracer tests read) and
 * an injected fake caller (offline, no Anthropic call). Asserts only observable output: stdout
 * lines and files actually written to disk.
 *
 * Acceptance criteria (issue #10):
 *  1. stdout contains the [done] lines for fetch, filter, clean, split, agents, verdicts — in
 *     that order, each with a non-zero count and a real existing path.
 *  2. Every fixture letter without a pre-seeded task_id produced one [stub] clickup: line;
 *     zero ClickUp write calls recorded.
 *  3. Break one stage (clean quarantines every fetched letter as machine-mail): the script
 *     exits non-zero, prints a [fail] line for that stage, and NO [done] lines for any later
 *     stage appear.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runOkbE2E } from './run-okb-e2e.ts';
import type { LlmCallRequest } from '../src/llm/call.ts';
import type { ReplyItem } from '../src/replyio/fetch.ts';

const fixDir = fileURLToPath(new URL('../src/pipeline/__fixtures__/tracer', import.meta.url));

function readFixture(name: string): ReplyItem {
  return JSON.parse(readFileSync(join(fixDir, name), 'utf8')) as ReplyItem;
}

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'tracer-e2e-'));
}

function fakeCaller(requests: LlmCallRequest[]) {
  return async (req: LlmCallRequest): Promise<string> => {
    requests.push(req);
    return JSON.stringify({
      tc_covered: { pricing_per_article: true, link_type: false },
      decision_data: { payment_terms: '150 USD per article' },
      reasoning: 'fixture reasoning — pricing confirmed, link type still open',
      draft: 'Thanks for the update — could you confirm dofollow vs nofollow for the link?',
    });
  };
}

/** Capture console.log lines for the duration of one run; always restores afterward. */
async function withCapturedLog<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.log = orig;
  }
}

const DONE_RE = /^\[done\] ([a-z ]+): created (\d+) .+ at (\S+)$/;

test('tracer.e2e-script: fixture day -> 6 ordered [done] lines, stub lines for unmapped letters, verdicts filled', async () => {
  const root = makeRoot();
  const date = '2026-06-24';

  // Two DIFFERENT fixture letters (different id/company/contact/body) — neither has a prior
  // registry entry, so both are brand-new and unmapped (issue #05: new letters get
  // task_id: null).
  const letterA = readFixture('okb-reply.raw.json'); // id 1001, VidaTech Blog
  const letterB = readFixture('okb-reply-sequence.raw.json'); // id 1002, Northwind Gear

  const requests: LlmCallRequest[] = [];
  const { result, lines } = await withCapturedLog(() =>
    runOkbE2E(root, date, {
      fetchReplyio: async () => [letterA, letterB],
      caller: fakeCaller(requests),
    }),
  );

  assert.equal(result.ok, true, `expected a clean run, got:\n${lines.join('\n')}`);

  // ── #1: six [done] lines, in order, each with a non-zero count and a real existing path ──
  const doneLines = lines.filter((l) => l.startsWith('[done]'));
  const matches = doneLines.map((l) => DONE_RE.exec(l));
  assert.ok(
    matches.every((m) => m !== null),
    `every [done] line matches the "created <N> ... at <path>" format:\n${doneLines.join('\n')}`,
  );
  assert.deepEqual(
    matches.map((m) => m![1]),
    ['fetch replyio', 'filter', 'clean', 'split', 'agents', 'verdicts'],
    'the six stages announce completion in this exact order',
  );
  for (const m of matches) {
    assert.ok(Number(m![2]) > 0, `stage "${m![1]}" reports a non-zero count`);
    assert.ok(existsSync(m![3]), `stage "${m![1]}"'s reported path actually exists: ${m![3]}`);
  }

  // ── #2: every unmapped letter got exactly one stub line; zero ClickUp actions of any kind ──
  const stubLines = lines.filter((l) => l.startsWith('[stub] clickup:'));
  assert.equal(stubLines.length, 2, 'both fixture letters are unmapped -> two stub lines, one each');
  assert.ok(stubLines.some((l) => l.includes('1001')), 'letter 1001 got a stub line');
  assert.ok(stubLines.some((l) => l.includes('1002')), 'letter 1002 got a stub line');
  assert.ok(
    !lines.some((l) => /clickup/i.test(l) && !l.startsWith('[stub] clickup:')),
    'no ClickUp action of any kind other than the stub line itself',
  );

  // ── model calls: exactly one per letter (issue #05 spine, exercised through this script) ──
  assert.equal(requests.length, 2, 'exactly one direct model call per letter');
  assert.equal(result.modelCallCount, 2);

  // ── verdicts genuinely filled from the fake caller's reply, not a hollow template ──
  const dayRoot = join(root, 'data', date);
  const verdictA = JSON.parse(
    readFileSync(join(dayRoot, 'outputs', 'emails', 'replyio', '1001.verdict.json'), 'utf8'),
  ) as Record<string, unknown>;
  const verdictB = JSON.parse(
    readFileSync(join(dayRoot, 'outputs', 'emails', 'replyio', '1002.verdict.json'), 'utf8'),
  ) as Record<string, unknown>;
  for (const v of [verdictA, verdictB]) {
    assert.equal(v['label'], 'outreach');
    assert.ok(v['tc_covered'], 'tc_covered filled');
    assert.equal(v['reasoning'], 'fixture reasoning — pricing confirmed, link type still open');
    assert.equal(v['draft'], 'Thanks for the update — could you confirm dofollow vs nofollow for the link?');
  }
});

test('tracer.e2e-script: broken clean stage (every fetched letter is machine-mail) -> [fail], no later [done] lines, non-zero result', async () => {
  const root = makeRoot();
  const date = '2026-06-25';

  // A well-formed reply.io item that clean()'s machine-mail gate quarantines on arrival
  // (subject matches the out-of-office pattern) — fetch and filter both succeed (one real,
  // fresh item kept), but clean() has nothing left to write once its own gate runs.
  const oooLetter: ReplyItem = {
    source: 'replyio',
    id: '9001',
    subject: 'Out of office: back next week',
    body: 'Automatic reply — I am currently out of office.',
    from: 'someone@example.com',
    date: '2026-06-24T00:00:00Z',
    email: 'someone@example.com',
    name: 'Someone Else',
    company: 'Example Co',
    raw: { lastActivityDate: '2026-06-24T00:00:00Z' },
  };

  const { result, lines } = await withCapturedLog(() =>
    runOkbE2E(root, date, {
      fetchReplyio: async () => [oooLetter],
      caller: async () => {
        throw new Error('must not be called — clean should already have failed the run');
      },
    }),
  );

  assert.equal(result.ok, false, 'the run reports failure');
  assert.equal(result.failedStage, 'clean', 'the run identifies clean as the failed stage');

  const doneStages = lines.filter((l) => l.startsWith('[done]')).map((l) => DONE_RE.exec(l)?.[1]);
  assert.deepEqual(doneStages, ['fetch replyio', 'filter'], 'only fetch and filter completed before the break');
  assert.ok(lines.some((l) => l.startsWith('[fail] clean:')), 'a [fail] line names the clean stage');
  assert.ok(!lines.some((l) => l.startsWith('[done] split')), 'split never runs after the break');
  assert.ok(!lines.some((l) => l.startsWith('[done] agents')), 'agents never runs after the break');
  assert.ok(!lines.some((l) => l.startsWith('[done] verdicts')), 'verdicts never runs after the break');
});
