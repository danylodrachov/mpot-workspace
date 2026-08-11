import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// CF-03: doc-content check — the reviewer's instructions must explicitly allow saved network
// evidence bodies as a factual source (in the mandated order) while still prohibiting live
// browsing/MCP tools, and must forbid using network evidence to prove an unvisited URL was
// visited.
const docPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '.claude',
  'agents',
  'discovery-reviewer.md',
);

test('CF-03: discovery-reviewer.md allows saved network evidence and still prohibits live browsing', () => {
  const doc = fs.readFileSync(docPath, 'utf-8');

  assert.match(doc, /never browses?|never browse/i);
  assert.match(doc, /No live browsing, no MCP\/browser tools/);

  assert.match(doc, /network-evidence\.jsonl/);
  assert.match(doc, /networkEvidenceIndexPath/);

  assert.match(doc, /saved page corpus\/HTML[\s\S]*interaction\/[\s\S]*passive trace evidence[\s\S]*same-origin captured network evidence/);

  assert.match(doc, /never proves?\s+that an unvisited document URL was\s+visited/i);
});
