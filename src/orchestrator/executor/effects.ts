/**
 * effects.ts — dry-run stubs (ADR 0042). Renders each Action to an intent string;
 * real API calls drop in behind the same signatures later without touching resolve.ts or its tests.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { Action, ReconcileVerdict } from './types.ts';

export function renderIntent(action: Action, taskId: string): string {
  switch (action.kind) {
    case 'lane_move':
      return `[CLICKUP] move ${taskId} → ${action.to} (gated)`;
    case 'comment': {
      const tag = action.tag ? ` @${action.tag}` : '';
      return `[CLICKUP] comment on ${taskId}: "${action.body.slice(0, 60)}"${tag}`;
    }
    case 'replyio': {
      const step = action.stepId != null ? ` step ${action.stepId}` : '';
      return `[REPLY.IO] ${action.op}${step}: ${action.note} (gated)`;
    }
    case 'flag_operator':
      return `[FLAG] ${action.reason}`;
  }
}

export function readReconcileVerdict(verdictPath: string): ReconcileVerdict {
  return JSON.parse(readFileSync(verdictPath, 'utf8')) as ReconcileVerdict;
}

/** Writes resolved Action[] as intent strings into `dry_run[]` on the verdict file. */
export function applyDryRun(verdictPath: string, actions: Action[], taskId: string): void {
  const verdict = readReconcileVerdict(verdictPath);
  verdict.dry_run = actions.map((a) => renderIntent(a, taskId));
  writeFileSync(verdictPath, JSON.stringify(verdict, null, 2));
}
