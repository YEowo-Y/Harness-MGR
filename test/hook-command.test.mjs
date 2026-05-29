/**
 * Tests for src/lib/hook-command.mjs (P2.U5b-2).
 *
 * Pure logic only — no filesystem, no PATH, no spawning. The three exported
 * functions are tested exhaustively: tokenizeCommand, expandVars, and
 * classifyHookCommand. The headline goal is the classifyHookCommand false-positive
 * guards: eval flags must produce null, npx must be 'external', and an unresolved
 * variable must propagate fullyExpanded:false rather than silently misfiling.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenizeCommand,
  expandVars,
  classifyHookCommand,
} from '../src/lib/hook-command.mjs';

// ── tokenizeCommand ──────────────────────────────────────────────────────────

test('tokenize: bare words split on whitespace', () => {
  assert.deepEqual(tokenizeCommand('any-buddy apply --silent'), ['any-buddy', 'apply', '--silent']);
});

test('tokenize: double-quoted arg strips quotes and preserves spaces', () => {
  assert.deepEqual(tokenizeCommand('node "$HOME/x.mjs"'), ['node', '$HOME/x.mjs']);
});

test('tokenize: single-quoted span with spaces → one token', () => {
  assert.deepEqual(tokenizeCommand("'a b' c"), ['a b', 'c']);
});

test('tokenize: empty string → []', () => {
  assert.deepEqual(tokenizeCommand(''), []);
});

test('tokenize: non-string inputs → []', () => {
  assert.deepEqual(tokenizeCommand(null), []);
  assert.deepEqual(tokenizeCommand(undefined), []);
  assert.deepEqual(tokenizeCommand(42), []);
  assert.deepEqual(tokenizeCommand({}), []);
});

test('tokenize: multiple/trailing spaces collapse', () => {
  assert.deepEqual(tokenizeCommand('  a   b  '), ['a', 'b']);
});

test('tokenize: tab as whitespace', () => {
  assert.deepEqual(tokenizeCommand('a\tb'), ['a', 'b']);
});

test('tokenize: mid-token quote glues adjacent content', () => {
  // --opt="a b" → one token --opt=a b
  assert.deepEqual(tokenizeCommand('--opt="a b"'), ['--opt=a b']);
});

test('tokenize: single-word command → single token', () => {
  assert.deepEqual(tokenizeCommand('node'), ['node']);
});

// ── expandVars ───────────────────────────────────────────────────────────────

test('expandVars: $HOME substitution with HOME present', () => {
  const r = expandVars('$HOME/x', { HOME: '/h' });
  assert.equal(r.value, '/h/x');
  assert.equal(r.fullyExpanded, true);
});

test('expandVars: $HOME falls back to USERPROFILE when HOME absent', () => {
  const r = expandVars('$HOME/x', { USERPROFILE: 'C:\\Users\\ye' });
  assert.equal(r.value, 'C:\\Users\\ye/x');
  assert.equal(r.fullyExpanded, true);
});

test('expandVars: ${VAR} brace form', () => {
  const r = expandVars('${FOO}/bar', { FOO: '/opt' });
  assert.equal(r.value, '/opt/bar');
  assert.equal(r.fullyExpanded, true);
});

test('expandVars: %VAR% Windows form', () => {
  const r = expandVars('%APPDATA%\\hooks', { APPDATA: 'C:\\Users\\ye\\AppData\\Roaming' });
  assert.equal(r.value, 'C:\\Users\\ye\\AppData\\Roaming\\hooks');
  assert.equal(r.fullyExpanded, true);
});

test('expandVars: leading ~ expands to HOME', () => {
  const r = expandVars('~/.claude/hooks/foo.mjs', { HOME: '/home/ye' });
  assert.equal(r.value, '/home/ye/.claude/hooks/foo.mjs');
  assert.equal(r.fullyExpanded, true);
});

test('expandVars: leading ~ expands to USERPROFILE when HOME absent', () => {
  const r = expandVars('~\\.claude\\hooks', { USERPROFILE: 'C:\\Users\\ye' });
  assert.equal(r.value, 'C:\\Users\\ye\\.claude\\hooks');
  assert.equal(r.fullyExpanded, true);
});

test('expandVars: ~ at end of string (tilde-only) expands', () => {
  const r = expandVars('~', { HOME: '/home/ye' });
  assert.equal(r.value, '/home/ye');
  assert.equal(r.fullyExpanded, true);
});

test('expandVars: unknown var left as-is, fullyExpanded false', () => {
  const r = expandVars('$NOPE/x', {});
  assert.equal(r.value, '$NOPE/x');
  assert.equal(r.fullyExpanded, false);
});

test('expandVars: bare $ not a valid var → left as-is, fullyExpanded true', () => {
  const r = expandVars('cost $100', { HOME: '/h' });
  assert.equal(r.value, 'cost $100');
  assert.equal(r.fullyExpanded, true);
});

test('expandVars: 100% not a var reference → unchanged, fullyExpanded true', () => {
  const r = expandVars('100%', {});
  assert.equal(r.value, '100%');
  assert.equal(r.fullyExpanded, true);
});

test('expandVars: non-string input → {value:"", fullyExpanded:false}', () => {
  assert.deepEqual(expandVars(null), { value: '', fullyExpanded: false });
  assert.deepEqual(expandVars(42), { value: '', fullyExpanded: false });
  assert.deepEqual(expandVars(undefined), { value: '', fullyExpanded: false });
});

test('expandVars: multiple vars in one string', () => {
  const r = expandVars('$HOME/$USER/cfg', { HOME: '/home', USER: 'ye' });
  assert.equal(r.value, '/home/ye/cfg');
  assert.equal(r.fullyExpanded, true);
});

test('expandVars: one resolved + one unresolved → partial, fullyExpanded false', () => {
  const r = expandVars('$HOME/$NOPE', { HOME: '/h' });
  assert.equal(r.value, '/h/$NOPE');
  assert.equal(r.fullyExpanded, false);
});

test('expandVars: a substituted value containing $X is NOT re-scanned (single pass)', () => {
  // ${HOME} → "$OTHER"; that inserted "$OTHER" must stay literal (no cascade).
  const r = expandVars('${HOME}/x', { HOME: '$OTHER', OTHER: 'LEAK' });
  assert.equal(r.value, '$OTHER/x');
  assert.equal(r.fullyExpanded, true);
});

test('expandVars: HOME undefined and USERPROFILE undefined → fullyExpanded false', () => {
  const r = expandVars('$HOME/x', {});
  assert.equal(r.value, '$HOME/x');
  assert.equal(r.fullyExpanded, false);
});

test('expandVars: ~ not at index 0 → NOT treated as home', () => {
  // tilde mid-string should remain untouched
  const r = expandVars('foo~bar', { HOME: '/h' });
  assert.equal(r.value, 'foo~bar');
  assert.equal(r.fullyExpanded, true);
});

// ── classifyHookCommand — headline cases ──────────────────────────────────────

test('classify: node + $HOME script → file, fullyExpanded true', () => {
  const r = classifyHookCommand('node "$HOME/.claude/hooks/foo.mjs"', { HOME: '/h' });
  assert.deepEqual(r, { kind: 'file', target: '/h/.claude/hooks/foo.mjs', fullyExpanded: true });
});

test('classify: node + unresolved var → file, fullyExpanded false', () => {
  // $CLAUDE_PROJECT_DIR absent → target keeps original text, probe marks INDETERMINATE
  const r = classifyHookCommand('node "$CLAUDE_PROJECT_DIR/h.mjs"', {});
  assert.deepEqual(r, { kind: 'file', target: '$CLAUDE_PROJECT_DIR/h.mjs', fullyExpanded: false });
});

test('classify: bare external command → external', () => {
  const r = classifyHookCommand('any-buddy apply --silent', {});
  assert.deepEqual(r, { kind: 'external', target: 'any-buddy', fullyExpanded: true });
});

test('classify: absolute path → file (path-like)', () => {
  const r = classifyHookCommand('/usr/local/bin/hook.sh', {});
  assert.deepEqual(r, { kind: 'file', target: '/usr/local/bin/hook.sh', fullyExpanded: true });
});

test('classify: ./relative path → file (starts with .)', () => {
  const r = classifyHookCommand('./hooks/foo.sh', {});
  assert.deepEqual(r, { kind: 'file', target: './hooks/foo.sh', fullyExpanded: true });
});

test('classify: ../relative path → file (starts with .)', () => {
  const r = classifyHookCommand('../scripts/run.sh', {});
  assert.deepEqual(r, { kind: 'file', target: '../scripts/run.sh', fullyExpanded: true });
});

// ── false-positive guards (critical) ─────────────────────────────────────────

test('classify: node -e inline code → null (eval flag guard)', () => {
  assert.equal(classifyHookCommand('node -e "console.log(1)"', {}), null);
});

test('classify: python -m module → null (eval flag guard)', () => {
  assert.equal(classifyHookCommand('python -m http.server', {}), null);
});

test('classify: bash -c inline → null (eval flag guard)', () => {
  assert.equal(classifyHookCommand('bash -c "echo hi"', {}), null);
});

test('classify: pwsh --command inline → null (eval flag guard)', () => {
  assert.equal(classifyHookCommand('pwsh --command "Write-Host hi"', {}), null);
});

test('classify: deno --eval inline → null (eval flag guard)', () => {
  assert.equal(classifyHookCommand('deno --eval "console.log(1)"', {}), null);
});

test('classify: node --print inline → null (eval flag guard)', () => {
  assert.equal(classifyHookCommand('node --print "process.version"', {}), null);
});

test('classify: npx prettier → external (npx is NOT an interpreter)', () => {
  const r = classifyHookCommand('npx prettier --write', {});
  assert.deepEqual(r, { kind: 'external', target: 'npx', fullyExpanded: true });
});

test('classify: npx @scope/pkg → external (package arg never treated as file)', () => {
  const r = classifyHookCommand('npx @scope/pkg --flag', {});
  assert.deepEqual(r, { kind: 'external', target: 'npx', fullyExpanded: true });
});

// ── interpreter flag skipping ─────────────────────────────────────────────────

test('classify: pwsh -File script → file (flag skipped, next token is script)', () => {
  const r = classifyHookCommand('pwsh -File "C:\\h.ps1"', {});
  assert.deepEqual(r, { kind: 'file', target: 'C:\\h.ps1', fullyExpanded: true });
});

test('classify: node --no-warnings script.mjs → file (flag skipped)', () => {
  const r = classifyHookCommand('node --no-warnings script.mjs', {});
  assert.deepEqual(r, { kind: 'file', target: 'script.mjs', fullyExpanded: true });
});

test('classify: python3 -u script.py → file (flag skipped)', () => {
  const r = classifyHookCommand('python3 -u script.py', {});
  assert.deepEqual(r, { kind: 'file', target: 'script.py', fullyExpanded: true });
});

test('classify: interpreter with no script arg → null', () => {
  // e.g. just `node` with no arguments
  assert.equal(classifyHookCommand('node', {}), null);
  assert.equal(classifyHookCommand('node --no-warnings', {}), null);
});

// ── edge cases / junk inputs ──────────────────────────────────────────────────

test('classify: empty string → null', () => {
  assert.equal(classifyHookCommand('', {}), null);
});

test('classify: whitespace-only → null', () => {
  assert.equal(classifyHookCommand('   ', {}), null);
});

test('classify: non-string → null', () => {
  assert.equal(classifyHookCommand(null), null);
  assert.equal(classifyHookCommand(undefined), null);
  assert.equal(classifyHookCommand(42), null);
});

// ── Windows-style interpreter name (.exe suffix) ───────────────────────────

test('classify: node.exe → treated as interpreter', () => {
  const r = classifyHookCommand('node.exe script.mjs', {});
  assert.deepEqual(r, { kind: 'file', target: 'script.mjs', fullyExpanded: true });
});

test('classify: PYTHON3.EXE (uppercase) → treated as interpreter', () => {
  const r = classifyHookCommand('PYTHON3.EXE script.py', {});
  assert.deepEqual(r, { kind: 'file', target: 'script.py', fullyExpanded: true });
});

// ── Windows backslash path-like exe ───────────────────────────────────────

test('classify: Windows absolute path exe → file (path-like via backslash)', () => {
  const r = classifyHookCommand('C:\\tools\\run.exe', {});
  assert.deepEqual(r, { kind: 'file', target: 'C:\\tools\\run.exe', fullyExpanded: true });
});

// ── env defaults to process.env when not provided ─────────────────────────

test('classify: omitted env defaults gracefully (no throw)', () => {
  assert.doesNotThrow(() => classifyHookCommand('any-buddy check'));
  assert.doesNotThrow(() => expandVars('$HOME/x'));
});

// ── expandVars: ${VAR:-default} and ${VAR-default} forms ─────────────────

test('expandVars: ${VAR:-default} with VAR unset → default, fullyExpanded true', () => {
  const r = expandVars('${MYVAR:-/default/path}', {});
  assert.equal(r.value, '/default/path');
  assert.equal(r.fullyExpanded, true);
});

test('expandVars: ${VAR:-default} with VAR set → uses VAR value, fullyExpanded true', () => {
  const r = expandVars('${MYVAR:-/default/path}', { MYVAR: '/real/path' });
  assert.equal(r.value, '/real/path');
  assert.equal(r.fullyExpanded, true);
});

test('expandVars: ${VAR:-default} with VAR set to empty string → default (colon-dash treats empty as unset)', () => {
  const r = expandVars('${MYVAR:-/fallback}', { MYVAR: '' });
  assert.equal(r.value, '/fallback');
  assert.equal(r.fullyExpanded, true);
});

test('expandVars: ${VAR-default} with VAR set to empty string → empty string kept (dash keeps empty)', () => {
  const r = expandVars('${MYVAR-/fallback}', { MYVAR: '' });
  assert.equal(r.value, '');
  assert.equal(r.fullyExpanded, true);
});

test('expandVars: ${VAR-default} with VAR unset → default, fullyExpanded true', () => {
  const r = expandVars('${MYVAR-/fallback}', {});
  assert.equal(r.value, '/fallback');
  assert.equal(r.fullyExpanded, true);
});

test('expandVars: real CC hook path with ${CLAUDE_CONFIG_DIR:-...} literal default → resolves, fullyExpanded true', () => {
  const input = '${CLAUDE_CONFIG_DIR:-C:\\Users\\alice/.claude}/hooks/post-tool-use.mjs';
  const r = expandVars(input, {});
  assert.equal(r.value, 'C:\\Users\\alice/.claude/hooks/post-tool-use.mjs');
  assert.equal(r.fullyExpanded, true);
});

test('expandVars: default body with colons and backslashes is preserved verbatim', () => {
  const r = expandVars('${X:-C:\\Users\\name/path:extra}', {});
  assert.equal(r.value, 'C:\\Users\\name/path:extra');
  assert.equal(r.fullyExpanded, true);
});

test('expandVars: malformed ${VAR:- with no closing brace → no throw, text untouched', () => {
  assert.doesNotThrow(() => {
    const r = expandVars('${MISSING_BRACE:-', {});
    // No match → text is returned as-is
    assert.equal(r.value, '${MISSING_BRACE:-');
  });
});

// Regression: plain ${VAR} still works (no default operator present)
test('expandVars: regression — plain ${VAR} unset still leaves literal + fullyExpanded false', () => {
  const r = expandVars('${NOPE}/x', {});
  assert.equal(r.value, '${NOPE}/x');
  assert.equal(r.fullyExpanded, false);
});

// ── classifyHookCommand: end-to-end with ${VAR:-default} ─────────────────

test('classify: node with ${CLAUDE_CONFIG_DIR:-default_dir}/hooks/x.mjs → file, fullyExpanded true', () => {
  const cmd = 'node "${CLAUDE_CONFIG_DIR:-/synth/claude}/hooks/x.mjs"';
  const r = classifyHookCommand(cmd, {});
  assert.deepEqual(r, {
    kind: 'file',
    target: '/synth/claude/hooks/x.mjs',
    fullyExpanded: true,
  });
});

// ── HIGH-1: nested $VAR inside default body ────────────────────────────────

test('expandVars: THE REAL SHAPE — ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/x.mjs with HOME set', () => {
  // CLAUDE_CONFIG_DIR unset → falls back to $HOME/.claude → HOME expands → full path
  const r = expandVars('${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/x.mjs', { HOME: '/home/u' });
  assert.equal(r.value, '/home/u/.claude/hooks/x.mjs');
  assert.equal(r.fullyExpanded, true);
});

test('expandVars: THE REAL SHAPE — USERPROFILE fallback when HOME absent', () => {
  const r = expandVars('${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/x.mjs', { USERPROFILE: 'C:\\Users\\ye' });
  assert.equal(r.value, 'C:\\Users\\ye/.claude/hooks/x.mjs');
  assert.equal(r.fullyExpanded, true);
});

test('expandVars: ${CLAUDE_CONFIG_DIR:-$HOME/.claude} with CLAUDE_CONFIG_DIR set → uses it, does NOT expand default', () => {
  const r = expandVars('${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/x.mjs', {
    CLAUDE_CONFIG_DIR: '/custom/dir',
    HOME: '/home/u',
  });
  assert.equal(r.value, '/custom/dir/hooks/x.mjs');
  assert.equal(r.fullyExpanded, true);
});

test('expandVars: nested-unresolved default → fullyExpanded false (graceful degradation)', () => {
  // Both X and NOPE unset → default $NOPE/y applied → inner NOPE unresolved
  const r = expandVars('${X:-$NOPE/y}', {});
  assert.ok(r.value.includes('$NOPE'), 'inner $NOPE must remain literal');
  assert.equal(r.fullyExpanded, false);
});

// ── HIGH-2: ReDoS length guard ─────────────────────────────────────────────

test('expandVars: ReDoS regression — very long malformed input returns in <100ms', () => {
  const hostile = '${A:-'.repeat(50000);
  const start = Date.now();
  const r = expandVars(hostile, {});
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 100, `must return in <100ms, took ${elapsed}ms`);
  assert.equal(r.fullyExpanded, false);
  assert.doesNotThrow(() => expandVars(hostile, {}));
});

test('expandVars: string at exactly the cap (8192) is processed normally', () => {
  // A valid short reference at the start of an 8192-char string should resolve.
  const pad = 'x'.repeat(8192 - 6); // total = exactly 8192 after prepending '$HOME/' (6 chars)
  const r = expandVars('$HOME/' + pad, { HOME: '/h' });
  assert.ok(r.value.startsWith('/h/'));
  assert.equal(r.fullyExpanded, true);
});

test('expandVars: string one byte over the cap → returned as-is, fullyExpanded false', () => {
  const over = 'x'.repeat(8193);
  const r = expandVars(over, {});
  assert.equal(r.value, over);
  assert.equal(r.fullyExpanded, false);
});

// ── classifyHookCommand: end-to-end with nested ${VAR:-$HOME/...} ──────────

test('classify: node with ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/x.mjs → kind:file, target resolves, fullyExpanded true', () => {
  const cmd = 'node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/x.mjs"';
  const r = classifyHookCommand(cmd, { HOME: '/home/u' });
  assert.deepEqual(r, {
    kind: 'file',
    target: '/home/u/.claude/hooks/x.mjs',
    fullyExpanded: true,
  });
});
