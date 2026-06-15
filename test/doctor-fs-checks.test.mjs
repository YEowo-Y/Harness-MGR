/**
 * P2.U6b — doctor-fs-checks.test.mjs
 *
 * Tests for the five pure filesystem doctor checks:
 *   #13 claude-md-backup-bloat
 *   #14 snapshot-retention
 *   #20 probe-residue
 *   #21 apply-leftover-files
 *   #25 config-rules-stale
 *
 * All checks are pure (no I/O, no clock — they read input.now injected by caller).
 * Exercised directly via FS_CHECKS and also via runDoctor() for integration.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor, CHECKS } from '../src/analysis/doctor/index.mjs';
import { FS_CHECKS } from '../src/analysis/doctor/fs-checks.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1.8e12; // fixed reference time — deterministic, far from epoch

/** Find a check in FS_CHECKS by numeric id. */
function byId(id) {
  const c = FS_CHECKS.find((ch) => ch.id === id);
  assert.ok(c, `check #${id} not found in FS_CHECKS`);
  return c;
}

/** Filter a Diagnostic[] by code. */
const byCode = (diags, code) => diags.filter((d) => d.code === code);

// ══════════════════════════════════════════════════════════════════════════════
// A. #13 claude-md-backup-bloat
// ══════════════════════════════════════════════════════════════════════════════

test('#13: count 3 (boundary, not MORE than 3) → no findings', () => {
  const check = byId(13);
  const diags = check.run({ fsFacts: { claudeMdBackups: { count: 3 } } });
  assert.deepEqual(diags, []);
});

test('#13: count 4 → exactly one info claude-md-backup-bloat', () => {
  const check = byId(13);
  const diags = check.run({ fsFacts: { claudeMdBackups: { count: 4 } } });
  assert.equal(diags.length, 1);
  assert.equal(diags[0].severity, 'info');
  assert.equal(diags[0].code, 'claude-md-backup-bloat');
  assert.match(diags[0].message, /4/);
  assert.equal(diags[0].phase, 'doctor');
  assert.equal(typeof diags[0].fix, 'string');
});

test('#13: count 0 → no findings', () => {
  const check = byId(13);
  assert.deepEqual(check.run({ fsFacts: { claudeMdBackups: { count: 0 } } }), []);
});

test('#13: count 10 → one finding mentioning 10', () => {
  const check = byId(13);
  const diags = check.run({ fsFacts: { claudeMdBackups: { count: 10 } } });
  assert.equal(diags.length, 1);
  assert.match(diags[0].message, /10/);
});

test('#13: missing fsFacts → no findings, no throw', () => {
  const check = byId(13);
  let diags;
  assert.doesNotThrow(() => { diags = check.run({}); });
  assert.deepEqual(diags, []);
});

test('#13: fsFacts present but claudeMdBackups absent → no findings', () => {
  const check = byId(13);
  assert.deepEqual(check.run({ fsFacts: {} }), []);
});

test('#13: claudeMdBackups.count is non-numeric → treated as 0, no findings', () => {
  const check = byId(13);
  const diags = check.run({ fsFacts: { claudeMdBackups: { count: 'lots' } } });
  assert.deepEqual(diags, []);
});

// ══════════════════════════════════════════════════════════════════════════════
// B. #14 snapshot-retention
// ══════════════════════════════════════════════════════════════════════════════

test('#14: now absent → [] even with a very old snapshot', () => {
  const check = byId(14);
  const diags = check.run({
    fsFacts: { snapshots: [{ path: '/s/ancient', mtimeMs: 0 }] },
  });
  assert.deepEqual(diags, []);
});

test('#14: now present, snapshot 91 days old → one info snapshot-retention', () => {
  const check = byId(14);
  const diags = check.run({
    now: NOW,
    fsFacts: { snapshots: [{ path: '/s/old', mtimeMs: NOW - 91 * DAY }] },
  });
  assert.equal(diags.length, 1);
  assert.equal(diags[0].severity, 'info');
  assert.equal(diags[0].code, 'snapshot-retention');
  assert.equal(diags[0].path, '/s/old');
  assert.match(diags[0].message, /\/s\/old/);
  assert.equal(diags[0].phase, 'doctor');
  assert.equal(typeof diags[0].fix, 'string');
});

