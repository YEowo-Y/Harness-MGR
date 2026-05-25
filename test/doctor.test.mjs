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

/** A minimal synthetic installed-plugin record — #8/#9/#10 read key/marketplace/enabled/cachePresent. */
const plugin = (over = {}) => ({ key: 'p@mp', name: 'p', marketplace: 'mp', version: '1.0.0', enabled: true, cachePresent: true, ...over });

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

// ── B2. #8 / #9 / #10 plugin-state checks ─────────────────────────────────────

test('#10: real-harness oracle — plugins-groundtruth (all settings-enabled) yields exactly 11 cache-missing warns', () => {
  const s = scan({ targetClaudeDir: fix('plugins-groundtruth') });
  const enabledPlugins = Object.fromEntries(s.plugins.map((p) => [p.key, true])); // settings enables all 13
  const r = runDoctor({ installedPlugins: s.plugins, enabledPlugins });
  const found = byCode(r.diagnostics, 'plugin-cache-missing');
  assert.equal(found.length, 11); // 13 installed + enabled, 2 cached → 11 missing (plan's "11/13")
  assert.ok(found.every((d) => d.severity === 'warn'));
});

test('#10: only SETTINGS-ENABLED installs with a missing cache are flagged', () => {
  const r = runDoctor({
    installedPlugins: [
      plugin({ key: 'on@m', cachePresent: false }),
      plugin({ key: 'off@m', cachePresent: false }),  // missing cache but not enabled in settings
      plugin({ key: 'cached@m', cachePresent: true }),
    ],
    enabledPlugins: { 'on@m': true, 'cached@m': true },
  });
  const found = byCode(r.diagnostics, 'plugin-cache-missing');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /on@m/);
});

test('#10: record.enabled is IGNORED — only the settings map enables (regression, STABILITY-LOG 2026-05-24)', () => {
  // record enabled:true but absent from the settings map → NOT flagged (settings is authoritative).
  const r1 = runDoctor({ installedPlugins: [plugin({ key: 'x@m', enabled: true, cachePresent: false })], enabledPlugins: {} });
  assert.equal(byCode(r1.diagnostics, 'plugin-cache-missing').length, 0);
  // record enabled:false but settings-enabled → MUST be flagged (the latent false-negative we fixed).
  const r2 = runDoctor({ installedPlugins: [plugin({ key: 'x@m', enabled: false, cachePresent: false })], enabledPlugins: { 'x@m': true } });
  assert.equal(byCode(r2.diagnostics, 'plugin-cache-missing').length, 1);
});

test('#8: an installed plugin absent from the settings map → info; a settings-enabled one is silent', () => {
  // Both records default enabled:true, so this also proves #8 ignores record.enabled:
  // off@m has record enabled:true yet is flagged because settings does not enable it.
  const r = runDoctor({
    installedPlugins: [plugin({ key: 'off@m' }), plugin({ key: 'on@m' })],
    enabledPlugins: { 'on@m': true },
  });
  const found = byCode(r.diagnostics, 'plugin-installed-not-enabled');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'info');
  assert.match(found[0].message, /off@m/);
});

test('#8: real-harness shape — all installed plugins enabled in settings → no findings', () => {
  const s = scan({ targetClaudeDir: fix('plugins-groundtruth') });
  const enabledPlugins = Object.fromEntries(s.plugins.map((p) => [p.key, true]));
  const r = runDoctor({ installedPlugins: s.plugins, enabledPlugins });
  assert.equal(byCode(r.diagnostics, 'plugin-installed-not-enabled').length, 0);
});

test('#9: an installed plugin from an unknown marketplace → info', () => {
  const r = runDoctor({
    installedPlugins: [plugin({ key: 'p@ghost', marketplace: 'ghost' }), plugin({ key: 'q@known', marketplace: 'known' })],
    marketplaces: [{ name: 'known' }],
  });
  const found = byCode(r.diagnostics, 'plugin-marketplace-unknown');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'info');
  assert.match(found[0].message, /ghost/);
});

test('#9: with no known marketplaces there is no baseline → no findings (avoids a flood)', () => {
  const r = runDoctor({ installedPlugins: [plugin({ key: 'p@whatever', marketplace: 'whatever' })], marketplaces: [] });
  assert.equal(byCode(r.diagnostics, 'plugin-marketplace-unknown').length, 0);
});

test('#9: a plugin with an empty marketplace is not flagged (no data, not "unknown")', () => {
  const r = runDoctor({ installedPlugins: [plugin({ key: 'p@', marketplace: '' })], marketplaces: [{ name: 'known' }] });
  assert.equal(byCode(r.diagnostics, 'plugin-marketplace-unknown').length, 0);
});

test('#9: real harness — every installed plugin uses a known marketplace → no findings', () => {
  const s = scan({ targetClaudeDir: fix('plugins-groundtruth') });
  const r = runDoctor({ installedPlugins: s.plugins, marketplaces: s.marketplaces });
  assert.equal(byCode(r.diagnostics, 'plugin-marketplace-unknown').length, 0);
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
  // findings line up with the registry order; the plugin-state checks (#8/#9/#10)
  // find nothing here (no installed plugins / marketplaces in this bundle).
  assert.deepEqual(r.checks.map((c) => [c.id, c.findings]), [[1, 0], [2, 0], [3, 0], [5, 0], [18, 0], [6, 1], [7, 1], [8, 0], [9, 0], [10, 0], [11, 1], [12, 0], [22, 0], [23, 0], [13, 0], [14, 0], [16, 0], [20, 0], [21, 0], [25, 0], [17, 0]]);
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

test('boundary: an array enabledPlugins is treated as empty, not iterated (never throws)', () => {
  let r;
  assert.doesNotThrow(() => {
    r = runDoctor({ enabledPlugins: /** @type {any} */ ([1, 2, 3]), installedPlugins: [plugin({ key: 'a@m', cachePresent: false })] });
  });
  // typeof [] === 'object', but enabledMap excludes arrays → {} → nothing is "enabled".
  assert.equal(byCode(r.diagnostics, 'plugin-enabled-not-installed').length, 0);
  assert.equal(byCode(r.diagnostics, 'plugin-cache-missing').length, 0);
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
