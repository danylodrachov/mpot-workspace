/**
 * Black-box acceptance test for issue #58 — prune.ts: promote description + tags.
 * Locked BEFORE implementation (Ralph gate 1). No network, no mocks of prune itself.
 *
 * Acceptance criteria (issue #58):
 *  - description field present on returned item, matches raw.description
 *  - tags field present, is array of raw tag name strings
 *  - raw still present and intact (description + tags inside raw not removed)
 *  - Unit tests (no network): description/tags correct; raw intact
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pruneItems } from './prune.ts';
import type { ClickUpItem } from './fetch.ts';

function makeItem(overrides: { description?: string; tags?: Array<{ name: string }> } = {}): ClickUpItem {
  return {
    source: 'clickup',
    id: 'test-001',
    name: 'Test task',
    board: 'outreach',
    status: 'in progress',
    assignees: ['Alice'],
    due: null,
    url: 'https://app.clickup.com/t/test-001',
    list: 'Outreach kanban board',
    comments: [],
    raw: {
      id: 'test-001',
      name: 'Test task',
      description: overrides.description ?? 'A raw description here.',
      tags: overrides.tags ?? [{ name: 'affiliate' }, { name: 'gp' }],
    },
  };
}

test('description is promoted from raw.description to top-level', () => {
  const input = makeItem({ description: 'Hello from raw.' });
  const [result] = pruneItems([input]);
  assert.ok(result, 'result must exist');
  assert.equal(result.description, 'Hello from raw.', 'top-level description matches raw.description');
});

test('tags is promoted as array of raw name strings', () => {
  const input = makeItem({ tags: [{ name: 'affiliate' }, { name: 'tier-1' }] });
  const [result] = pruneItems([input]);
  assert.ok(result, 'result must exist');
  assert.deepEqual(result.tags, ['affiliate', 'tier-1'], 'top-level tags = raw name strings');
});

test('raw is present and intact after pruning', () => {
  const input = makeItem({ description: 'Preserved.', tags: [{ name: 'foo' }] });
  const [result] = pruneItems([input]);
  assert.ok(result, 'result must exist');
  assert.ok(result.raw, 'raw still present');
  const raw = result.raw as { description?: string; tags?: Array<{ name: string }> };
  assert.equal(raw.description, 'Preserved.', 'raw.description not removed');
  assert.deepEqual(raw.tags, [{ name: 'foo' }], 'raw.tags not modified');
});

test('missing description in raw yields empty string', () => {
  const item = makeItem();
  // Override raw with no description field
  (item.raw as Record<string, unknown>).description = undefined;
  const [result] = pruneItems([item]);
  assert.ok(result, 'result must exist');
  assert.equal(result.description, '', 'missing description -> empty string');
});

test('missing tags in raw yields empty array', () => {
  const item = makeItem();
  (item.raw as Record<string, unknown>).tags = undefined;
  const [result] = pruneItems([item]);
  assert.ok(result, 'result must exist');
  assert.deepEqual(result.tags, [], 'missing tags -> empty array');
});

test('multiple items: second case with different data passes independently', () => {
  const items = [
    makeItem({ description: 'First desc', tags: [{ name: 'alpha' }] }),
    makeItem({ description: 'Second desc', tags: [{ name: 'beta' }, { name: 'gamma' }] }),
  ];
  items[1]!.id = 'test-002';
  const results = pruneItems(items);
  assert.equal(results.length, 2);

  assert.equal(results[0]!.description, 'First desc');
  assert.deepEqual(results[0]!.tags, ['alpha']);

  assert.equal(results[1]!.description, 'Second desc');
  assert.deepEqual(results[1]!.tags, ['beta', 'gamma']);
});

// ---------------------------------------------------------------------------
// Issue #59 — Transform 3: resolve importance from custom_fields
// ---------------------------------------------------------------------------

/** Build a ClickUpItem with custom_fields shaped like the real ClickUp API. */
function makeItemWithImportance(opts: {
  fieldPresent?: boolean;
  value?: number | null;
  options?: Array<{ orderindex: number; name: string }>;
} = {}): ClickUpItem {
  const {
    fieldPresent = true,
    value = 1,
    options = [
      { orderindex: 0, name: 'Low priority 🔽' },
      { orderindex: 1, name: 'Important but not urgent 🔝' },
      { orderindex: 2, name: 'Urgent and important ‼️' },
    ],
  } = opts;

  const customFields = fieldPresent
    ? [
        {
          name: '📌 Importance and priority',
          value: value,
          type_config: { options },
        },
      ]
    : [];

  return {
    source: 'clickup',
    id: 'imp-001',
    name: 'Importance test task',
    board: 'content',
    status: 'to do',
    assignees: ['Alice'],
    due: null,
    url: 'https://app.clickup.com/t/imp-001',
    list: 'Content board',
    comments: [],
    raw: {
      id: 'imp-001',
      name: 'Importance test task',
      description: '',
      tags: [],
      custom_fields: customFields,
    },
  };
}