test('#14: snapshot exactly 90 days old (not STRICTLY more) → no findings', () => {
  const check = byId(14);
  const diags = check.run({
    now: NOW,
    fsFacts: { snapshots: [{ path: '/s/edge', mtimeMs: NOW - 90 * DAY }] },
  });
  assert.deepEqual(diags, []);
});

test('#14: snapshot 89 days old → no findings', () => {
  const check = byId(14);
  const diags = check.run({
    now: NOW,
    fsFacts: { snapshots: [{ path: '/s/fresh', mtimeMs: NOW - 89 * DAY }] },
  });
  assert.deepEqual(diags, []);
});

test('#14: future snapshot (mtimeMs > now) → no findings', () => {
  const check = byId(14);
  const diags = check.run({
    now: NOW,
    fsFacts: { snapshots: [{ path: '/s/future', mtimeMs: NOW + 10 * DAY }] },
  });
  assert.deepEqual(diags, []);
});

test('#14: two stale snapshots → two findings', () => {
  const check = byId(14);
  const diags = check.run({
    now: NOW,
    fsFacts: {
      snapshots: [
        { path: '/s/a', mtimeMs: NOW - 100 * DAY },
        { path: '/s/b', mtimeMs: NOW - 200 * DAY },
      ],
    },
  });
  assert.equal(diags.length, 2);
  assert.ok(diags.some((d) => d.path === '/s/a'));
  assert.ok(diags.some((d) => d.path === '/s/b'));
});

test('#14: mixed stale and fresh snapshots → only stale ones flagged', () => {
  const check = byId(14);
  const diags = check.run({
    now: NOW,
    fsFacts: {
      snapshots: [
        { path: '/s/stale', mtimeMs: NOW - 95 * DAY },
        { path: '/s/fresh', mtimeMs: NOW - 10 * DAY },
      ],
    },
  });
  assert.equal(diags.length, 1);
  assert.equal(diags[0].path, '/s/stale');
});

test('#14: snapshots absent in fsFacts → no findings', () => {
  const check = byId(14);
  assert.deepEqual(check.run({ now: NOW, fsFacts: {} }), []);
});

test('#14: snapshot entry missing path → finding emitted without path property', () => {
  const check = byId(14);
  const diags = check.run({
    now: NOW,
    fsFacts: { snapshots: [{ mtimeMs: NOW - 91 * DAY }] },
  });
  assert.equal(diags.length, 1);
  assert.equal(diags[0].code, 'snapshot-retention');
  // path should be undefined (not an empty string set as path)
  assert.ok(!Object.prototype.hasOwnProperty.call(diags[0], 'path') || diags[0].path === undefined);
});

test('#14: non-object entries in snapshots are skipped, no throw', () => {
  const check = byId(14);
  let diags;
  assert.doesNotThrow(() => {
    diags = check.run({
      now: NOW,
      fsFacts: { snapshots: [null, 42, 'bad', { path: '/s/real', mtimeMs: NOW - 91 * DAY }] },
    });
  });
  assert.equal(diags.length, 1);
  assert.equal(diags[0].path, '/s/real');
});

// ══════════════════════════════════════════════════════════════════════════════
// C. #20 probe-residue
// ══════════════════════════════════════════════════════════════════════════════

test('#20: two residue paths → two warn probe-residue findings', () => {
  const check = byId(20);
  const diags = check.run({ fsFacts: { probeResidue: ['/a', '/b'] } });
  assert.equal(diags.length, 2);
  assert.ok(diags.every((d) => d.severity === 'warn'));
  assert.ok(diags.every((d) => d.code === 'probe-residue'));
  assert.ok(diags.some((d) => d.path === '/a'));
  assert.ok(diags.some((d) => d.path === '/b'));
  assert.ok(diags.every((d) => d.phase === 'doctor'));
  assert.ok(diags.every((d) => typeof d.fix === 'string'));
});

test('#20: empty probeResidue → no findings', () => {
  const check = byId(20);
  assert.deepEqual(check.run({ fsFacts: { probeResidue: [] } }), []);
});

test('#20: empty-string entries are skipped', () => {
  const check = byId(20);
  const diags = check.run({ fsFacts: { probeResidue: ['', '/real'] } });
  assert.equal(diags.length, 1);
  assert.equal(diags[0].path, '/real');
});

