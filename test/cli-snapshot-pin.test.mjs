/**
 * P3.U21 — cli-snapshot-pin.test.mjs (snapshot pin/unpin CLI handler tests).
 *
 * HERMETIC: no real `.mgr-state`, no real paths.mjs, no real `.pin` file — every
 * path is driven through injected `deps` seams (a recording `loadPaths` / `pinFn` /
 * `unpinFn` spy + a fake `env`). Every assertion checks actual call ARGS / result /
 * diagnostics (falsifiable).
 *
 * Mirrors cli-lock.test.mjs. Covers BOTH snapshotPinCommand and snapshotUnpinCommand:
 *   • dry-run by default (no paths.mjs load, no write)
 *   • the two-factor write gate on --apply (closed env → writes-disabled-env code 3
 *     BEFORE any write; open env → the real pin/unpin runs with the injected gate)
 *   • a missing id → usage error (code 2)
 *   • a throwing dynamic paths.mjs import → graceful snapshot-pin-unavailable warn.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  snapshotPinCommand, snapshotUnpinCommand,
} from '../src/cli/snapshot-pin-command.mjs';

const ID = '2026-06-01T12-00-00Z';

/** A CommandContext with the given parsed args (positionals + flags). */
const CTX = (args) => ({ configDir: '/cfg', mgrStateDir: '/cfg/.mgr-state', args });

/** A recording spy that returns a canned value and remembers its call args. */
function makeSpy(canned) {
  const calls = [];
  const fn = (...a) => { calls.push(a); return canned; };
  fn.calls = calls;
  return fn;
}

/** An async recording spy (for loadPaths) returning a canned resolved value. */
function makeAsyncSpy(canned) {
  const calls = [];
  const fn = async (...a) => { calls.push(a); return canned; };
  fn.calls = calls;
  return fn;
}

// ── snapshot pin: dry-run (default) ───────────────────────────────────────────────

test('snapshotPinCommand: dry-run (no --apply) → mode dry-run, wouldPin, loadPaths/pinFn NOT called', async () => {
  const loadPaths = makeAsyncSpy({ assertWritable: (p) => p });
  const pinFn = makeSpy({ pinned: true, path: 'x', diagnostics: [] });
  const out = await snapshotPinCommand(CTX({ positionals: [ID] }), { loadPaths, pinFn, env: {} });
  assert.equal(out.result.mode, 'dry-run');
  assert.equal(out.result.id, ID);
  assert.equal(out.result.wouldPin, true);
  assert.ok(out.diagnostics.some((d) => d.code === 'snapshot-pin-dry-run' && d.severity === 'info'));
  assert.equal(out.code, undefined, 'a clean dry-run carries no explicit code');
  assert.equal(loadPaths.calls.length, 0, 'dry-run must NOT load paths.mjs');
  assert.equal(pinFn.calls.length, 0, 'dry-run must NOT write (pinFn never called)');
});

// ── snapshot unpin: dry-run (default) ─────────────────────────────────────────────

test('snapshotUnpinCommand: dry-run (no --apply) → mode dry-run, wouldUnpin, unpinFn NOT called', async () => {
  const unpinFn = makeSpy({ unpinned: true, diagnostics: [] });
  const out = await snapshotUnpinCommand(CTX({ positionals: [ID] }), { unpinFn, env: {} });
  assert.equal(out.result.mode, 'dry-run');
  assert.equal(out.result.id, ID);
  assert.equal(out.result.wouldUnpin, true);
  assert.ok(out.diagnostics.some((d) => d.code === 'snapshot-unpin-dry-run' && d.severity === 'info'));
  assert.equal(unpinFn.calls.length, 0, 'dry-run must NOT write (unpinFn never called)');
});

// ── snapshot pin: gate-closed --apply → writes-disabled-env ───────────────────────

test('snapshotPinCommand: --apply with env=0 closed → code3 writes-disabled-env, loadPaths/pinFn NOT called', async () => {
  const loadPaths = makeAsyncSpy({ assertWritable: (p) => p });
  const pinFn = makeSpy({ pinned: true, path: 'x', diagnostics: [] });
  const out = await snapshotPinCommand(
    CTX({ positionals: [ID], apply: true }), { loadPaths, pinFn, env: { HARNESS_MGR_ENABLE_WRITES: '0' } });
  assert.equal(out.code, 3);
  assert.equal(out.result.mode, 'applied');
  assert.equal(out.result.pinned, false);
  assert.ok(out.diagnostics.some((d) => d.code === 'writes-disabled-env' && d.severity === 'error'));
  assert.equal(loadPaths.calls.length, 0, 'a closed gate must refuse BEFORE loading paths.mjs');
  assert.equal(pinFn.calls.length, 0, 'a closed gate must refuse BEFORE any write');
});

// ── snapshot unpin: gate-closed --apply → writes-disabled-env ─────────────────────

