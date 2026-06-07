/**
 * P4b.U7b — test/cli-config-diff.test.mjs
 *
 * Unit + integration tests for src/cli/config-diff-command.mjs and the COMMANDS /
 * cli.mjs (run(argv)) wiring. `config diff <a> <b>` is a READ-ONLY command: it reads
 * two files and prints a unified line-diff via the pure Myers engine. No write gate,
 * no paths.mjs, no snapshot.
 *
 * Most tests inject a `readFn` seam returning canned text; the --format json + smoke
 * tests use real temp files (written under os.tmpdir() and cleaned up).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configDiffCommand } from '../src/cli/config-diff-command.mjs';
import { configDiffCommand as configDiffViaCommands } from '../src/cli/commands.mjs';
import { run } from '../src/cli.mjs';

// ── helpers ──────────────────────────────────────────────────────────────────────

function makeCtx(positionals = [], extra = {}) {
  return {
    configDir: '/fake/claude',
    mgrStateDir: '/fake/claude/.mgr-state',
    args: Object.assign(Object.create(null), { positionals, ...extra }),
  };
}

/** A readFn seam mapping a path string → its canned content (or an error). */
function cannedReader(map) {
  return (path) => {
    if (Object.prototype.hasOwnProperty.call(map, path)) {
      const v = map[path];
      return typeof v === 'string' ? { text: v } : v; // {error:...} passes through
    }
    return { error: 'ENOENT: no such file' };
  };
}

// ── 1. missing args → code 2, config-diff-no-spec ────────────────────────────────

test('configDiffCommand: no positionals → code 2, config-diff-no-spec', () => {
  const out = configDiffCommand(makeCtx([]));
  assert.equal(out.code, 2);
  assert.equal(out.result.status, 'no-spec');
  assert.ok(out.diagnostics.some((d) => d.code === 'config-diff-no-spec'), 'expected config-diff-no-spec');
});

test('configDiffCommand: only one positional → code 2, config-diff-no-spec', () => {
  const out = configDiffCommand(makeCtx(['onlyone']));
  assert.equal(out.code, 2);
  assert.ok(out.diagnostics.some((d) => d.code === 'config-diff-no-spec'));
});

test('configDiffCommand: empty-string second arg → code 2, config-diff-no-spec', () => {
  const out = configDiffCommand(makeCtx(['a', '']));
  assert.equal(out.code, 2);
  assert.ok(out.diagnostics.some((d) => d.code === 'config-diff-no-spec'));
});

// ── 2. two DIFFERING files → code 0, expected ±/lines, stats, changed:true ───────

test('configDiffCommand: differing files → code 0, unified ±lines, stats, changed:true', () => {
  const deps = {
    readFn: cannedReader({ '/A': 'x\ny\nz', '/B': 'x\nY\nz' }),
    cwd: '/',
  };
  const out = configDiffCommand(makeCtx(['/A', '/B']), deps);
  assert.equal(out.code, 0, `expected code 0, got ${out.code}`);
  assert.equal(out.diagnostics.length, 0);
  assert.equal(out.result.changed, true, 'files differ → changed true');
  assert.equal(out.result.stats.added, 1, 'one inserted line (Y)');
  assert.equal(out.result.stats.deleted, 1, 'one deleted line (y)');
  assert.ok(out.result.unified.includes('-y'), `unified should show -y, got:\n${out.result.unified}`);
  assert.ok(out.result.unified.includes('+Y'), `unified should show +Y, got:\n${out.result.unified}`);
  assert.ok(out.result.unified.includes('--- /A'), 'header shows aLabel');
  assert.ok(out.result.unified.includes('+++ /B'), 'header shows bLabel');
  assert.ok(Array.isArray(out.result.hunks) && out.result.hunks.length >= 1, 'has at least one hunk');
});

// ── 3. IDENTICAL files → code 0, changed:false, header-only, stats 0/0 ───────────

