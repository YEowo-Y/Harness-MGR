/**
 * Integration tests for src/selftest/release-gate-seams.mjs — the REAL seam
 * implementations the release-gate CLI path uses.
 *
 * These spawn `node --test` / a doctor gather, but ONLY over tiny TEMP dirs or a
 * clean fixture — NEVER the repo's own ~1100-test suite (no reentrancy). Coverage:
 *   - readCoverageSummary: valid map / non-object JSON / missing file.
 *   - defaultChangedSrcFiles: real repo root → .mjs paths; bad root → [] (never throws).
 *   - defaultRunDoctorPassive: clean fixture → {pass:true, detail}.
 *   - defaultRunTests: temp 1-file passing dir → {pass:true}; failing dir → {pass:false}.
 *   - defaultRunCoverage: temp dir without node_modules/c8 → {coverageMap:null, 'c8 not found'}.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readCoverageSummary,
  defaultChangedSrcFiles,
  defaultRunDoctorPassive,
  defaultRunTests,
  defaultRunCoverage,
} from '../../src/selftest/release-gate-seams.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');             // test/integration → repo root
const minimalFixture = join(here, '..', 'fixtures', 'minimal');

/** Make a unique temp dir and return its path. */
function mkTemp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ── readCoverageSummary ──────────────────────────────────────────────────────

