/**
 * Integration — drift-config-dir-roundtrip.test.mjs
 *
 * Pins that `driftCommand` binds the lockfile WRITE GATE to the ACTIVE target via
 * `resolveAssertWritable(paths, ctx)` (the --config-dir fix). UNLIKE
 * drift-roundtrip.test.mjs — which stubs the gate with `(p) => p` to test the
 * analysis round-trip — this exercises the REAL gate resolved from ctx:
 *
 *   - Codex: a descriptor WITH a writeSurface → a gate bound to ctx.configDir, so
 *     the baseline lockfile is written into the sandbox's .mgr-state. Pre-fix this
 *     was REFUSED as `write-outside-target` because driftCommand used the bare
 *     ~/.claude gate (the home-bound default), ignoring --config-dir.
 *   - Claude: NO writeSurface → the bare ~/.claude gate (byte-identical to before),
 *     so a sandbox lockfile write is REFUSED. Claude writes are home-bound BY DESIGN
 *     (same as snapshot/remove/config-edit; their sandbox tests inject the gate
 *     directly rather than via --config-dir). This is the no-regression guard, and
 *     it proves nothing escapes to the real ~/.claude.
 *
 * Graceful-skip when paths.mjs (the write gate) can't load in this env — driftCommand
 * then returns status 'unavailable' (the M2 ~/.claude/hooks/lib load constraint).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { driftCommand } from '../../src/cli/ops-commands.mjs';
import { codexDescriptor } from '../../src/targets/codex.mjs';
import { claudeDescriptor } from '../../src/targets/claude.mjs';

// Hardcoded like drift-roundtrip.test.mjs (avoids a top-level paths.mjs import that
// would defeat the graceful-skip); a separate drift-guard test reconciles the literal.
const STATE = '.mgr-state';

/** A realistic temp config dir with a .mgr-state + a tracked skill + a signature file. */
function makeTree(signatureFile, signatureBytes) {
  const tmp = mkdtempSync(join(tmpdir(), 'mgr-drift-cfgdir-'));
  mkdirSync(join(tmp, STATE), { recursive: true });
  mkdirSync(join(tmp, 'skills', 'x'), { recursive: true });
  writeFileSync(join(tmp, 'skills', 'x', 'SKILL.md'), '# s\n');
  writeFileSync(join(tmp, signatureFile), signatureBytes);
  return tmp;
}

test('codex drift --update binds the gate to --config-dir → writes the baseline into the sandbox, then reads clean', async (t) => {
  const tmp = makeTree('config.toml', 'model = "gpt-5.5"\n');
  try {
    const out = await driftCommand({
      descriptor: codexDescriptor, configDir: tmp, mgrStateDir: join(tmp, STATE), args: { update: true },
    });
    if (out.result.status === 'unavailable') { t.skip('write gate (paths.mjs) unavailable in this env'); return; }

    assert.ok(existsSync(join(tmp, STATE, 'lockfile.json')),
      'codex: the baseline lockfile must be written into the sandbox .mgr-state');
    assert.ok(out.diagnostics.some((d) => d.code === 'drift-baseline-updated'),
      'codex: a drift-baseline-updated diagnostic is emitted');
    assert.ok(!out.diagnostics.some((d) => d.code === 'lockfile-write-failed'),
      'codex: there is no write refusal');

    // A follow-up read sees the current state matching the just-written baseline.
    const read = await driftCommand({
      descriptor: codexDescriptor, configDir: tmp, mgrStateDir: join(tmp, STATE), args: {},
    });
    assert.equal(read.result.status, 'clean', 'codex: a follow-up read sees no drift');
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('claude drift --update stays home-bound: a --config-dir sandbox write is refused (no regression, nothing escapes to ~/.claude)', async (t) => {
  const tmp = makeTree('settings.json', '{"model":"sonnet"}');
  try {
    const out = await driftCommand({
      descriptor: claudeDescriptor, configDir: tmp, mgrStateDir: join(tmp, STATE), args: { update: true },
    });
    if (out.result.status === 'unavailable') { t.skip('write gate (paths.mjs) unavailable in this env'); return; }

    // Claude has no writeSurface → resolveAssertWritable returns the bare ~/.claude
    // gate, which refuses a sandbox lockfile path. The write is REFUSED (not
    // redirected): Claude's behavior is byte-identical to before AND nothing is
    // written to the sandbox (nor, since the path is refused, to the real ~/.claude).
    assert.ok(!existsSync(join(tmp, STATE, 'lockfile.json')),
      'claude: no lockfile is written into the sandbox (home-bound by design)');
    assert.ok(out.diagnostics.some((d) => d.code === 'lockfile-write-failed'),
      'claude: the bare home gate refuses the sandbox lockfile path');
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
