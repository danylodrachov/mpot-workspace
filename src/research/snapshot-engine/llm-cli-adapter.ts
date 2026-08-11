// CD-N06: subscription-CLI transport for the LLM JSON-build/fact-extraction step.
//
// Reuses the EXACT invocation mechanism already established by `cliLlmCaller` in
// src/llm/call.ts: a one-shot `claude -p` child process, with `--system-prompt` replacing the
// Claude Code harness system prompt, `--disallowedTools "*"` sending no tool schemas, and
// `--exclude-dynamic-system-prompt-sections` dropping the remaining dynamic harness inserts, so
// the request is token-equivalent to a plain single-turn model call. This module never imports an
// SDK, never reads/sends a raw model API key env var, and never calls the raw model API directly
// — the only "model call" this codebase makes is through the operator's already-logged-in `claude` CLI.
//
// The one addition over `cliLlmCaller`: a bounded `timeoutMs` (sourced from runtime-config.ts's
// `llmJsonBuildTimeoutMs` budget by the caller) wired through `execFile`'s native `timeout`/
// `killSignal` options, so a hung child process is always killed rather than left running, and the
// timeout case is reported as the dedicated `llm_timeout` status (see `LlmJsonBuildStatus` in
// types.ts) instead of being indistinguishable from any other child-process failure.
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { LlmJsonBuildStatus } from './types.ts';

export interface LlmJsonCliRequest {
  /** Pinned model short name (e.g. 'sonnet') — same convention as src/llm/call.ts's MODEL_IDS. */
  model?: string;
  /** Replaces the Claude Code harness system prompt for this one-shot call. */
  system: string;
  /** Sent over stdin as the single user turn. */
  user: string;
  /** Bounded wall-clock budget for this one child-process invocation. */
  timeoutMs: number;
}

export interface LlmJsonCliResult {
  status: LlmJsonBuildStatus;
  stdout?: string;
  errorMessage?: string;
}

/** Injectable — tests supply a fake caller and must never spawn a real `claude` process. */
export type LlmJsonCliCaller = (request: LlmJsonCliRequest) => Promise<LlmJsonCliResult>;

export const cliLlmJsonCaller: LlmJsonCliCaller = (request: LlmJsonCliRequest): Promise<LlmJsonCliResult> =>
  new Promise<LlmJsonCliResult>((resolve) => {
    const child = execFile(
      'claude',
      [
        '-p',
        '--model', request.model ?? 'sonnet',
        '--system-prompt', request.system,
        '--disallowedTools', '*',
        '--exclude-dynamic-system-prompt-sections',
      ],
      {
        cwd: tmpdir(),
        maxBuffer: 20 * 1024 * 1024,
        timeout: request.timeoutMs,
        killSignal: 'SIGKILL',
      },
      (err, stdout, stderr) => {
        if (err) {
          // execFile's own timeout enforcement sets `killed: true` on the error only when IT
          // decided to kill the child after `timeout` elapsed (Node semantics) — distinct from any
          // other spawn/exit failure, so this is a reliable, non-heuristic timeout signal.
          if (err.killed) {
            resolve({
              status: 'llm_timeout',
              errorMessage: `claude -p killed after exceeding the ${request.timeoutMs}ms llmJsonBuildTimeoutMs budget: ${err.message}`,
            });
            return;
          }
          resolve({ status: 'error', errorMessage: `claude -p failed: ${err.message}\n${stderr}` });
          return;
        }
        if (!stdout.trim()) {
          resolve({ status: 'error', errorMessage: 'claude -p: empty response' });
          return;
        }
        resolve({ status: 'complete', stdout });
      },
    );
    child.stdin?.end(request.user);
  });
