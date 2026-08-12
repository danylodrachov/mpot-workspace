import assert from 'node:assert/strict';
import test from 'node:test';

import { collectStableDomNavigationCandidates } from '../src/research/url-map/dom-navigation-collector.ts';

class FakePage {
  private read = 0;
  async evaluate<T>(_fn: () => T | Promise<T>): Promise<T> {
    this.read += 1;
    const values = this.read < 3
      ? []
      : [
          { value: '/en/promo', label: 'a[href]' },
          { value: '/en/page/terms-and-conditions', label: 'a[href]' },
        ];
    return values as T;
  }
  async waitForTimeout(_ms: number): Promise<void> {}
}

test('does not treat an early empty DOM as stable and captures late SPA anchors', async () => {
  const page = new FakePage();
  const result = await collectStableDomNavigationCandidates(page, 'https://megarich.com/en', {
    maxWaitMs: 50,
    sampleIntervalMs: 1,
    minObservationMs: 0,
    stableSamples: 1,
  });
  assert.deepEqual(result.map(item => item.rawUrl).sort(), [
    '/en/page/terms-and-conditions',
    '/en/promo',
  ]);
  assert.ok(result.every(item => item.provenance.sourceFamily === 'dom_navigation_url'));
});