test('configDiffCommand: identical files → code 0, changed:false, header-only unified', () => {
  const deps = {
    readFn: cannedReader({ '/A': 'same\ntext\n', '/B': 'same\ntext\n' }),
    cwd: '/',
  };
  const out = configDiffCommand(makeCtx(['/A', '/B']), deps);
  assert.equal(out.code, 0);
  assert.equal(out.result.changed, false, 'identical → changed false');
  assert.equal(out.result.stats.added, 0);
  assert.equal(out.result.stats.deleted, 0);
  assert.deepEqual(out.result.hunks, [], 'no hunks for identical files');
  // Header-only: exactly the --- / +++ lines, no @@ / ± body.
  assert.equal(out.result.unified, '--- /A\n+++ /B', `expected header-only, got:\n${out.result.unified}`);
});

// ── 4. unreadable file → code 1, config-diff-unreadable ──────────────────────────

test('configDiffCommand: unreadable first file → code 1, config-diff-unreadable', () => {
  const deps = {
    readFn: cannedReader({ '/A': { error: 'EACCES: permission denied' }, '/B': 'ok' }),
    cwd: '/',
  };
  const out = configDiffCommand(makeCtx(['/A', '/B']), deps);
  assert.equal(out.code, 1, `expected code 1, got ${out.code}`);
  assert.equal(out.result.status, 'unreadable');
  assert.ok(out.diagnostics.some((d) => d.code === 'config-diff-unreadable'), 'expected config-diff-unreadable');
  assert.ok(out.diagnostics[0].message.includes('/A'), 'message names the unreadable file');
});

test('configDiffCommand: both files unreadable → code 1, two diagnostics', () => {
  const deps = {
    readFn: cannedReader({ '/A': { error: 'ENOENT' }, '/B': { error: 'ENOENT' } }),
    cwd: '/',
  };
  const out = configDiffCommand(makeCtx(['/A', '/B']), deps);
  assert.equal(out.code, 1);
  assert.equal(out.diagnostics.filter((d) => d.code === 'config-diff-unreadable').length, 2);
});

// ── 5. --format json via run(argv) over real temp files (proves canonicalize) ────

