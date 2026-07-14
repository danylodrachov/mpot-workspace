/**
 * tracer.followups (issue #06) — locked from the acceptance criteria (Ralph gate 1).
 * Black-box: drives the real `runFollowupSweep` over a fixture registry + on-disk verdict/thread
 * files for four open outreach threads (session 2026-07-03 follow-up rule: questions uncovered
 * AND >=2 days since the thread's last letter; who wrote last only changes the draft's tone):
 *
 *  1. covered, stale               -> not selected (tc_covered fully true)
 *  2. uncovered, last letter 1 day -> not selected (under the 2-day threshold)
 *  3. uncovered, last letter 3 days, donor wrote last -> SELECTED, who_wrote_last: "donor"
 *  4. uncovered, last letter 3 days, we wrote last, but a draft is already pending -> not
 *     selected (draft already non-null)
 *
 * Acceptance criteria (issue #06):
 *  1. Sweep selects exactly thread 3.
 *  2. Fake caller receives exactly one write-only call carrying who_wrote_last: "donor"; zero
 *     other model calls.
 *  3. Re-running the sweep immediately (draft now pending) selects nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runFollowupSweep } from './followups.ts';
import type { Registry } from './registry.ts';
import type { LlmCallRequest } from '../llm/call.ts';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'tracer-followups-'));
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

const THREAD_VERDICT_TEMPLATE = {
  source: 'replyio',
  thread_id: null as string | null,
  sequence: 'Guest Post Outreach — Q3',
  media: null,
  label: 'outreach',
  tc_covered: null as Record<string, boolean> | null,
  decision_data: { payment_terms: null, ready_for_qa: null },
  reasoning: 'prior read-pass reasoning',
  draft: null as string | null,
  user_feedback: null,
  AI_feedback: null,
};

function makeThread(id: string, company: string, contactEmail: string, isOutboundLast: boolean) {
  return {
    id,
    subject: `Re: Guest post collaboration — ${company}`,
    sequence: 'Guest Post Outreach — Q3',
    lastActivityDate: null,
    category: 'Interested',
    contact: { name: 'Contact Person', email: contactEmail, company, title: 'Editor' },
    messages: [
      {
        date: '2026-06-20T00:00:00Z',
        from: isOutboundLast ? 'daniel@marketing-pot.com' : contactEmail,
        isOutbound: isOutboundLast,
        body: isOutboundLast ? 'Just checking in on the above.' : 'Thanks, still reviewing.',
        attachments: [],
      },
    ],
  };
}

/** Seeds one thread's on-disk thread + verdict files and its registry entry, keyed like issue #01. */
function seedThread(
  root: string,
  registry: Registry,
  opts: {
    id: string;
    company: string;
    lastActivityDate: string;
    tcCovered: Record<string, boolean>;
    draft: string | null;
    isOutboundLast: boolean;
  },
): string {
  const { id, company, lastActivityDate, tcCovered, draft, isOutboundLast } = opts;
  const contactEmail = `contact@${company.toLowerCase().replace(/\s+/g, '')}.com`;
  const dir = join(root, 'data', '2026-06-20', 'outputs', 'emails', 'replyio');

  const threadPath = join(dir, `${id}.json`);
  const verdictPath = join(dir, `${id}.verdict.json`);

  writeJson(threadPath, makeThread(id, company, contactEmail, isOutboundLast));
  writeJson(verdictPath, { ...THREAD_VERDICT_TEMPLATE, thread_id: id, tc_covered: tcCovered, draft });

  const key = `replyio:${id}:${lastActivityDate}`;
  registry[key] = {
    thread_id: id,
    task_id: null,
    clickup_status: null,
    file: `data/2026-06-20/outputs/emails/replyio/${id}.json`,
    verdict: `data/2026-06-20/outputs/emails/replyio/${id}.verdict.json`,
    redo_draft: null,
  };
  return key;
}

function fakeCaller(requests: LlmCallRequest[]) {
  return async (req: LlmCallRequest): Promise<string> => {
    requests.push(req);
    return JSON.stringify({ draft: 'Following up — could you confirm the outstanding point?' });
  };
}