test('importance resolves to correct label when field and value are present', () => {
  const input = makeItemWithImportance({ value: 1 });
  const [result] = pruneItems([input]);
  assert.ok(result, 'result must exist');
  assert.equal(result.importance, 'Important but not urgent 🔝');
});

test('importance resolves to different label for orderindex 2', () => {
  const input = makeItemWithImportance({ value: 2 });
  const [result] = pruneItems([input]);
  assert.ok(result, 'result must exist');
  assert.equal(result.importance, 'Urgent and important ‼️');
});

test('importance is null when field is absent from custom_fields', () => {
  const input = makeItemWithImportance({ fieldPresent: false });
  const [result] = pruneItems([input]);
  assert.ok(result, 'result must exist');
  assert.equal(result.importance, null);
});

test('importance is null when value is null (unset)', () => {
  const input = makeItemWithImportance({ value: null });
  const [result] = pruneItems([input]);
  assert.ok(result, 'result must exist');
  assert.equal(result.importance, null);
});

// ---------------------------------------------------------------------------
// Issue #60 — Transform 4: slim comment user to { id, username }
// ---------------------------------------------------------------------------

/** A "fat" user object as the ClickUp API returns it — more fields than we want to keep. */
const FAT_USER = {
  id: 7654321,
  username: 'alice',
  email: 'alice@example.com',
  color: '#ff00ff',
  initials: 'AL',
  profilePicture: 'https://cdn.clickup.com/avatar.png',
};

function makeItemWithFatCommentUser(commentId = 'cmt-001', user: Record<string, unknown> = FAT_USER): ClickUpItem {
  return {
    source: 'clickup',
    id: 'task-fat-001',
    name: 'Task with fat comment user',
    board: 'outreach',
    status: 'in progress',
    assignees: ['alice'],
    due: null,
    url: 'https://app.clickup.com/t/task-fat-001',
    list: 'Outreach board',
    comments: [
      {
        id: commentId,
        comment_text: 'A comment from Alice.',
        user,
        date: '1718000000000',
        resolved: false,
        parent: null,
        reply_count: 0,
      },
    ],
    raw: {
      id: 'task-fat-001',
      name: 'Task with fat comment user',
      description: '',
      tags: [],
    },
  };
}

test('comment user is slimmed — email removed', () => {
  const input = makeItemWithFatCommentUser();
  const [result] = pruneItems([input]);
  assert.ok(result, 'result must exist');
  const u = result.comments[0]!.user as Record<string, unknown>;
  assert.ok(!('email' in u), 'email must not be on comment user');
});

test('comment user is slimmed — color removed', () => {
  const input = makeItemWithFatCommentUser();
  const [result] = pruneItems([input]);
  const u = result!.comments[0]!.user as Record<string, unknown>;
  assert.ok(!('color' in u), 'color must not be on comment user');
});

test('comment user is slimmed — initials removed', () => {
  const input = makeItemWithFatCommentUser();
  const [result] = pruneItems([input]);
  const u = result!.comments[0]!.user as Record<string, unknown>;
  assert.ok(!('initials' in u), 'initials must not be on comment user');
});

