/**
 * P2.U6a — doctor-config-checks.test.mjs
 *
 * Tests for the three pure config-fact doctor checks:
 *   #12 orphan-files
 *   #22 claude-config-schema-version
 *   #23 permissions-overbroad
 *
 * Exercised through runDoctor() as well as directly via CONFIG_CHECKS.
 * All checks are pure (no I/O, no clock), so no fixtures required.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor, CHECKS } from '../src/analysis/doctor/index.mjs';
import { CONFIG_CHECKS } from '../src/analysis/doctor/config-checks.mjs';

const byCode = (diags, code) => diags.filter((d) => d.code === code);

// ── A. #12 orphan-files ───────────────────────────────────────────────────────

test('#12: one hard + one soft orphan → two info orphan-files diagnostics', () => {
  const r = runDoctor({
    orphans: [
      { path: 'extra-file.md', category: 'hard', reason: 'not a known top-level entry' },
      { path: 'skills/stray.txt', category: 'soft', reason: 'non-.md file inside skills/' },
    ],
  });
  const found = byCode(r.diagnostics, 'orphan-files');
  assert.equal(found.length, 2);
  assert.ok(found.every((d) => d.severity === 'info'));
});

test('#12: hard orphan message contains category, path, and reason', () => {
  const r = runDoctor({
    orphans: [{ path: 'weird-dir', category: 'hard', reason: 'not in KNOWN_TOP_DIRS' }],
  });
  const found = byCode(r.diagnostics, 'orphan-files');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /hard/);
  assert.match(found[0].message, /weird-dir/);
  assert.match(found[0].message, /not in KNOWN_TOP_DIRS/);
  assert.equal(found[0].path, 'weird-dir');
  assert.equal(found[0].phase, 'doctor');
  assert.equal(typeof found[0].fix, 'string');
});

test('#12: soft orphan message contains "soft" category', () => {
  const r = runDoctor({
    orphans: [{ path: 'skills/foo.js', category: 'soft', reason: 'non-.md file inside component dir' }],
  });
  const found = byCode(r.diagnostics, 'orphan-files');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /soft/);
});

test('#12: output is sorted by message (ascending)', () => {
  const r = runDoctor({
    orphans: [
      { path: 'z-file', category: 'hard', reason: 'z reason' },
      { path: 'a-file', category: 'soft', reason: 'a reason' },
    ],
  });
  const found = byCode(r.diagnostics, 'orphan-files');
  assert.equal(found.length, 2);
  // "hard orphan: z-file" sorts after "soft orphan: a-file" alphabetically
  // "hard" < "soft" — so hard orphan a-file would come first, but we have hard z and soft a
  // "hard orphan: z-file" vs "soft orphan: a-file" → 'h' < 's' → hard first
  assert.match(found[0].message, /hard/);
  assert.match(found[1].message, /soft/);
});

test('#12: path field is set on each diagnostic', () => {
  const r = runDoctor({
    orphans: [{ path: 'some/path.md', category: 'soft', reason: 'stray file' }],
  });
  const found = byCode(r.diagnostics, 'orphan-files');
  assert.equal(found[0].path, 'some/path.md');
});

test('#12: orphans absent → 0 findings', () => {
  const r = runDoctor({});
  assert.equal(byCode(r.diagnostics, 'orphan-files').length, 0);
});

test('#12: non-array orphans → 0 findings, no throw', () => {
  let r;
  assert.doesNotThrow(() => { r = runDoctor({ orphans: 'nope' }); });
  assert.equal(byCode(r.diagnostics, 'orphan-files').length, 0);
});

test('#12: record missing path is skipped', () => {
  const r = runDoctor({
    orphans: [
      { category: 'hard', reason: 'no path here' },
      { path: 'valid.md', category: 'hard', reason: 'has path' },
    ],
  });
  const found = byCode(r.diagnostics, 'orphan-files');
  assert.equal(found.length, 1);
  assert.equal(found[0].path, 'valid.md');
});

test('#12: record with empty-string path is skipped', () => {
  const r = runDoctor({ orphans: [{ path: '', category: 'hard', reason: 'x' }] });
  assert.equal(byCode(r.diagnostics, 'orphan-files').length, 0);
});

test('#12: non-object record is skipped, no throw', () => {
  let r;
  assert.doesNotThrow(() => {
    r = runDoctor({ orphans: [null, 42, 'bad', { path: 'ok.md', category: 'soft', reason: 'x' }] });
  });
  const found = byCode(r.diagnostics, 'orphan-files');
  assert.equal(found.length, 1);
});

test('#12: unknown category is rendered as "unknown" in the message', () => {
  const r = runDoctor({
    orphans: [{ path: 'x.md', category: 'weird', reason: 'some reason' }],
  });
  const found = byCode(r.diagnostics, 'orphan-files');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /unknown/);
});

test('#12: missing reason falls back to "unexpected entry"', () => {
  const r = runDoctor({
    orphans: [{ path: 'x.md', category: 'hard' }],
  });
  const found = byCode(r.diagnostics, 'orphan-files');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /unexpected entry/);
});

// ── B. #22 claude-config-schema-version ──────────────────────────────────────

test('#22: plugin-schema-version-unknown fact → one warn claude-config-schema-version', () => {
  const r = runDoctor({
    pluginDiagnostics: [
      { severity: 'warn', code: 'plugin-schema-version-unknown', message: 'schema version 99 not recognized', path: '/p/installed_plugins.json', phase: 'plugins' },
    ],
  });
  const found = byCode(r.diagnostics, 'claude-config-schema-version');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'warn');
  assert.equal(found[0].message, 'schema version 99 not recognized');
  assert.equal(found[0].path, '/p/installed_plugins.json');
  assert.equal(found[0].phase, 'doctor');
  assert.equal(typeof found[0].fix, 'string');
});

test('#22: other-code facts are ignored (no false positive)', () => {
  const r = runDoctor({
    pluginDiagnostics: [
      { severity: 'warn', code: 'plugin-cache-missing', message: 'some other fact', phase: 'plugins' },
      { severity: 'info', code: 'something-else', message: 'noise', phase: 'plugins' },
    ],
  });
  assert.equal(byCode(r.diagnostics, 'claude-config-schema-version').length, 0);
});

test('#22: pluginDiagnostics absent → 0 findings', () => {
  const r = runDoctor({});
  assert.equal(byCode(r.diagnostics, 'claude-config-schema-version').length, 0);
});

test('#22: non-array pluginDiagnostics → 0 findings, no throw', () => {
  let r;
  assert.doesNotThrow(() => { r = runDoctor({ pluginDiagnostics: 'nope' }); });
  assert.equal(byCode(r.diagnostics, 'claude-config-schema-version').length, 0);
});

test('#22: path is preserved only when it is a string', () => {
  // With path
  const r1 = runDoctor({
    pluginDiagnostics: [{ code: 'plugin-schema-version-unknown', message: 'x', path: '/foo' }],
  });
  assert.equal(byCode(r1.diagnostics, 'claude-config-schema-version')[0].path, '/foo');

  // Without path (no path property on fact)
  const r2 = runDoctor({
    pluginDiagnostics: [{ code: 'plugin-schema-version-unknown', message: 'x' }],
  });
  const found2 = byCode(r2.diagnostics, 'claude-config-schema-version');
  assert.equal(found2.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(found2[0], 'path'), false);
});

test('#22: missing message falls back to default text', () => {
  const r = runDoctor({
    pluginDiagnostics: [{ code: 'plugin-schema-version-unknown' }],
  });
  const found = byCode(r.diagnostics, 'claude-config-schema-version');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /unrecognized schema version/);
});

test('#22: non-object entries in pluginDiagnostics are skipped, no throw', () => {
  let r;
  assert.doesNotThrow(() => {
    r = runDoctor({ pluginDiagnostics: [null, 42, { code: 'plugin-schema-version-unknown', message: 'ok' }] });
  });
  assert.equal(byCode(r.diagnostics, 'claude-config-schema-version').length, 1);
});

// ── C. #23 permissions-overbroad ─────────────────────────────────────────────

test('#23: wildcard entries in allow → one warn each', () => {
  const r = runDoctor({
    permissions: { allow: ['mcp__*', 'Read', 'Bash(*)'] },
  });
  const found = byCode(r.diagnostics, 'permissions-overbroad');
  assert.equal(found.length, 2);
  assert.ok(found.every((d) => d.severity === 'warn'));
  // "Read" is exact, no wildcard — must NOT be present
  assert.ok(found.every((d) => !d.message.includes('"Read"')));
});

test('#23: specific rule without wildcard is not flagged', () => {
  const r = runDoctor({
    permissions: { allow: ['Read', 'Bash(/c/Dev/Projects/claude-mgr)', 'Write(/tmp/x)'] },
  });
  assert.equal(byCode(r.diagnostics, 'permissions-overbroad').length, 0);
});

test('#23: duplicate wildcard entries are deduped to one finding', () => {
  const r = runDoctor({
    permissions: { allow: ['mcp__*', 'mcp__*', 'mcp__*'] },
  });
  const found = byCode(r.diagnostics, 'permissions-overbroad');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /mcp__\*/);
});

