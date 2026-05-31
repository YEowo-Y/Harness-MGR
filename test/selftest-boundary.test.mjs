/**
 * P1.U16 -- selftest-boundary.test.mjs
 *
 * Hermetic tests for src/selftest/boundary.mjs.
 * Does NOT import the real paths.mjs; uses a fake assertWritable + fake roots
 * so the test is self-contained and never touches the filesystem for write checks.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FORBIDDEN_IMPORT_PREFIXES,
  checkStaticImports,
  checkWriteAllowlist,
  checkBoundary,
} from '../src/selftest/boundary.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoSrc = join(here, '..', 'src');

// ── fake roots + fake assertWritable ──────────────────────────────────────

// Build fake roots using join so all paths use the platform's native separator.
// join('/', 'fake', '.claude') on Windows = \fake\.claude; on POSIX = /fake/.claude.
// This keeps isUnderFake comparisons consistent across platforms.
const _fakeBase = join(sep, 'fake');
const _fakeTarget = join(_fakeBase, '.claude');
const fakeRoots = Object.freeze({
  targetClaudeDir: _fakeTarget,
  mgrStateDir: join(_fakeTarget, '.mgr-state'),
  mgrInstallDir: join(_fakeBase, 'mgr'),
});

/**
 * Platform-safe prefix check: is `child` equal to or under `parent`?
 * Uses path.sep so it works on both POSIX ('/') and Windows ('\').
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
function isUnderFake(child, parent) {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

const FAKE_PROBE_NAME_RE = /^__mgr-probe-[0-9a-f-]+\.md$/i;
const FAKE_APPLY_WRITABLE_FILES = ['settings.json', 'settings.local.json', '.mcp.json'];

/**
 * Correct fake that mirrors the real assertWritable rules.
 * @param {string} target
 * @param {string} [context]
 * @returns {string}
 */
function fakeAssertWritable(target, context = 'apply') {
  const { targetClaudeDir, mgrStateDir } = fakeRoots;
  const ctx = (context === 'rollback' || context === 'probe') ? context : 'apply';

  // Always writable: under mgrStateDir
  if (isUnderFake(target, mgrStateDir)) {
    return target;
  }

  // Outside targetClaudeDir
  if (!isUnderFake(target, targetClaudeDir)) {
    throw Object.assign(new Error('outside target: ' + target), { code: 'write-outside-target' });
  }

  // Always-forbidden subtrees
  const forbidden = [
    join(targetClaudeDir, 'plugins', 'marketplaces'),
    join(targetClaudeDir, 'projects'),
  ];
  for (const f of forbidden) {
    if (isUnderFake(target, f)) {
      throw Object.assign(new Error('forbidden: ' + target), { code: 'write-forbidden' });
    }
  }

  // Probe context: only agents/__mgr-probe-*.md directly in agents/.
  // NOTE: this fake is intentionally string-only (no canonical()/realpath). The
  // real gate's traversal/symlink-escape handling is covered by paths.test.mjs,
  // not here — do not "upgrade" this fake to resolve paths.
  if (ctx === 'probe') {
    const agentsDir = join(targetClaudeDir, 'agents');
    const parentDir = target.slice(0, target.lastIndexOf(sep));
    const filename = target.slice(target.lastIndexOf(sep) + 1);
    if (parentDir === agentsDir && FAKE_PROBE_NAME_RE.test(filename)) {
      return target;
    }
    throw Object.assign(new Error('probe-only: ' + target), { code: 'write-probe-only' });
  }

  // Always-writable governed settings files (plan line 432): exact basename,
  // DIRECTLY under the config dir, in BOTH 'apply' and 'rollback'. String-only
  // match (consistent with this fake's design — see the probe note above).
  if (ctx === 'apply' || ctx === 'rollback') {
    const parentDir = target.slice(0, target.lastIndexOf(sep));
    const filename = target.slice(target.lastIndexOf(sep) + 1);
    if (parentDir === targetClaudeDir && FAKE_APPLY_WRITABLE_FILES.includes(filename)) {
      return target;
    }
  }

  // Rollback-only surfaces
  const rollbackOnly = [
    join(targetClaudeDir, 'CLAUDE.md'),
    join(targetClaudeDir, 'agents'),
    join(targetClaudeDir, 'skills'),
    join(targetClaudeDir, 'commands'),
    join(targetClaudeDir, 'hooks'),
  ];
  for (const r of rollbackOnly) {
    if (isUnderFake(target, r)) {
      if (ctx === 'rollback') return target;
      throw Object.assign(new Error('rollback-only: ' + target), { code: 'write-rollback-only' });
    }
  }

  // Everything else under targetClaudeDir
  throw Object.assign(new Error('not allowed: ' + target), { code: 'write-not-allowed' });
}

// ── A. checkWriteAllowlist: correct fake -> zero diagnostics ──────────────

