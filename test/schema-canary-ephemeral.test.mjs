/**
 * Ephemeral-key denylist tests for src/selftest/schema-canary.mjs
 * (docs/schema-canary-ephemeral-keys-design.md §5 — falsifiable oracles).
 *
 * The denylist filters CC-internal ephemeral appKeys (caches/counters/launch-seen
 * markers) OUT of the `appKeys` dimension in computeFingerprint, so routine churn
 * in ~/.claude.json produces NO fingerprint change. These tests pin:
 *   - HEADLINE: two fact sets differing ONLY in ephemeral keys → IDENTICAL fingerprint
 *   - dimensions.appKeys EXCLUDES ephemeral keys (golden literal list)
 *   - a STRUCTURAL appKey added/removed STILL drifts
 *   - a removed DIMENSION (appKeys gone) STILL drifts (presence untouched)
 *   - each pattern class has a positive (filtered) + a near-miss negative (kept)
 *   - never-throws on junk
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeFingerprint, compareFingerprint } from '../src/selftest/schema-canary.mjs';

// Structural baseline appKeys (all explicitly KEPT per design §3).
const STRUCTURAL = ['mcpServers', 'oauthAccount', 'projects', 'userID'];

const BASE_FACTS = {
  pluginSchemaVersion: 2,
  settingsKeys: ['hooks', 'model'],
  topDirs: ['agents', 'skills'],
  hookEvents: ['PreToolUse'],
  mcpServerCount: 1,
  mcpTransports: ['stdio'],
  appKeys: [...STRUCTURAL],
};

/** @param {object} facts */
function fp(facts) { return computeFingerprint(facts); }

