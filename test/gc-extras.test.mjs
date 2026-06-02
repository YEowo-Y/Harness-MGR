/**
 * P3.U21 — gc-extras.test.mjs
 *
 * Tests src/ops/gc-extras.mjs: gcAuditLarge / gcOrphanLock / gcLeftoverSidecars +
 * the gcExtras orchestrator, over real temp `.mgr-state` dirs. Acceptance (DoD),
 * all falsifiable:
 *   - audit-large: an UNREFERENCED old file is the only orphan; a REFERENCED file
 *     is kept; a FRESH (<60s) unreferenced file is kept (race guard); dry-run
 *     previews, apply deletes.
 *   - lock: a dead+25h lock reaps; an alive lock is kept; a dead-but-recent lock
 *     is kept.
 *   - leftovers: an old `.mgr-old` is pruned; a fresh `.mgr-new` + a `.json` are
 *     kept; dry-run previews.
 *   - bounded: a subdir named like a sidecar is never followed/recursed.
 *   - gcExtras merges; never-throws on bad input / throwing seams.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  gcAuditLarge, gcOrphanLock, gcLeftoverSidecars, gcExtras,
} from '../src/ops/gc-extras.mjs';
import { lockPath } from '../src/ops/lock.mjs';

// ── helpers ───────────────────────────────────────────────────────────────────

/** A temp `.mgr-state` dir + cleanup. */
function makeStateDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-gcx-'));
  return {
    dir,
    cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

/** Set a file's mtime to N days ago (utimes wants seconds). */
function ageDays(path, days) {
  const when = new Date(Date.now() - days * 86400 * 1000);
  utimesSync(path, when, when);
}

/** Write a real apply.lock with the given holder JSON. */
function plantLock(stateDir, holder) {
  const lf = lockPath(stateDir);
  mkdirSync(join(stateDir, 'locks'), { recursive: true });
  writeFileSync(lf, JSON.stringify(holder), 'utf8');
  return lf;
}

/** killFn seam that reports a pid as dead (ESRCH) or alive. */
function deadKill() { return () => { const e = new Error('no such process'); e.code = 'ESRCH'; throw e; }; }
function aliveKill() { return () => { /* returns normally → alive */ }; }

const FIXED_NOW = 1_800_000_000_000; // a fixed clock for deterministic age math

// ── 1. gcAuditLarge ─────────────────────────────────────────────────────────────

test('gcAuditLarge: only the unreferenced OLD orphan is pruned; referenced + fresh kept', () => {
  const st = makeStateDir();
  try {
    const largeDir = join(st.dir, 'audit-large');
    mkdirSync(largeDir, { recursive: true });
    // audit.log references aaa.json via a pointer line.
    writeFileSync(join(st.dir, 'audit.log'),
      `${JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', large: true, ref: 'aaa.json', sha256: 'x' })}\n`,
      'utf8');
    const aaa = join(largeDir, 'aaa.json'); // referenced, OLD
    const bbb = join(largeDir, 'bbb.json'); // orphan, OLD
    const ccc = join(largeDir, 'ccc.json'); // orphan, FRESH (<60s) → race guard
    for (const f of [aaa, bbb, ccc]) writeFileSync(f, '{}', 'utf8');
    ageDays(aaa, 2);
    ageDays(bbb, 2);
    // ccc left fresh (current mtime)

    // Dry-run: only bbb would be deleted.
    const dry = gcAuditLarge({ mgrStateDir: st.dir });
    assert.deepEqual(dry.wouldDelete, ['bbb.json']);
    assert.deepEqual(dry.deleted, []);
    assert.ok(existsSync(bbb), 'dry-run must not delete');

    // Apply: bbb gone; aaa (referenced) + ccc (fresh) kept.
    const res = gcAuditLarge({ mgrStateDir: st.dir, apply: true });
    assert.deepEqual(res.deleted, ['bbb.json']);
    assert.equal(existsSync(bbb), false, 'orphan removed');
    assert.ok(existsSync(aaa), 'referenced kept');
    assert.ok(existsSync(ccc), 'fresh orphan kept (race guard)');
  } finally { st.cleanup(); }
});

test('gcAuditLarge: a PATH-SHAPED audit.log ref still protects the file from deletion (Low-3)', () => {
  const st = makeStateDir();
  try {
    const largeDir = join(st.dir, 'audit-large');
    mkdirSync(largeDir, { recursive: true });
    // A FUTURE writer that ever emits a path-shaped ref ('audit-large/referenced.json')
    // must still protect referenced.json — the ref is normalized to a basename before
    // the orphan check, so a referenced file is never mistaken for an orphan + deleted.
    writeFileSync(join(st.dir, 'audit.log'),
      `${JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', large: true, ref: 'audit-large/referenced.json', sha256: 'x' })}\n`,
      'utf8');
    const referenced = join(largeDir, 'referenced.json'); // protected by the path-shaped ref
    const orphan = join(largeDir, 'orphan.json');         // genuinely unreferenced
    for (const f of [referenced, orphan]) writeFileSync(f, '{}', 'utf8');
    ageDays(referenced, 2);
    ageDays(orphan, 2);

    const res = gcAuditLarge({ mgrStateDir: st.dir, apply: true });
    assert.deepEqual(res.deleted, ['orphan.json'], 'only the genuine orphan is deleted');
    assert.ok(existsSync(referenced), 'the path-shaped-ref file MUST be protected from deletion');
    assert.equal(existsSync(orphan), false, 'the unreferenced orphan is removed');
  } finally { st.cleanup(); }
});

test('gcAuditLarge: missing audit-large dir is benign (no orphans, no diag)', () => {
  const st = makeStateDir();
  try {
    const res = gcAuditLarge({ mgrStateDir: st.dir, apply: true });
    assert.deepEqual(res.deleted, []);
    assert.deepEqual(res.wouldDelete, []);
    assert.equal(res.diagnostics.length, 0);
  } finally { st.cleanup(); }
});

test('gcAuditLarge: missing audit.log → every audit-large file is unreferenced', () => {
  const st = makeStateDir();
  try {
    const largeDir = join(st.dir, 'audit-large');
    mkdirSync(largeDir, { recursive: true });
    const f = join(largeDir, 'zzz.json');
    writeFileSync(f, '{}', 'utf8');
    ageDays(f, 2);
    const res = gcAuditLarge({ mgrStateDir: st.dir });
    assert.deepEqual(res.wouldDelete, ['zzz.json']);
  } finally { st.cleanup(); }
});

// ── 2. gcOrphanLock ─────────────────────────────────────────────────────────────

test('gcOrphanLock: dead pid + 25h-old lock is reaped (apply)', () => {
  const st = makeStateDir();
  try {
    const startTime = new Date(FIXED_NOW - 25 * 3600 * 1000).toISOString();
    const lf = plantLock(st.dir, { pid: 4242, startTime, hostname: 'h' });

    // Dry-run: wouldReap, file survives.
    const dry = gcOrphanLock({ mgrStateDir: st.dir, now: () => FIXED_NOW, seams: { killFn: deadKill() } });
    assert.equal(dry.wouldReap, true);
    assert.equal(dry.reaped, false);
    assert.equal(dry.holder.pid, 4242);
    assert.ok(existsSync(lf), 'dry-run must not unlink');

    // Apply: reaped, file gone.
    const res = gcOrphanLock({ mgrStateDir: st.dir, apply: true, now: () => FIXED_NOW, seams: { killFn: deadKill() } });
    assert.equal(res.reaped, true);
    assert.equal(existsSync(lf), false, 'orphan lock removed');
    assert.ok(res.diagnostics.some((d) => d.code === 'gc-lock-reaped'));
  } finally { st.cleanup(); }
});

test('gcOrphanLock: alive holder is kept', () => {
  const st = makeStateDir();
  try {
    const startTime = new Date(FIXED_NOW - 25 * 3600 * 1000).toISOString();
    const lf = plantLock(st.dir, { pid: 5, startTime, hostname: 'h' });
    const res = gcOrphanLock({ mgrStateDir: st.dir, apply: true, now: () => FIXED_NOW, seams: { killFn: aliveKill() } });
    assert.equal(res.reaped, false);
    assert.equal(res.wouldReap, false);
    assert.ok(existsSync(lf), 'alive lock kept');
    assert.ok(res.diagnostics.some((d) => d.code === 'gc-lock-alive'));
  } finally { st.cleanup(); }
});

test('gcOrphanLock: dead but recent (1h) lock is kept', () => {
  const st = makeStateDir();
  try {
    const startTime = new Date(FIXED_NOW - 3600 * 1000).toISOString(); // 1h ago
    const lf = plantLock(st.dir, { pid: 6, startTime, hostname: 'h' });
    const res = gcOrphanLock({ mgrStateDir: st.dir, apply: true, now: () => FIXED_NOW, seams: { killFn: deadKill() } });
    assert.equal(res.reaped, false);
    assert.ok(existsSync(lf), 'dead-but-recent lock kept');
    assert.ok(res.diagnostics.some((d) => d.code === 'gc-lock-recent'));
  } finally { st.cleanup(); }
});

test('gcOrphanLock: absent lock is a no-op', () => {
  const st = makeStateDir();
  try {
    const res = gcOrphanLock({ mgrStateDir: st.dir, apply: true, now: () => FIXED_NOW, seams: { killFn: deadKill() } });
    assert.deepEqual({ reaped: res.reaped, wouldReap: res.wouldReap, holder: res.holder },
      { reaped: false, wouldReap: false, holder: null });
  } finally { st.cleanup(); }
});

test('gcOrphanLock: corrupt/unreadable lock is left for --break-lock', () => {
  const st = makeStateDir();
  try {
    const lf = lockPath(st.dir);
    mkdirSync(join(st.dir, 'locks'), { recursive: true });
    writeFileSync(lf, 'not json{', 'utf8');
    const res = gcOrphanLock({ mgrStateDir: st.dir, apply: true, now: () => FIXED_NOW, seams: { killFn: deadKill() } });
    assert.equal(res.reaped, false);
    assert.ok(existsSync(lf), 'corrupt lock kept');
    assert.ok(res.diagnostics.some((d) => d.code === 'gc-lock-corrupt'));
  } finally { st.cleanup(); }
});

// ── 3. gcLeftoverSidecars ───────────────────────────────────────────────────────

test('gcLeftoverSidecars: old .mgr-old pruned; fresh .mgr-new + keep.json kept', () => {
  const st = makeStateDir();
  try {
    const old = join(st.dir, 'foo.mgr-old');  // 8 days old → prune
    const fresh = join(st.dir, 'bar.mgr-new'); // fresh → keep
    const keep = join(st.dir, 'keep.json');    // not a sidecar → keep
    for (const f of [old, fresh, keep]) writeFileSync(f, 'x', 'utf8');
    ageDays(old, 8);

    const dry = gcLeftoverSidecars({ mgrStateDir: st.dir });
    assert.deepEqual(dry.wouldDelete, ['foo.mgr-old']);
    assert.ok(existsSync(old), 'dry-run must not delete');

    const res = gcLeftoverSidecars({ mgrStateDir: st.dir, apply: true });
    assert.deepEqual(res.deleted, ['foo.mgr-old']);
    assert.equal(existsSync(old), false, 'old sidecar removed');
    assert.ok(existsSync(fresh), 'fresh sidecar kept');
    assert.ok(existsSync(keep), 'non-sidecar kept');
  } finally { st.cleanup(); }
});

// ── bounded: no recursion / no symlink follow ───────────────────────────────────

test('gcLeftoverSidecars: a SUBDIR named like a sidecar is never followed/recursed', () => {
  const st = makeStateDir();
  try {
    // A directory whose NAME ends .mgr-old must be skipped (not a regular file).
    const subdir = join(st.dir, 'evil.mgr-old');
    mkdirSync(subdir, { recursive: true });
    // Plant a file INSIDE it that would be a prune target if recursion happened.
    const inner = join(subdir, 'inner.mgr-old');
    writeFileSync(inner, 'x', 'utf8');
    ageDays(inner, 30);

    const res = gcLeftoverSidecars({ mgrStateDir: st.dir, apply: true });
    assert.deepEqual(res.deleted, [], 'no sidecar deleted (dir skipped, no recursion)');
    assert.ok(existsSync(subdir), 'subdir untouched');
    assert.ok(existsSync(inner), 'inner file untouched (no recursion)');
  } finally { st.cleanup(); }
});

test('gcAuditLarge: a SUBDIR named *.json inside audit-large is skipped (no recurse)', () => {
  const st = makeStateDir();
  try {
    const largeDir = join(st.dir, 'audit-large');
    mkdirSync(join(largeDir, 'weird.json'), { recursive: true }); // a DIR named *.json
    writeFileSync(join(largeDir, 'weird.json', 'inner.json'), '{}', 'utf8');
    const res = gcAuditLarge({ mgrStateDir: st.dir, apply: true });
    assert.deepEqual(res.deleted, [], 'dir entry skipped, never recursed');
    assert.ok(existsSync(join(largeDir, 'weird.json')), 'dir untouched');
  } finally { st.cleanup(); }
});

// ── orchestrator ────────────────────────────────────────────────────────────────

test('gcExtras: runs all three, merges diagnostics', () => {
  const st = makeStateDir();
  try {
    // audit-large orphan (old) + dead/old lock + old sidecar — all three fire.
    const largeDir = join(st.dir, 'audit-large');
    mkdirSync(largeDir, { recursive: true });
    const orphanLarge = join(largeDir, 'orph.json');
    writeFileSync(orphanLarge, '{}', 'utf8');
    ageDays(orphanLarge, 5);

    const startTime = new Date(FIXED_NOW - 30 * 3600 * 1000).toISOString();
    plantLock(st.dir, { pid: 9999, startTime, hostname: 'h' });

    const sidecar = join(st.dir, 'x.mgr-new');
    writeFileSync(sidecar, 'x', 'utf8');
    ageDays(sidecar, 10);

    const res = gcExtras({ mgrStateDir: st.dir, apply: true, now: () => FIXED_NOW, seams: { killFn: deadKill() } });
    assert.deepEqual(res.auditLarge.deleted, ['orph.json']);
    assert.equal(res.lock.reaped, true);
    assert.deepEqual(res.leftovers.deleted, ['x.mgr-new']);
    // Merged diagnostics include all three sub-results' diagnostics.
    assert.equal(res.diagnostics.length,
      res.auditLarge.diagnostics.length + res.lock.diagnostics.length + res.leftovers.diagnostics.length);
    assert.ok(res.diagnostics.some((d) => d.code === 'gc-lock-reaped'));
  } finally { st.cleanup(); }
});

// ── never-throws ────────────────────────────────────────────────────────────────

test('never-throws: bad mgrStateDir → error diagnostics, no exception', () => {
  for (const fn of [gcAuditLarge, gcOrphanLock, gcLeftoverSidecars]) {
    const res = fn({ mgrStateDir: '' });
    assert.ok(res.diagnostics.some((d) => d.severity === 'error' && d.code === 'gc-bad-state-dir'),
      `${fn.name} must report gc-bad-state-dir`);
  }
  // Orchestrator over a bad dir also never throws and merges the three errors.
  const orch = gcExtras({ mgrStateDir: '' });
  assert.equal(orch.diagnostics.filter((d) => d.code === 'gc-bad-state-dir').length, 3);
});

test('never-throws: gcExtras with no opts at all does not throw', () => {
  const res = gcExtras();
  assert.ok(Array.isArray(res.diagnostics));
});

test('never-throws: a throwing readdir/stat seam degrades to a warn', () => {
  const st = makeStateDir();
  try {
    const boom = () => { throw new Error('seam boom'); };
    // audit-large: throwing direntFn → warn, no throw.
    const a = gcAuditLarge({ mgrStateDir: st.dir, apply: true, seams: { direntFn: boom } });
    assert.deepEqual(a.deleted, []);
    assert.ok(a.diagnostics.some((d) => d.code === 'gc-audit-large-unreadable' && d.severity === 'warn'));

    // leftovers: throwing direntFn → warn, no throw.
    const l = gcLeftoverSidecars({ mgrStateDir: st.dir, apply: true, seams: { direntFn: boom } });
    assert.deepEqual(l.deleted, []);
    assert.ok(l.diagnostics.some((d) => d.code === 'gc-leftover-unreadable' && d.severity === 'warn'));
  } finally { st.cleanup(); }
});

test('never-throws: a throwing unlink during apply degrades to a warn (file-level)', () => {
  const st = makeStateDir();
  try {
    const old = join(st.dir, 'z.mgr-old');
    writeFileSync(old, 'x', 'utf8');
    ageDays(old, 30);
    const boom = () => { throw new Error('unlink boom'); };
    const res = gcLeftoverSidecars({ mgrStateDir: st.dir, apply: true, seams: { unlink: boom } });
    assert.deepEqual(res.deleted, [], 'failed unlink not counted as deleted');
    assert.ok(res.diagnostics.some((d) => d.code === 'gc-leftover-failed' && d.severity === 'warn'));
    assert.ok(existsSync(old), 'file still present after failed unlink');
  } finally { st.cleanup(); }
});