test('checkWriteAllowlist: correct fake -> zero diagnostics', () => {
  const diags = checkWriteAllowlist(fakeAssertWritable, fakeRoots);
  const errors = diags.filter((d) => d.severity === 'error');
  assert.deepEqual(errors, [], `unexpected errors: ${JSON.stringify(errors)}`);
});

// ── B. checkWriteAllowlist: wrong fake (allows outside) -> boundary-write-allowed-unexpectedly

test('checkWriteAllowlist: fake that wrongly allows outside path -> boundary-write-allowed-unexpectedly', () => {
  // This fake always returns the target (never throws)
  function wrongFake(target) { return target; }

  const diags = checkWriteAllowlist(wrongFake, fakeRoots);
  const errCodes = diags.filter((d) => d.severity === 'error').map((d) => d.code);
  // The outside-path case should fire
  assert.ok(
    errCodes.includes('boundary-write-allowed-unexpectedly'),
    `expected boundary-write-allowed-unexpectedly in ${JSON.stringify(errCodes)}`,
  );
});

// ── C. checkWriteAllowlist: fake throws wrong code for outside path -> boundary-write-wrong-code

test('checkWriteAllowlist: fake throws wrong code for outside path -> boundary-write-wrong-code', () => {
  function wrongCodeFake(target, context) {
    const { targetClaudeDir, mgrStateDir } = fakeRoots;

    if (isUnderFake(target, mgrStateDir)) return target;

    if (!isUnderFake(target, targetClaudeDir)) {
      // Wrong code -- should be write-outside-target
      throw Object.assign(new Error('oops'), { code: 'some-other-code' });
    }

    // For everything else, delegate to correct fake
    return fakeAssertWritable(target, context);
  }

  const diags = checkWriteAllowlist(wrongCodeFake, fakeRoots);
  const errCodes = diags.filter((d) => d.severity === 'error').map((d) => d.code);
  assert.ok(
    errCodes.includes('boundary-write-wrong-code'),
    `expected boundary-write-wrong-code in ${JSON.stringify(errCodes)}`,
  );
});

// ── D. checkStaticImports: forbidden prefix detected ─────────────────────

test('checkStaticImports: static from-import with forbidden prefix -> boundary-forbidden-import', () => {
  const files = [
    { path: 'a.mjs', source: "import x from '../vendor/cco/y.mjs'" },
  ];
  const diags = checkStaticImports(files, ['../vendor/cco/']);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].code, 'boundary-forbidden-import');
  assert.equal(diags[0].severity, 'error');
  assert.equal(diags[0].path, 'a.mjs');
  assert.equal(diags[0].phase, 'boundary');
});

test('checkStaticImports: dynamic import() with forbidden prefix -> boundary-forbidden-import', () => {
  const files = [
    { path: 'b.mjs', source: "const m = await import('../vendor/cco/x.mjs')" },
  ];
  const diags = checkStaticImports(files, ['../vendor/cco/']);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].code, 'boundary-forbidden-import');
  assert.equal(diags[0].severity, 'error');
  assert.equal(diags[0].path, 'b.mjs');
  assert.equal(diags[0].phase, 'boundary');
});

test('checkStaticImports: both static and dynamic forbidden imports in one file -> two diagnostics', () => {
  const files = [
    {
      path: 'c.mjs',
      source: [
        "import x from '../vendor/cco/y.mjs'",
        "const m = await import('../vendor/cco/x.mjs')",
      ].join('\n'),
    },
  ];
  const diags = checkStaticImports(files, ['../vendor/cco/']);
  assert.equal(diags.length, 2);
  assert.ok(diags.every((d) => d.code === 'boundary-forbidden-import'));
});

test('checkStaticImports: default empty prefixes -> zero diagnostics', () => {
  const files = [
    { path: 'a.mjs', source: "import x from '../vendor/cco/y.mjs'" },
  ];
  // Use the module default (empty freeze list)
  const diags = checkStaticImports(files, FORBIDDEN_IMPORT_PREFIXES);
  assert.deepEqual(diags, []);
});

test('checkStaticImports: no prefix arg -> zero diagnostics (empty default)', () => {
  const files = [
    { path: 'a.mjs', source: "import foo from 'some-external-pkg'" },
  ];
  const diags = checkStaticImports(files);
  assert.deepEqual(diags, []);
});

// ── E. checkBoundary with real src/ -> boundary-runtime-skipped info, no errors ─

test('checkBoundary with real src dir, no runtime -> boundary-runtime-skipped info, no errors', () => {
  const { diagnostics } = checkBoundary({ srcDir: repoSrc });
  const errors = diagnostics.filter((d) => d.severity === 'error');
  assert.deepEqual(errors, [], `unexpected errors in real src: ${JSON.stringify(errors)}`);

  const skipped = diagnostics.filter((d) => d.code === 'boundary-runtime-skipped');
  assert.ok(skipped.length >= 1, 'expected at least one boundary-runtime-skipped info diagnostic');
  assert.equal(skipped[0].severity, 'info');
  assert.equal(skipped[0].phase, 'boundary');
});

