/**
 * P2.U4 — doctor.test.mjs
 *
 * Check-logic goldens + boundary for runDoctor(), the passive health dispatcher.
 * The three U4 checks are exercised against a mix of REAL discovery facts (so the
 * doctor is wired to the same fact shapes the CLI will feed it) and synthetic
 * clusters (Phase-1 scan cannot itself produce a shadowing cluster — see header of
 * src/analysis/doctor/index.mjs):
 *   #6  settings-json-valid           ← scan(settings-dupkey).settings.diagnostics
 *   #7  plugin-enabled-not-installed  ← scan(plugins-groundtruth).plugins + ghost key
 *   #11 duplicate-component-shadowing ← synthetic ConflictCluster[]
 * Plus aggregate report shape, never-throws boundary, and determinism.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/discovery/scan.mjs';
import { runDoctor, CHECKS } from '../src/analysis/doctor/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fix = (rel) => join(here, 'fixtures', rel);

const byCode = (diags, code) => diags.filter((d) => d.code === code);
const bySeverity = (diags, sev) => diags.filter((d) => d.severity === sev);

/** A minimal synthetic shadowing cluster — the doctor reads only these fields. */
const cluster = (over = {}) => ({
  kind: 'agent', key: 'executor', possibleWinners: [{}, {}],
  reason: 'agent "executor" is defined at user, plugin; the user copy wins',
  fix: 'remove or rename the shadowed agent if the override is unintended',
  ...over,
});

// ── A. #6 settings-json-valid ─────────────────────────────────────────────────

test('#6: a real duplicate-key fact escalates to a settings-json-valid error with line:column', () => {
  const s = scan({ targetClaudeDir: fix('settings-dupkey') });
  // Sanity: discovery produced the warn FACT the doctor is meant to judge.
  assert.equal(byCode(s.settings.diagnostics, 'settings-duplicate-key').length, 1);

  const r = runDoctor({ settingsDiagnostics: s.settings.diagnostics });
  const found = byCode(r.diagnostics, 'settings-json-valid');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'error'); // escalated from the warn fact
  assert.match(found[0].message, /duplicate key "model"/);
  assert.match(found[0].message, /line 3/);
  assert.match(found[0].fix, /duplicate/); // fix is specific to the duplicate-key cause
  assert.equal(found[0].phase, 'doctor');
});

test('#6: unreadable + malformed facts also escalate to settings-json-valid errors', () => {
  const settingsDiagnostics = [
    { severity: 'error', code: 'settings-unreadable', message: 'invalid JSONC: x (line 1, column 1)', path: '/s.json', phase: 'settings' },
    { severity: 'warn', code: 'settings-malformed', message: 'settings.json is not a JSON object', path: '/s.json', phase: 'settings' },
  ];
  const r = runDoctor({ settingsDiagnostics });
  const found = byCode(r.diagnostics, 'settings-json-valid');
  assert.equal(found.length, 2);
  assert.ok(found.every((d) => d.severity === 'error'));
  assert.equal(found[0].path, '/s.json'); // unreadable fact
  assert.equal(found[1].path, '/s.json'); // malformed fact — path propagated for every fact
  assert.match(found[0].fix, /syntax/);   // unreadable → syntax-focused fix
  assert.match(found[1].fix, /object/);   // malformed → not-an-object fix
});

test('#6: unrelated settings facts are ignored (no false positive)', () => {
  const settingsDiagnostics = [{ severity: 'info', code: 'settings-some-other-fact', message: 'noise', phase: 'settings' }];
  const r = runDoctor({ settingsDiagnostics });
  assert.equal(byCode(r.diagnostics, 'settings-json-valid').length, 0);
});

// ── B. #7 plugin-enabled-not-installed ────────────────────────────────────────

test('#7: enabled plugin missing from the installed set → exactly one error for the ghost', () => {
  const s = scan({ targetClaudeDir: fix('plugins-groundtruth') });
  assert.ok(s.plugins.length >= 13, 'fixture installs the known 13 plugins');

  const enabledPlugins = {
    'claude-mem@thedotmack': true,      // installed → must NOT be flagged
    'ghost-plugin@nowhere': true,       // not installed → flagged
  };
  const r = runDoctor({ enabledPlugins, installedPlugins: s.plugins });
  const found = byCode(r.diagnostics, 'plugin-enabled-not-installed');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'error');
  assert.match(found[0].message, /ghost-plugin@nowhere/);
});

test('#7: a plugin set to false is not "enabled", so it is never flagged', () => {
  const r = runDoctor({ enabledPlugins: { 'ghost@nowhere': false }, installedPlugins: [] });
  assert.equal(byCode(r.diagnostics, 'plugin-enabled-not-installed').length, 0);
});

