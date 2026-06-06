/**
 * Hermetic unit tests for src/selftest/write-gate-completeness.mjs.
 *
 * The cross-phase invariant: every src/ module that CALLS an fs-mutation seam on
 * a code line must reference `assertWritable` (gated) or be on the EXEMPT_MODULES
 * allowlist (an audited non-governed writer).
 *
 * FALSIFIABILITY:
 *   - A synthetic gated mutator MUST be clean.
 *   - A synthetic ungated, non-exempt mutator MUST yield write-gate-unguarded.
 *   - A seam mention only in a comment/JSDoc line MUST NOT trigger.
 *   - An EXEMPT-id ungated mutator MUST be clean.
 *   - Non-array / garbage input MUST return [] without throwing.
 *   - The real src/ tree MUST yield zero write-gate-unguarded errors.
 *   - atomic-delete.mjs (the NEW governed-delete write path) MUST be detected as
 *     a mutator AND gated; stripping its assertWritable reference (in-memory) MUST
 *     flip it to write-gate-unguarded — proving the guard is falsifiable.
 *
 * Never touches the filesystem for writes. Pure logic + read-only src/ scan.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkWriteGateCompleteness,
  MUTATION_SEAMS,
  EXEMPT_MODULES,
} from '../src/selftest/write-gate-completeness.mjs';

// ── helpers ───────────────────────────────────────────────────────────────

/** Recursively collect absolute paths of src/**.mjs. */
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

function loadSrcFiles() {
  const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const files = [];
  for (const p of gatherMjs(srcDir)) {
    try { files.push({ path: p, source: readFileSync(p, 'utf-8') }); } catch { /* skip */ }
  }
  return files;
}

// ── 1. Gated mutator -> clean ──────────────────────────────────────────────

test('gated mutator (writeFileSync + assertWritable on code lines) -> no diagnostic', () => {
  const files = [
    {
      path: '/abs/src/ops/some-writer.mjs',
      source: [
        'import { writeFileSync } from "node:fs";',
        'export function write(target, assertWritable) {',
        '  assertWritable(target, "apply");',
        '  writeFileSync(target, "data", "utf8");',
        '}',
      ].join('\n'),
    },
  ];
  assert.deepEqual(checkWriteGateCompleteness(files), []);
});

// ── 2. Ungated, non-exempt mutator -> write-gate-unguarded ──────────────────

test('ungated non-exempt mutator (rmSync, no assertWritable) -> one write-gate-unguarded error', () => {
  const files = [
    {
      path: '/abs/src/ops/rogue-deleter.mjs',
      source: [
        'import { rmSync } from "node:fs";',
        'export function nuke(p) {',
        '  rmSync(p, { recursive: true });',
        '}',
      ].join('\n'),
    },
  ];
  const diags = checkWriteGateCompleteness(files);
  assert.equal(diags.length, 1, `expected 1 error, got: ${JSON.stringify(diags)}`);
  assert.equal(diags[0].code, 'write-gate-unguarded');
  assert.equal(diags[0].severity, 'error');
  assert.equal(diags[0].phase, 'boundary');
  assert.ok(diags[0].message.includes('rogue-deleter'), 'message should name the offending module');
  assert.equal(diags[0].path, '/abs/src/ops/rogue-deleter.mjs');
});

// ── 3. Seam only in comment / JSDoc lines -> no diagnostic ──────────────────

test('mutation seam only in a // comment or * jsdoc line -> no diagnostic (code-line detection)', () => {
  const files = [
    {
      path: '/abs/src/ops/doc-only.mjs',
      source: [
        '/**',
        ' * This module never calls writeFileSync( directly — it delegates.',
        ' */',
        '// rmSync({recursive}) is intentionally avoided here.',
        'export function noop() { return 42; }',
      ].join('\n'),
    },
  ];
  assert.deepEqual(checkWriteGateCompleteness(files), []);
});

// 3b. A seam name without a call paren (import / seam-variable) -> not detected.
test('seam name in an import or `?? seam` reference (no call paren) -> no diagnostic', () => {
  const files = [
    {
      path: '/abs/src/ops/seam-var.mjs',
      source: [
        'import { unlinkSync, statSync } from "node:fs";',
        'export function del(p, seams) {',
        '  const unlinkFn = seams.unlink ?? unlinkSync;',
        '  unlinkFn(p);', // call is via the variable, not unlinkSync(
        '}',
      ].join('\n'),
    },
  ];
  assert.deepEqual(checkWriteGateCompleteness(files), []);
});

// ── 4. Exempt-id ungated mutator -> clean ──────────────────────────────────

test('exempt-id module that mutates without a gate -> no diagnostic (on the allowlist)', () => {
  // Use a real exempt id so the basename resolves into EXEMPT_MODULES.
  const exemptId = [...EXEMPT_MODULES][0];
  const files = [
    {
      path: `/abs/src/ops/${exemptId}.mjs`,
      source: [
        'import { rmSync } from "node:fs";',
        'export function cleanup(dir) { rmSync(dir, { recursive: true }); }',
      ].join('\n'),
    },
  ];
  assert.deepEqual(checkWriteGateCompleteness(files), []);
});

// ── 5. Never-throws on null / garbage input ────────────────────────────────

