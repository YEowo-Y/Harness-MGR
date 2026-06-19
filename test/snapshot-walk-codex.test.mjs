/**
 * Codex snapshot-scope re-proof (P6 write wave · unit 2).
 *
 * Builds a real temp `~/.codex`-shaped tree containing BOTH the governed config +
 * components AND the secret/privacy/runtime files that must NEVER be captured, then
 * proves walkSnapshotScope with codexDescriptor.snapshotScope captures EXACTLY the
 * governed surface and nothing else. Plus a Claude byte-identity drift-guard and the
 * capture↔rollback parity invariant. See docs/phase-6-codex-snapshot-design.md §3-4.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { walkSnapshotScope, CLAUDE_SNAPSHOT_SCOPE } from '../src/ops/snapshot-walk.mjs';
import { codexDescriptor } from '../src/targets/codex.mjs';

/** Write a file, creating parent dirs. */
function put(root, rel, content = 'x') {
  const abs = join(root, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

/** Build a realistic codex tree with governed files + secrets/privacy/runtime noise. */
function buildCodexTree() {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-codex-snap-'));
  // GOVERNED — must be captured.
  put(dir, 'config.toml', 'model = "gpt-5.5"\n');
  put(dir, 'AGENTS.md', '# agents\n');
  put(dir, 'hooks.json', '{"hooks":{}}');
  put(dir, 'skills/myskill/SKILL.md', '# skill\n');
  put(dir, 'prompts/greet.md', '# greet\n');
  put(dir, 'agents/architect.toml', 'name = "architect"\n');
  // SECRETS / PRIVACY / RUNTIME — must NEVER be captured.
  put(dir, 'auth.json', '{"token":"sk-SECRET"}');
  put(dir, '.credentials.json', '{"k":"SECRET"}');
  put(dir, 'history.jsonl', '{"cmd":"secret"}\n');
  put(dir, 'sessions/s1.jsonl', 'conversation\n');
  put(dir, 'archived_sessions/a1.jsonl', 'old conversation\n');
  put(dir, 'sqlite/goals.sqlite', 'BINARYDB');
  put(dir, 'cache/c.bin', 'cache');
  put(dir, 'log/l.txt', 'logs');
  put(dir, 'plugins/cache/mp/p/skills/x/SKILL.md', '# plugin skill\n');
  put(dir, '.mgr-state/snapshots/old/files.tar', 'archive'); // self-exclusion
  return dir;
}

const EXPECTED_CODEX_CAPTURE = [
  'AGENTS.md',
  'agents/architect.toml',
  'config.toml',
  'hooks.json',
  'prompts/greet.md',
  'skills/myskill/SKILL.md',
].sort();

test('codex snapshot scope captures EXACTLY the governed surface', () => {
  const dir = buildCodexTree();
  try {
    const { files, diagnostics } = walkSnapshotScope({ targetClaudeDir: dir, scope: codexDescriptor.snapshotScope });
    assert.deepEqual(files, EXPECTED_CODEX_CAPTURE, 'captures config.toml/AGENTS.md/hooks.json + skills/prompts/agents only');
    assert.equal(diagnostics.length, 0, 'clean walk');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex snapshot scope NEVER captures secrets / privacy / runtime / .mgr-state', () => {
  const dir = buildCodexTree();
  try {
    const { files } = walkSnapshotScope({ targetClaudeDir: dir, scope: codexDescriptor.snapshotScope });
    const joined = files.join('\n');
    for (const forbidden of [
      'auth.json', '.credentials.json', 'history.jsonl',
      'sessions/', 'archived_sessions/', 'sqlite/', 'cache/', 'log/', 'plugins/', '.mgr-state/',
    ]) {
      assert.ok(!joined.includes(forbidden), `must NOT capture ${forbidden}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude byte-identity drift-guard: no-scope walk === CLAUDE_SNAPSHOT_SCOPE walk', () => {
  // A Claude-shaped tree; the default (no scope) and the explicit Claude scope must agree.
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-claude-snap-'));
  try {
    put(dir, 'CLAUDE.md', '# claude\n');
    put(dir, 'settings.json', '{}');
    put(dir, 'agents/foo.md', '# a\n');
    put(dir, 'skills/s/SKILL.md', '# s\n');
    put(dir, 'commands/c.md', '# c\n');
    put(dir, 'plugins/installed_plugins.json', '{}');
    put(dir, 'plugins/cache/should-not-capture.json', '{}');
    put(dir, 'sessions/s.jsonl', 'x');
    const a = walkSnapshotScope({ targetClaudeDir: dir });
    const b = walkSnapshotScope({ targetClaudeDir: dir, scope: CLAUDE_SNAPSHOT_SCOPE });
    assert.deepEqual(a.files, b.files, 'default scope must equal CLAUDE_SNAPSHOT_SCOPE');
    // sanity: it DID capture the claude surface and excluded plugins/cache + sessions.
    assert.ok(a.files.includes('CLAUDE.md') && a.files.includes('plugins/installed_plugins.json'));
    assert.ok(!a.files.some((f) => f.startsWith('plugins/cache/') || f.startsWith('sessions/')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture↔rollback parity: codex walkDirs ∪ topFiles == writeSurface.rollbackPaths', () => {
  // The load-bearing invariant: rollback can only restore what snapshot captured, and the
  // gate only lets rollback WRITE its rollbackPaths — so the two sets MUST match exactly.
  const scope = codexDescriptor.snapshotScope;
  const captured = [...scope.walkDirs, ...scope.topFiles].sort();
  const rollbackable = [...codexDescriptor.writeSurface.rollbackPaths].sort();
  assert.deepEqual(captured, rollbackable,
    'codex snapshot capture set must equal the gate rollback-writable set');
});
