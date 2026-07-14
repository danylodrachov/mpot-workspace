/**
 * tracer.replyio (issue #10): step-targeted enrolment via contact-links/bulk.
 * Acceptance criteria:
 *  - enrol Action → exact contact-links/bulk body (startStepId, removeFromExisting)
 *  - re-target path (removeFromExisting:true + startStepId) asserted
 *  - loop guard ≤2 runs/step
 *  - stub only at the fetcher boundary; the rest is real
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBulkEnrolBody,
  enrolContact,
  LOOP_GUARD_MAX,
  type BulkEnrolBody,
  type EnrolResult,
} from './outbound.ts';

// ── buildBulkEnrolBody: pure body construction ───────────────────────────────

test('tracer.replyio: enrol → exact contact-links/bulk body (removeFromExisting:false)', () => {
  const body = buildBulkEnrolBody(42, 1, false);
  const expected: BulkEnrolBody = {
    contacts: [{ id: 42 }],
    startStepId: 1,
    removeFromExisting: false,
  };
  assert.deepEqual(body, expected);
});

test('tracer.replyio: re-target path → removeFromExisting:true + startStepId', () => {
  const body = buildBulkEnrolBody(99, 2, true);
  assert.equal(body.removeFromExisting, true);
  assert.equal(body.startStepId, 2);
  assert.equal(body.contacts[0]!.id, 99);
});

test('tracer.replyio: customFields included when present', () => {
  const fields = [
    { key: 'article_draft_url', value: 'https://drive.google.com/drive/folders/abc123' },
    { key: 'article_title', value: 'My Article' },
  ];
  const body = buildBulkEnrolBody(7, 1, false, fields);
  assert.deepEqual(body.contacts[0]!.customFields, fields);
});

test('tracer.replyio: customFields omitted when empty', () => {
  const body = buildBulkEnrolBody(7, 1, false, []);
  assert.equal(body.contacts[0]!.customFields, undefined);
});

// ── loop guard ────────────────────────────────────────────────────────────────

test('tracer.replyio: loop guard — runCountForStep >= LOOP_GUARD_MAX → outcome:loop_guard', async () => {
  const result = await enrolContact({
    apiKey: 'test-key',
    sequenceId: 5,
    contactId: 42,
    stepId: 2,
    removeFromExisting: true,
    runCountForStep: LOOP_GUARD_MAX,
  });
  assert.deepEqual(result, { outcome: 'loop_guard' });
});

test('tracer.replyio: loop guard cap is 2 (LOOP_GUARD_MAX === 2)', () => {
  assert.equal(LOOP_GUARD_MAX, 2);
});

// ── fetcher boundary stub ─────────────────────────────────────────────────────

function makeFetcher(status: number, responseBody: unknown): (url: string, init?: RequestInit) => Promise<Response> {
  return async (_url, _init) =>
    new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
}

function captureBodyFetcher(): {
  fetcher: (url: string, init?: RequestInit) => Promise<Response>;
  captured: { url: string; body: BulkEnrolBody | null };
} {
  const captured = { url: '', body: null as BulkEnrolBody | null };
  const fetcher = async (url: string, init?: RequestInit) => {
    captured.url = url;
    captured.body = JSON.parse((init?.body as string) ?? 'null') as BulkEnrolBody;
    return new Response(JSON.stringify({ items: [{ status: 'ok' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetcher, captured };
}

test('tracer.replyio: enrol → correct URL and body sent to API', async () => {
  const { fetcher, captured } = captureBodyFetcher();
  const result: EnrolResult = await enrolContact({
    apiKey: 'key-abc',
    sequenceId: 10,
    contactId: 55,
    stepId: 1,
    removeFromExisting: false,
    runCountForStep: 0,
    customFields: [{ key: 'article_title', value: 'Test' }],
    fetcher,
  });
  assert.equal(result.outcome, 'enrolled');
  assert.match(captured.url, /sequences\/10\/contact-links\/bulk/);
  assert.equal(captured.body!.startStepId, 1);
  assert.equal(captured.body!.removeFromExisting, false);
  assert.equal(captured.body!.contacts[0]!.id, 55);
  assert.deepEqual(captured.body!.contacts[0]!.customFields, [{ key: 'article_title', value: 'Test' }]);
});

test('tracer.replyio: re_enrol → removeFromExisting:true in sent body', async () => {
  const { fetcher, captured } = captureBodyFetcher();
  await enrolContact({
    apiKey: 'key-abc',
    sequenceId: 10,
    contactId: 55,
    stepId: 2,
    removeFromExisting: true,
    runCountForStep: 0,
    fetcher,
  });
  assert.equal(captured.body!.removeFromExisting, true);
  assert.equal(captured.body!.startStepId, 2);
});

test('tracer.replyio: contactAlreadyInSequence response → outcome:already_in_sequence', async () => {
  const fetcher = makeFetcher(200, { items: [{ status: 'contactAlreadyInSequence' }] });
  const result = await enrolContact({
    apiKey: 'key-abc',
    sequenceId: 10,
    contactId: 55,
    stepId: 1,
    removeFromExisting: false,
    runCountForStep: 0,
    fetcher,
  });
  assert.equal(result.outcome, 'already_in_sequence');
});

test('tracer.replyio: API error → throws with status in message', async () => {
  const fetcher = makeFetcher(400, 'Bad Request');
  await assert.rejects(
    () =>
      enrolContact({
        apiKey: 'key-abc',
        sequenceId: 10,
        contactId: 55,
        stepId: 1,
        removeFromExisting: false,
        runCountForStep: 0,
        fetcher,
      }),
    /400/,
  );
});