test('checkWriteGateCompleteness: never throws on null/garbage input, returns []', () => {
  assert.doesNotThrow(() => checkWriteGateCompleteness(null));
  assert.deepEqual(checkWriteGateCompleteness(null), []);
  assert.deepEqual(checkWriteGateCompleteness(undefined), []);
  assert.deepEqual(checkWriteGateCompleteness(42), []);
  assert.deepEqual(checkWriteGateCompleteness('hello'), []);
  assert.deepEqual(checkWriteGateCompleteness({}), []);
  assert.deepEqual(checkWriteGateCompleteness([null, undefined, 42, {}, { path: 'x' }]), []);
});

// ── 6. selftest/ files are excluded ────────────────────────────────────────

test('selftest/ files are excluded even if they call a mutation seam without a gate', () => {
  const files = [
    {
      path: `/abs/src${sep}selftest${sep}some-infra.mjs`,
      source: [
        'import { writeFileSync } from "node:fs";',
        'export function w(p) { writeFileSync(p, "x"); }',
      ].join('\n'),
    },
  ];
  assert.deepEqual(checkWriteGateCompleteness(files), []);
});

// ── 7. MUTATION_SEAMS / EXEMPT_MODULES shape ───────────────────────────────

test('MUTATION_SEAMS is a frozen non-empty array of strings', () => {
  assert.ok(Array.isArray(MUTATION_SEAMS));
  assert.ok(MUTATION_SEAMS.length > 0);
  assert.ok(Object.isFrozen(MUTATION_SEAMS));
  for (const s of MUTATION_SEAMS) assert.equal(typeof s, 'string');
});

test('EXEMPT_MODULES is a frozen Set of strings', () => {
  assert.ok(EXEMPT_MODULES instanceof Set);
  assert.ok(Object.isFrozen(EXEMPT_MODULES));
  for (const id of EXEMPT_MODULES) assert.equal(typeof id, 'string');
});

// ── 7c. selftest-command is explicitly in EXEMPT_MODULES ──────────────────

test('selftest-command is in EXEMPT_MODULES and exempt branch clears it without checking assertWritable', () => {
  // Confirm the entry is present.
  assert.ok(EXEMPT_MODULES.has('selftest-command'), 'selftest-command must be in EXEMPT_MODULES');

  // A synthetic selftest-command module that calls writeFileSync WITHOUT any
  // assertWritable reference must yield no diagnostic — cleared by exemption,
  // not coincidentally by the assertWritable check.
  const files = [
    {
      path: '/abs/src/cli/selftest-command.mjs',
      source: [
        'import { writeFileSync } from "node:fs";',
        'export function updateBaseline(path, data) {',
        '  writeFileSync(path, JSON.stringify(data), "utf8");',
        '}',
      ].join('\n'),
    },
  ];
  assert.deepEqual(checkWriteGateCompleteness(files), []);
});

// ── 8. Real src/ tree -> zero write-gate-unguarded errors (headline) ───────

test('real src/ tree -> zero write-gate-unguarded errors (every writer is gated or exempt)', () => {
  const files = loadSrcFiles();
  assert.ok(files.length > 0, 'expected to load some src/ files');
  const diags = checkWriteGateCompleteness(files);
  const errors = diags.filter((d) => d.code === 'write-gate-unguarded');
  assert.deepEqual(
    errors,
    [],
    `real src/ tree must have no ungated governed writers, got: ${JSON.stringify(errors)}`,
  );
});

// ── 9. atomic-delete.mjs is detected as a GATED mutator (proof for U1b) ─────

test('atomic-delete.mjs is detected as a mutator AND is gated', () => {
  const files = loadSrcFiles();
  const atomicDelete = files.find((f) => f.path.endsWith(`${sep}atomic-delete.mjs`));
  assert.ok(atomicDelete, 'atomic-delete.mjs must exist in src/');

  // It must contain a mutation-seam CALL on a code line.
  const callRe = new RegExp(`\\b(?:${MUTATION_SEAMS.join('|')})\\s*\\(`);
  const hasMutationCall = atomicDelete.source
    .split('\n')
    .some((l) => {
      const t = l.trim();
      return t.length > 0 && !t.startsWith('*') && !t.startsWith('//') && callRe.test(t);
    });
  assert.ok(hasMutationCall, 'atomic-delete.mjs must call an fs-mutation seam');

  // And it must reference assertWritable on a code line (gated) -> no diagnostic.
  const diags = checkWriteGateCompleteness([atomicDelete]);
  assert.deepEqual(diags, [], `atomic-delete.mjs must be gated (no diagnostic), got: ${JSON.stringify(diags)}`);
});

// 9b. Falsifiability: strip the assertWritable reference (in-memory) -> flagged.
test('atomic-delete.mjs WITHOUT its assertWritable reference -> write-gate-unguarded (falsifiable)', () => {
  const files = loadSrcFiles();
  const atomicDelete = files.find((f) => f.path.endsWith(`${sep}atomic-delete.mjs`));
  assert.ok(atomicDelete, 'atomic-delete.mjs must exist in src/');

  // Remove every `assertWritable` token from a COPY of the source. The module is
  // not on EXEMPT_MODULES, so losing its gate reference must make the check fire.
  const ungated = {
    path: atomicDelete.path,
    source: atomicDelete.source.replace(/assertWritable/g, 'someOtherFn'),
  };
  const diags = checkWriteGateCompleteness([ungated]);
  const errors = diags.filter((d) => d.code === 'write-gate-unguarded');
  assert.equal(errors.length, 1, `expected exactly 1 write-gate-unguarded, got: ${JSON.stringify(diags)}`);
  assert.ok(errors[0].message.includes('atomic-delete'), 'message should name atomic-delete');
});
