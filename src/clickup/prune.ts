/**
 * prune.ts — post-fetch transforms for ClickUp items (issue #58, retrieval-spine).
 *
 * Promotes signal fields from `raw` to the top level so reader subagents can access
 * them without digging into `raw`. The `raw` payload is always preserved intact.
 *
 * Transforms applied (in order):
 *   1. raw.description -> top-level description: string  (empty string if absent)
 *   2. raw.tags[].name -> top-level tags: string[]       (raw names; [] if absent)
 *   3. raw.custom_fields["📌 Importance and priority"] -> top-level importance: string | null
 *   4. comments[].user -> { id, username } only (drop email, color, initials, profilePicture)
 *   5. content board only: drop leading comments before first @Danylo Drachov mention;
 *      if no mention found, keep all; outreach board: untouched.
 *
 * Called from fetch-to-day.ts after fetchTasks returns. fetch.ts is never modified.
 */
import type { ClickUpItem } from './fetch.ts';

/** ClickUpItem with the pruned signal fields promoted to the top level. */
export interface PrunedItem extends ClickUpItem {
  description: string;
  tags: string[];
  importance: string | null;
}

const IMPORTANCE_FIELD = '📌 Importance and priority';
const MENTION = '@Danylo Drachov';

/**
 * Promote description, tags, and importance from raw to the top level of each item.
 * raw is always preserved intact — no keys are removed from it.
 * comment users are slimmed to { id, username } only.
 * Content board: leading comments before first @Danylo Drachov mention are dropped.
 */
export function pruneItems(items: ClickUpItem[]): PrunedItem[] {
  return items.map((item) => {
    const raw = item.raw as Record<string, unknown>;

    // Transform 1: description
    const description = typeof raw.description === 'string' ? raw.description : '';

    // Transform 2: tags
    const rawTags = Array.isArray(raw.tags) ? (raw.tags as Array<Record<string, unknown>>) : [];
    const tags = rawTags.map((t) => (typeof t.name === 'string' ? t.name : '')).filter(Boolean);

    // Transform 3: importance from custom_fields
    const importance = resolveImportance(raw);

    // Transform 4: slim comment users to { id, username } only
    const slimmedComments = item.comments.map((comment) => {
      const u = comment.user as Record<string, unknown> | null | undefined;
      const slimUser = u != null ? { id: u.id, username: u.username } : u;
      return { ...comment, user: slimUser };
    });

    // Transform 5: content board — drop leading comments before first @Danylo Drachov mention
    const comments = item.board === 'content'
      ? trimLeadingComments(slimmedComments)
      : slimmedComments;

    return { ...item, description, tags, importance, comments };
  });
}

type SlimComment = ClickUpItem['comments'][number];

/**
 * For content board: find the first comment whose comment_text contains "@Danylo Drachov"
 * and return a slice from that index onward. If no such comment exists, return all.
 */
function trimLeadingComments(comments: SlimComment[]): SlimComment[] {
  const mentionIndex = comments.findIndex((c) => c.comment_text.includes(MENTION));
  if (mentionIndex === -1) return comments;
  return comments.slice(mentionIndex);
}

type CustomField = {
  name: string;
  value: unknown;
  type_config?: { options?: Array<{ orderindex: number; name: string }> };
};

function resolveImportance(raw: Record<string, unknown>): string | null {
  if (!Array.isArray(raw.custom_fields)) return null;
  const fields = raw.custom_fields as CustomField[];
  const field = fields.find((f) => f.name === IMPORTANCE_FIELD);
  if (!field) return null;
  if (field.value === null || field.value === undefined) return null;
  const options = field.type_config?.options;
  if (!Array.isArray(options)) return null;
  const match = options.find((o) => o.orderindex === field.value);
  return match ? match.name : null;
}
