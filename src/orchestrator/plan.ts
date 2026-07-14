import { writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Action } from './executor/types.ts';
import type { SortableCard } from './sort.ts';

function renderAction(a: Action): string {
  switch (a.kind) {
    case 'lane_move':
      return `LANE MOVE → ${a.to} (gated)`;
    case 'replyio': {
      const step = a.stepId != null ? ` step ${a.stepId}` : '';
      return `REPLY.IO ${a.op}${step} (gated)`;
    }
    case 'comment':
      return `COMMENT: ${a.body.slice(0, 80)}`;
    case 'flag_operator':
      return `FLAG: ${a.reason}`;
  }
}

export function writeDailyPlan(
  dayRoot: string,
  cards: SortableCard[],
  quarantineCount: number,
  flags: string[] = [],
): void {
  const date = basename(dayRoot);
  const lines: string[] = [`# Daily Plan — ${date}`, ''];

  // Safeguard flags (issue #08) — surfaced at the very top so a degraded/halted run is never
  // mistaken for a quiet, healthy one.
  for (const f of flags) {
    if (f.startsWith('RUN DEGRADED') || f.startsWith('HANDBACK')) {
      lines.push(`⚠ ${f}`);
    }
  }
  if (flags.some((f) => f.startsWith('RUN DEGRADED') || f.startsWith('HANDBACK'))) {
    lines.push('');
  }

  const actionable = cards.filter((c) => c.actions.length > 0);
  const idle = cards.filter((c) => c.actions.length === 0);

  lines.push(`## Cards requiring action (${actionable.length})`, '');

  for (const card of actionable) {
    lines.push(`### [${card.board.toUpperCase()}] ${card.taskId} — ${card.currentLane}`);
    lines.push(`**Signal:** ${card.truthfulSignal}`);
    for (const a of card.actions) {
      lines.push(`**Action:** ${renderAction(a)}`);
    }
    lines.push('');
  }

  if (idle.length > 0) {
    lines.push(`## No action needed (${idle.length})`, '');
    for (const card of idle) {
      lines.push(`- [${card.board.toUpperCase()}] ${card.taskId} — ${card.currentLane}`);
    }
    lines.push('');
  }

  lines.push('## Quarantine');
  lines.push(
    quarantineCount > 0
      ? `⚠ ${quarantineCount} item(s) quarantined — check inputs/clean/_quarantine/`
      : 'No items quarantined.',
  );

  writeFileSync(join(dayRoot, 'daily-plan.md'), lines.join('\n') + '\n');
}
