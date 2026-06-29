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

test('hooks --format json: empty hooks on the minimal fixture', async () => {
  const out = await run(['hooks', '--config-dir', MIN, '--format', 'json']);
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
  assert.ok(out.stdout.includes('--active-probes'), 'usage documents the --active-probes flag');
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

// ── strict unknown-flag handling (P2.1) ───────────────────────────────────────────

test('unknown long flag → code 2, names the flag, command did NOT execute', async () => {
  const out = await run(['inventory', '--bogus', '--config-dir', MIN, '--format', 'json']);
  assert.equal(out.code, 2);
  assert.ok(out.stdout.includes('--bogus'), 'the offending flag is named');
  // The command body never ran: output is the usage text, NOT an inventory envelope.
  assert.ok(out.stdout.includes('unknown flag'), 'usage text, not a result');
  assert.throws(() => JSON.parse(out.stdout), 'no JSON envelope — the command did not execute');
});

test('mistyped --configdir on snapshot --apply → code 2 (write-misdirection guard)', async () => {
  // The headline guard: a typo for --config-dir must be CAUGHT, never silently
  // dropped (which would leave configDir undefined → resolve the real ~/.claude).
  const out = await run(['snapshot', '--configdir', '/tmp/x', '--apply']);
  assert.equal(out.code, 2);
  assert.ok(out.stdout.includes('--configdir'), 'the mistyped flag is named');
});

test('unknown --format value → still renders, warn diagnostic code unknown-format', async () => {
  const out = await run(['inventory', '--config-dir', MIN, '--format', 'jsonn']);
  assert.equal(out.code, 0, 'a format typo is advisory, not fatal — exit code unchanged');
  // Falls back to the table render (a non-empty human block naming the command).
  assert.ok(out.stdout.includes('inventory'), 'fell back to the table title');
  // The footer line is `severity code: message` → assert the warn severity + code.
  assert.ok(out.stdout.includes('warn unknown-format'), 'a warn-severity unknown-format diagnostic surfaced');
  assert.ok(out.stdout.includes('jsonn'), 'names the bad format value');
});

test('valid --format json: no unknown-format diagnostic', async () => {
  const out = await run(['inventory', '--config-dir', MIN, '--format', 'json']);
  assert.equal(out.code, 0);
  const env = JSON.parse(out.stdout);
  assert.ok(!env.diagnostics.some((d) => d.code === 'unknown-format'), 'a valid format raises no warn');
});

// ── regression: valid flags still work under the strict policy ────────────────────

test('valid --config-dir still works under strict-flag policy → code 0, no flag error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-mgr-cli-strict-'));
  try {
    await writeFile(join(dir, 'settings.json'), '{"model":"opus"}', 'utf-8');
    const out = await run(['config', 'show-effective', '--config-dir', dir, '--format', 'json']);
    assert.equal(out.code, 0);
    assert.ok(!out.stdout.includes('unknown flag'), 'a valid flag is not rejected');
    const env = JSON.parse(out.stdout);
    assert.equal(env.command, 'config:show-effective');
    assert.equal(env.result.effective.model, 'opus');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('every recognized flag parses without an unknown-flag error', async () => {
  // A broad smoke over the boolean/value flags real commands use: none should be
  // mistaken for an unknown flag (the full suite staying green proves nothing broke,
  // but this pins the enumeration explicitly).
  const cases = [
    ['inventory', '--detail', '--config-dir', MIN, '--format', 'json'],
    ['inventory', '--type', 'skill', '--config-dir', MIN, '--format', 'json'],
    ['conflicts', '--name', 'x', '--config-dir', MIN, '--format', 'json'],
    ['hooks', '--config-dir', MIN, '--format', 'json'],
    ['doctor', '--active-probes', '--config-dir', MIN, '--format', 'json'],
    ['audit', '--since', '7d', '--config-dir', MIN, '--format', 'json'],
    ['snapshot', '--reason', 'r', '--include-auth', '--config-dir', MIN, '--format', 'json'],
    ['snapshot', 'gc', '--keep', '2', '--older-than', '30d', '--config-dir', MIN, '--format', 'json'],
    ['selftest', '--all', '--config-dir', MIN, '--format', 'json'],
  ];
  for (const argv of cases) {
    const out = await run(argv);
    assert.ok(!out.stdout.includes('unknown flag'), `recognized flags must not error: ${argv.join(' ')}`);
    assert.notEqual(out.code, 2, `recognized flags must not hit the usage exit: ${argv.join(' ')}`);
  }
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
  const dir = await mkdtemp(join(tmpdir(), 'harness-mgr-cli-'));
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

// ── audit ─────────────────────────────────────────────────────────────────────────

test('audit --format json: empty entries on minimal (no audit.log yet)', async () => {
  const out = await run(['audit', '--config-dir', MIN, '--format', 'json']);
  assert.equal(out.code, 0);
  const env = JSON.parse(out.stdout);
  assert.equal(env.command, 'audit');
  assert.ok(Array.isArray(env.result.entries), 'result.entries is an array');
  assert.ok(env.result.summary !== undefined && env.result.summary !== null, 'result.summary is present');
});

test('audit --since 7d --format json: does not throw', async () => {
  const out = await run(['audit', '--since', '7d', '--config-dir', MIN, '--format', 'json']);
  assert.equal(out.code, 0);
  const env = JSON.parse(out.stdout);
  assert.equal(env.command, 'audit');
  assert.ok(Array.isArray(env.result.entries));
});

test('audit default (table) format: mentions the command', async () => {
  const out = await run(['audit', '--config-dir', MIN]);
  assert.equal(out.code, 0);
  assert.ok(out.stdout.includes('audit'), 'table title names the command');
});

// ── drift ─────────────────────────────────────────────────────────────────────────

test('drift --format json: no-baseline on minimal (no lockfile)', async () => {
  const out = await run(['drift', '--config-dir', MIN, '--format', 'json']);
  assert.equal(out.code, 0);
  const env = JSON.parse(out.stdout);
  assert.equal(env.command, 'drift');
  assert.ok(
    ['no-baseline', 'clean', 'drifted'].includes(env.result.status),
    `result.status must be a valid DriftStatus, got: ${env.result.status}`,
  );
});

test('drift default (table) format: mentions the command', async () => {
  const out = await run(['drift', '--config-dir', MIN]);
  assert.equal(out.code, 0);
  assert.ok(out.stdout.includes('drift'), 'table title names the command');
});

test('drift --update against fixture degrades gracefully (no throw, write rejected)', async () => {
  // assertWritable rejects writes outside the real targetClaudeDir; --update against
  // a fixture emits a warn diagnostic but must NOT throw and must return a status.
  await assert.doesNotReject(async () => {
    const out = await run(['drift', '--update', '--config-dir', MIN, '--format', 'json']);
    assert.equal(typeof out.code, 'number');
    const env = JSON.parse(out.stdout);
    assert.ok(
      ['no-baseline', 'clean', 'drifted', 'unavailable'].includes(env.result.status),
      `result.status must be a valid status, got: ${env.result.status}`,
    );
  });
});

// ── ndjson format ────────────────────────────────────────────────────────────────

test('inventory --format ndjson: every line is valid JSON, line 0 is the result', async () => {
  const out = await run(['inventory', '--config-dir', MIN, '--format', 'ndjson']);
  assert.equal(out.code, 0);
  const lines = out.stdout.split('\n');
  assert.ok(lines.length >= 1, 'at least one line');
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line), `line must be valid JSON: ${line}`);
  }
  const first = JSON.parse(lines[0]);
  assert.equal(first.type, 'result');
  assert.equal(first.command, 'inventory');
  assert.equal(first.version, 1);
  assert.ok(first.result && typeof first.result.counts === 'object', 'result.counts present');
});

test('conflicts --format ndjson: has a type:diagnostic line with code + severity', async () => {
  const out = await run(['conflicts', '--config-dir', MIN, '--format', 'ndjson']);
  assert.equal(out.code, 0);
  const lines = out.stdout.split('\n').map((l) => JSON.parse(l));
  const diagLines = lines.filter((l) => l.type === 'diagnostic');
  assert.ok(diagLines.length >= 1, 'expected at least one diagnostic line');
  for (const d of diagLines) {
    assert.ok(typeof d.code === 'string', 'diagnostic has code');
    assert.ok(typeof d.severity === 'string', 'diagnostic has severity');
  }
});

test('config show-effective --format ndjson on broken fixture: exit 1, error diagnostic streamed', async () => {
  const out = await run(['config', 'show-effective', '--config-dir', fix('broken'), '--format', 'ndjson']);
  assert.equal(out.code, 1);
  const lines = out.stdout.split('\n').map((l) => JSON.parse(l));
  const errLines = lines.filter((l) => l.type === 'diagnostic' && l.severity === 'error');
  assert.ok(errLines.length >= 1, 'expected at least one error-severity diagnostic line');
});

test('inventory --format ndjson on minimal: exactly one line (zero diagnostics)', async () => {
  // Verify inventory on minimal truly has 0 diagnostics first via json format.
  const jsonOut = await run(['inventory', '--config-dir', MIN, '--format', 'json']);
  const env = JSON.parse(jsonOut.stdout);
  assert.equal(env.diagnostics.length, 0, 'prerequisite: inventory/minimal has 0 diagnostics');
  // Now verify ndjson is exactly one line.
  const out = await run(['inventory', '--config-dir', MIN, '--format', 'ndjson']);
  const lines = out.stdout.split('\n');
  assert.equal(lines.length, 1, 'zero diagnostics → exactly one ndjson line');
  assert.equal(JSON.parse(lines[0]).type, 'result');
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

// ── snapshot list / gc routing (the two-word canonicalize) ────────────────────────

test('canonicalize: `snapshot list` → snapshot:list (empty list on minimal, exit 0)', async () => {
  const out = await run(['snapshot', 'list', '--config-dir', MIN, '--format', 'json']);
  assert.equal(out.code, 0);
  const env = JSON.parse(out.stdout);
  assert.equal(env.command, 'snapshot:list'); // two-word collapsed to the canonical key
  assert.deepEqual(env.result.snapshots, []); // no .mgr-state/snapshots under the fixture
  assert.equal(env.result.count, 0);
});

test('canonicalize: `snapshot gc` with no criterion → snapshot:gc, gc-no-criterion warn, deletes nothing', async () => {
  const out = await run(['snapshot', 'gc', '--config-dir', MIN, '--format', 'json']);
  assert.equal(out.code, 0); // a warn is not an error
  const env = JSON.parse(out.stdout);
  assert.equal(env.command, 'snapshot:gc');
  assert.equal(env.result.mode, 'dry-run'); // no --apply
  assert.deepEqual(env.result.deleted, []);
  assert.deepEqual(env.result.wouldDelete, []);
  assert.ok(env.diagnostics.some((d) => d.code === 'gc-no-criterion' && d.severity === 'warn'));
});

test('canonicalize: bare `snapshot` stays the create command (dry-run preview), NOT snapshot:list/gc', async () => {
  const out = await run(['snapshot', '--config-dir', MIN, '--format', 'json']);
  assert.equal(out.code, 0);
  const env = JSON.parse(out.stdout);
  assert.equal(env.command, 'snapshot'); // bare → the create command, not a sub-verb
  assert.equal(env.result.mode, 'dry-run');
});

test('snapshot gc: --keep flag is parsed as a value flag and reaches the handler', async () => {
  // --keep 2 is a value flag; with no snapshots present nothing is pruned, but the
  // criterion is accepted (no gc-no-criterion warn) → exit 0, dry-run, empty lists.
  const out = await run(['snapshot', 'gc', '--keep', '2', '--config-dir', MIN, '--format', 'json']);
  assert.equal(out.code, 0);
  const env = JSON.parse(out.stdout);
  assert.equal(env.command, 'snapshot:gc');
  assert.ok(!env.diagnostics.some((d) => d.code === 'gc-no-criterion'), 'a valid --keep is a criterion');
  assert.deepEqual(env.result.wouldDelete, []);
});

test('snapshot gc: a bad --keep value emits gc-keep-invalid warn (and falls back to no-criterion)', async () => {
  const out = await run(['snapshot', 'gc', '--keep', 'abc', '--config-dir', MIN, '--format', 'json']);
  assert.equal(out.code, 0);
  const env = JSON.parse(out.stdout);
  assert.ok(env.diagnostics.some((d) => d.code === 'gc-keep-invalid' && d.severity === 'warn'));
  // With the only criterion invalid, gc refuses to delete (no-criterion path).
  assert.ok(env.diagnostics.some((d) => d.code === 'gc-no-criterion'));
});

test('snapshot list: default table format renders the snapshot:list header', async () => {
  const out = await run(['snapshot', 'list', '--config-dir', MIN]);
  assert.equal(out.code, 0);
  assert.ok(typeof out.stdout === 'string' && out.stdout.includes('snapshot:list'));
});
