/**
 * P2.U6b-2 — probe-statusline.test.mjs
 *
 * Tests for gatherStatuslineProbe: statusLine command resolution
 * (file/external), indeterminate status for unexpanded vars, null when no
 * command is configured, and diagnostics always empty.
 *
 * Mirrors the style of probe-hooks.test.mjs. Real temp files via
 * fs.mkdtempSync; cleaned up in finally blocks.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatherStatuslineProbe } from '../src/discovery/probe-statusline.mjs';

function mktmp() {
  return mkdtempSync(join(tmpdir(), 'mgr-statusline-'));
}

// ── 1. no / empty / non-string statusLineCommand → null ──────────────────────

test('no statusLineCommand → { statusline: null, diagnostics: [] }', () => {
  const result = gatherStatuslineProbe({});
  assert.equal(result.statusline, null);
  assert.deepEqual(result.diagnostics, []);
});

test('empty string statusLineCommand → { statusline: null, diagnostics: [] }', () => {
  const result = gatherStatuslineProbe({ statusLineCommand: '' });
  assert.equal(result.statusline, null);
  assert.deepEqual(result.diagnostics, []);
});

test('non-string statusLineCommand (number) → { statusline: null, diagnostics: [] }', () => {
  const result = gatherStatuslineProbe({ statusLineCommand: /** @type {any} */ (42) });
  assert.equal(result.statusline, null);
  assert.deepEqual(result.diagnostics, []);
});

test('non-string statusLineCommand (null) → { statusline: null, diagnostics: [] }', () => {
  const result = gatherStatuslineProbe({ statusLineCommand: /** @type {any} */ (null) });
  assert.equal(result.statusline, null);
  assert.deepEqual(result.diagnostics, []);
});

test('no arguments at all (called with no args) → { statusline: null, diagnostics: [] }, no throw', () => {
  let result;
  assert.doesNotThrow(() => { result = gatherStatuslineProbe(); });
  assert.equal(result.statusline, null);
  assert.deepEqual(result.diagnostics, []);
});

// ── 2. file found: absolute path to a real temp file ─────────────────────────

test('node <abs path to real temp file> → kind:file, status:found', () => {
  const tmp = mktmp();
  try {
    const scriptPath = join(tmp, 'status.mjs');
    writeFileSync(scriptPath, '// statusline', 'utf-8');

    const result = gatherStatuslineProbe({
      statusLineCommand: `node "${scriptPath}"`,
      env: {},
      platform: 'linux',
    });

    assert.notEqual(result.statusline, null, 'statusline fact must be set');
    assert.equal(result.statusline.kind, 'file');
    assert.equal(result.statusline.status, 'found');
    assert.ok(result.statusline.target.endsWith('status.mjs'), `target should end with status.mjs, got: ${result.statusline.target}`);
    assert.deepEqual(result.diagnostics, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 3. file missing: absolute path that does not exist ───────────────────────

test('node /definitely/missing/xyz.mjs → kind:file, status:missing', () => {
  const result = gatherStatuslineProbe({
    statusLineCommand: 'node /definitely/missing/xyz.mjs',
    env: {},
    platform: 'linux',
  });

  assert.notEqual(result.statusline, null);
  assert.equal(result.statusline.kind, 'file');
  assert.equal(result.statusline.status, 'missing');
  assert.deepEqual(result.diagnostics, []);
});

// ── 4. indeterminate: unexpanded env var ──────────────────────────────────────

test('node $CLAUDE_PROJECT_DIR/foo.mjs with var NOT in env → status:indeterminate, not missing', () => {
  const result = gatherStatuslineProbe({
    statusLineCommand: 'node $CLAUDE_PROJECT_DIR/foo.mjs',
    env: {},          // CLAUDE_PROJECT_DIR not present
    platform: 'linux',
  });

  assert.notEqual(result.statusline, null);
  assert.equal(result.statusline.status, 'indeterminate',
    'unexpanded var must yield indeterminate, not missing');
  assert.notEqual(result.statusline.status, 'missing');
  assert.deepEqual(result.diagnostics, []);
});

test('node "$UNSET/hook.mjs" with no env → status:indeterminate', () => {
  const result = gatherStatuslineProbe({
    statusLineCommand: 'node "$UNSET/hook.mjs"',
    env: {},
    platform: 'linux',
  });

  assert.notEqual(result.statusline, null);
  assert.equal(result.statusline.status, 'indeterminate');
  assert.deepEqual(result.diagnostics, []);
});

// ── 5. external missing: bare command not found on empty PATH ─────────────────

test('definitely-not-a-real-binary-xyz → kind:external, status:missing', () => {
  const tmp = mktmp();
  try {
    const result = gatherStatuslineProbe({
      statusLineCommand: 'definitely-not-a-real-binary-xyz --opt',
      env: { PATH: tmp },   // empty dir on PATH — command not there
      platform: 'linux',
    });

    assert.notEqual(result.statusline, null);
    assert.equal(result.statusline.kind, 'external');
    assert.equal(result.statusline.status, 'missing');
    assert.deepEqual(result.diagnostics, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 6. diagnostics is always [] ──────────────────────────────────────────────

test('diagnostics is always [] regardless of command outcome', () => {
  const cases = [
    gatherStatuslineProbe({}),
    gatherStatuslineProbe({ statusLineCommand: 'node /no/such/file.mjs', env: {}, platform: 'linux' }),
    gatherStatuslineProbe({ statusLineCommand: 'node $UNSET/x.mjs', env: {}, platform: 'linux' }),
  ];
  for (const r of cases) {
    assert.deepEqual(r.diagnostics, [], 'diagnostics must always be []');
  }
});

// ── 7. returned fact shape ────────────────────────────────────────────────────

test('returned fact has command, kind, target, status fields', () => {
  const tmp = mktmp();
  try {
    const scriptPath = join(tmp, 'sl.mjs');
    writeFileSync(scriptPath, '// sl', 'utf-8');

    const result = gatherStatuslineProbe({
      statusLineCommand: `node "${scriptPath}"`,
      env: {},
      platform: 'linux',
    });

    assert.notEqual(result.statusline, null);
    const { statusline } = result;
    assert.ok(Object.prototype.hasOwnProperty.call(statusline, 'command'), 'must have command');
    assert.ok(Object.prototype.hasOwnProperty.call(statusline, 'kind'), 'must have kind');
    assert.ok(Object.prototype.hasOwnProperty.call(statusline, 'target'), 'must have target');
    assert.ok(Object.prototype.hasOwnProperty.call(statusline, 'status'), 'must have status');
    assert.equal(statusline.command, `node "${scriptPath}"`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
