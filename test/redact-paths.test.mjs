/**
 * Unit tests for src/output/redact-paths.mjs — redactHomePaths().
 *
 * All assertions use specific before/after string comparisons (never just exit 0).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { redactHomePaths } from '../src/output/redact-paths.mjs';

// ── 1. Backslash form ─────────────────────────────────────────────────────────

test('backslash: homeDir in backslash form is replaced with ~', () => {
  const homeDir = 'C:\\Users\\bob';
  const input = { p: 'C:\\Users\\bob\\.claude\\daemon' };
  const out = redactHomePaths(input, homeDir);
  assert.deepEqual(out, { p: '~\\.claude\\daemon' });
});

// ── 2. Forward-slash form when homeDir is given in backslash form ─────────────

test('forward-slash: homeDir given as backslash catches forward-slash variant', () => {
  const homeDir = 'C:\\Users\\bob';
  const input = { p: 'C:/Users/bob/.claude/hud/x.mjs' };
  const out = redactHomePaths(input, homeDir);
  assert.deepEqual(out, { p: '~/.claude/hud/x.mjs' });
});

test('forward-slash: homeDir given as forward-slash catches backslash variant', () => {
  const homeDir = 'C:/Users/bob';
  const input = { p: 'C:\\Users\\bob\\.claude\\daemon' };
  const out = redactHomePaths(input, homeDir);
  assert.deepEqual(out, { p: '~\\.claude\\daemon' });
});

// ── 3. Mid-sentence replacement (global — all occurrences) ───────────────────

test('mid-sentence: path embedded in a longer message is replaced', () => {
  const homeDir = 'C:\\Users\\bob';
  const input = 'unknown dir C:\\Users\\bob\\.claude\\daemon — orphan';
  const out = redactHomePaths(input, homeDir);
  assert.equal(out, 'unknown dir ~\\.claude\\daemon — orphan');
});

test('global: multiple occurrences in one string are all replaced', () => {
  const homeDir = 'C:\\Users\\bob';
  const input = 'C:\\Users\\bob\\a and C:\\Users\\bob\\b';
  const out = redactHomePaths(input, homeDir);
  assert.equal(out, '~\\a and ~\\b');
});

// ── 4. Nested objects + arrays + diagnostics-shaped input ────────────────────

test('nested objects are deep-copied and paths redacted', () => {
  const homeDir = '/home/alice';
  const input = {
    result: {
      files: ['/home/alice/.claude/a.md', '/home/alice/.claude/b.md'],
      meta: { label: '/home/alice/notes' },
    },
  };
  const out = redactHomePaths(input, homeDir);
  assert.deepEqual(out, {
    result: {
      files: ['~/.claude/a.md', '~/.claude/b.md'],
      meta: { label: '~/notes' },
    },
  });
});

test('diagnostics-shaped array: message paths redacted', () => {
  const homeDir = 'C:\\Users\\bob';
  const input = [
    { severity: 'info', code: 'orphan-files', message: 'hard orphan: C:\\Users\\bob\\.claude\\daemon — unknown top-level directory' },
    { severity: 'warn', code: 'other', message: 'no path here' },
  ];
  const out = redactHomePaths(input, homeDir);
  assert.ok(Array.isArray(out));
  assert.equal(out[0].message, 'hard orphan: ~\\.claude\\daemon — unknown top-level directory');
  assert.equal(out[1].message, 'no path here');
});

// ── 5. Non-string leaves are untouched ────────────────────────────────────────

test('non-string primitives pass through unchanged', () => {
  const homeDir = '/home/alice';
  const input = { n: 42, b: true, nil: null, u: undefined, s: '/home/alice/x' };
  const out = redactHomePaths(input, homeDir);
  assert.equal(out.n, 42);
  assert.equal(out.b, true);
  assert.equal(out.nil, null);
  assert.equal(out.u, undefined);
  assert.equal(out.s, '~/x');
});

// ── 6. No over-redaction ──────────────────────────────────────────────────────

test('no over-redaction: string without home dir is returned content-identical', () => {
  const homeDir = 'C:\\Users\\bob';
  const input = 'hello world';
  const out = redactHomePaths(input, homeDir);
  assert.equal(out, 'hello world');
});

test('no over-redaction: bare ~ is untouched', () => {
  const homeDir = 'C:\\Users\\bob';
  const input = '~ is the home shortcut';
  const out = redactHomePaths(input, homeDir);
  assert.equal(out, '~ is the home shortcut');
});

test('no over-redaction: unrelated "Users" substring is untouched', () => {
  const homeDir = 'C:\\Users\\bob';
  const input = 'AllUsers or Users is not redacted';
  const out = redactHomePaths(input, homeDir);
  assert.equal(out, 'AllUsers or Users is not redacted');
});

test('no over-redaction: partial prefix (only drive letter) is not redacted', () => {
  const homeDir = 'C:\\Users\\bob';
  const input = 'C:\\Windows\\System32';
  const out = redactHomePaths(input, homeDir);
  // C:\Windows is NOT the homeDir prefix, so untouched
  assert.equal(out, 'C:\\Windows\\System32');
});

// ── 7. Never-throws: garbage inputs ──────────────────────────────────────────

test('never-throws: null value returns null', () => {
  assert.equal(redactHomePaths(null, 'C:\\Users\\bob'), null);
});

test('never-throws: undefined value returns undefined', () => {
  assert.equal(redactHomePaths(undefined, 'C:\\Users\\bob'), undefined);
});

test('never-throws: number value returns unchanged', () => {
  assert.equal(redactHomePaths(42, 'C:\\Users\\bob'), 42);
});

test('never-throws: empty-string homeDir returns value unchanged', () => {
  const input = { p: 'C:\\Users\\bob\\x' };
  const out = redactHomePaths(input, '');
  assert.deepEqual(out, { p: 'C:\\Users\\bob\\x' });
});

test('never-throws: null homeDir returns value unchanged', () => {
  const input = { p: 'C:\\Users\\bob\\x' };
  const out = redactHomePaths(input, null);
  assert.deepEqual(out, { p: 'C:\\Users\\bob\\x' });
});

test('never-throws: undefined homeDir returns value unchanged', () => {
  const input = { p: 'C:\\Users\\bob\\x' };
  const out = redactHomePaths(input, undefined);
  assert.deepEqual(out, { p: 'C:\\Users\\bob\\x' });
});

test('never-throws: numeric homeDir returns value unchanged', () => {
  const input = { p: '/home/alice/x' };
  const out = redactHomePaths(input, 42);
  assert.deepEqual(out, { p: '/home/alice/x' });
});

// ── 8. Proto-safety ───────────────────────────────────────────────────────────

test('proto-safety: __proto__ own key is dropped from output, no prototype pollution', () => {
  const homeDir = '/home/alice';
  // JSON.parse can produce an object with __proto__ as an own key.
  const input = JSON.parse('{"__proto__": {"polluted": true}, "safe": "/home/alice/x"}');
  const out = redactHomePaths(input, homeDir);
  // The __proto__ key must not appear in the output.
  assert.ok(!Object.prototype.hasOwnProperty.call(out, '__proto__'),
    '__proto__ own key must be dropped');
  // And it must not have polluted Object.prototype.
  assert.equal(({}).polluted, undefined, 'Object.prototype must not be polluted');
  // The safe key must still be redacted.
  assert.equal(out.safe, '~/x');
});

test('proto-safety: constructor and prototype keys are dropped', () => {
  const homeDir = '/home/alice';
  const input = Object.create(null);
  input.constructor = '/home/alice/bad';
  input.prototype = '/home/alice/bad2';
  input.ok = '/home/alice/good';
  const out = redactHomePaths(input, homeDir);
  assert.ok(!Object.prototype.hasOwnProperty.call(out, 'constructor'), 'constructor dropped');
  assert.ok(!Object.prototype.hasOwnProperty.call(out, 'prototype'), 'prototype dropped');
  assert.equal(out.ok, '~/good');
});

// ── 9. Input not mutated ──────────────────────────────────────────────────────

test('input object is not mutated', () => {
  const homeDir = '/home/alice';
  const input = { p: '/home/alice/x', nested: { q: '/home/alice/y' } };
  const origP = input.p;
  const origQ = input.nested.q;
  redactHomePaths(input, homeDir);
  assert.equal(input.p, origP, 'input.p must not be mutated');
  assert.equal(input.nested.q, origQ, 'input.nested.q must not be mutated');
});

// ── 10. Case-insensitivity is platform-driven (win32 + macOS), exact on Linux ──
// The active platform is injected (3rd arg) so these are deterministic on ANY
// host — the old test could only run its assertion when the host itself was win32.

test('win32 case-insensitivity: lowercase path matches against mixed-case homeDir', () => {
  const homeDir = 'C:\\Users\\bob';
  const out = redactHomePaths('c:\\users\\bob\\x', homeDir, 'win32');
  assert.equal(out, '~\\x', 'lowercase variant should be redacted on win32');
});

test('darwin case-insensitivity: mixed-case path is redacted (macOS FS is case-insensitive)', () => {
  // Privacy regression guard for P0-2: on macOS a path that spells the home dir
  // with different case still points at the same home and MUST be scrubbed.
  const homeDir = '/Users/Bob';
  const out = redactHomePaths('/users/bob/.claude/x', homeDir, 'darwin');
  assert.equal(out, '~/.claude/x', 'macOS: differently-cased home path must still be redacted');
});

test('linux case-sensitivity: differently-cased path is NOT redacted (case-sensitive FS)', () => {
  const homeDir = '/home/alice';
  const out = redactHomePaths('/HOME/ALICE/x', homeDir, 'linux');
  assert.equal(out, '/HOME/ALICE/x', 'Linux: a differently-cased path is a different path — not redacted');
});

test('linux exact-case path IS redacted', () => {
  const homeDir = '/home/alice';
  const out = redactHomePaths('/home/alice/x', homeDir, 'linux');
  assert.equal(out, '~/x');
});