test('comment user is slimmed — profilePicture removed', () => {
  const input = makeItemWithFatCommentUser();
  const [result] = pruneItems([input]);
  const u = result!.comments[0]!.user as Record<string, unknown>;
  assert.ok(!('profilePicture' in u), 'profilePicture must not be on comment user');
});

test('comment user retains id after slimming', () => {
  const input = makeItemWithFatCommentUser();
  const [result] = pruneItems([input]);
  const u = result!.comments[0]!.user as Record<string, unknown>;
  assert.equal(u.id, 7654321, 'id must be preserved');
});

test('comment user retains username after slimming', () => {
  const input = makeItemWithFatCommentUser();
  const [result] = pruneItems([input]);
  const u = result!.comments[0]!.user as Record<string, unknown>;
  assert.equal(u.username, 'alice', 'username must be preserved');
});

test('all comments on multi-comment item have slimmed users', () => {
  const item: ClickUpItem = {
    source: 'clickup',
    id: 'task-multi-001',
    name: 'Multi comment task',
    board: 'content',
    status: 'to do',
    assignees: ['bob'],
    due: null,
    url: 'https://app.clickup.com/t/task-multi-001',
    list: 'Content board',
    comments: [
      {
        id: 'cmt-a',
        comment_text: 'First comment',
        user: { id: 111, username: 'bob', email: 'bob@example.com', color: '#aabbcc', initials: 'B', profilePicture: null },
        date: '1718000001000',
        resolved: false,
        parent: null,
        reply_count: 0,
      },
      {
        id: 'cmt-b',
        comment_text: 'Second comment',
        user: { id: 222, username: 'carol', email: 'carol@example.com', color: '#123456', initials: 'C', profilePicture: 'https://cdn.clickup.com/carol.jpg' },
        date: '1718000002000',
        resolved: false,
        parent: null,
        reply_count: 0,
      },
    ],
    raw: { id: 'task-multi-001', name: 'Multi comment task', description: '', tags: [] },
  };

  const [result] = pruneItems([item]);
  assert.ok(result, 'result must exist');
  for (const comment of result.comments) {
    const u = comment.user as Record<string, unknown>;
    assert.ok(!('email' in u), `email absent on comment ${comment.id}`);
    assert.ok(!('color' in u), `color absent on comment ${comment.id}`);
    assert.ok(!('initials' in u), `initials absent on comment ${comment.id}`);
    assert.ok(!('profilePicture' in u), `profilePicture absent on comment ${comment.id}`);
    assert.ok('id' in u, `id present on comment ${comment.id}`);
    assert.ok('username' in u, `username present on comment ${comment.id}`);
  }
});

test('second case different user data (id=9999, username=zara) — slimmed correctly', () => {
  const zaraUser = { id: 9999, username: 'zara', email: 'zara@agency.io', color: '#000000', initials: 'ZR', profilePicture: 'https://cdn.clickup.com/zara.png' };
  const input = makeItemWithFatCommentUser('cmt-zara', zaraUser);
  const [result] = pruneItems([input]);
  const u = result!.comments[0]!.user as Record<string, unknown>;
  assert.equal(u.id, 9999);
  assert.equal(u.username, 'zara');
  assert.ok(!('email' in u));
  assert.ok(!('color' in u));
  assert.ok(!('initials' in u));
  assert.ok(!('profilePicture' in u));
});

// ---------------------------------------------------------------------------
// Issue #61 — Transform 5: content-board lead-trim comments to first @Danylo Drachov
// ---------------------------------------------------------------------------

/**
 * Build a content board ClickUpItem with the given comments array.
 * `user` is pre-slimmed (id+username) since Transform 4 runs before Transform 5.
 */
function makeContentItem(id: string, comments: Array<{ id: string; comment_text: string }>): ClickUpItem {
  return {
    source: 'clickup',
    id,
    name: `Content task ${id}`,
    board: 'content',
    status: 'to do',
    assignees: ['Danylo Drachov'],
    due: null,
    url: `https://app.clickup.com/t/${id}`,
    list: 'Content board',
    comments: comments.map((c) => ({
      id: c.id,
      comment_text: c.comment_text,
      user: { id: 1, username: 'someone' },
      date: '1718000000000',
      resolved: false,
      parent: null,
      reply_count: 0,
    })),
    raw: { id, name: `Content task ${id}`, description: '', tags: [] },
  };
}