test('snapshotUnpinCommand: --apply with env=0 closed → code3 writes-disabled-env, unpinFn NOT called', async () => {
  const unpinFn = makeSpy({ unpinned: true, diagnostics: [] });
  const out = await snapshotUnpinCommand(
    CTX({ positionals: [ID], apply: true }), { unpinFn, env: { HARNESS_MGR_ENABLE_WRITES: '0' } });
  assert.equal(out.code, 3);
  assert.equal(out.result.mode, 'applied');
  assert.equal(out.result.unpinned, false);
  assert.ok(out.diagnostics.some((d) => d.code === 'writes-disabled-env' && d.severity === 'error'));
  assert.equal(unpinFn.calls.length, 0, 'a closed gate must refuse BEFORE any write');
});

// ── snapshot pin: gate-open --apply → real pin runs with the injected gate ─────────

test('snapshotPinCommand: --apply with armed env → mode applied, pinned:true, pinFn got the gate', async () => {
  const gate = (p) => p;
  const loadPaths = makeAsyncSpy({ assertWritable: gate });
  const pinFn = makeSpy({ pinned: true, path: '/cfg/.mgr-state/snapshots/' + ID + '/.pin', diagnostics: [] });
  const out = await snapshotPinCommand(
    CTX({ positionals: [ID], apply: true }),
    { loadPaths, pinFn, env: { HARNESS_MGR_ENABLE_WRITES: '1' } });
  assert.equal(out.result.mode, 'applied');
  assert.equal(out.result.pinned, true);
  assert.equal(out.result.id, ID);
  assert.equal(loadPaths.calls.length, 1, 'an armed --apply loads the gate');
  assert.equal(pinFn.calls.length, 1, 'pinFn called once');
  const arg = pinFn.calls[0][0];
  assert.equal(arg.mgrStateDir, '/cfg/.mgr-state', 'pinFn receives the ctx mgrStateDir');
  assert.equal(arg.snapshotId, ID, 'pinFn receives the id');
  assert.equal(arg.assertWritable, gate, 'pinFn receives the injected governed-write gate');
});

// ── snapshot unpin: gate-open --apply → real unpin runs ───────────────────────────

test('snapshotUnpinCommand: --apply with armed env → mode applied, unpinned:true, unpinFn got the id', async () => {
  const unpinFn = makeSpy({ unpinned: true, diagnostics: [] });
  const out = await snapshotUnpinCommand(
    CTX({ positionals: [ID], apply: true }),
    { unpinFn, env: { HARNESS_MGR_ENABLE_WRITES: '1' } });
  assert.equal(out.result.mode, 'applied');
  assert.equal(out.result.unpinned, true);
  assert.equal(unpinFn.calls.length, 1, 'unpinFn called once');
  const arg = unpinFn.calls[0][0];
  assert.equal(arg.mgrStateDir, '/cfg/.mgr-state', 'unpinFn receives the ctx mgrStateDir');
  assert.equal(arg.snapshotId, ID, 'unpinFn receives the id');
});

// ── missing id → usage error (code 2), no write ───────────────────────────────────

test('snapshotPinCommand: missing id → code2 snapshot-pin-id-missing, no write', async () => {
  const loadPaths = makeAsyncSpy({ assertWritable: (p) => p });
  const pinFn = makeSpy({ pinned: true, path: 'x', diagnostics: [] });
  const out = await snapshotPinCommand(CTX({ positionals: [] }), { loadPaths, pinFn, env: {} });
  assert.equal(out.code, 2);
  assert.equal(out.result.mode, 'error');
  assert.ok(out.diagnostics.some((d) => d.code === 'snapshot-pin-id-missing' && d.severity === 'error'));
  assert.equal(loadPaths.calls.length, 0);
  assert.equal(pinFn.calls.length, 0);
});

test('snapshotUnpinCommand: missing id → code2 snapshot-unpin-id-missing, no write', async () => {
  const unpinFn = makeSpy({ unpinned: true, diagnostics: [] });
  const out = await snapshotUnpinCommand(CTX({ positionals: [] }), { unpinFn, env: {} });
  assert.equal(out.code, 2);
  assert.equal(out.result.mode, 'error');
  assert.ok(out.diagnostics.some((d) => d.code === 'snapshot-unpin-id-missing' && d.severity === 'error'));
  assert.equal(unpinFn.calls.length, 0);
});

// ── a throwing paths.mjs import degrades gracefully (never throws) ─────────────────

test('snapshotPinCommand: a throwing loadPaths → snapshot-pin-unavailable warn, pinned:false, never throws', async () => {
  const pinFn = makeSpy({ pinned: true, path: 'x', diagnostics: [] });
  const loadPaths = async () => { throw new Error('boom'); };
  // The command catches the import failure internally → it never rejects. Awaiting it
  // directly (and reaching the assertions) IS the never-throws proof.
  const out = await snapshotPinCommand(
    CTX({ positionals: [ID], apply: true }),
    { loadPaths, pinFn, env: { HARNESS_MGR_ENABLE_WRITES: '1' } });
  assert.equal(out.result.mode, 'applied');
  assert.equal(out.result.pinned, false);
  assert.ok(out.diagnostics.some((d) => d.code === 'snapshot-pin-unavailable' && d.severity === 'warn'),
    'a paths.mjs import failure surfaces a snapshot-pin-unavailable warn');
  assert.equal(pinFn.calls.length, 0, 'no pin attempted when the gate is unloadable');
});