test('#20: non-string entries are skipped, no throw', () => {
  const check = byId(20);
  let diags;
  assert.doesNotThrow(() => {
    diags = check.run({ fsFacts: { probeResidue: [null, 42, '/valid'] } });
  });
  assert.equal(diags.length, 1);
  assert.equal(diags[0].path, '/valid');
});

test('#20: probeResidue absent in fsFacts → no findings', () => {
  const check = byId(20);
  assert.deepEqual(check.run({ fsFacts: {} }), []);
});

test('#20: missing fsFacts → no findings, no throw', () => {
  const check = byId(20);
  let diags;
  assert.doesNotThrow(() => { diags = check.run({}); });
  assert.deepEqual(diags, []);
});

test('#20: each finding message contains the path', () => {
  const check = byId(20);
  const diags = check.run({ fsFacts: { probeResidue: ['/tmp/probe-abc'] } });
  assert.equal(diags.length, 1);
  assert.match(diags[0].message, /\/tmp\/probe-abc/);
});

// ══════════════════════════════════════════════════════════════════════════════
// D. #21 apply-leftover-files
// ══════════════════════════════════════════════════════════════════════════════

test('#21: two leftover paths → two warn apply-leftover-files findings', () => {
  const check = byId(21);
  const diags = check.run({ fsFacts: { applyLeftovers: ['/x/foo.mgr-new', '/y/bar.mgr-old'] } });
  assert.equal(diags.length, 2);
  assert.ok(diags.every((d) => d.severity === 'warn'));
  assert.ok(diags.every((d) => d.code === 'apply-leftover-files'));
  assert.ok(diags.some((d) => d.path === '/x/foo.mgr-new'));
  assert.ok(diags.some((d) => d.path === '/y/bar.mgr-old'));
  assert.ok(diags.every((d) => d.phase === 'doctor'));
  assert.ok(diags.every((d) => typeof d.fix === 'string'));
});

test('#21: empty applyLeftovers → no findings', () => {
  const check = byId(21);
  assert.deepEqual(check.run({ fsFacts: { applyLeftovers: [] } }), []);
});

test('#21: empty-string entries are skipped', () => {
  const check = byId(21);
  const diags = check.run({ fsFacts: { applyLeftovers: ['', '/valid.mgr-new'] } });
  assert.equal(diags.length, 1);
  assert.equal(diags[0].path, '/valid.mgr-new');
});

test('#21: non-string entries are skipped, no throw', () => {
  const check = byId(21);
  let diags;
  assert.doesNotThrow(() => {
    diags = check.run({ fsFacts: { applyLeftovers: [null, 99, '/valid.mgr-old'] } });
  });
  assert.equal(diags.length, 1);
  assert.equal(diags[0].path, '/valid.mgr-old');
});

test('#21: applyLeftovers absent in fsFacts → no findings', () => {
  const check = byId(21);
  assert.deepEqual(check.run({ fsFacts: {} }), []);
});

test('#21: missing fsFacts → no findings, no throw', () => {
  const check = byId(21);
  let diags;
  assert.doesNotThrow(() => { diags = check.run({}); });
  assert.deepEqual(diags, []);
});

test('#21: each finding message contains the path', () => {
  const check = byId(21);
  const diags = check.run({ fsFacts: { applyLeftovers: ['/tmp/settings.json.mgr-new'] } });
  assert.equal(diags.length, 1);
  assert.match(diags[0].message, /\/tmp\/settings\.json\.mgr-new/);
});

// ══════════════════════════════════════════════════════════════════════════════
// E. #25 config-rules-stale
// ══════════════════════════════════════════════════════════════════════════════

test('#25: now absent → [] even with a very old doc', () => {
  const check = byId(25);
  const diags = check.run({
    fsFacts: { configRulesDoc: { path: '/d', mtimeMs: 0 } },
  });
  assert.deepEqual(diags, []);
});

test('#25: now <= 0 → no findings', () => {
  const check = byId(25);
  assert.deepEqual(check.run({ now: 0, fsFacts: { configRulesDoc: { path: '/d', mtimeMs: 1 } } }), []);
  assert.deepEqual(check.run({ now: -1, fsFacts: { configRulesDoc: { path: '/d', mtimeMs: 1 } } }), []);
});

