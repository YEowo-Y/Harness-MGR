/**
 * Hermetic unit tests for src/selftest/spawn-spec-guardrail.mjs and
 * src/selftest/spawn-spec-completeness.mjs.
 *
 * FALSIFIABILITY:
 *   - The real SPAWN_SPECS registry MUST yield zero guardrail errors.
 *   - Synthetic permissive descriptors MUST yield spawn-spec-permissive-positional errors.
 *   - A missing/non-RegExp pattern MUST yield spawn-spec-missing-pattern.
 *   - A tight clone of NODE_PATH_RE MUST be clean AND accept the legit path.
 *   - An unregistered opt-in module MUST yield spawn-spec-unregistered.
 *   - The real src/ tree MUST yield zero spawn-spec-unregistered errors.
 *
 * Never spawns a process. Pure logic only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkSpawnSpecGuardrail,
  MUTATION_FLAGS,
  LEGIT_POSIX_PATH,
} from '../src/selftest/spawn-spec-guardrail.mjs';

import { checkSpawnSpecCompleteness } from '../src/selftest/spawn-spec-completeness.mjs';
import { SPAWN_SPECS } from '../src/selftest/spawn-spec-registry.mjs';

// ── 1. Real SPAWN_SPECS registry -> zero errors ───────────────────────────

test('real SPAWN_SPECS registry -> zero spawn-spec-* errors', () => {
  const diags = checkSpawnSpecGuardrail(SPAWN_SPECS);
  const errors = diags.filter((d) => d.severity === 'error');
  assert.deepEqual(
    errors,
    [],
    `real registry must be clean, got: ${JSON.stringify(errors)}`,
  );
});

test('real SPAWN_SPECS has exactly one descriptor (probe-hook-syntax)', () => {
  assert.equal(SPAWN_SPECS.length, 1);
  assert.equal(SPAWN_SPECS[0].id, 'probe-hook-syntax');
  assert.equal(SPAWN_SPECS[0].allowSlashPositionals, true);
  assert.ok(SPAWN_SPECS[0].positionalPattern instanceof RegExp);
});

// ── 2. Synthetic permissive /.+/ -> flagged for every mutation flag ────────

test('permissive /.+/ pattern -> spawn-spec-permissive-positional for all mutation flags', () => {
  const specs = [
    { id: 'synthetic-permissive', allowSlashPositionals: true, positionalPattern: /.+/ },
  ];
  const diags = checkSpawnSpecGuardrail(specs);
  const errors = diags.filter((d) => d.code === 'spawn-spec-permissive-positional' && d.severity === 'error');
  // Every mutation flag should be flagged.
  assert.ok(
    errors.length >= MUTATION_FLAGS.length,
    `expected >=${MUTATION_FLAGS.length} errors, got ${errors.length}: ${JSON.stringify(errors)}`,
  );
  // Each offending token appears in a message.
  for (const flag of MUTATION_FLAGS) {
    const found = errors.some((d) => d.message.includes(flag));
    assert.ok(found, `expected a diagnostic mentioning flag '${flag}'`);
  }
  // All point at the descriptor id.
  for (const e of errors) {
    assert.equal(e.path, 'synthetic-permissive');
    assert.equal(e.phase, 'boundary');
  }
});

// ── 3. Slash-leading pattern without extension tail -> flagged ─────────────
// The most realistic mistake a new tar/git consumer might make: copy the
// drive-letter pattern from probe-access but forget the extension requirement.

test('slash-leading /^[\\/].+/ pattern (no extension) -> flagged (admits /grant, /deny)', () => {
  const specs = [
    { id: 'synthetic-slash-no-ext', allowSlashPositionals: true, positionalPattern: /^[/\\].+/ },
  ];
  const diags = checkSpawnSpecGuardrail(specs);
  const errors = diags.filter((d) => d.code === 'spawn-spec-permissive-positional');
  assert.ok(errors.length >= 1, `expected >=1 error, got: ${JSON.stringify(errors)}`);
  // /grant and /deny specifically must be caught.
  for (const flag of ['/grant', '/deny', '/reset']) {
    const found = errors.some((d) => d.message.includes(flag));
    assert.ok(found, `expected a diagnostic mentioning '${flag}'`);
  }
});

// ── 4. Missing / non-RegExp positionalPattern -> spawn-spec-missing-pattern ─

test('allowSlashPositionals:true with missing positionalPattern -> spawn-spec-missing-pattern', () => {
  const specs = [
    { id: 'missing-pattern', allowSlashPositionals: true },
  ];
  const diags = checkSpawnSpecGuardrail(specs);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].code, 'spawn-spec-missing-pattern');
  assert.equal(diags[0].severity, 'error');
  assert.equal(diags[0].phase, 'boundary');
  assert.equal(diags[0].path, 'missing-pattern');
});

test('allowSlashPositionals:true with positionalPattern:null -> spawn-spec-missing-pattern', () => {
  const specs = [
    { id: 'null-pattern', allowSlashPositionals: true, positionalPattern: null },
  ];
  const diags = checkSpawnSpecGuardrail(specs);
  assert.ok(diags.some((d) => d.code === 'spawn-spec-missing-pattern'));
});

test('allowSlashPositionals:true with positionalPattern:"string" -> spawn-spec-missing-pattern', () => {
  const specs = [
    { id: 'string-pattern', allowSlashPositionals: true, positionalPattern: '^.+$' },
  ];
  const diags = checkSpawnSpecGuardrail(specs);
  assert.ok(diags.some((d) => d.code === 'spawn-spec-missing-pattern'));
});

// ── 5. Safe clone of NODE_PATH_RE -> clean + legit-path accepted ──────────

test('tight clone of NODE_PATH_RE -> zero errors, legit POSIX path accepted', () => {
  // Reproduce the exact pattern from probe-hook-syntax.mjs.
  const tightPattern = /^(?:[A-Za-z]:[\\/]|[\\/]).+\.(?:mjs|cjs|js)$/i;
  const specs = [
    { id: 'tight-clone', allowSlashPositionals: true, positionalPattern: tightPattern },
  ];
  const diags = checkSpawnSpecGuardrail(specs);
  const errors = diags.filter((d) => d.severity === 'error');
  assert.deepEqual(errors, [], `tight clone must be clean, got: ${JSON.stringify(errors)}`);
  // Confirm the accept-probe would pass.
  assert.ok(tightPattern.test(LEGIT_POSIX_PATH), 'tight pattern must accept the legit POSIX path');
  // Confirm every mutation flag is rejected.
  for (const flag of MUTATION_FLAGS) {
    assert.equal(
      tightPattern.test(flag),
      false,
      `tight pattern must reject '${flag}'`,
    );
  }
});

// ── 6. Never-throws on null/garbage/empty input ───────────────────────────

test('checkSpawnSpecGuardrail: never throws on null input', () => {
  assert.doesNotThrow(() => checkSpawnSpecGuardrail(null));
});

test('checkSpawnSpecGuardrail: never throws on undefined input', () => {
  assert.doesNotThrow(() => checkSpawnSpecGuardrail(undefined));
});

test('checkSpawnSpecGuardrail: never throws on empty array', () => {
  const result = checkSpawnSpecGuardrail([]);
  assert.deepEqual(result, []);
});

test('checkSpawnSpecGuardrail: never throws on garbage array entries', () => {
  assert.doesNotThrow(() => checkSpawnSpecGuardrail([null, undefined, 42, 'string', {}, []]));
});

test('checkSpawnSpecGuardrail: returns [] on non-array inputs', () => {
  assert.deepEqual(checkSpawnSpecGuardrail(null), []);
  assert.deepEqual(checkSpawnSpecGuardrail(undefined), []);
  assert.deepEqual(checkSpawnSpecGuardrail(42), []);
  assert.deepEqual(checkSpawnSpecGuardrail('hello'), []);
  assert.deepEqual(checkSpawnSpecGuardrail({}), []);
});

// ── 7. allowSlashPositionals:false / absent -> skipped entirely ──────────

test('descriptor with allowSlashPositionals:false is skipped (no errors)', () => {
  const specs = [
    // Even with a dangerously permissive pattern, false means not opted in.
    { id: 'not-opted-in', allowSlashPositionals: false, positionalPattern: /.+/ },
  ];
  const diags = checkSpawnSpecGuardrail(specs);
  assert.deepEqual(diags, []);
});

test('descriptor with no allowSlashPositionals field is skipped', () => {
  const specs = [
    { id: 'no-opt-in-field', positionalPattern: /.+/ },
  ];
  const diags = checkSpawnSpecGuardrail(specs);
  assert.deepEqual(diags, []);
});

// ── 8. MUTATION_FLAGS shape ───────────────────────────────────────────────

test('MUTATION_FLAGS is a frozen non-empty array of strings', () => {
  assert.ok(Array.isArray(MUTATION_FLAGS));
  assert.ok(MUTATION_FLAGS.length > 0);
  assert.ok(Object.isFrozen(MUTATION_FLAGS));
  for (const f of MUTATION_FLAGS) {
    assert.equal(typeof f, 'string', `expected string, got ${typeof f}: ${f}`);
    assert.ok(f.startsWith('/'), `flag '${f}' should start with /`);
  }
});

// ── 9. accept-probe fails on overly-restrictive pattern ──────────────────

test('overly-restrictive pattern /^$/ -> spawn-spec-accept-failed', () => {
  const specs = [
    { id: 'empty-pattern', allowSlashPositionals: true, positionalPattern: /^$/ },
  ];
  const diags = checkSpawnSpecGuardrail(specs);
  // /^$/ rejects all mutation flags (good) but also rejects the legit path (bad).
  assert.ok(
    diags.some((d) => d.code === 'spawn-spec-accept-failed' && d.severity === 'error'),
    `expected spawn-spec-accept-failed, got: ${JSON.stringify(diags)}`,
  );
  // Must NOT have a permissive-positional error (all flags are rejected by /^$/).
  assert.ok(
    !diags.some((d) => d.code === 'spawn-spec-permissive-positional'),
    'should not have permissive-positional errors for /^$/',
  );
});

// ── 10. All diagnostics carry phase:'boundary' ───────────────────────────

test('all diagnostics from checkSpawnSpecGuardrail carry phase:boundary', () => {
  const specs = [
    { id: 'missing-pattern', allowSlashPositionals: true },
    { id: 'permissive', allowSlashPositionals: true, positionalPattern: /.+/ },
  ];
  const diags = checkSpawnSpecGuardrail(specs);
  for (const d of diags) {
    assert.equal(d.phase, 'boundary', `expected phase:boundary, got: ${JSON.stringify(d)}`);
  }
});

// ── 11. Registry-completeness backstop (checkSpawnSpecCompleteness) ──────

// 11a. Unregistered opt-in module -> spawn-spec-unregistered error
test('checkSpawnSpecCompleteness: code line with opt-in token, unregistered -> spawn-spec-unregistered', () => {
  const files = [
    {
      path: '/abs/src/discovery/probe-new-thing.mjs',
      source: [
        '/**',
        ' * allowSlashPositionals: docs only, ignored',
        ' */',
        'export const SPEC = Object.freeze({',
        '  id: "probe-new-thing",',
        '  allowSlashPositionals: true,',
        '  positionalPattern: /^\\/.+\\.exe$/i,',
        '});',
      ].join('\n'),
    },
  ];
  const registeredIds = new Set(['probe-hook-syntax']); // probe-new-thing NOT registered
  const diags = checkSpawnSpecCompleteness(files, registeredIds);
  assert.equal(diags.length, 1, `expected 1 error, got: ${JSON.stringify(diags)}`);
  assert.equal(diags[0].code, 'spawn-spec-unregistered');
  assert.equal(diags[0].severity, 'error');
  assert.equal(diags[0].phase, 'boundary');
  assert.ok(diags[0].message.includes('probe-new-thing'), 'message should name the offending module');
  assert.equal(diags[0].path, '/abs/src/discovery/probe-new-thing.mjs');
});

