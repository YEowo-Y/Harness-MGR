/**
 * P2.U7c-2 — probe-loader.test.mjs
 *
 * Hermetic unit tests for gatherLoaderProbe(). ALL seams are injected so no
 * real filesystem or write-gate is touched. A fixed uuid: () => '0000' makes
 * the probeName deterministic (__mgr-probe-0000).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { gatherLoaderProbe } from '../src/discovery/probe-loader.mjs';

// ── helpers ──────────────────────────────────────────────────────────────────

const FIXED_UUID = () => '0000';
const PROBE_NAME = '__mgr-probe-0000';

/** Minimal seam set that represents a fully successful run. */
function happySeams(over = {}) {
  return {
    configDir: '/cfg',
    ccVersion: '2.1.5',
    uuid: FIXED_UUID,
    assertProbeWritable: (p) => p,
    writeFn: () => {},
    discoverFn: () => ({ components: [{ kind: 'agent', name: PROBE_NAME }], diagnostics: [] }),
    removeFn: () => {},
    existsFn: () => false,
    ...over,
  };
}

const byCode = (diags, code) => diags.filter((d) => d.code === code);

// ── A. Happy path ─────────────────────────────────────────────────────────────

test('happy: wrote+observed+cleanedUp all true; ccVersion echoed', async () => {
  const { loader, diagnostics } = await gatherLoaderProbe(happySeams());
  assert.equal(loader.probeName, PROBE_NAME);
  assert.equal(loader.wrote, true);
  assert.equal(loader.observed, true);
  assert.equal(loader.cleanedUp, true);
  assert.equal(loader.ccVersion, '2.1.5');
  assert.equal(diagnostics.length, 0);
});

// ── B. assertProbeWritable throws → blocked ───────────────────────────────────

test('assertProbeWritable throws → wrote:false cleanedUp:true + loader-probe-blocked warn; writeFn not called', async () => {
  let writeCalled = false;
  const { loader, diagnostics } = await gatherLoaderProbe(happySeams({
    assertProbeWritable: () => { throw new Error('outside governed dir'); },
    writeFn: () => { writeCalled = true; },
  }));
  assert.equal(loader.wrote, false);
  assert.equal(loader.cleanedUp, true);
  assert.equal(writeCalled, false, 'writeFn must NOT be called when gate rejects');
  const blocked = byCode(diagnostics, 'loader-probe-blocked');
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].severity, 'warn');
  assert.match(blocked[0].message, /outside governed dir/);
});

// ── C. writeFn throws (e.g. ENOENT — agents/ missing) ────────────────────────

test('writeFn throws ENOENT → wrote:false cleanedUp:true + loader-probe-skipped info', async () => {
  const err = Object.assign(new Error('no such dir'), { code: 'ENOENT' });
  const { loader, diagnostics } = await gatherLoaderProbe(happySeams({
    writeFn: () => { throw err; },
  }));
  assert.equal(loader.wrote, false);
  assert.equal(loader.cleanedUp, true);
  const skipped = byCode(diagnostics, 'loader-probe-skipped');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].severity, 'info');
  assert.match(skipped[0].message, /ENOENT/);
});

// ── D. discoverFn returns components WITHOUT the probe ────────────────────────

test('discoverFn returns no matching agent → observed:false; removeFn WAS called; cleanedUp:true', async () => {
  let removeCalled = false;
  const { loader, diagnostics } = await gatherLoaderProbe(happySeams({
    discoverFn: () => ({ components: [{ kind: 'agent', name: 'other-agent' }], diagnostics: [] }),
    removeFn: () => { removeCalled = true; },
  }));
  assert.equal(loader.wrote, true);
  assert.equal(loader.observed, false);
  assert.equal(loader.cleanedUp, true);
  assert.equal(removeCalled, true, 'removeFn must be called even when observed:false');
  assert.equal(diagnostics.length, 0);
});

// ── E. discoverFn THROWS → observed:false, cleanup still runs (critical) ──────