test('#25: doc 91 days old → one info config-rules-stale with path', () => {
  const check = byId(25);
  const diags = check.run({
    now: NOW,
    fsFacts: { configRulesDoc: { path: '/d/rules.md', mtimeMs: NOW - 91 * DAY } },
  });
  assert.equal(diags.length, 1);
  assert.equal(diags[0].severity, 'info');
  assert.equal(diags[0].code, 'config-rules-stale');
  assert.equal(diags[0].path, '/d/rules.md');
  assert.equal(diags[0].phase, 'doctor');
  assert.equal(typeof diags[0].fix, 'string');
});

test('#25: doc exactly 90 days old (boundary, not strictly more) → no findings', () => {
  const check = byId(25);
  const diags = check.run({
    now: NOW,
    fsFacts: { configRulesDoc: { path: '/d', mtimeMs: NOW - 90 * DAY } },
  });
  assert.deepEqual(diags, []);
});

test('#25: doc 89 days old → no findings', () => {
  const check = byId(25);
  const diags = check.run({
    now: NOW,
    fsFacts: { configRulesDoc: { path: '/d', mtimeMs: NOW - 89 * DAY } },
  });
  assert.deepEqual(diags, []);
});

test('#25: configRulesDoc null → no findings', () => {
  const check = byId(25);
  assert.deepEqual(check.run({ now: NOW, fsFacts: { configRulesDoc: null } }), []);
});

test('#25: configRulesDoc absent in fsFacts → no findings', () => {
  const check = byId(25);
  assert.deepEqual(check.run({ now: NOW, fsFacts: {} }), []);
});

test('#25: missing fsFacts → no findings, no throw', () => {
  const check = byId(25);
  let diags;
  assert.doesNotThrow(() => { diags = check.run({ now: NOW }); });
  assert.deepEqual(diags, []);
});

test('#25: future doc (mtimeMs > now) → no findings', () => {
  const check = byId(25);
  const diags = check.run({
    now: NOW,
    fsFacts: { configRulesDoc: { path: '/d', mtimeMs: NOW + 10 * DAY } },
  });
  assert.deepEqual(diags, []);
});

// ══════════════════════════════════════════════════════════════════════════════
// E2. #16 disk-budget
// ══════════════════════════════════════════════════════════════════════════════

test('#16: diskUsage.bytes strictly over 5 GiB → one warn disk-budget with .path', () => {
  const check = byId(16);
  const diags = check.run({ fsFacts: { diskUsage: { path: '/s', bytes: 6 * 1024 * 1024 * 1024 } } });
  assert.equal(diags.length, 1);
  assert.equal(diags[0].severity, 'warn');
  assert.equal(diags[0].code, 'disk-budget');
  assert.equal(diags[0].path, '/s');
  assert.equal(diags[0].phase, 'doctor');
  assert.equal(typeof diags[0].fix, 'string');
});

test('#16: bytes exactly at 5 GiB boundary → [] (not strictly over)', () => {
  const check = byId(16);
  const diags = check.run({ fsFacts: { diskUsage: { path: '/s', bytes: 5 * 1024 * 1024 * 1024 } } });
  assert.deepEqual(diags, []);
});

test('#16: bytes 0 → []', () => {
  const check = byId(16);
  assert.deepEqual(check.run({ fsFacts: { diskUsage: { path: '/s', bytes: 0 } } }), []);
});

test('#16: diskUsage null → []', () => {
  const check = byId(16);
  assert.deepEqual(check.run({ fsFacts: { diskUsage: null } }), []);
});

test('#16: missing fsFacts → [], no throw', () => {
  const check = byId(16);
  let diags;
  assert.doesNotThrow(() => { diags = check.run({}); });
  assert.deepEqual(diags, []);
});

// ══════════════════════════════════════════════════════════════════════════════
// F. REGISTRY
// ══════════════════════════════════════════════════════════════════════════════

test('registry: FS_CHECKS ids are [13, 14, 16, 20, 21, 25]', () => {
  assert.deepEqual(FS_CHECKS.map((c) => c.id), [13, 14, 16, 20, 21, 25]);
});

test('registry: all FS_CHECKS are probeLevel passive', () => {
  assert.ok(FS_CHECKS.every((c) => c.probeLevel === 'passive'));
});