// 11b. Registered opt-in module -> no error
test('checkSpawnSpecCompleteness: code line with opt-in token, registered -> clean', () => {
  const files = [
    {
      path: '/abs/src/discovery/probe-hook-syntax.mjs',
      source: [
        'export const SPEC = Object.freeze({',
        '  allowSlashPositionals: /** @type {true} */ (true),',
        '  positionalPattern: /^\\/.+\\.mjs$/i,',
        '});',
      ].join('\n'),
    },
  ];
  const registeredIds = new Set(['probe-hook-syntax']);
  const diags = checkSpawnSpecCompleteness(files, registeredIds);
  assert.deepEqual(diags, []);
});

// 11c. JSDoc/comment-only lines are ignored (no code-line opt-in -> no error)
test('checkSpawnSpecCompleteness: allowSlashPositionals only in JSDoc/comments -> no error', () => {
  const files = [
    {
      path: '/abs/src/selftest/spawn-spec-guardrail.mjs',
      source: [
        '/**',
        ' * `allowSlashPositionals: true` in a JSDoc comment — should be ignored.',
        ' */',
        '// allowSlashPositionals: also in a line comment — ignored.',
        'export function foo() { return 42; }',
      ].join('\n'),
    },
  ];
  const registeredIds = new Set(); // nothing registered; no code opt-in so no error
  const diags = checkSpawnSpecCompleteness(files, registeredIds);
  assert.deepEqual(diags, []);
});

