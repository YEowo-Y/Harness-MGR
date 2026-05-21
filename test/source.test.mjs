import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSource, isSourceTier, SOURCE_TIERS } from '../src/lib/source.mjs';

test('SOURCE_TIERS lists exactly the four authoritative tiers', () => {
  assert.deepEqual([...SOURCE_TIERS], ['user', 'plugin', 'catalog', 'marketplace-copy']);
});

test('isSourceTier accepts valid tiers and rejects junk', () => {
  assert.equal(isSourceTier('user'), true);
  assert.equal(isSourceTier('plugin'), true);
  assert.equal(isSourceTier('catalog'), true);
  assert.equal(isSourceTier('marketplace-copy'), true);
  assert.equal(isSourceTier('builtin'), false);
  assert.equal(isSourceTier(''), false);
  assert.equal(isSourceTier(undefined), false);
  assert.equal(isSourceTier(42), false);
});

test('makeSource defaults unknown/missing tier to user', () => {
  assert.deepEqual(makeSource(), { tier: 'user' });
  assert.deepEqual(makeSource({}), { tier: 'user' });
  assert.deepEqual(makeSource({ tier: 'nope' }), { tier: 'user' });
});

test('makeSource carries plugin/marketplace/version only when present', () => {
  const s = makeSource({
    tier: 'plugin',
    plugin: 'oh-my-claudecode',
    marketplace: 'everything-claude-code',
    version: '1.2.3',
  });
  assert.deepEqual(s, {
    tier: 'plugin',
    marketplace: 'everything-claude-code',
    plugin: 'oh-my-claudecode',
    version: '1.2.3',
  });
});

test('makeSource omits absent optional fields (minimal serialization)', () => {
  const s = makeSource({ tier: 'catalog', marketplace: 'thedotmack' });
  assert.deepEqual(s, { tier: 'catalog', marketplace: 'thedotmack' });
  assert.equal('plugin' in s, false);
  assert.equal('version' in s, false);
});