test('readCoverageSummary: valid summary → {absPath: {lines, branches}} map', () => {
  const dir = mkTemp('mgr-cov-ok-');
  try {
    const p = join(dir, 'coverage-summary.json');
    writeFileSync(p, JSON.stringify({
      total: { lines: { pct: 100 }, branches: { pct: 88 } },
      '/abs/src/a.mjs': { lines: { pct: 91.5 }, branches: { pct: 73.2 } },
      '/abs/src/b.mjs': { lines: { pct: 42 }, branches: { pct: 10 } },
      '/abs/src/no-lines.mjs': { statements: { pct: 50 } }, // no .lines.pct → skipped
    }), 'utf8');
    const { coverageMap, detail } = readCoverageSummary(p);
    assert.ok(coverageMap && typeof coverageMap === 'object');
    // Both line AND branch pct are now captured per file.
    assert.equal(coverageMap['/abs/src/a.mjs'].lines, 91.5);
    assert.equal(coverageMap['/abs/src/a.mjs'].branches, 73.2,
      'branches.pct must be captured (the new branch dimension)');
    assert.equal(coverageMap['/abs/src/b.mjs'].lines, 42);
    assert.equal(coverageMap['/abs/src/b.mjs'].branches, 10);
    assert.equal(coverageMap['total'].lines, 100);
    assert.equal(coverageMap['total'].branches, 88);
    assert.ok(!('/abs/src/no-lines.mjs' in coverageMap), 'entries without lines.pct are skipped');
    assert.ok(detail.includes('parsed'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readCoverageSummary: missing branches.pct defaults to 100 (never blocks)', () => {
  const dir = mkTemp('mgr-cov-nobranch-');
  try {
    const p = join(dir, 'coverage-summary.json');
    writeFileSync(p, JSON.stringify({
      '/abs/src/a.mjs': { lines: { pct: 95 } },                       // no branches field
      '/abs/src/b.mjs': { lines: { pct: 95 }, branches: { pct: 'x' } }, // non-numeric branches.pct
    }), 'utf8');
    const { coverageMap } = readCoverageSummary(p);
    assert.equal(coverageMap['/abs/src/a.mjs'].lines, 95);
    assert.equal(coverageMap['/abs/src/a.mjs'].branches, 100,
      'absent branches.pct must default to 100 so it never blocks');
    assert.equal(coverageMap['/abs/src/b.mjs'].branches, 100,
      'non-numeric branches.pct must default to 100');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readCoverageSummary: non-object JSON → coverageMap null', () => {
  const dir = mkTemp('mgr-cov-bad-');
  try {
    const p = join(dir, 'coverage-summary.json');
    writeFileSync(p, '42', 'utf8'); // valid JSON, not an object
    const { coverageMap, detail } = readCoverageSummary(p);
    assert.equal(coverageMap, null);
    assert.ok(detail.includes('not an object'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readCoverageSummary: missing/unreadable path → coverageMap null', () => {
  const dir = mkTemp('mgr-cov-missing-');
  try {
    const { coverageMap, detail } = readCoverageSummary(join(dir, 'does-not-exist.json'));
    assert.equal(coverageMap, null);
    assert.ok(detail.includes('could not read'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── defaultChangedSrcFiles ───────────────────────────────────────────────────

test('defaultChangedSrcFiles: real repo root → array of .mjs paths', () => {
  const out = defaultChangedSrcFiles({ repoRoot });
  assert.ok(Array.isArray(out), 'returns an array');
  for (const p of out) {
    assert.equal(typeof p, 'string');
    assert.ok(p.endsWith('.mjs'), `every entry ends with .mjs (got ${p})`);
  }
});

test('defaultChangedSrcFiles: bad repoRoot → [] (never throws)', () => {
  let out;
  assert.doesNotThrow(() => { out = defaultChangedSrcFiles({ repoRoot: join(tmpdir(), 'definitely-not-a-git-repo-xyz') }); });
  assert.deepEqual(out, []);
});

test('defaultChangedSrcFiles: base starting with "-" is ignored (no flag injection), still an array', () => {
  // The MEDIUM-2 guard: a base beginning with '-' must NOT be passed to merge-base;
  // it falls through to the default HEAD diff, which still returns a .mjs array.
  let out;
  assert.doesNotThrow(() => { out = defaultChangedSrcFiles({ repoRoot, base: '--upload-pack=evil' }); });
  assert.ok(Array.isArray(out));
  for (const p of out) assert.ok(p.endsWith('.mjs'));
});

// ── defaultRunDoctorPassive ──────────────────────────────────────────────────

test('defaultRunDoctorPassive: hermetic fixture → object with boolean pass (no spawn)', async () => {
  // The seam now ignores configDir and always runs over the synthetic hermetic
  // fixture tree (test/fixtures/real-snapshot/). The passed configDir is kept for
  // backward-compatible signature but has no effect on the gating decision.
  const r = await defaultRunDoctorPassive({ configDir: minimalFixture, mgrStateDir: '' });
  assert.ok(r && typeof r === 'object');
  assert.equal(typeof r.pass, 'boolean');
  assert.equal(typeof r.detail, 'string');
  // The hermetic fixture yields 0 doctor errors → pass true.
  assert.equal(r.pass, true, `expected pass true on the hermetic fixture, detail: ${r.detail}`);
});

// ── defaultRunTests (temp 1-file dirs — NOT the repo suite) ───────────────────

test('defaultRunTests: temp dir with one passing test → {pass:true}', () => {
  const dir = mkTemp('mgr-runtests-pass-');
  try {
    writeFileSync(join(dir, 'x.test.mjs'),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('ok', () => assert.equal(1, 1));\n", 'utf8');
    const r = defaultRunTests({ repoRoot: dir });
    assert.equal(r.pass, true, `detail: ${r.detail}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('defaultRunTests: temp dir with one failing test → {pass:false}', () => {
  const dir = mkTemp('mgr-runtests-fail-');
  try {
    writeFileSync(join(dir, 'x.test.mjs'),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('boom', () => assert.equal(1, 2));\n", 'utf8');
    const r = defaultRunTests({ repoRoot: dir });
    assert.equal(r.pass, false, `detail: ${r.detail}`);
    assert.ok(r.detail.includes('node --test exited'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── defaultRunCoverage (no c8 in a temp dir) ──────────────────────────────────

test('defaultRunCoverage: temp dir without node_modules/c8 → {coverageMap:null, "c8 not found"}', () => {
  const dir = mkTemp('mgr-runcov-noc8-');
  try {
    const r = defaultRunCoverage({ repoRoot: dir });
    assert.equal(r.coverageMap, null);
    assert.ok(r.detail.includes('c8 not found'), `detail: ${r.detail}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── defaultRunDoctorPassive over the hermetic fixture ─────────────────────────

test('defaultRunDoctorPassive (default): fixture-backed → pass:true, detail mentions "fixture"', async () => {
  const r = await defaultRunDoctorPassive({});
  assert.ok(r && typeof r === 'object', 'returns object');
  assert.equal(typeof r.pass, 'boolean', 'has boolean pass');
  assert.equal(typeof r.detail, 'string', 'has string detail');
  assert.equal(r.pass, true, `expected pass true (fixture run), detail: ${r.detail}`);
  assert.ok(r.detail.includes('fixture'), `detail should mention "fixture": ${r.detail}`);
});

test('defaultRunDoctorPassive (default): configDir-independent — bogus configDir still passes', async () => {
  const r = await defaultRunDoctorPassive({ configDir: '/no/such/path/synthetic-bogus', mgrStateDir: '/no/such/state' });
  assert.equal(r.pass, true, `expected pass true regardless of configDir, detail: ${r.detail}`);
});

test('defaultRunDoctorPassive (default): no-args call → pass:true (fixture path resolved from module URL)', async () => {
  const r = await defaultRunDoctorPassive();
  assert.equal(r.pass, true, `expected pass true with no args, detail: ${r.detail}`);
});