// 11d. Real src/ tree -> clean (no unregistered opt-ins exist)
test('checkSpawnSpecCompleteness: real src/ tree -> zero spawn-spec-unregistered errors', () => {
  const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

  function gatherMjs(dir) {
    const results = [];
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return results; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      try {
        if (e.isDirectory()) { for (const f of gatherMjs(abs)) results.push(f); }
        else if (e.isFile() && e.name.endsWith('.mjs')) results.push(abs);
      } catch { /* skip */ }
    }
    return results;
  }

  const files = [];
  for (const p of gatherMjs(srcDir)) {
    try { files.push({ path: p, source: readFileSync(p, 'utf-8') }); } catch { /* skip */ }
  }

  const registeredIds = new Set(SPAWN_SPECS.map((s) => (s && typeof s.id === 'string' ? s.id : '')));
  const diags = checkSpawnSpecCompleteness(files, registeredIds);
  const errors = diags.filter((d) => d.code === 'spawn-spec-unregistered');
  assert.deepEqual(
    errors,
    [],
    `real src/ tree must have no unregistered opt-ins, got: ${JSON.stringify(errors)}`,
  );
});

// 11e. Non-array / garbage input -> never throws, returns []
test('checkSpawnSpecCompleteness: never throws on null files', () => {
  assert.doesNotThrow(() => checkSpawnSpecCompleteness(null, new Set()));
  assert.deepEqual(checkSpawnSpecCompleteness(null, new Set()), []);
});

