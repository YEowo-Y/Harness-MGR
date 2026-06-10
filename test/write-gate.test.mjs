/**
 * test/write-gate.test.mjs
 *
 * Unit tests for the RELAXED write-gate semantics (off-ramp 2026-06-09):
 *   - apply falsy                  → dry-run  (enableWrites:false, no refusal)
 *   - apply truthy + env='0'       → REFUSED  (enableWrites:false, code:3,
 *                                              writes-disabled-env)
 *   - apply truthy + env=' 0'      → REFUSED  (whitespace-trimmed; same lock)
 *   - apply truthy + env='0\n'     → REFUSED  (trailing newline trimmed)
 *   - apply truthy + env='\t0'     → REFUSED  (leading tab trimmed)
 *   - apply truthy + env='0 '      → REFUSED  (trailing space trimmed)
 *   - apply truthy + env='1'       → enabled  (back-compat; enableWrites:true)
 *   - apply truthy + env=' 1'      → enabled  (non-'0' after trim; not a lock)
 *   - apply truthy + env unset     → enabled  (relaxation: unset now enables)
 *   - apply truthy + null env      → enabled  (null/undefined env: not locked)
 *   - apply truthy + env='true'    → enabled  (any non-'0' value enables)
 *   - apply truthy + env='false'   → enabled  (documented: 'false' does not lock)
 *   - apply truthy + env='00'      → enabled  ('00' trims to '00', not '0')
 *   - apply truthy + env='0x'      → enabled  ('0x' is not '0')
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

// ── Whitespace-trim tests (the 2026-06-10 footgun fix) ────────────────────────
// pre-fix: all four values silently ENABLED writes; post-fix: they REFUSE.

test('resolveWriteIntent: apply + env=" 0" (leading space) → REFUSED', () => {
  const r = resolveWriteIntent({ apply: true, env: { CLAUDE_MGR_ENABLE_WRITES: ' 0' } });
  assert.equal(r.enableWrites, false);
  assert.equal(r.code, 3);
  assert.ok(r.refusal, 'refusal must be present');
  assert.equal(r.refusal.code, 'writes-disabled-env');
});

test('resolveWriteIntent: apply + env="0 " (trailing space) → REFUSED', () => {
  const r = resolveWriteIntent({ apply: true, env: { CLAUDE_MGR_ENABLE_WRITES: '0 ' } });
  assert.equal(r.enableWrites, false);
  assert.equal(r.code, 3);
  assert.ok(r.refusal, 'refusal must be present');
  assert.equal(r.refusal.code, 'writes-disabled-env');
});

test('resolveWriteIntent: apply + env="0\\n" (trailing newline) → REFUSED', () => {
  // This is the headline CI footgun: a shell-expanded env var often carries a
  // trailing newline.  Pre-fix this silently enabled writes; post-fix it locks.
  const r = resolveWriteIntent({ apply: true, env: { CLAUDE_MGR_ENABLE_WRITES: '0\n' } });
  assert.equal(r.enableWrites, false);
  assert.equal(r.code, 3);
  assert.ok(r.refusal, 'refusal must be present');
  assert.equal(r.refusal.code, 'writes-disabled-env');
  // message still references the opt-out lock
  assert.match(r.refusal.message, /CLAUDE_MGR_ENABLE_WRITES/);
});

test('resolveWriteIntent: apply + env="\\t0" (leading tab) → REFUSED', () => {
  const r = resolveWriteIntent({ apply: true, env: { CLAUDE_MGR_ENABLE_WRITES: '\t0' } });
  assert.equal(r.enableWrites, false);
  assert.equal(r.code, 3);
  assert.ok(r.refusal, 'refusal must be present');
  assert.equal(r.refusal.code, 'writes-disabled-env');
});

// ── Values that must NOT lock (trim does not over-reach) ─────────────────────

test('resolveWriteIntent: apply + env=" 1" (leading space around 1) → enabled', () => {
  // ' 1'.trim() === '1', which is not the lock value '0'.
  const r = resolveWriteIntent({ apply: true, env: { CLAUDE_MGR_ENABLE_WRITES: ' 1' } });
  assert.equal(r.enableWrites, true);
  assert.equal(r.refusal, null);
  assert.equal(r.code, null);
});

test('resolveWriteIntent: apply + env="false" → enabled (documented: false does not lock)', () => {
  // 'false' is explicitly not the lock value; trimming does not change this.
  const r = resolveWriteIntent({ apply: true, env: { CLAUDE_MGR_ENABLE_WRITES: 'false' } });
  assert.equal(r.enableWrites, true);
  assert.equal(r.refusal, null);
  assert.equal(r.code, null);
});

test('resolveWriteIntent: apply + env="00" → enabled ("00" trims to "00", not "0")', () => {
  const r = resolveWriteIntent({ apply: true, env: { CLAUDE_MGR_ENABLE_WRITES: '00' } });
  assert.equal(r.enableWrites, true);
  assert.equal(r.refusal, null);
  assert.equal(r.code, null);
});

test('resolveWriteIntent: apply + env="0x" → enabled ("0x" is not the lock value)', () => {
  const r = resolveWriteIntent({ apply: true, env: { CLAUDE_MGR_ENABLE_WRITES: '0x' } });
  assert.equal(r.enableWrites, true);
  assert.equal(r.refusal, null);
  assert.equal(r.code, null);
});
