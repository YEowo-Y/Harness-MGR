/**
 * doctor-codex-checks.test.mjs (P6 codex doctor) — pure runDoctor with an injected
 * input.codexConfig.
 *
 * Headline falsifiable oracles:
 *   #26 config-toml-valid — tomlError set → exactly one ERROR; null → none.
 *   #27 trust-overbroad   — home dir / drive root / ancestor of home → WARN; a
 *                           specific subdir → no warning.
 *   codex-guarded         — absent input.codexConfig → ZERO findings (Claude-safe).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor } from '../src/analysis/doctor/index.mjs';

const HOME = 'C:\\Users\\alice';
const byCode = (diags, code) => diags.filter((d) => d.code === code);

// ── #26 config-toml-valid ──────────────────────────────────────────────────────

test('#26: tomlError set → exactly one config-toml-valid ERROR naming the reason', () => {
  const r = runDoctor({ codexConfig: { tomlError: 'invalid TOML: expected = (line 3, column 5)', trustedProjects: [], homeDir: HOME } });
  const found = byCode(r.diagnostics, 'config-toml-valid');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'error');
  assert.match(found[0].message, /Codex config\.toml is invalid:/);
  assert.match(found[0].message, /expected = \(line 3, column 5\)/);
  assert.equal(found[0].phase, 'doctor');
  assert.equal(typeof found[0].fix, 'string');
});

test('#26: tomlError null → no config-toml-valid finding', () => {
  const r = runDoctor({ codexConfig: { tomlError: null, trustedProjects: [], homeDir: HOME } });
  assert.equal(byCode(r.diagnostics, 'config-toml-valid').length, 0);
});

test('#26: empty-string tomlError → no finding', () => {
  const r = runDoctor({ codexConfig: { tomlError: '', trustedProjects: [], homeDir: HOME } });
  assert.equal(byCode(r.diagnostics, 'config-toml-valid').length, 0);
});

// ── #27 trust-overbroad ────────────────────────────────────────────────────────

test('#27: trusting the home dir itself → a trust-overbroad WARN naming it', () => {
  const r = runDoctor({ codexConfig: { tomlError: null, trustedProjects: [HOME], homeDir: HOME } });
  const found = byCode(r.diagnostics, 'trust-overbroad');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'warn');
  assert.match(found[0].message, /C:\\Users\\alice/);
  assert.equal(found[0].phase, 'doctor');
  assert.equal(typeof found[0].fix, 'string');
});

test('#27: a drive root "D:\\\\" → WARN', () => {
  const r = runDoctor({ codexConfig: { tomlError: null, trustedProjects: ['D:\\'], homeDir: HOME } });
  assert.equal(byCode(r.diagnostics, 'trust-overbroad').length, 1);
});

test('#27: an ancestor of home "C:\\\\Users" → WARN', () => {
  const r = runDoctor({ codexConfig: { tomlError: null, trustedProjects: ['C:\\Users'], homeDir: HOME } });
  assert.equal(byCode(r.diagnostics, 'trust-overbroad').length, 1);
});

test('#27: a specific subdir under home → NO warning (precise trust is fine)', () => {
  const r = runDoctor({ codexConfig: { tomlError: null, trustedProjects: [HOME + '\\projects\\foo'], homeDir: HOME } });
  assert.equal(byCode(r.diagnostics, 'trust-overbroad').length, 0);
});

test('#27: mixed list → only the overbroad paths warn, deduped', () => {
  const r = runDoctor({ codexConfig: {
    tomlError: null,
    trustedProjects: [HOME, HOME, HOME + '\\projects\\foo', 'C:\\'],
    homeDir: HOME,
  } });
  const found = byCode(r.diagnostics, 'trust-overbroad');
  // HOME (deduped to 1) + drive root C:\ = 2; the specific subdir is fine.
  assert.equal(found.length, 2);
});

// ── codex-guarded (Claude-safe) ────────────────────────────────────────────────

test('absent input.codexConfig → ZERO #26/#27 findings (proves the checks are codex-guarded)', () => {
  const r = runDoctor({}); // a Claude run never gathers codexConfig
  assert.equal(byCode(r.diagnostics, 'config-toml-valid').length, 0);
  assert.equal(byCode(r.diagnostics, 'trust-overbroad').length, 0);
});

test('non-object codexConfig → no findings, no throw', () => {
  let r;
  assert.doesNotThrow(() => { r = runDoctor({ codexConfig: 'nope' }); });
  assert.equal(byCode(r.diagnostics, 'config-toml-valid').length, 0);
  assert.equal(byCode(r.diagnostics, 'trust-overbroad').length, 0);
});

test('#26/#27 are registered passive checks (present in the registry, run by default)', () => {
  const r = runDoctor({ codexConfig: { tomlError: null, trustedProjects: [], homeDir: HOME } });
  const c26 = r.checks.find((c) => c.id === 26);
  const c27 = r.checks.find((c) => c.id === 27);
  assert.ok(c26 && c26.probeLevel === 'passive' && c26.ran, '#26 registered, passive, ran');
  assert.ok(c27 && c27.probeLevel === 'passive' && c27.ran, '#27 registered, passive, ran');
});