test('checkSpawnSpecCompleteness: never throws on null registeredIds', () => {
  assert.doesNotThrow(() => checkSpawnSpecCompleteness([], null));
  assert.deepEqual(checkSpawnSpecCompleteness([], null), []);
});

test('checkSpawnSpecCompleteness: garbage file entries are skipped silently', () => {
  const diags = checkSpawnSpecCompleteness([null, undefined, 42, {}, { path: 'x' }], new Set());
  assert.deepEqual(diags, []);
});

// 11f. ROBUSTNESS: /g flag on positionalPattern does not under-count mutation flags
// (non-blocking finding from the review — guard in checkSpawnSpecGuardrail)
test('checkSpawnSpecGuardrail: /g flag on positionalPattern still catches all mutation flags', () => {
  // /.+/g carries lastIndex state; verify all flags are still individually reported.
  const specs = [
    { id: 'global-flag', allowSlashPositionals: true, positionalPattern: /.+/g },
  ];
  const diags = checkSpawnSpecGuardrail(specs);
  const errors = diags.filter((d) => d.code === 'spawn-spec-permissive-positional');
  for (const flag of MUTATION_FLAGS) {
    const found = errors.some((d) => d.message.includes(flag));
    assert.ok(found, `expected a diagnostic for flag '${flag}' even with /g pattern`);
  }
});