test('run(config diff a b --format json): envelope has hunks + stats when files differ', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-config-diff-'));
  const aPath = join(dir, 'a.txt');
  const bPath = join(dir, 'b.txt');
  try {
    writeFileSync(aPath, 'one\ntwo\nthree\n', 'utf8');
    writeFileSync(bPath, 'one\nTWO\nthree\n', 'utf8');
    const r = await run(['config', 'diff', aPath, bPath, '--format', 'json']);
    assert.equal(r.code, 0, `expected code 0, got ${r.code}; stdout: ${r.stdout.slice(0, 300)}`);
    const env = JSON.parse(r.stdout);
    assert.equal(env.command, 'config:diff', 'canonicalize routed config diff → config:diff');
    assert.ok(Array.isArray(env.result.hunks) && env.result.hunks.length > 0, 'result.hunks is a non-empty array');
    assert.ok(env.result.stats && typeof env.result.stats === 'object', 'result.stats present');
    assert.equal(env.result.stats.added, 1);
    assert.equal(env.result.stats.deleted, 1);
    assert.equal(env.result.changed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run(config diff a b): table format prints the raw unified diff', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-config-diff-'));
  const aPath = join(dir, 'a.txt');
  const bPath = join(dir, 'b.txt');
  try {
    writeFileSync(aPath, 'x\ny\nz', 'utf8');
    writeFileSync(bPath, 'x\nY\nz', 'utf8');
    const r = await run(['config', 'diff', aPath, bPath]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('-y') && r.stdout.includes('+Y'), `table output should contain the diff, got:\n${r.stdout}`);
    assert.ok(r.stdout.includes('@@'), 'table output should contain a hunk header');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 6. --context threading reaches the engine (changes context line count) ───────

test('configDiffCommand: --context threads through to the unified output', () => {
  // 9 lines, a single change at line 5. context=1 shows 1 surrounding line each
  // side; context=3 shows 3. Compare the number of ' ' (context) body lines.
  const aText = 'l1\nl2\nl3\nl4\nOLD\nl6\nl7\nl8\nl9';
  const bText = 'l1\nl2\nl3\nl4\nNEW\nl6\nl7\nl8\nl9';
  const reader = cannedReader({ '/A': aText, '/B': bText });

  const small = configDiffCommand(makeCtx(['/A', '/B'], { context: 1 }), { readFn: reader, cwd: '/' });
  const large = configDiffCommand(makeCtx(['/A', '/B'], { context: 3 }), { readFn: reader, cwd: '/' });

  const ctxLines = (s) => s.split('\n').filter((ln) => ln.startsWith(' ')).length;
  // A symmetric single change → context lines split evenly above/below.
  // context=1 → 2 context lines (one each side); context=3 → 6 context lines.
  assert.equal(ctxLines(small.result.unified), 2, `context:1 → 2 surrounding lines, got:\n${small.result.unified}`);
  assert.equal(ctxLines(large.result.unified), 6, `context:3 → 6 surrounding lines, got:\n${large.result.unified}`);
});

test('configDiffCommand: garbage --context falls back to 3', () => {
  const aText = 'l1\nl2\nl3\nl4\nOLD\nl6\nl7\nl8\nl9';
  const bText = 'l1\nl2\nl3\nl4\nNEW\nl6\nl7\nl8\nl9';
  const reader = cannedReader({ '/A': aText, '/B': bText });
  const out = configDiffCommand(makeCtx(['/A', '/B'], { context: 'notanumber' }), { readFn: reader, cwd: '/' });
  const ctxLines = out.result.unified.split('\n').filter((ln) => ln.startsWith(' ')).length;
  assert.equal(ctxLines, 6, 'garbage context → default 3 → 6 surrounding lines');
});

// ── 7. never-throws ──────────────────────────────────────────────────────────────

test('configDiffCommand: empty args object → no throw, code 2', () => {
  let out;
  assert.doesNotThrow(() => { out = configDiffCommand({ args: {} }); });
  assert.equal(out.code, 2);
  assert.ok(out.diagnostics.some((d) => d.code === 'config-diff-no-spec'));
});

test('configDiffCommand: null ctx → no throw, code 2', () => {
  let out;
  assert.doesNotThrow(() => { out = configDiffCommand(null); });
  assert.equal(out.code, 2);
});

test('configDiffCommand: a throwing readFn → no throw, code 1, config-diff-error', () => {
  const deps = { readFn: () => { throw new Error('boom'); }, cwd: '/' };
  let out;
  assert.doesNotThrow(() => { out = configDiffCommand(makeCtx(['/A', '/B']), deps); });
  assert.equal(out.code, 1, `expected code 1, got ${out.code}`);
  assert.ok(out.diagnostics.some((d) => d.code === 'config-diff-error'), 'expected config-diff-error');
  assert.equal(out.result.status, 'error');
});

// ── 8. COMMANDS registry: config:diff is wired + re-exported ─────────────────────

test('commands.mjs: configDiffCommand is exported', () => {
  assert.equal(typeof configDiffViaCommands, 'function', 'configDiffCommand should be a function export');
});

test('run(argv): config diff is wired (not unknown-command); missing 2nd arg → code 2', async () => {
  const r = await run(['config', 'diff', 'onlyone']);
  assert.equal(r.code, 2, `expected code 2, got ${r.code}; stdout: ${r.stdout.slice(0, 300)}`);
  assert.ok(!r.stdout.includes('unknown command'), `should be wired, got: ${r.stdout.slice(0, 300)}`);
  assert.ok(r.stdout.includes('config-diff-no-spec'), `expected config-diff-no-spec, got: ${r.stdout.slice(0, 300)}`);
});

test('run(argv): usage text mentions config diff', async () => {
  const r = await run([]);
  assert.ok(r.stdout.includes('config diff'), `usage text should mention config diff, got:\n${r.stdout.slice(0, 800)}`);
});