/**
 * Build an outreach board ClickUpItem with the given comments array.
 */
function makeOutreachItemForTrimTest(id: string, comments: Array<{ id: string; comment_text: string }>): ClickUpItem {
  return {
    source: 'clickup',
    id,
    name: `Outreach task ${id}`,
    board: 'outreach',
    status: 'in progress',
    assignees: ['Danylo Drachov'],
    due: null,
    url: `https://app.clickup.com/t/${id}`,
    list: 'Outreach board',
    comments: comments.map((c) => ({
      id: c.id,
      comment_text: c.comment_text,
      user: { id: 1, username: 'someone' },
      date: '1718000000000',
      resolved: false,
      parent: null,
      reply_count: 0,
    })),
    raw: { id, name: `Outreach task ${id}`, description: '', tags: [] },
  };
}

test('content WITH mention: comments before first @Danylo Drachov are dropped', () => {
  const item = makeContentItem('ct-001', [
    { id: 'c1', comment_text: 'Early context comment' },
    { id: 'c2', comment_text: 'Another leading comment' },
    { id: 'c3', comment_text: 'Hey @Danylo Drachov please review this' },
    { id: 'c4', comment_text: 'Follow-up comment' },
  ]);
  const [result] = pruneItems([item]);
  assert.ok(result, 'result must exist');
  const ids = result.comments.map((c) => c.id);
  assert.ok(!ids.includes('c1'), 'c1 (before mention) must be dropped');
  assert.ok(!ids.includes('c2'), 'c2 (before mention) must be dropped');
  assert.ok(ids.includes('c3'), 'c3 (the mention comment) must be kept');
  assert.ok(ids.includes('c4'), 'c4 (after mention) must be kept');
});

test('content WITH mention: second case — mention is first comment, nothing dropped', () => {
  const item = makeContentItem('ct-002', [
    { id: 'd1', comment_text: '@Danylo Drachov can you look at this?' },
    { id: 'd2', comment_text: 'Sure, on it.' },
  ]);
  const [result] = pruneItems([item]);
  assert.ok(result, 'result must exist');
  const ids = result.comments.map((c) => c.id);
  assert.equal(ids.length, 2, 'both comments kept when mention is first');
  assert.ok(ids.includes('d1'), 'd1 kept');
  assert.ok(ids.includes('d2'), 'd2 kept');
});

test('content WITHOUT mention: all comments kept', () => {
  const item = makeContentItem('ct-003', [
    { id: 'e1', comment_text: 'Just a regular comment' },
    { id: 'e2', comment_text: 'Another regular comment, no mention here' },
    { id: 'e3', comment_text: 'Third comment, still no mention' },
  ]);
  const [result] = pruneItems([item]);
  assert.ok(result, 'result must exist');
  assert.equal(result.comments.length, 3, 'all 3 comments kept when no mention');
  const ids = result.comments.map((c) => c.id);
  assert.ok(ids.includes('e1'), 'e1 kept');
  assert.ok(ids.includes('e2'), 'e2 kept');
  assert.ok(ids.includes('e3'), 'e3 kept');
});

test('outreach WITH mention: comments array completely untouched', () => {
  const item = makeOutreachItemForTrimTest('ot-001', [
    { id: 'f1', comment_text: 'Leading outreach comment' },
    { id: 'f2', comment_text: '@Danylo Drachov FYI' },
    { id: 'f3', comment_text: 'Another outreach comment' },
  ]);
  const [result] = pruneItems([item]);
  assert.ok(result, 'result must exist');
  assert.equal(result.comments.length, 3, 'all 3 outreach comments kept despite mention');
  const ids = result.comments.map((c) => c.id);
  assert.ok(ids.includes('f1'), 'f1 kept (outreach board — no trimming)');
  assert.ok(ids.includes('f2'), 'f2 kept');
  assert.ok(ids.includes('f3'), 'f3 kept');
});