test('discoverFn throws → observed:false AND removeFn still called (finally) → cleanedUp:true', async () => {
  let removeCalled = false;
  const { loader, diagnostics } = await gatherLoaderProbe(happySeams({
    discoverFn: () => { throw new Error('discovery exploded'); },
    removeFn: () => { removeCalled = true; },
  }));
  assert.equal(loader.wrote, true);
  assert.equal(loader.observed, false);
  assert.equal(loader.cleanedUp, true);
  assert.equal(removeCalled, true, 'cleanup must run in finally even when discoverFn throws');
  assert.equal(diagnostics.length, 0);
});

// ── F. removeFn throws → cleanedUp:false ──────────────────────────────────────

test('removeFn throws → cleanedUp:false', async () => {
  const { loader } = await gatherLoaderProbe(happySeams({
    removeFn: () => { throw new Error('permission denied'); },
    existsFn: () => true,
  }));
  assert.equal(loader.wrote, true);
  assert.equal(loader.cleanedUp, false);
});

// ── G. removeFn returns but file still exists → cleanedUp:false ───────────────

test('removeFn succeeds but existsFn still true → cleanedUp:false', async () => {
  const { loader } = await gatherLoaderProbe(happySeams({
    removeFn: () => {},
    existsFn: () => true, // file not actually gone
  }));
  assert.equal(loader.wrote, true);
  assert.equal(loader.cleanedUp, false);
});

// ── H. Bad configDir ──────────────────────────────────────────────────────────

test('bad configDir (undefined) → discover-bad-root error; wrote:false; never rejects', async () => {
  const { loader, diagnostics } = await gatherLoaderProbe({ uuid: FIXED_UUID, assertProbeWritable: (p) => p });
  assert.equal(loader.wrote, false);
  assert.equal(loader.probeName, '');
  const bad = byCode(diagnostics, 'discover-bad-root');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].severity, 'error');
});

test('bad configDir (empty string) → discover-bad-root error', async () => {
  const { loader, diagnostics } = await gatherLoaderProbe({ configDir: '', uuid: FIXED_UUID, assertProbeWritable: (p) => p });
  assert.equal(loader.wrote, false);
  assert.equal(byCode(diagnostics, 'discover-bad-root').length, 1);
});

test('bad configDir (number) → discover-bad-root error', async () => {
  const { loader, diagnostics } = await gatherLoaderProbe({ configDir: /** @type {any} */ (42), uuid: FIXED_UUID, assertProbeWritable: (p) => p });
  assert.equal(loader.wrote, false);
  assert.equal(byCode(diagnostics, 'discover-bad-root').length, 1);
});

// ── I. ccVersion non-string → ccVersion:null ──────────────────────────────────

test('ccVersion non-string (number) → ccVersion:null in fact', async () => {
  const { loader } = await gatherLoaderProbe(happySeams({ ccVersion: /** @type {any} */ (123) }));
  assert.equal(loader.ccVersion, null);
});

test('ccVersion absent → ccVersion:null in fact', async () => {
  const { loader } = await gatherLoaderProbe(happySeams({ ccVersion: undefined }));
  assert.equal(loader.ccVersion, null);
});

// ── J. Returns a Promise; never throws on any bad input ───────────────────────

test('gatherLoaderProbe() always returns a Promise', async () => {
  const result = gatherLoaderProbe(happySeams());
  assert.ok(result && typeof result.then === 'function', 'must be a Promise');
  await result;
});

test('never rejects when called with no args', async () => {
  const { loader, diagnostics } = await gatherLoaderProbe();
  assert.equal(loader.wrote, false);
  assert.equal(typeof diagnostics, 'object');
});

test('never rejects when called with null', async () => {
  const { loader } = await gatherLoaderProbe(/** @type {any} */ (null));
  assert.equal(loader.wrote, false);
});

// ── K. probeName appears in fact even when write is blocked ───────────────────

test('assertProbeWritable blocks → probeName still set (not empty)', async () => {
  const { loader } = await gatherLoaderProbe(happySeams({
    assertProbeWritable: () => { throw new Error('blocked'); },
  }));
  assert.equal(loader.probeName, PROBE_NAME);
  assert.equal(loader.wrote, false);
  assert.equal(loader.cleanedUp, true);
});
