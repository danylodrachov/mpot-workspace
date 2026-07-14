/**
 * Direct model caller (issue #05) — replaces the per-step Claude Code session (`realSpawner`
 * double-session defect) for the OKB letter path. A "subagent" here is a PLAIN Anthropic API
 * request: code reads the agent's `.claude/agents/<name>.md` body as the system prompt, inlines
 * the cleaned letter (+ mapped card) as the user turn, and sends NO `tools` field — the model
 * physically cannot read any other file. Code parses the JSON reply and writes verdict fields;
 * the model never touches the filesystem (sessions/2026-07-03-registry-design-facts.md §"Agent
 * economy").
 */
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';

export interface LlmCallRequest {
  /** Pinned model id — resolved from the agent .md frontmatter's `model:` short name. */
  model: string;
  /** The agent's prompt body (frontmatter stripped) — sent as the system turn. */
  system: string;
  /** Inlined cleaned content (thread + mapped card, or verdict + card for write-only calls). */
  user: string;
}

/** Injectable — tests record payloads and return canned JSON; production hits the real API. */
export type LlmCaller = (req: LlmCallRequest) => Promise<string>;

/** Short frontmatter names (`.claude/agents/*.md`) -> pinned Anthropic model ids. */
const MODEL_IDS: Record<string, string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-4-5',
  opus: 'claude-opus-4-1',
};

export function resolveModelId(shortName: string): string {
  return MODEL_IDS[shortName] ?? shortName;
}

/** Split an agent `.md` file into its pinned model id + system-prompt body. */
export function loadAgentPrompt(path: string): { model: string; system: string } {
  const raw = readFileSync(path, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`agent prompt ${path}: missing --- frontmatter`);
  const [, frontmatter, body] = m;
  const modelLine = frontmatter.match(/^model:\s*(\S+)/m);
  const shortName = modelLine ? modelLine[1] : 'sonnet';
  return { model: resolveModelId(shortName), system: body.trim() };
}

/**
 * Real caller — plain Anthropic Messages API request over `fetch`, no SDK, no tools field.
 * Only reachable in production (tests always inject a fake caller).
 */
export const realLlmCaller: LlmCaller = async (req: LlmCallRequest): Promise<string> => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set — required for the direct OKB caller');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: req.model,
      max_tokens: 4096,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      // No `tools` field — intentionally absent, never add one here.
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
  const textBlock = data.content.find((c) => c.type === 'text');
  if (!textBlock?.text) throw new Error('Anthropic API: no text content in response');
  return textBlock.text;
};

/**
 * Subscription caller — same single-shot, tool-less request as `realLlmCaller`, transported
 * through the operator's logged-in `claude` CLI instead of an API key. The three flags strip
 * the request down to system prompt + letter (measured 168 input tokens vs 18,640 for a plain
 * `claude -p` session): `--system-prompt` REPLACES the Claude Code system prompt with the
 * agent's body, `--disallowedTools "*"` sends no tool schemas, and
 * `--exclude-dynamic-system-prompt-sections` drops the remaining harness inserts. One
 * response, one iteration — token weight matches the API path. cwd is the OS tmpdir so no
 * CLAUDE.md or project settings can leak into the request.
 */
export const cliLlmCaller: LlmCaller = (req: LlmCallRequest): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const child = execFile(
      'claude',
      [
        '-p',
        '--model', req.model,
        '--system-prompt', req.system,
        '--disallowedTools', '*',
        '--exclude-dynamic-system-prompt-sections',
      ],
      { cwd: tmpdir(), maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`claude -p failed: ${err.message}\n${stderr}`));
        else if (!stdout.trim()) reject(new Error('claude -p: empty response'));
        else resolve(stdout);
      },
    );
    child.stdin?.end(req.user);
  });

/** Production default: API key when the operator set one, otherwise the subscription CLI. */
export const defaultLlmCaller: LlmCaller = (req: LlmCallRequest): Promise<string> =>
  process.env.ANTHROPIC_API_KEY ? realLlmCaller(req) : cliLlmCaller(req);

/** Parse a model's JSON reply, tolerating a ```json ... ``` fence some models still add. */
export function parseModelJson(raw: string): Record<string, unknown> {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = fenced ? fenced[1] : raw;
  return JSON.parse(text.trim()) as Record<string, unknown>;
}