test('#7: multiple ghosts are reported sorted by key (deterministic)', () => {
  const r = runDoctor({
    enabledPlugins: { 'zeta@m': true, 'alpha@m': true },
    installedPlugins: [{ key: 'beta@m' }],
  });
  const msgs = byCode(r.diagnostics, 'plugin-enabled-not-installed').map((d) => d.message);
  assert.equal(msgs.length, 2);
  assert.match(msgs[0], /alpha@m/); // sorted: alpha before zeta
  assert.match(msgs[1], /zeta@m/);
});

test('#7: a __proto__ own-key in enabledPlugins is not treated as a plugin (proto-safety)', () => {
  // JSON.parse makes __proto__ a real own, enumerable key — must not become a finding.
  const r = runDoctor({ enabledPlugins: JSON.parse('{"__proto__": true, "constructor": true}'), installedPlugins: [] });
  assert.equal(byCode(r.diagnostics, 'plugin-enabled-not-installed').length, 0);
});

// ── C. #11 duplicate-component-shadowing ──────────────────────────────────────

test('#11: a cluster of 2 members → one warn reusing the cluster reason/fix', () => {
  const c = cluster();
  const r = runDoctor({ conflicts: [c] });
  const found = byCode(r.diagnostics, 'duplicate-component-shadowing');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'warn');
  assert.equal(found[0].message, c.reason);
  assert.equal(found[0].fix, c.fix);
});

test('#11: a degenerate single-member cluster is not a conflict (guarded out)', () => {
  const r = runDoctor({ conflicts: [cluster({ possibleWinners: [{}] })] });
  assert.equal(byCode(r.diagnostics, 'duplicate-component-shadowing').length, 0);
});

test('#11: a cluster with no reason/fix falls back to a synthesized message', () => {
  const r = runDoctor({ conflicts: [{ kind: 'skill', key: 'sup:deploy', possibleWinners: [{}, {}] }] });
  const found = byCode(r.diagnostics, 'duplicate-component-shadowing');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /skill "sup:deploy"/);
  assert.equal(typeof found[0].fix, 'string');
});

// ── D. AGGREGATE REPORT SHAPE ─────────────────────────────────────────────────

test('aggregate: all three checks fire together; report is passive with per-check summaries', () => {
  const r = runDoctor({
    settingsDiagnostics: [{ severity: 'warn', code: 'settings-duplicate-key', message: 'duplicate key "x" at line 1, column 1 (last value wins)', path: '/s', phase: 'settings' }],
    enabledPlugins: { 'ghost@nowhere': true },
    installedPlugins: [],
    conflicts: [cluster()],
  });
  assert.equal(r.probeLevel, 'passive');
  assert.equal(r.checks.length, CHECKS.length);
  assert.ok(r.checks.every((c) => c.ran), 'every passive check runs by default');
  // findings line up with the registry order: #6=1, #7=1, #11=1.
  assert.deepEqual(r.checks.map((c) => [c.id, c.findings]), [[6, 1], [7, 1], [11, 1]]);
  assert.equal(bySeverity(r.diagnostics, 'error').length, 2); // #6 + #7
  assert.equal(bySeverity(r.diagnostics, 'warn').length, 1);  // #11
});

test('aggregate: a clean bundle yields zero findings', () => {
  const r = runDoctor({ settingsDiagnostics: [], enabledPlugins: {}, installedPlugins: [], conflicts: [] });
  assert.equal(r.diagnostics.length, 0);
  assert.ok(r.checks.every((c) => c.ran && c.findings === 0));
});

// ── E. BOUNDARY (never throws) ────────────────────────────────────────────────

for (const bad of [null, undefined, 42, 'nope', []]) {
  test(`boundary: ${JSON.stringify(bad)} input → no findings, never throws`, () => {
    let r;
    assert.doesNotThrow(() => { r = runDoctor(/** @type {any} */ (bad)); });
    assert.equal(r.probeLevel, 'passive');
    assert.equal(r.diagnostics.length, 0);
    assert.equal(r.checks.length, CHECKS.length);
  });
}

test('boundary: malformed field types all coerce to empty, never throw', () => {
  let r;
  assert.doesNotThrow(() => {
    r = runDoctor(/** @type {any} */ ({ settingsDiagnostics: 'x', enabledPlugins: 7, installedPlugins: {}, conflicts: 'y' }));
  });
  assert.equal(r.diagnostics.length, 0);
});

test('boundary: a malformed cluster member is skipped, not thrown on', () => {
  let r;
  assert.doesNotThrow(() => { r = runDoctor({ conflicts: [null, 5, cluster()] }); });
  assert.equal(byCode(r.diagnostics, 'duplicate-component-shadowing').length, 1);
});

// ── F. DETERMINISM ────────────────────────────────────────────────────────────

test('determinism: two runs on the same input deepEqual', () => {
  const input = {
    settingsDiagnostics: [{ severity: 'warn', code: 'settings-duplicate-key', message: 'duplicate key "m" at line 2, column 2 (last value wins)', path: '/s', phase: 'settings' }],
    enabledPlugins: { 'g@n': true },
    installedPlugins: [],
    conflicts: [cluster()],
  };
  assert.deepEqual(runDoctor(input), runDoctor(input));
});
