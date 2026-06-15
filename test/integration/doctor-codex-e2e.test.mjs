/**
 * doctor-codex-e2e.test.mjs (P6 codex doctor) — END-TO-END through run().
 *
 * Drives the FULL stack: cli.mjs → resolve-target (--target codex) → doctorCommand
 * → gatherDoctorInput (descriptor-gated codex config probe + descriptor-threaded
 * detectOrphans) → runDoctor → the new #26/#27 codex checks.
 *
 * Headline oracles:
 *   - a [projects."<real home>"] trust_level="trusted" → a trust-overbroad WARN.
 *   - the codex layout produces ZERO orphan-files findings (the descriptor-threading
 *     fix that killed the 97-false-orphan flood).
 *   - a deliberately broken config.toml → a config-toml-valid ERROR.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

import { run } from '../../src/cli.mjs';

/**
 * Build a temp codex dir: a config.toml trusting the REAL os.homedir() (so #27
 * fires deterministically) + a codex-shaped skill (skills/<n>/SKILL.md).
 * The home path is embedded as a TOML literal string ('...') so Windows
 * backslashes are taken verbatim (no escape processing).
 */
function makeCodexDir() {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-codex-doctor-'));
  const home = homedir();
  const toml = [
    `[projects.'${home}']`,
    'trust_level = "trusted"',
    '',
    `[projects.'${join(home, 'projects', 'specific')}']`,
    'trust_level = "trusted"',
  ].join('\n');
  writeFileSync(join(dir, 'config.toml'), toml, 'utf8');
  const skillDir = join(dir, 'skills', 'my-skill');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: my-skill\n---\nbody\n', 'utf8');
  return { dir, home };
}

test('doctor --target codex: trust-overbroad WARN fires + ZERO orphan-files findings', async () => {
  const { dir } = makeCodexDir();
  try {
    const out = await run(['doctor', '--target', 'codex', '--config-dir', dir, '--format', 'json']);
    assert.ok(out.code === 0 || out.code === 1, `exit 0/1 (not 2): got ${out.code} — ${out.stdout}`);
    const env = JSON.parse(out.stdout);

    // #27 trust-overbroad: the home-dir trust is overbroad; the specific subdir is not.
    const overbroad = env.diagnostics.filter((d) => d.code === 'trust-overbroad');
    assert.equal(overbroad.length, 1, 'exactly one overbroad trust (home), not the specific subdir');
    assert.equal(overbroad[0].severity, 'warn');

    // The orphan-noise fix: the codex layout (config.toml + skills/) yields NO orphans.
    const orphans = env.diagnostics.filter((d) => d.code === 'orphan-files');
    assert.equal(orphans.length, 0, `codex layout must produce 0 orphan-files findings, got ${orphans.length}`);

    // valid config → no #26 error.
    assert.equal(env.diagnostics.filter((d) => d.code === 'config-toml-valid').length, 0);

    // #26/#27 are registered + ran (passive).
    assert.ok(env.result.checks.find((c) => c.id === 26 && c.ran), '#26 ran');
    assert.ok(env.result.checks.find((c) => c.id === 27 && c.ran), '#27 ran');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('doctor --target codex: a broken config.toml → a config-toml-valid ERROR', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-codex-broken-'));
  try {
    // an unterminated table header is a clean parse error
    writeFileSync(join(dir, 'config.toml'), '[projects."broken"\ntrust_level = "trusted"\n', 'utf8');
    const out = await run(['doctor', '--target', 'codex', '--config-dir', dir, '--format', 'json']);
    assert.ok(out.code === 0 || out.code === 1, `exit 0/1 (not 2): got ${out.code}`);
    const env = JSON.parse(out.stdout);
    const err = env.diagnostics.filter((d) => d.code === 'config-toml-valid');
    assert.equal(err.length, 1, 'a broken config.toml yields one config-toml-valid finding');
    assert.equal(err[0].severity, 'error');
    assert.match(err[0].message, /Codex config\.toml is invalid:/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
