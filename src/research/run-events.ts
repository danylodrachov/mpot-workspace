/**
 * Run event structure for casino discovery pipeline.
 * Events are append-only JSONL records with timing, actor, and stage information.
 */

export interface RunEvent {
  run_id: string;
  event_id: string;
  parent_event_id?: string;
  actor: string;
  module: string;
  stage: number;
  action: string;
  status: "pending" | "running" | "completed" | "blocked" | "error";
  timestamp: string;
  duration_ms?: number;
  counts?: Record<string, number>;
  url_id?: string;
  template_id?: string;
  field_id?: string;
  rule_id?: string;
  error?: string;
  artifact_references?: string[];
  evidence_references?: string[];
}

/**
 * Validates a run event structure.
 */
export function validateRunEvent(event: unknown): event is RunEvent {
  if (typeof event !== "object" || event === null) {
    return false;
  }

  const e = event as Record<string, unknown>;

  // Required fields
  if (typeof e.run_id !== "string") return false;
  if (typeof e.event_id !== "string") return false;
  if (typeof e.actor !== "string") return false;
  if (typeof e.module !== "string") return false;
  if (typeof e.stage !== "number") return false;
  if (typeof e.action !== "string") return false;
  if (typeof e.status !== "string") return false;
  if (typeof e.timestamp !== "string") return false;

  // Optional fields - basic type check
  if (e.parent_event_id !== undefined && typeof e.parent_event_id !== "string") return false;
  if (e.duration_ms !== undefined && typeof e.duration_ms !== "number") return false;
  if (e.url_id !== undefined && typeof e.url_id !== "string") return false;
  if (e.template_id !== undefined && typeof e.template_id !== "string") return false;
  if (e.field_id !== undefined && typeof e.field_id !== "string") return false;
  if (e.rule_id !== undefined && typeof e.rule_id !== "string") return false;
  if (e.error !== undefined && typeof e.error !== "string") return false;

  return true;
}