describe('schema-canary ephemeral appKey denylist', () => {

  // ── HEADLINE: ephemeral churn is invisible ────────────────────────────────────

  it('HEADLINE: adding several ephemeral keys → SAME fingerprint (churn invisible)', () => {
    const without = fp(BASE_FACTS);
    const withEphemeral = fp({
      ...BASE_FACTS,
      appKeys: [
        ...STRUCTURAL,
        'showExpandedTodos', 'numStartups', 'fooCache', 'barLastFetched', 'bazSeenCount',
      ],
    });
    assert.match(without.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(
      withEphemeral.fingerprint,
      without.fingerprint,
      'ephemeral keys must not change the fingerprint',
    );
    // And comparing them yields clean.
    const cmp = compareFingerprint({ current: withEphemeral, baseline: without });
    assert.equal(cmp.status, 'clean');
    assert.equal(cmp.changes.length, 0);
  });

  // ── dimensions.appKeys EXCLUDES ephemeral keys (golden literal) ────────────────

  it('dimensions.appKeys excludes ephemeral keys (golden literal, sorted)', () => {
    const { dimensions } = fp({
      ...BASE_FACTS,
      appKeys: [
        'mcpServers', 'projects',
        'showExpandedTodos', 'numStartups', 'fooCache', 'barLastFetched',
      ],
    });
    assert.deepEqual(dimensions.appKeys, ['mcpServers', 'projects']);
  });

  // ── mutation oracle: without the filter, ephemeral keys reappear ──────────────

  it('FILTER MUTATION GUARD: ephemeral keys are absent from dimensions (delete-filter → RED)', () => {
    // If the `.filter(...isEphemeralAppKey)` line were removed, these would appear.
    const { dimensions } = fp({
      ...BASE_FACTS,
      appKeys: [...STRUCTURAL, 'pluginUsage', 'tipLifetimeShownCounts', 'unpinFable5LaunchEffort'],
    });
    for (const k of ['pluginUsage', 'tipLifetimeShownCounts', 'unpinFable5LaunchEffort']) {
      assert.ok(!dimensions.appKeys.includes(k), `${k} must be filtered out`);
    }
    assert.deepEqual(dimensions.appKeys, [...STRUCTURAL].sort());
  });

  // ── STRUCTURAL drift STILL caught ──────────────────────────────────────────────

  it('STRUCTURAL: a new non-ephemeral appKey → drifted with +[someNewRealKey]', () => {
    const base = fp(BASE_FACTS);
    const cur = fp({ ...BASE_FACTS, appKeys: [...STRUCTURAL, 'someNewRealKey'] });
    const r = compareFingerprint({ current: cur, baseline: base });
    assert.equal(r.status, 'drifted');
    assert.equal(r.changes.length, 1);
    assert.equal(r.changes[0].dimension, 'appKeys');
    assert.equal(r.changes[0].change, 'modified');
    assert.ok(r.changes[0].detail.includes('+[someNewRealKey]'), 'detail names the added structural key');
    const warns = r.diagnostics.filter((d) => d.code === 'schema-drift-detected');
    assert.equal(warns.length, 1);
  });

  it('STRUCTURAL: baseline [mcpServers] vs current [mcpServers, someNewRealKey] → drifted', () => {
    const base = fp({ ...BASE_FACTS, appKeys: ['mcpServers'] });
    const cur = fp({ ...BASE_FACTS, appKeys: ['mcpServers', 'someNewRealKey'] });
    const r = compareFingerprint({ current: cur, baseline: base });
    assert.equal(r.status, 'drifted');
    assert.equal(r.changes[0].dimension, 'appKeys');
    assert.ok(r.changes[0].detail.includes('+[someNewRealKey]'));
  });

  // ── removed DIMENSION still caught (presence untouched) ───────────────────────

  it('DIMENSION PRESENCE: current dimensions missing appKeys entirely → drifted, removed', () => {
    const base = fp(BASE_FACTS);
    // Build a current result whose dimensions object has NO appKeys property.
    const curDims = { ...base.dimensions };
    delete curDims.appKeys;
    const cur = { fingerprint: 'deadbeef', dimensions: curDims };
    const r = compareFingerprint({ current: cur, baseline: base });
    assert.equal(r.status, 'drifted');
    const removed = r.changes.find((c) => c.dimension === 'appKeys');
    assert.ok(removed, 'appKeys change present');
    assert.equal(removed.change, 'removed');
    assert.ok(removed.detail.includes('dimension removed'), 'reports dimension removed');
  });

  // ── pattern coverage: positive (filtered) + near-miss negative (kept) ─────────

  it('PATTERN positives: a *Cache, *Count, *LastFetched, *SeenCount name are all filtered', () => {
    const { dimensions } = fp({
      ...BASE_FACTS,
      appKeys: [
        'mcpServers',           // structural anchor (kept)
        'someWidgetCache',      // /cache/i
        'retryAttemptCount',    // /Count$/
        'modelListLastFetched', // /LastFetched$/
        'tourViewSeenCount',    // /SeenCount/
      ],
    });
    assert.deepEqual(dimensions.appKeys, ['mcpServers'], 'only the structural anchor survives');
  });

  it('PATTERN near-miss NEGATIVES: structural-ish names survive (not over-matched)', () => {
    // None of these match a pattern or the exact set; all must be KEPT.
    const survivors = ['mcpServers', 'projects', 'accountInfo', 'cohortId', 'discountRate'];
    const { dimensions } = fp({ ...BASE_FACTS, appKeys: [...survivors] });
    assert.deepEqual(dimensions.appKeys, [...survivors].sort());
  });

  it('EXACT denylist: each design-§3 exact name is filtered', () => {
    const exact = [
      'showExpandedTodos', 'hasOpenedAgentsView', 'numStartups', 'autoUpdates',
      'pluginUsage', 'migrationVersion', 'feedbackSurveyState', 'opus48LaunchSeenCount',
    ];
    const { dimensions } = fp({ ...BASE_FACTS, appKeys: ['mcpServers', ...exact] });
    assert.deepEqual(dimensions.appKeys, ['mcpServers']);
  });

  it('DELIBERATELY-KEPT structural keys (design §3) all survive', () => {
    const keep = ['mcpServers', 'projects', 'oauthAccount', 'installMethod', 'githubRepoPaths', 'companion'];
    const { dimensions } = fp({ ...BASE_FACTS, appKeys: [...keep] });
    assert.deepEqual(dimensions.appKeys, [...keep].sort());
  });

  // ── never-throws ──────────────────────────────────────────────────────────────

  it('never-throws: junk appKeys entries are filtered without throwing', () => {
    assert.doesNotThrow(() => fp({ ...BASE_FACTS, appKeys: [null, undefined, 42, {}, 'fooCache', 'mcpServers'] }));
    const { dimensions } = fp({ ...BASE_FACTS, appKeys: [null, undefined, 42, {}, 'fooCache', 'mcpServers'] });
    // non-strings dropped by safeStringArr; 'fooCache' filtered by denylist.
    assert.deepEqual(dimensions.appKeys, ['mcpServers']);
  });

  it('never-throws: computeFingerprint(junk) still returns the empty-shape', () => {
    for (const junk of [null, undefined, 42, 'str', []]) {
      assert.doesNotThrow(() => computeFingerprint(junk));
      const r = computeFingerprint(junk);
      assert.ok(Array.isArray(r.dimensions.appKeys));
      assert.equal(r.dimensions.appKeys.length, 0);
    }
  });

});
