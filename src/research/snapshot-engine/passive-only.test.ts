import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

// The snapshot crawl is passive by contract: it may navigate and read, but it must
// never activate a page element. A regression here would make the saved trace claim
// post-action behaviour the run never observed.
const engineDir = import.meta.dirname;
const sources = fs
  .readdirSync(engineDir)
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
  .map((file) => ({ file, text: fs.readFileSync(path.join(engineDir, file), 'utf-8') }));

test('no snapshot-engine module performs a page-element interaction', () => {
  const forbidden = [
    /\.click\s*\(/,
    /\.dblclick\s*\(/,
    /\.hover\s*\(/,
    /\.tap\s*\(/,
    /\.fill\s*\(/,
    /(?<!dialog)\.type\s*\(/, // dialog.type() reads the native dialog kind; it activates nothing
    /\.press\s*\(/,
    /\.selectOption\s*\(/,
    /\.check\s*\(/,
    /\.uncheck\s*\(/,
    /\.setInputFiles\s*\(/,
    /\.dragTo\s*\(/,
    /\.focus\s*\(/,
    /\.scrollIntoViewIfNeeded\s*\(/,
    /mouse\.\w+\s*\(/,
    /keyboard\.\w+\s*\(/,
  ];
  for (const { file, text } of sources) {
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(text), `${file} must not call ${pattern.source} — the crawl is passive-only`);
    }
  }
});

test('automatic dialogs are only dismissed, never accepted', () => {
  for (const { file, text } of sources) {
    assert.ok(!/dialog\.accept\s*\(/.test(text), `${file} must not accept native dialogs`);
  }
  const capture = sources.find((source) => source.file === 'page-capture.ts')?.text ?? '';
  assert.match(capture, /autoDismissedForCrawl/, 'auto-dismissed dialogs must be marked in the trace');
});

test('the crawler never closes the attached authenticated browser', () => {
  for (const { file, text } of sources) {
    assert.ok(!/browser\.close\s*\(/.test(text), `${file} must not close the user's attached Chrome`);
  }
});

// Guard the runtime loader contract: the engine must load under
// node --experimental-strip-types (no enums, namespaces, or parameter properties).
test('every snapshot-engine module loads under type stripping', async () => {
  for (const { file } of sources) {
    await import(new URL(`./${file}`, import.meta.url).href);
  }
});