test('tracer.followups: selects only the uncovered thread >=2 days stale with no pending draft', async () => {
  const root = makeRoot();
  const now = new Date('2026-06-23T00:00:00Z');

  const registry: Registry = {};

  // Thread 1 — covered, stale. Not selected: fully covered.
  seedThread(root, registry, {
    id: '2001',
    company: 'CoveredStaleOutlet',
    lastActivityDate: '2026-06-01T00:00:00Z',
    tcCovered: { pricing_per_article: true, link_type: true },
    draft: null,
    isOutboundLast: false,
  });

  // Thread 2 — uncovered, last letter 1 day ago. Not selected: under 2-day threshold.
  seedThread(root, registry, {
    id: '2002',
    company: 'RecentOutlet',
    lastActivityDate: '2026-06-22T00:00:00Z',
    tcCovered: { pricing_per_article: true, link_type: false },
    draft: null,
    isOutboundLast: false,
  });

  // Thread 3 — uncovered, last letter 3 days ago, donor wrote last. SELECTED.
  seedThread(root, registry, {
    id: '2003',
    company: 'StaleUncoveredOutlet',
    lastActivityDate: '2026-06-20T00:00:00Z',
    tcCovered: { pricing_per_article: true, link_type: false },
    draft: null,
    isOutboundLast: false, // donor wrote last
  });

  // Thread 4 — uncovered, 3 days, we wrote last, but a draft is already pending. Not selected.
  seedThread(root, registry, {
    id: '2004',
    company: 'PendingDraftOutlet',
    lastActivityDate: '2026-06-20T00:00:00Z',
    tcCovered: { pricing_per_article: true, link_type: false },
    draft: 'Already drafted, awaiting operator approval.',
    isOutboundLast: true, // we wrote last
  });

  const requests: LlmCallRequest[] = [];
  const selected = await runFollowupSweep(root, registry, fakeCaller(requests), now);

  // ── #1: sweep selects exactly thread 3 ──
  assert.equal(selected.length, 1, 'exactly one thread selected');
  assert.equal(selected[0].entry.thread_id, '2003', 'the selected thread is thread 3');

  // ── #2: exactly one write-only call, carrying who_wrote_last: "donor" ──
  assert.equal(requests.length, 1, 'exactly one model call total');
  const user = JSON.parse(requests[0].user) as { who_wrote_last: string; verdict: { thread_id: string } };
  assert.equal(user.who_wrote_last, 'donor', 'who_wrote_last reflects the donor-wrote-last scene');
  assert.equal(user.verdict.thread_id, '2003', 'the call carries thread 3\'s verdict as context');
  assert.match(requests[0].system, /OKB drafter/, 'request carries the messaging-write-outreach.md prompt body');
  assert.ok(!('tools' in requests[0]), 'request carries no tool definitions');

  // Draft actually landed on thread 3's verdict file, nothing else touched.
  const verdict3 = JSON.parse(
    readFileSync(join(root, 'data/2026-06-20/outputs/emails/replyio/2003.verdict.json'), 'utf8'),
  ) as { draft: string | null };
  assert.ok(verdict3.draft, 'thread 3 verdict got a draft written');

  const verdict4 = JSON.parse(
    readFileSync(join(root, 'data/2026-06-20/outputs/emails/replyio/2004.verdict.json'), 'utf8'),
  ) as { draft: string | null };
  assert.equal(
    verdict4.draft,
    'Already drafted, awaiting operator approval.',
    'thread 4 (pending draft) is untouched by this sweep',
  );

  // ── #3: re-running immediately (thread 3's draft now pending) selects nothing ──
  const requests2: LlmCallRequest[] = [];
  const selected2 = await runFollowupSweep(root, registry, fakeCaller(requests2), now);
  assert.equal(selected2.length, 0, 're-run: nothing selected once the draft is pending');
  assert.equal(requests2.length, 0, 're-run: zero model calls');
});
