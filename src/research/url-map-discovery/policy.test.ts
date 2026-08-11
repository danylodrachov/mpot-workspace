import assert from 'node:assert/strict';
import test from 'node:test';
import { decideDocumentUrl } from './policy.ts';

const hosts = new Set(['megarich.com', 'example.test']);
const p = [{ sourceFamily: 'inline_script_url_token' as const, discoveredOn: 'https://megarich.com/en' }];
const decide = (url: string, base = 'https://megarich.com/en') => decideDocumentUrl(url, base, hosts, p);

test('Megarich failure regression: expected research routes survive and garbage never becomes a visit', () => {
  const accepted = [
    'https://megarich.com/en/promo',
    'https://megarich.com/en/page/terms-and-conditions',
    'https://megarich.com/en/page/bonus-terms',
    'https://megarich.com/en/games/category/live-casino',
    'https://megarich.com/en/games/category/popular',
    'https://megarich.com/en/sport',
  ];
  for (const url of accepted) assert.equal(decide(url).decision, 'accepted', url);

  for (const url of [
    'https://megarich.com/',
    'https://megarich.com/en',
    'https://megarich.com/src/layout/DefaultLayout.vue',
    'https://megarich.com/src/layout/EmptyLayout.vue',
  ]) assert.notEqual(decide(url).decision, 'accepted', url);

  assert.equal(decide('https://megarich.com/engine.io').decision, 'tbd');
  assert.equal(decide('https://megarich.com/socket.io').decision, 'tbd');
  assert.equal(decide('https://megarich.com/zimpler/login').decision, 'tbd');
});

test('URL rules explicit remove precedence', () => {
  for (const path of [
    '/my-account/settings', '/transaction-history', '/responsible-gaming', '/self-exclusion',
    '/privacy-policy', '/cookie-policy', '/support', '/aml_kyc_policy', '/about', '/blog',
    '/casino/lobby', '/casino/instant-games', '/sports/lobby', '/',
  ]) assert.equal(decide(`https://example.test/en${path}`, 'https://example.test/en').decision, 'rejected', path);
});

test('URL rules explicit keeps', () => {
  for (const path of [
    '/bonuses', '/promo', '/offers', '/offers-summer', '/deposit', '/withdraw', '/payment-methods', '/payments',
    '/bet-limits', '/deposit-limits', '/loss-limits', '/time-limits', '/terms-and-conditions', '/bonus-terms', '/rules',
    '/sports-rules', '/casino-rules', '/live-casino-rules', '/casino/slots', '/casino/live-casino', '/casino/virtual-sports',
    '/horse-racing', '/football', '/tennis', '/basketball',
  ]) assert.equal(decide(`https://example.test/en${path}`, 'https://example.test/en').decision, 'accepted', path);
});

test('sports live/prematch filters normalize to root category without inventing another host', () => {
  const live = decide('https://example.test/en/football/live', 'https://example.test/en');
  assert.equal(live.decision, 'accepted');
  assert.equal(live.canonicalUrl, 'https://example.test/en/football');

  const query = decide('https://megarich.com/en/sport?bt-path=/live-section');
  assert.equal(query.decision, 'accepted');
  assert.equal(query.canonicalUrl, 'https://megarich.com/en/sport');
});


test('URL rules keep mailto/tel as TBD rather than inventing a drop policy', () => {
  assert.equal(decideDocumentUrl('mailto:test@example.test', 'https://example.test/en', hosts, p).decision, 'tbd');
  assert.equal(decideDocumentUrl('tel:+123456789', 'https://example.test/en', hosts, p).decision, 'tbd');
});