test('#23: ask and deny wildcards are NOT flagged (only allow is security-relevant)', () => {
  const r = runDoctor({
    permissions: { allow: [], ask: ['*'], deny: ['Bash(*)', 'mcp__*'] },
  });
  assert.equal(byCode(r.diagnostics, 'permissions-overbroad').length, 0);
});

test('#23: output is sorted by message (ascending)', () => {
  const r = runDoctor({
    permissions: { allow: ['z__*', 'a__*'] },
  });
  const found = byCode(r.diagnostics, 'permissions-overbroad');
  assert.equal(found.length, 2);
  assert.match(found[0].message, /a__\*/);
  assert.match(found[1].message, /z__\*/);
});

test('#23: permissions absent → 0 findings', () => {
  const r = runDoctor({});
  assert.equal(byCode(r.diagnostics, 'permissions-overbroad').length, 0);
});

test('#23: non-object permissions → 0 findings, no throw', () => {
  let r;
  assert.doesNotThrow(() => { r = runDoctor({ permissions: 'nope' }); });
  assert.equal(byCode(r.diagnostics, 'permissions-overbroad').length, 0);
});

test('#23: non-array allow → 0 findings, no throw', () => {
  let r;
  assert.doesNotThrow(() => { r = runDoctor({ permissions: { allow: 'Bash(*)' } }); });
  assert.equal(byCode(r.diagnostics, 'permissions-overbroad').length, 0);
});

