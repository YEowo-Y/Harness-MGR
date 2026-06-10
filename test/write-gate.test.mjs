/**
 * test/write-gate.test.mjs
 *
 * Unit tests for the RELAXED write-gate semantics (off-ramp 2026-06-09):
 *   - apply falsy                  → dry-run  (enableWrites:false, no refusal)
 *   - apply truthy + env='0'       → REFUSED  (enableWrites:false, code:3,
 *                                              writes-disabled-env)
 *   - apply truthy + env='1'       → enabled  (back-compat; enableWrites:true)
 *   - apply truthy + env unset     → enabled  (relaxation: unset now enables)
 *   - apply truthy + null env      → enabled  (null/undefined env: not locked)
 *   - apply truthy + env='true'    → enabled  (any non-'0' value enables)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWriteIntent } from '../src/cli/write-gate.mjs';

// 1. No --apply → dry-run regardless of env
test('resolveWriteIntent: no apply → dry-run, enableWrites:false, no refusal', () => {
  const r = resolveWriteIntent({ apply: false, env: {} });
  assert.equal(r.enableWrites, false);
  assert.equal(r.refusal, null);
  assert.equal(r.code, null);
});

test('resolveWriteIntent: no apply, env=1 → still dry-run (env irrelevant without --apply)', () => {
  const r = resolveWriteIntent({ apply: false, env: { CLAUDE_MGR_ENABLE_WRITES: '1' } });
  assert.equal(r.enableWrites, false);
  assert.equal(r.refusal, null);
  assert.equal(r.code, null);
});

// 2. apply + env='0' → REFUSED (the explicit opt-out lock)
test('resolveWriteIntent: apply + env=0 → REFUSED, code:3, writes-disabled-env', () => {
  const r = resolveWriteIntent({ apply: true, env: { CLAUDE_MGR_ENABLE_WRITES: '0' } });
  assert.equal(r.enableWrites, false);
  assert.equal(r.code, 3);
  assert.ok(r.refusal, 'refusal must be present');
  assert.equal(r.refusal.code, 'writes-disabled-env');
  assert.equal(r.refusal.severity, 'error');
  assert.equal(r.refusal.phase, 'cli');
  // message references the =0 opt-out, not the old =1 requirement
  assert.match(r.refusal.message, /CLAUDE_MGR_ENABLE_WRITES/);
  assert.match(r.refusal.message, /"0"/);
});

// 3. apply + env='1' → ENABLED (back-compat: the old way still works)
test('resolveWriteIntent: apply + env=1 → enabled (back-compat)', () => {
  const r = resolveWriteIntent({ apply: true, env: { CLAUDE_MGR_ENABLE_WRITES: '1' } });
  assert.equal(r.enableWrites, true);
  assert.equal(r.refusal, null);
  assert.equal(r.code, null);
});

// 4. apply + env unset → ENABLED (the relaxation: unset no longer locks)
test('resolveWriteIntent: apply + env unset → enabled (relaxation: unset now enables)', () => {
  const r = resolveWriteIntent({ apply: true, env: {} });
  assert.equal(r.enableWrites, true);
  assert.equal(r.refusal, null);
  assert.equal(r.code, null);
});

// 5. apply + null/undefined env → ENABLED (tolerate null env gracefully)
test('resolveWriteIntent: apply + null env → enabled (null env treated as not-locked)', () => {
  const r = resolveWriteIntent({ apply: true, env: null });
  assert.equal(r.enableWrites, true);
  assert.equal(r.refusal, null);
  assert.equal(r.code, null);
});

test('resolveWriteIntent: apply + undefined env → enabled', () => {
  const r = resolveWriteIntent({ apply: true, env: undefined });
  assert.equal(r.enableWrites, true);
  assert.equal(r.refusal, null);
  assert.equal(r.code, null);
});

// 6. apply + env='true' (non-'0') → ENABLED (any non-'0' value enables)
test('resolveWriteIntent: apply + env=true → enabled (non-"0" value enables)', () => {
  const r = resolveWriteIntent({ apply: true, env: { CLAUDE_MGR_ENABLE_WRITES: 'true' } });
  assert.equal(r.enableWrites, true);
  assert.equal(r.refusal, null);
  assert.equal(r.code, null);
});

// 7. default call (no args) → dry-run
test('resolveWriteIntent: called with no args → dry-run', () => {
  const r = resolveWriteIntent();
  assert.equal(r.enableWrites, false);
  assert.equal(r.refusal, null);
  assert.equal(r.code, null);
});