// ── F. checkBoundary with assertWritable + roots -> zero errors ───────────

test('checkBoundary with correct fake assertWritable + roots -> zero errors', () => {
  const { diagnostics } = checkBoundary({
    srcDir: repoSrc,
    assertWritable: fakeAssertWritable,
    roots: fakeRoots,
  });
  const errors = diagnostics.filter((d) => d.severity === 'error');
  assert.deepEqual(errors, [], `unexpected errors: ${JSON.stringify(errors)}`);
  // No skipped diagnostic since runtime ran
  const skipped = diagnostics.filter((d) => d.code === 'boundary-runtime-skipped');
  assert.equal(skipped.length, 0);
});

// ── G. Never-throws on bad input ──────────────────────────────────────────

test('checkStaticImports: never throws on null/undefined/garbage input', () => {
  assert.doesNotThrow(() => checkStaticImports(null));
  assert.doesNotThrow(() => checkStaticImports(undefined));
  assert.doesNotThrow(() => checkStaticImports([]));
  assert.doesNotThrow(() => checkStaticImports([null, undefined, 42, { path: 1, source: 2 }]));
  assert.doesNotThrow(() => checkStaticImports([{ path: 'f', source: 'ok' }], null));
  assert.doesNotThrow(() => checkStaticImports([{ path: 'f', source: 'ok' }], 42));
});

test('checkWriteAllowlist: never throws on bad input, returns boundary-runtime-bad-input error', () => {
  // All bad-input paths must not throw and must emit boundary-runtime-bad-input (error),
  // never boundary-runtime-skipped (which is INFO-only and emitted only by checkBoundary).
  for (const call of [
    () => checkWriteAllowlist(null, null),
    () => checkWriteAllowlist(undefined, undefined),
    () => checkWriteAllowlist(() => {}, null),
    () => checkWriteAllowlist(() => {}, { targetClaudeDir: 1, mgrStateDir: 2 }),
  ]) {
    let result;
    assert.doesNotThrow(() => { result = call(); });
    assert.ok(Array.isArray(result), 'expected array result');
    assert.ok(
      result.some((d) => d.code === 'boundary-runtime-bad-input' && d.severity === 'error'),
      `expected boundary-runtime-bad-input error in ${JSON.stringify(result)}`,
    );
    assert.ok(
      !result.some((d) => d.code === 'boundary-runtime-skipped'),
      `boundary-runtime-skipped must not appear in bad-input path: ${JSON.stringify(result)}`,
    );
  }
});

test('checkBoundary: never throws on bad/missing input', () => {
  assert.doesNotThrow(() => checkBoundary());
  assert.doesNotThrow(() => checkBoundary({}));
  assert.doesNotThrow(() => checkBoundary({ srcDir: '/nonexistent/path/xyz' }));
  assert.doesNotThrow(() => checkBoundary({ srcDir: null, assertWritable: null, roots: null }));
});

// ── H. FORBIDDEN_IMPORT_PREFIXES shape ───────────────────────────────────

test('FORBIDDEN_IMPORT_PREFIXES is a frozen empty array', () => {
  assert.ok(Array.isArray(FORBIDDEN_IMPORT_PREFIXES));
  assert.equal(FORBIDDEN_IMPORT_PREFIXES.length, 0);
  assert.ok(Object.isFrozen(FORBIDDEN_IMPORT_PREFIXES));
});

// ── I. phase field is always set correctly ────────────────────────────────

test('all diagnostics from checkBoundary carry phase:boundary', () => {
  const { diagnostics } = checkBoundary({ srcDir: repoSrc });
  for (const d of diagnostics) {
    assert.equal(d.phase, 'boundary', `diagnostic missing phase:boundary -- ${JSON.stringify(d)}`);
  }
});

// ── J. Spawn-spec guardrail end-to-end via checkBoundary over real src ────
// Proves the wiring: the same path selftest --boundary (selftest-command.mjs:286)
// and release-gate step 4 (release-gate.mjs:144) use emits zero spawn-spec-* errors.

test('checkBoundary over real src emits zero spawn-spec-* errors', () => {
  const { diagnostics } = checkBoundary({ srcDir: repoSrc });
  const spawnSpecErrors = diagnostics.filter(
    (d) => d.severity === 'error' && typeof d.code === 'string' && d.code.startsWith('spawn-spec-'),
  );
  assert.deepEqual(
    spawnSpecErrors,
    [],
    `real registry must be clean through checkBoundary, got: ${JSON.stringify(spawnSpecErrors)}`,
  );
});
