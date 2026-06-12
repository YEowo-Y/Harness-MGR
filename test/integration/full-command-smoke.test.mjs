/**
 * P4b.U11 — full-command smoke (the "exercise EVERY command" half of U11).
 *
 * Builds a minimal-but-realistic sandbox `~/.claude` ONCE, then runs EVERY
 * registered `COMMANDS` key against it in DRY-RUN / READ mode (no --apply, no
 * CLAUDE_MGR_ENABLE_WRITES) and asserts none of them produce an UNEXPECTED
 * internal crash.
 *
 * `run(argv)` from src/cli.mjs never throws — an unexpected internal throw is
 * caught at the boundary and rendered as a JSON envelope
 * `{ error: 'internal', message: ..., version: 1 }` with code 2. So the core
 * per-command assertion is: the `--format json` stdout PARSES and is NOT that
 * `error:'internal'` envelope. Legitimate usage/refusal codes (0/1/2/3) are all
 * FINE — we only forbid the internal-throw signature (a real command crash).
 *
 * Three oracles:
 *   1. DRIFT-GUARD (headline) — the SET of table keys deepEquals
 *      `Object.keys(COMMANDS)`, so a future command can't be added without a smoke
 *      entry (machine-enforced "exercises EVERY command").
 *   2. PER-COMMAND no-internal-crash — for each entry assert a sane exit code, a
 *      parseable JSON envelope, and `j.error !== 'internal'`. Failures are collected
 *      and reported together so a broken command is named precisely.
 *   3. WRITES-NOTHING — a recursive (path+size) listing of the sandbox is EQUAL
 *      before and after the whole run (dry-run/read wrote nothing to governed files).
 *
 * NO src changes; this is a pure integration test. Dry-run safety: never passes
 * --apply and never sets CLAUDE_MGR_ENABLE_WRITES, so the write commands stay
 * dry-run and the sandbox governed files are never mutated.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync, rmSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../src/cli.mjs';
import { COMMANDS } from '../../src/cli/commands.mjs';

/** Build a minimal-but-realistic sandbox ~/.claude tree. Returns its absolute path. */
function buildSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-smoke-'));
  writeFileSync(join(dir, 'settings.json'), '{}\n');
  writeFileSync(join(dir, 'CLAUDE.md'), '# sandbox CLAUDE\n');
  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(join(dir, 'agents', 'a.md'), '---\nname: a\n---\n# a\n');
  mkdirSync(join(dir, 'commands'), { recursive: true });
  writeFileSync(join(dir, 'commands', 'c.md'), '---\nname: c\n---\n# c\n');
  mkdirSync(join(dir, 'skills', 's'), { recursive: true });
  writeFileSync(join(dir, 'skills', 's', 'SKILL.md'), '---\nname: s\n---\n# s\n');
  mkdirSync(join(dir, '.mgr-state'), { recursive: true });
  // Two tiny files for `config diff`.
  writeFileSync(join(dir, 'diffA.txt'), 'x\ny\n');
  writeFileSync(join(dir, 'diffB.txt'), 'x\nz\n');
  return dir;
}

/** Recursive (relative-path → size) snapshot of every file under dir. */
function listTree(dir) {
  /** @type {Record<string, number>} */
  const out = Object.create(null);
  const walk = (d, prefix) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, ent.name);
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(abs, rel);
      else out[rel] = statSync(abs).size;
    }
  };
  walk(dir, '');
  return out;
}

/**
 * The per-command argv TABLE (WITHOUT the trailing `--format json --config-dir
 * <sandbox>`, which the harness appends). One entry per canonical COMMANDS key.
 * Every invocation is dry-run / read-only and minimal-valid. The function form
 * lets the `config:diff` entry reference the two sandbox file paths.
 */
function buildArgvTable(sandbox) {
  const diffA = join(sandbox, 'diffA.txt');
  const diffB = join(sandbox, 'diffB.txt');
  // A snapshot id that does NOT exist in the sandbox — the write commands take a
  // dry-run / refusal path on it (target-not-found / preflight), never a crash.
  const fakeId = '2026-01-01T00-00-00Z';
  return {
    'inventory': ['inventory'],
    'conflicts': ['conflicts'],
    'orphans': ['orphans'],
    'config:show-effective': ['config', 'show-effective'],
    'config:diff': ['config', 'diff', diffA, diffB],
    'hooks': ['hooks'],
    'permissions': ['permissions', '--audit'],
    'selftest': ['selftest', '--lint'],
    'doctor': ['doctor'],
    'health': ['health'], // read-only, passive always (P5.U5)
    'audit': ['audit'],
    'drift': ['drift'], // dry-run (no --update)
    'snapshot': ['snapshot'], // dry-run preview (no --apply)
    'snapshot:list': ['snapshot', 'list'],
    'snapshot:gc': ['snapshot', 'gc', '--keep', '1'], // dry-run (no --apply)
    'snapshot:pin': ['snapshot', 'pin', fakeId], // dry-run
    'snapshot:unpin': ['snapshot', 'unpin', fakeId], // dry-run
    'rollback': ['rollback', fakeId], // dry-run preflight
    'recover': ['recover', fakeId, '--mark-failed'], // no --apply → gate-closed refusal (clean)
    'lock': ['lock'], // read-only status
    'remove': ['remove', 'agent:nonexistent-xyz'], // dry-run → target-not-found refusal
    'update': ['update', 'nonexistent-xyz'], // dry-run → plugin-not-found refusal
    'mcp:remove': ['mcp', 'remove', 'nonexistent-xyz'], // dry-run → advisory
    'skill:propose': ['skill', 'propose'], // no name → clean exit 3 (not an internal crash)
    'skill:accept': ['skill', 'accept'], // no name → clean exit 3 (not an internal crash)
    'completion': ['completion', 'bash'],
  };
}

