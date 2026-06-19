/**
 * Codex write-gate oracle (P6 write wave · unit 1).
 *
 * The falsifiable matrix for the Codex governed-write surface: builds a gate via
 * makeAssertWritable({configDir, mgrStateDir, surface: codexDescriptor.writeSurface})
 * against a REAL temp dir (so realpathSync resolves) and asserts the allow/deny +
 * error code for every threat-model case in docs/phase-6-codex-write-gate-design.md §4.
 *
 * The gate's security LOGIC is shared with Claude (proven byte-identical by
 * test/paths.test.mjs + the boundary-cases matrix); this file proves the DATA
 * (codexDescriptor.writeSurface) yields the intended least-authority surface.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { makeAssertWritable, CLAUDE_WRITE_SURFACE, WriteForbiddenError, assertWritable, MGR_STATE_DIRNAME } from '../src/paths.mjs';
import { codexDescriptor } from '../src/targets/codex.mjs';

/** Build a codex-bound gate over a fresh temp `~/.codex`-shaped dir. */
function withCodexGate(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-codex-gate-'));
  const stateDir = join(dir, MGR_STATE_DIRNAME);
  const gate = makeAssertWritable({ configDir: dir, mgrStateDir: stateDir, surface: codexDescriptor.writeSurface });
  try {
    fn({ dir, stateDir, gate });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Assert `gate(target, ctx)` throws a WriteForbiddenError with `code`. */
function denies(gate, target, ctx, code) {
  assert.throws(
    () => gate(target, ctx),
    (e) => e instanceof WriteForbiddenError && e.code === code,
    `expected ${code} for ${ctx} ${target}`,
  );
}

// ─── POSITIVE surface: what codex writes legitimately ───────────────────────

test('codex gate ALLOWS the mgr state dir in every context', () => {
  withCodexGate(({ stateDir, gate }) => {
    for (const ctx of ['apply', 'rollback', 'remove', 'remove-skill']) {
      assert.ok(gate(join(stateDir, 'snapshots', 'x', 'manifest.json'), ctx));
    }
  });
});

test('codex gate ALLOWS rollback of governed config files + component dirs (whole-file restore)', () => {
  withCodexGate(({ dir, gate }) => {
    for (const rel of ['config.toml', 'AGENTS.md', 'hooks.json']) {
      assert.ok(gate(join(dir, rel), 'rollback'), `${rel} rollback`);
    }
    assert.ok(gate(join(dir, 'skills', 'foo', 'SKILL.md'), 'rollback'));
    assert.ok(gate(join(dir, 'prompts', 'greet.md'), 'rollback'));
    assert.ok(gate(join(dir, 'agents', 'architect.toml'), 'rollback'));
  });
});

test('codex gate ALLOWS remove of a prompts/*.md command and an agents/*.toml agent', () => {
  withCodexGate(({ dir, gate }) => {
    assert.ok(gate(join(dir, 'prompts', 'greet.md'), 'remove'));
    assert.ok(gate(join(dir, 'agents', 'architect.toml'), 'remove'));
  });
});

test('codex gate ALLOWS remove-skill of a direct-child skill dir', () => {
  withCodexGate(({ dir, gate }) => {
    assert.ok(gate(join(dir, 'skills', 'myskill'), 'remove-skill'));
  });
});

// ─── THREAT MODEL: secrets / privacy / caches are ALWAYS forbidden ───────────

test('codex gate DENIES the secret files even in rollback (write-forbidden)', () => {
  withCodexGate(({ dir, gate }) => {
    for (const secret of ['auth.json', '.credentials.json']) {
      denies(gate, join(dir, secret), 'rollback', 'write-forbidden');
      denies(gate, join(dir, secret), 'apply', 'write-forbidden');
    }
  });
});

test('codex gate DENIES conversation history/sessions in any context (write-forbidden)', () => {
  withCodexGate(({ dir, gate }) => {
    denies(gate, join(dir, 'sessions', 's1.jsonl'), 'rollback', 'write-forbidden');
    denies(gate, join(dir, 'archived_sessions', 'a1'), 'rollback', 'write-forbidden');
    denies(gate, join(dir, 'history.jsonl'), 'apply', 'write-forbidden');
  });
});

test('codex gate DENIES plugin cache + marketplaces (write-forbidden)', () => {
  withCodexGate(({ dir, gate }) => {
    denies(gate, join(dir, 'plugins', 'cache', 'm', 'p', 'skills', 'x', 'SKILL.md'), 'rollback', 'write-forbidden');
    denies(gate, join(dir, 'plugins', 'marketplaces', 'm', 'x'), 'remove', 'write-forbidden');
  });
});

// ─── THREAT MODEL: config.toml is read-only for apply, restorable by rollback ──

test('codex gate: config.toml apply -> write-rollback-only (no in-place edit); rollback -> ALLOW', () => {
  withCodexGate(({ dir, gate }) => {
    denies(gate, join(dir, 'config.toml'), 'apply', 'write-rollback-only');
    assert.ok(gate(join(dir, 'config.toml'), 'rollback'));
  });
});

test('codex gate: there are NO apply-writable files (settings.json/.mcp.json are not codex surfaces)', () => {
  withCodexGate(({ dir, gate }) => {
    denies(gate, join(dir, 'settings.json'), 'apply', 'write-not-allowed');
    denies(gate, join(dir, '.mcp.json'), 'apply', 'write-not-allowed');
  });
});

// ─── THREAT MODEL: escape / traversal ────────────────────────────────────────

test('codex gate DENIES paths outside the config dir (write-outside-target)', () => {
  withCodexGate(({ gate }) => {
    denies(gate, join(tmpdir(), 'elsewhere', 'x.md'), 'rollback', 'write-outside-target');
  });
});

test('codex gate DENIES a junction inside the config dir that escapes the allowlist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-codex-esc-'));
  const outside = mkdtempSync(join(tmpdir(), 'cmgr-codex-victim-'));
  const stateDir = join(dir, MGR_STATE_DIRNAME);
  const gate = makeAssertWritable({ configDir: dir, mgrStateDir: stateDir, surface: codexDescriptor.writeSurface });
  try {
    const skills = join(dir, 'skills');
    mkdirSync(skills, { recursive: true });
    const link = join(skills, 'escape');
    let made = false;
    try { symlinkSync(outside, link, 'junction'); made = true; } catch { /* no priv — skip */ }
    if (made) {
      denies(gate, join(link, 'SKILL.md'), 'rollback', 'write-outside-target');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('codex gate: skills/../auth.json traversal in remove-skill -> refused (not write-forbidden allow)', () => {
  withCodexGate(({ dir, gate }) => {
    // canonical() collapses skills/../auth.json to <dir>/auth.json — which is a
    // forbidden subpath, so the forbidden denial wins.
    denies(gate, join(dir, 'skills', '..', 'auth.json'), 'remove-skill', 'write-forbidden');
  });
});

// ─── THREAT MODEL: wrong-extension / nested remove ──────────────────────────

test('codex gate: wrong-extension remove is refused (agents wants .toml, prompts wants .md)', () => {
  withCodexGate(({ dir, gate }) => {
    denies(gate, join(dir, 'agents', 'foo.md'), 'remove', 'write-remove-only');     // codex agents are .toml
    denies(gate, join(dir, 'prompts', 'foo.toml'), 'remove', 'write-remove-only');  // codex prompts are .md
    denies(gate, join(dir, 'commands', 'foo.md'), 'remove', 'write-remove-only');   // codex has no commands/ kind
  });
});

test('codex gate: nested remove / remove-skill targets are refused (direct child only)', () => {
  withCodexGate(({ dir, gate }) => {
    denies(gate, join(dir, 'prompts', 'sub', 'foo.md'), 'remove', 'write-remove-only');
    denies(gate, join(dir, 'agents', 'sub', 'foo.toml'), 'remove', 'write-remove-only');
    denies(gate, join(dir, 'skills', 'sub', 'foo'), 'remove-skill', 'write-remove-skill-only');
  });
});

test('codex gate: remove did NOT widen apply — prompts/agents in apply are rollback-only', () => {
  withCodexGate(({ dir, gate }) => {
    denies(gate, join(dir, 'prompts', 'greet.md'), 'apply', 'write-rollback-only');
    denies(gate, join(dir, 'agents', 'architect.toml'), 'apply', 'write-rollback-only');
  });
});

// ─── THREAT MODEL: Claude-only feature contexts are disabled for codex ───────

test('codex gate: probe/propose/accept feature contexts fall through to a deny (never allow)', () => {
  withCodexGate(({ dir, gate }) => {
    // probe artifact in agents/ — features.probe=false; agents/ is a rollback path → deny
    denies(gate, join(dir, 'agents', '__mgr-probe-0000.md'), 'probe', 'write-rollback-only');
    // propose/accept on a skill leaf — features off; skills/ is a rollback path → deny
    denies(gate, join(dir, 'skills', 'foo', 'SKILL.proposed-2026-01-01T00-00-00Z.md'), 'propose', 'write-rollback-only');
    denies(gate, join(dir, 'skills', 'foo', 'SKILL.md'), 'accept', 'write-rollback-only');
  });
});

test('codex gate: an unknown path under the config dir -> write-not-allowed', () => {
  withCodexGate(({ dir, gate }) => {
    denies(gate, join(dir, 'sqlite', 'goals.sqlite'), 'rollback', 'write-not-allowed');
    denies(gate, join(dir, 'rules', 'x.md'), 'apply', 'write-not-allowed');
  });
});

// ─── DRIFT GUARD: makeAssertWritable with the Claude surface === assertWritable ─

test('drift guard: makeAssertWritable(CLAUDE_WRITE_SURFACE) matches the default assertWritable', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-driftguard-'));
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    const gate = makeAssertWritable({ configDir: dir, mgrStateDir: join(dir, MGR_STATE_DIRNAME), surface: CLAUDE_WRITE_SURFACE });
    const cases = [
      [join(dir, 'CLAUDE.md'), 'apply'],
      [join(dir, 'CLAUDE.md'), 'rollback'],
      [join(dir, 'settings.json'), 'apply'],
      [join(dir, 'agents', 'foo.md'), 'remove'],
      [join(dir, 'skills', 'foo'), 'remove-skill'],
      [join(dir, 'agents', '__mgr-probe-0000.md'), 'probe'],
      [join(dir, 'plugins', 'marketplaces', 'm', 'x'), 'apply'],
      [join(dir, 'telemetry', 'blob.bin'), 'apply'],
    ];
    for (const [t, ctx] of cases) {
      let aErr = null, gErr = null, aVal = null, gVal = null;
      try { aVal = assertWritable(t, ctx); } catch (e) { aErr = e.code; }
      try { gVal = gate(t, ctx); } catch (e) { gErr = e.code; }
      assert.equal(gErr, aErr, `error parity for ${ctx} ${t}`);
      assert.equal(gVal, aVal, `value parity for ${ctx} ${t}`);
    }
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── fail-closed: a misconfigured gate factory throws loudly ─────────────────

test('makeAssertWritable fail-closed on a missing configDir/mgrStateDir', () => {
  assert.throws(() => makeAssertWritable({ configDir: '', mgrStateDir: '/x' }),
    (e) => e instanceof WriteForbiddenError && e.code === 'write-gate-misconfigured');
  assert.throws(() => makeAssertWritable({ configDir: '/x' }),
    (e) => e instanceof WriteForbiddenError && e.code === 'write-gate-misconfigured');
});

// ─── config-edit context (P6 config.toml in-place mutation · gate unit) ──────────

/** A synthetic surface that ENABLES config-edit. The codex descriptor gains this in
 *  the descriptor unit; this proves the gate BRANCH independently of that wiring. */
const CONFIG_EDIT_SURFACE = Object.freeze({
  ...CLAUDE_WRITE_SURFACE,
  configEditFiles: Object.freeze(['config.toml']),
  features: Object.freeze({ ...CLAUDE_WRITE_SURFACE.features, configEdit: true }),
});

/** Build a gate over a fresh temp dir with a given surface. */
function withGate(surface, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-ce-'));
  const gate = makeAssertWritable({ configDir: dir, mgrStateDir: join(dir, MGR_STATE_DIRNAME), surface });
  try { fn({ dir, gate }); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('drift guard: CLAUDE_WRITE_SURFACE disables config-edit (configEdit:false, empty configEditFiles)', () => {
  assert.equal(CLAUDE_WRITE_SURFACE.features.configEdit, false);
  assert.deepEqual([...CLAUDE_WRITE_SURFACE.configEditFiles], []);
});

test('Claude surface DENIES the config-edit context (feature off → falls through to deny)', () => {
  withGate(CLAUDE_WRITE_SURFACE, ({ dir, gate }) => {
    // The feature-gated branch is skipped entirely for Claude; config.toml is not a Claude
    // writable surface at all → write-not-allowed (NOT write-config-edit-only).
    denies(gate, join(dir, 'config.toml'), 'config-edit', 'write-not-allowed');
  });
});

test('config-edit ALLOWS exactly configEditFiles directly under the config dir', () => {
  withGate(CONFIG_EDIT_SURFACE, ({ dir, gate }) => {
    assert.ok(gate(join(dir, 'config.toml'), 'config-edit'));
  });
});

test('config-edit DENIES wrong basename / nested / outside; a forbidden subpath wins first', () => {
  withGate(CONFIG_EDIT_SURFACE, ({ dir, gate }) => {
    denies(gate, join(dir, 'settings.json'), 'config-edit', 'write-config-edit-only');      // wrong basename
    denies(gate, join(dir, 'sub', 'config.toml'), 'config-edit', 'write-config-edit-only'); // nested, not a direct child
    denies(gate, join(dir, '..', 'config.toml'), 'config-edit', 'write-outside-target');    // escapes the config dir
    denies(gate, join(dir, 'projects', 'config.toml'), 'config-edit', 'write-forbidden');   // forbidden-first ordering
  });
});

test('config-edit does NOT widen apply: config.toml stays NON-apply-writable on a config-edit surface', () => {
  withGate(CONFIG_EDIT_SURFACE, ({ dir, gate }) => {
    // config.toml is NOT in applyWritableFiles → a plain apply/overwrite is refused; only the
    // dedicated config-edit context may write it (least authority — the splice is the sole path).
    denies(gate, join(dir, 'config.toml'), 'apply', 'write-not-allowed');
  });
});