test('registry: ids 13, 14, 20, 21, 25 all present in the full CHECKS registry', () => {
  const ids = new Set(CHECKS.map((c) => c.id));
  for (const id of [13, 14, 20, 21, 25]) {
    assert.ok(ids.has(id), `id ${id} missing from CHECKS`);
  }
});

test('registry: full CHECKS length is 27', () => {
  assert.equal(CHECKS.length, 27);
});

test('registry: full id order is [1,2,3,5,18,6,7,8,9,10,11,12,22,23,13,14,16,20,21,25,17,24,26,27,4,15,19]', () => {
  assert.deepEqual(CHECKS.map((c) => c.id), [1, 2, 3, 5, 18, 6, 7, 8, 9, 10, 11, 12, 22, 23, 13, 14, 16, 20, 21, 25, 17, 24, 26, 27, 4, 15, 19]);
});

// ══════════════════════════════════════════════════════════════════════════════
// G. INTEGRATION — runDoctor() with multiple fs checks triggered
// ══════════════════════════════════════════════════════════════════════════════

test('integration: runDoctor triggers claude-md-backup-bloat, probe-residue, snapshot-retention together', () => {
  const r = runDoctor({
    now: NOW,
    fsFacts: {
      claudeMdBackups: { count: 5 },
      probeResidue: ['/x/probe'],
      snapshots: [{ path: '/s/old', mtimeMs: NOW - 100 * DAY }],
      applyLeftovers: [],
      configRulesDoc: null,
    },
  });
  const codes = new Set(r.diagnostics.map((d) => d.code));
  assert.ok(codes.has('claude-md-backup-bloat'), 'claude-md-backup-bloat must be present');
  assert.ok(codes.has('probe-residue'), 'probe-residue must be present');
  assert.ok(codes.has('snapshot-retention'), 'snapshot-retention must be present');
});

test('integration: runDoctor({}) emits no fs-check findings', () => {
  const r = runDoctor({});
  for (const code of ['claude-md-backup-bloat', 'snapshot-retention', 'probe-residue', 'apply-leftover-files', 'config-rules-stale']) {
    assert.equal(byCode(r.diagnostics, code).length, 0, `${code} must be 0 for empty input`);
  }
});

test('integration: all five fs codes emitted when all thresholds exceeded', () => {
  const r = runDoctor({
    now: NOW,
    fsFacts: {
      claudeMdBackups: { count: 5 },
      snapshots: [{ path: '/s/stale', mtimeMs: NOW - 100 * DAY }],
      probeResidue: ['/p/probe'],
      applyLeftovers: ['/a/left.mgr-new'],
      configRulesDoc: { path: '/d/rules.md', mtimeMs: NOW - 95 * DAY },
    },
  });
  const codes = new Set(r.diagnostics.map((d) => d.code));
  for (const code of ['claude-md-backup-bloat', 'snapshot-retention', 'probe-residue', 'apply-leftover-files', 'config-rules-stale']) {
    assert.ok(codes.has(code), `${code} must be emitted`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// H. PURITY / NEVER-THROW
// ══════════════════════════════════════════════════════════════════════════════

test('purity: runDoctor(undefined) does not throw and fs checks contribute 0 findings', () => {
  // FS checks are always called via runDoctor which coerces input to {}; undefined goes
  // through runDoctor safely (it guards before dispatching to individual checks).
  let r;
  assert.doesNotThrow(() => { r = runDoctor(undefined); });
  for (const code of ['claude-md-backup-bloat', 'snapshot-retention', 'probe-residue', 'apply-leftover-files', 'config-rules-stale']) {
    assert.equal(byCode(r.diagnostics, code).length, 0, `${code} must be 0 for undefined input`);
  }
});

test('purity: runDoctor(null) does not throw and fs checks contribute 0 findings', () => {
  // FS checks are always called via runDoctor which coerces input to {}; null goes
  // through runDoctor safely (it guards before dispatching to individual checks).
  let r;
  assert.doesNotThrow(() => { r = runDoctor(null); });
  for (const code of ['claude-md-backup-bloat', 'snapshot-retention', 'probe-residue', 'apply-leftover-files', 'config-rules-stale']) {
    assert.equal(byCode(r.diagnostics, code).length, 0, `${code} must be 0 for null input`);
  }
});
