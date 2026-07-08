/**
 * Codex snapshot wiring (P6 write wave · unit 2): the resolveAssertWritable gate-picker
 * and the codex scope flowing through createSnapshot end-to-end (dry-run).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { resolveAssertWritable } from '../src/cli/write-gate.mjs';
import { assertWritable, makeAssertWritable, WriteForbiddenError, MGR_STATE_DIRNAME } from '../src/paths.mjs';
import { createSnapshot } from '../src/ops/snapshot.mjs';
import { codexDescriptor } from '../src/targets/codex.mjs';
import { claudeDescriptor } from '../src/targets/claude.mjs';

const PATHS = { assertWritable, makeAssertWritable };

test('resolveAssertWritable: a Claude ctx (no writeSurface) returns the bare paths.assertWritable', () => {
  const gate = resolveAssertWritable(PATHS, { descriptor: claudeDescriptor, configDir: '/x', mgrStateDir: '/x/.mgr-state' });
  assert.equal(gate, assertWritable, 'claude keeps the default call-time-resolving gate (byte-identical)');
});

test('resolveAssertWritable: a Codex ctx returns a gate bound to the codex dirs + surface', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cmgr-raw-codex-')));
  const stateDir = join(dir, MGR_STATE_DIRNAME);
  try {
    const gate = resolveAssertWritable(PATHS, { descriptor: codexDescriptor, configDir: dir, mgrStateDir: stateDir });
    assert.notEqual(gate, assertWritable, 'codex gets a bound gate, not the default');
    // It allows the codex .mgr-state write (what a snapshot does)...
    assert.ok(gate(join(stateDir, 'snapshots', 'x', 'files.tar'), 'apply'));
    // ...and still enforces the codex surface (auth.json forbidden in every context).
    assert.throws(() => gate(join(dir, 'auth.json'), 'rollback'),
      (e) => e instanceof WriteForbiddenError && e.code === 'write-forbidden');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveAssertWritable: never throws on a degenerate ctx (falls back to default gate)', () => {
  assert.equal(resolveAssertWritable(PATHS, undefined), assertWritable);
  assert.equal(resolveAssertWritable(PATHS, { descriptor: {} }), assertWritable);
});

test('createSnapshot dry-run with codex scope keeps the governed surface, drops nothing governed, sees no secrets', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cmgr-codex-create-')));
  try {
    const put = (rel, c = 'x') => {
      const abs = join(dir, ...rel.split('/'));
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, c);
    };
    put('config.toml', 'model = "gpt-5.5"\n');
    put('AGENTS.md', '# a\n');
    put('hooks.json', '{"hooks":{}}');
    put('skills/s/SKILL.md', '# s\n');
    put('prompts/g.md', '# g\n');
    put('agents/architect.toml', 'name="architect"\n');
    put('auth.json', '{"token":"sk-SECRET"}'); // must never appear in kept
    put('sessions/s1.jsonl', 'convo\n');

    const r = await createSnapshot({
      targetClaudeDir: dir, mgrStateDir: join(dir, MGR_STATE_DIRNAME),
      dryRun: true, scope: codexDescriptor.snapshotScope,
    });

    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    const kept = r.kept.slice().sort();
    assert.deepEqual(kept, [
      'AGENTS.md', 'agents/architect.toml', 'config.toml', 'hooks.json', 'prompts/g.md', 'skills/s/SKILL.md',
    ].sort());
    assert.ok(!r.kept.some((f) => f.includes('auth.json') || f.startsWith('sessions/')),
      'no secret/privacy file in the kept set');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reversibility: a secret-shaped config.toml is DROPPED standalone but KEPT under keepAll (so rollback can restore it)', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cmgr-codex-rev-')));
  try {
    const put = (rel, c) => {
      const abs = join(dir, ...rel.split('/'));
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, c);
    };
    // config.toml carrying a PEM private key (the content sniffer's deterministic leg).
    put('config.toml', 'key = """\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw\n-----END PRIVATE KEY-----\n"""\n');
    put('AGENTS.md', '# a\n');
    const base = { targetClaudeDir: dir, mgrStateDir: join(dir, MGR_STATE_DIRNAME), dryRun: true, scope: codexDescriptor.snapshotScope };

    // Standalone (keepAll false): config.toml is dropped by the content sniff — visible.
    const standalone = await createSnapshot(base);
    assert.ok(!standalone.kept.includes('config.toml'), 'standalone snapshot drops the secret-shaped config.toml');
    assert.ok(standalone.dropped.some((d) => d.path === 'config.toml' && d.by === 'content'), 'and reports it as a content drop');

    // Reversibility (keepAll via skipSecretFilter): config.toml is kept WHOLE so a
    // pre-mutation snapshot is restorable — this is the path apply.mjs uses for remove.
    const reversible = await createSnapshot({ ...base, skipSecretFilter: true });
    assert.ok(reversible.kept.includes('config.toml'), 'keepAll captures config.toml whole for rollback completeness');
    assert.equal(reversible.dropped.length, 0, 'keepAll drops nothing governed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