test('#23: non-string entries in allow are skipped, no throw', () => {
  let r;
  assert.doesNotThrow(() => {
    r = runDoctor({ permissions: { allow: [null, 42, 'mcp__*', { rule: '*' }] } });
  });
  const found = byCode(r.diagnostics, 'permissions-overbroad');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /mcp__\*/);
});

test('#23: fix message is present and mentions ask', () => {
  const r = runDoctor({ permissions: { allow: ['*'] } });
  const found = byCode(r.diagnostics, 'permissions-overbroad');
  assert.equal(found.length, 1);
  assert.match(found[0].fix, /ask/);
});

// ── D. REGISTRY ───────────────────────────────────────────────────────────────

test('registry: CONFIG_CHECKS ids are [12, 22, 23]', () => {
  assert.deepEqual(CONFIG_CHECKS.map((c) => c.id), [12, 22, 23]);
});

test('registry: all CONFIG_CHECKS are probeLevel passive', () => {
  assert.ok(CONFIG_CHECKS.every((c) => c.probeLevel === 'passive'));
});

test('registry: ids 12, 22, 23 all present in the full CHECKS registry', () => {
  const ids = new Set(CHECKS.map((c) => c.id));
  assert.ok(ids.has(12));
  assert.ok(ids.has(22));
  assert.ok(ids.has(23));
});

test('registry: CHECKS length is 22', () => {
  assert.equal(CHECKS.length, 22);
});

test('registry: full id order is [1,2,3,5,18,6,7,8,9,10,11,12,22,23,13,14,16,20,21,25,17,24]', () => {
  assert.deepEqual(CHECKS.map((c) => c.id), [1, 2, 3, 5, 18, 6, 7, 8, 9, 10, 11, 12, 22, 23, 13, 14, 16, 20, 21, 25, 17, 24]);
});

// ── E. PURITY / NEVER-THROW ───────────────────────────────────────────────────

test('purity: runDoctor({}, {}) does not throw and the three new checks contribute 0 findings', () => {
  let r;
  assert.doesNotThrow(() => { r = runDoctor({}, {}); });
  assert.equal(byCode(r.diagnostics, 'orphan-files').length, 0);
  assert.equal(byCode(r.diagnostics, 'claude-config-schema-version').length, 0);
  assert.equal(byCode(r.diagnostics, 'permissions-overbroad').length, 0);
});

test('purity: undefined input does not throw and new checks contribute 0 findings', () => {
  let r;
  assert.doesNotThrow(() => { r = runDoctor(undefined); });
  assert.equal(byCode(r.diagnostics, 'orphan-files').length, 0);
  assert.equal(byCode(r.diagnostics, 'claude-config-schema-version').length, 0);
  assert.equal(byCode(r.diagnostics, 'permissions-overbroad').length, 0);
});
