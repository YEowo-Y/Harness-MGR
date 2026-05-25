/**
 * CLI shell tests (P1.U15, sub-unit B).
 *
 * Exercises src/cli.mjs `run(argv)` end-to-end against the committed fixtures:
 * argv parsing (incl. the two-word `config show-effective`), per-command JSON
 * envelopes, the default table + quiet renderings, usage/unknown errors, the
 * error-severity → exit-1 path, and the never-throws guarantee.
 *
 * JSON assertions parse `out.stdout`; table/quiet assertions only check that the
 * output is a non-empty string containing expected substrings (the table is not
 * byte-asserted — its formatting is owned by table.mjs's own tests).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from '../src/cli.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fix = (rel) => join(here, 'fixtures', rel);
const MIN = fix('minimal');

// ── JSON envelopes, per command ───────────────────────────────────────────────

test('inventory --format json: counts the minimal fixture', async () => {
  const out = await run(['inventory', '--config-dir', MIN, '--format', 'json']);
  assert.equal(out.code, 0);
  const env = JSON.parse(out.stdout);
  assert.equal(env.version, 1);
  assert.equal(env.command, 'inventory');
  assert.equal(env.result.counts.skills, 1);
  assert.equal(env.result.counts.agents, 1);
  assert.equal(env.result.counts.commands, 1);
  assert.equal(env.result.counts.plugins, 0);
  assert.equal(env.result.counts.mcpServers, 0);
});

test('conflicts --format json: no conflicts + version-guard diagnostic', async () => {
  const out = await run(['conflicts', '--config-dir', MIN, '--format', 'json']);
  assert.equal(out.code, 0);
  const env = JSON.parse(out.stdout);
  assert.deepEqual(env.result.conflicts, []);
  assert.ok(
    env.diagnostics.some((d) => d.code === 'loader-rules-unverified-version'),
    'expected the Phase-1 loader version-guard diagnostic',
  );
});

test('orphans --format json: empty summary on the minimal fixture', async () => {
  const out = await run(['orphans', '--config-dir', MIN, '--format', 'json']);
  assert.equal(out.code, 0);
  const env = JSON.parse(out.stdout);
  assert.deepEqual(env.result.summary, { hard: 0, soft: 0, total: 0 });
});

test('config show-effective (two-word) --format json: effective model', async () => {
  const out = await run(['config', 'show-effective', '--config-dir', MIN, '--format', 'json']);
  assert.equal(out.code, 0);
  const env = JSON.parse(out.stdout);
  assert.equal(env.command, 'config:show-effective');
  assert.equal(env.result.effective.model, 'sonnet');
});

test('config show-effective --key model: narrows to the scalar value', async () => {
  const out = await run(['config', 'show-effective', '--config-dir', MIN, '--key', 'model', '--format', 'json']);
  assert.equal(out.code, 0);
  const env = JSON.parse(out.stdout);
  assert.equal(env.result.value, 'sonnet');
});

test('hooks --order --format json: empty hooks on the minimal fixture', async () => {
  const out = await run(['hooks', '--order', '--config-dir', MIN, '--format', 'json']);
  assert.equal(out.code, 0);
  const env = JSON.parse(out.stdout);
  assert.deepEqual(env.result.hooks, {});
});

test('selftest --format json: ok on the minimal fixture', async () => {
  const out = await run(['selftest', '--config-dir', MIN, '--format', 'json']);
  assert.equal(out.code, 0);
  const env = JSON.parse(out.stdout);
  assert.equal(env.result.ok, true);
});

test('selftest --all: rigorous gates over the mgr src run clean → exit 0', async () => {
  const out = await run(['selftest', '--all', '--config-dir', MIN, '--format', 'json']);
  assert.equal(out.code, 0);
  const env = JSON.parse(out.stdout);
  assert.equal(env.result.ok, true);
  const names = env.result.checks.map((c) => c.name);
  for (const n of ['scan', 'orphans', 'lint', 'invariants', 'boundary']) {
    assert.ok(names.includes(n), `--all should include the ${n} check`);
  }
});

test('doctor --format json: passive run on the minimal fixture', async () => {
  const out = await run(['doctor', '--config-dir', MIN, '--format', 'json']);
  assert.equal(out.code, 0); // minimal yields no error-severity diagnostics
  const env = JSON.parse(out.stdout);
  assert.equal(env.command, 'doctor');
  assert.equal(env.result.probeLevel, 'passive');
  assert.ok(Array.isArray(env.result.checks) && env.result.checks.length > 0, 'checks is a non-empty array');
  // Passive checks ran; the active checks (#4/#15/#19) did NOT (no --active-probes).
  for (const c of env.result.checks) {
    if (c.probeLevel === 'passive') assert.equal(c.ran, true, `passive check ${c.code} should run`);
    else assert.equal(c.ran, false, `active check ${c.code} must NOT run without --active-probes`);
  }
});

test('doctor --active-probes --format json: active checks run + opt-in notice', async () => {
  const out = await run(['doctor', '--active-probes', '--config-dir', MIN, '--format', 'json']);
  assert.equal(out.code, 0);
  const env = JSON.parse(out.stdout);
  assert.equal(env.result.probeLevel, 'active');
  const active = env.result.checks.filter((c) => c.probeLevel === 'active');
  assert.ok(active.length > 0, 'there are active checks');
  for (const c of active) assert.equal(c.ran, true, `active check ${c.code} should run under --active-probes`);
  assert.ok(
    env.diagnostics.some((d) => d.code === 'doctor-active-probes' && d.severity === 'info'),
    'expected the active-probes opt-in info diagnostic',
  );
});

test('doctor default (table) format: mentions the command', async () => {
  const out = await run(['doctor', '--config-dir', MIN]);
  assert.equal(out.code, 0);
  assert.ok(out.stdout.includes('doctor'), 'table title names the command');
});

// ── default (table) + quiet renderings ──────────────────────────────────────────

test('default format is a non-empty human table', async () => {
  const out = await run(['inventory', '--config-dir', MIN]);
  assert.equal(out.code, 0);
  assert.equal(typeof out.stdout, 'string');
  assert.ok(out.stdout.length > 0);
  assert.ok(out.stdout.includes('skills'), 'table should mention the skills metric');
});

test('quiet format: code 0 and a short one-line summary', async () => {
  const out = await run(['inventory', '--config-dir', MIN, '--format', 'quiet']);
  assert.equal(out.code, 0);
  assert.ok(out.stdout.includes('inventory'));
  assert.ok(!out.stdout.includes('\n'), 'quiet output is a single line');
});

test('unrecognized --format falls back to table (no error)', async () => {
  const out = await run(['inventory', '--config-dir', MIN, '--format', 'yaml']);
  assert.equal(out.code, 0);
  assert.ok(out.stdout.includes('inventory'), 'fell back to the table title');
});

// ── usage / unknown-command errors ──────────────────────────────────────────────

test('no subcommand → code 2 + usage text', async () => {
  const out = await run([]);
  assert.equal(out.code, 2);
  assert.ok(out.stdout.includes('usage'));
  assert.ok(out.stdout.includes('inventory'), 'usage lists the valid commands');
});

test('unknown subcommand → code 2 naming valid commands', async () => {
  const out = await run(['bogus', '--config-dir', MIN]);
  assert.equal(out.code, 2);
  assert.ok(out.stdout.includes('bogus'));
  assert.ok(out.stdout.includes('inventory'));
});

test('leading --flag with no subcommand → code 2 usage', async () => {
  const out = await run(['--format', 'json']);
  assert.equal(out.code, 2);
  assert.ok(out.stdout.includes('usage'));
});

// ── error path (exit 1) ──────────────────────────────────────────────────────────

test('malformed settings.json (broken fixture) → exit 1 + error diagnostic', async () => {
  // broken/settings.json has a trailing comma → invalid JSON → settings-unreadable.
  const out = await run(['config', 'show-effective', '--config-dir', fix('broken'), '--format', 'json']);
  assert.equal(out.code, 1);
  const env = JSON.parse(out.stdout);
  const errs = env.diagnostics.filter((d) => d.severity === 'error');
  assert.ok(errs.length > 0, 'expected at least one error-severity diagnostic');
  assert.ok(
    errs.some((d) => d.code === 'settings-unreadable' || d.code === 'settings-malformed'),
    'expected a settings-unreadable/settings-malformed error',
  );
});

test('error-severity diagnostic from a temp dir also yields exit 1', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-mgr-cli-'));
  try {
    await writeFile(join(dir, 'settings.json'), '{bad json', 'utf-8');
    const out = await run(['config', 'show-effective', '--config-dir', dir, '--format', 'json']);
    assert.equal(out.code, 1);
    const env = JSON.parse(out.stdout);
    assert.ok(env.diagnostics.some((d) => d.severity === 'error'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── never-throws ─────────────────────────────────────────────────────────────────

test('non-existent config dir: never throws, returns a well-formed envelope', async () => {
  await assert.doesNotReject(async () => {
    const out = await run(['inventory', '--config-dir', fix('does-not-exist'), '--format', 'json']);
    const env = JSON.parse(out.stdout);
    assert.equal(env.version, 1);
    assert.equal(env.command, 'inventory');
    assert.equal(typeof out.code, 'number');
  });
});

test('a non-array argv (undefined / null / number) does not throw → code 2', async () => {
  for (const bad of [undefined, null, 42]) {
    await assert.doesNotReject(async () => {
      // @ts-expect-error deliberately wrong type to prove the Array.isArray guard
      const out = await run(bad);
      assert.equal(out.code, 2); // no subcommand → usage
    });
  }
});
