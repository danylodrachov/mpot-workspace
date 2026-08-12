import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveBrowserLaunchHeadless } from '../src/research/url-map/browser-launch-policy.ts';

test('URL map discovery launches headed by default', () => {
  assert.equal(resolveBrowserLaunchHeadless({
    headlessRequested: false,
    headedRequested: false,
    manualBootstrap: false,
  }), false);
});

test('--headless explicitly opts into headless Chromium', () => {
  assert.equal(resolveBrowserLaunchHeadless({
    headlessRequested: true,
    headedRequested: false,
    manualBootstrap: false,
  }), true);
});

test('--headed remains a backwards-compatible explicit headed mode', () => {
  assert.equal(resolveBrowserLaunchHeadless({
    headlessRequested: false,
    headedRequested: true,
    manualBootstrap: false,
  }), false);
});

test('manual bootstrap is always headed', () => {
  assert.equal(resolveBrowserLaunchHeadless({
    headlessRequested: false,
    headedRequested: false,
    manualBootstrap: true,
  }), false);
});

test('manual bootstrap rejects explicit headless mode', () => {
  assert.throws(
    () => resolveBrowserLaunchHeadless({
      headlessRequested: true,
      headedRequested: false,
      manualBootstrap: true,
    }),
    /manual-bootstrap requires a headed browser/,
  );
});

test('conflicting --headless and --headed flags fail fast', () => {
  assert.throws(
    () => resolveBrowserLaunchHeadless({
      headlessRequested: true,
      headedRequested: true,
      manualBootstrap: false,
    }),
    /headless and --headed cannot be used together/,
  );
});