test('P4b.U11 smoke — table covers EVERY COMMANDS key (drift-guard)', () => {
  // A throwaway sandbox just to materialise the table (config:diff needs paths).
  const sandbox = buildSandbox();
  try {
    const table = buildArgvTable(sandbox);
    const tableKeys = Object.keys(table).sort();
    const commandKeys = Object.keys(COMMANDS).sort();
    const missing = commandKeys.filter((k) => !tableKeys.includes(k));
    const extra = tableKeys.filter((k) => !commandKeys.includes(k));
    assert.deepEqual(
      tableKeys,
      commandKeys,
      `smoke table must exercise EVERY COMMANDS key.`
        + (missing.length ? ` MISSING from table: ${missing.join(', ')}.` : '')
        + (extra.length ? ` EXTRA in table (not a real command): ${extra.join(', ')}.` : ''),
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('P4b.U11 smoke — every command runs against a sandbox with no internal crash', async () => {
  const sandbox = buildSandbox();
  const table = buildArgvTable(sandbox);

  // Some commands read CLAUDE_CONFIG_DIR; point it at the sandbox. ENSURE the write
  // env factor is unset so nothing can ever write. Save/restore BOTH in finally.
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const savedEnableWrites = process.env.CLAUDE_MGR_ENABLE_WRITES;
  process.env.CLAUDE_CONFIG_DIR = sandbox;
  delete process.env.CLAUDE_MGR_ENABLE_WRITES;

  /** @type {string[]} */
  const failures = [];

  try {
    for (const [name, argv] of Object.entries(table)) {
      const full = [...argv, '--format', 'json', '--config-dir', sandbox];
      const { code, stdout } = await run(full);

      if (typeof code !== 'number' || code < 0 || code > 3) {
        failures.push(`${name}: out-of-range exit code ${String(code)}`);
        continue;
      }

      let j;
      try {
        j = JSON.parse(stdout);
      } catch (err) {
        failures.push(`${name}: stdout did not parse as JSON (${err instanceof Error ? err.message : String(err)})\n--- stdout ---\n${stdout}`);
        continue;
      }

      if (j && j.error === 'internal') {
        // The boundary-catch signature of an UNEXPECTED throw — the real regression.
        failures.push(`${name}: INTERNAL CRASH — message: ${String(j.message)}\n--- full stdout ---\n${stdout}`);
      }
    }

    assert.deepEqual(failures, [], `smoke failures:\n${failures.join('\n\n')}`);
  } finally {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    if (savedEnableWrites === undefined) delete process.env.CLAUDE_MGR_ENABLE_WRITES;
    else process.env.CLAUDE_MGR_ENABLE_WRITES = savedEnableWrites;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('P4b.U11 smoke — the full dry-run/read pass writes nothing to the sandbox', async () => {
  const sandbox = buildSandbox();
  const table = buildArgvTable(sandbox);

  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const savedEnableWrites = process.env.CLAUDE_MGR_ENABLE_WRITES;
  process.env.CLAUDE_CONFIG_DIR = sandbox;
  delete process.env.CLAUDE_MGR_ENABLE_WRITES;

  try {
    const before = listTree(sandbox);
    for (const argv of Object.values(table)) {
      await run([...argv, '--format', 'json', '--config-dir', sandbox]);
    }
    const after = listTree(sandbox);
    // Whole-tree equality: the dry-run/read smoke wrote nothing at all (not even
    // under .mgr-state). If this ever needs to exclude .mgr-state, document why —
    // but empirically nothing is written in dry-run.
    assert.deepEqual(after, before, 'the dry-run/read smoke must not write any file under the sandbox');
    assert.ok(existsSync(join(sandbox, 'settings.json')), 'sandbox settings.json must still exist');
  } finally {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    if (savedEnableWrites === undefined) delete process.env.CLAUDE_MGR_ENABLE_WRITES;
    else process.env.CLAUDE_MGR_ENABLE_WRITES = savedEnableWrites;
    rmSync(sandbox, { recursive: true, force: true });
  }
});
