import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArgs } from './cli.ts';

// CD-N01: --casino-name is required, same validation style as the pre-existing --url check.

test('parseArgs requires --url', () => {
  assert.throws(
    () => parseArgs(['--casino-name', 'Example Casino']),
    /Required: --url/,
  );
});

test('parseArgs requires --casino-name', () => {
  assert.throws(
    () => parseArgs(['--url', 'https://example.test/']),
    /Required: --casino-name/,
  );
});

test('parseArgs accepts --url and --casino-name together, with debugArtifacts defaulting to false', () => {
  const args = parseArgs(['--url', 'https://example.test/', '--casino-name', 'Example Casino']);
  assert.equal(args.url, 'https://example.test/');
  assert.equal(args.casinoName, 'Example Casino');
  assert.equal(args.debugArtifacts, false);
});

test('parseArgs recognizes the --debug-artifacts boolean flag regardless of its position', () => {
  const args = parseArgs([
    '--url', 'https://example.test/',
    '--casino-name', 'Example Casino',
    '--debug-artifacts',
    '--geo', 'no',
  ]);
  assert.equal(args.debugArtifacts, true);
  assert.equal(args.geo, 'no');
});
