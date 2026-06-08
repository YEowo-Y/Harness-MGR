/**
 * test/cli-config-diff-snapshot.test.mjs
 *
 * Hermetic unit tests for the snapshot-mode detection + dispatch in
 * src/cli/config-diff-command.mjs. ALL I/O is injected via deps seams —
 * no real fs, no real tar, no real snapshot dirs are touched.
 *
 * Oracles are FALSIFIABLE: every test asserts specific call arguments or
 * specific codes, not just "no throw".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { configDiffCommand } from '../src/cli/config-diff-command.mjs';

// ── helpers ────────────────────────────────────────────────────────────────────

const VALID_ID_A = '2026-06-01T12-00-00Z';
const VALID_ID_B = '2026-06-02T08-30-00Z';

function makeCtx(positionals = [], extra = {}) {
  return {
    configDir: '/fake/claude',
    mgrStateDir: '/fake/claude/.mgr-state',
    args: Object.assign(Object.create(null), { positionals, ...extra }),
  };
}

/** A readFn seam mapping path → {text} or {error}. */
function cannedReader(map) {
  return (path) => {
    if (Object.prototype.hasOwnProperty.call(map, path)) {
      const v = map[path];
      return typeof v === 'string' ? { text: v } : v;
    }
    return { error: 'ENOENT: no such file' };
  };
}

/** A diffSnapshotsFn seam that records its call and returns a canned result. */
function makeSnapshotStub(result) {
  const calls = [];
  const fn = async (opts) => { calls.push({ ...opts }); return result; };
  fn.calls = calls;
  return fn;
}

// ── 1. SNAPSHOT MODE detection: valid ids + existsFn true → diffSnapshotsFn called ──

test('snapshot mode: valid ids + existsFn→true → diffSnapshotsFn called, readFn NOT called', async () => {
  const stub = makeSnapshotStub({
    mode: 'manifest', ok: true, idA: VALID_ID_A, idB: VALID_ID_B,
    added: [], removed: [], modified: [], unchanged: 5, diagnostics: [],
  });
  const readCalls = [];
  const readFn = (p) => { readCalls.push(p); return { text: '' }; };
  const deps = { existsFn: () => true, diffSnapshotsFn: stub, readFn };

  const out = await configDiffCommand(makeCtx([VALID_ID_A, VALID_ID_B]), deps);

  assert.equal(out.code, 0, `expected code 0, got ${out.code}`);
  assert.equal(stub.calls.length, 1, 'diffSnapshotsFn must be called exactly once');
  assert.equal(stub.calls[0].idA, VALID_ID_A, 'idA threaded correctly');
  assert.equal(stub.calls[0].idB, VALID_ID_B, 'idB threaded correctly');
  assert.equal(stub.calls[0].mgrStateDir, '/fake/claude/.mgr-state', 'mgrStateDir threaded');
  assert.equal(stub.calls[0].relpath, undefined, 'no relpath for 2-arg call');
  assert.equal(readCalls.length, 0, 'readFn (file path reader) must NOT be called in snapshot mode');
});

// ── 2. FALLBACK TO FILE MODE: valid ids but existsFn→false ─────────────────────────

test('snapshot mode fallback: valid ids but existsFn→false → file mode (readFn called)', async () => {
  const stub = makeSnapshotStub({ mode: 'manifest', ok: true, added: [], removed: [], modified: [], unchanged: 0, diagnostics: [] });
  const readFn = cannedReader({ [VALID_ID_A]: 'aaa', [VALID_ID_B]: 'bbb' });
  const deps = { existsFn: () => false, diffSnapshotsFn: stub, readFn, cwd: '/' };

  await configDiffCommand(makeCtx([VALID_ID_A, VALID_ID_B]), deps);

  assert.equal(stub.calls.length, 0, 'diffSnapshotsFn must NOT be called when snapshot dirs do not exist');
});

// ── 3. FALLBACK TO FILE MODE: non-snapshot-id first arg ────────────────────────────

test('snapshot mode fallback: non-snapshot-id first arg → file mode', async () => {
  const stub = makeSnapshotStub({ mode: 'manifest', ok: true, added: [], removed: [], modified: [], unchanged: 0, diagnostics: [] });
  // Use absolute-looking paths so resolvePath returns them unchanged on any platform.
  const A = '/fake/a.txt';
  const B = '/fake/b.txt';
  const readFn = cannedReader({ [A]: 'hello', [B]: 'world' });
  const deps = { existsFn: () => true, diffSnapshotsFn: stub, readFn };

  const out = await configDiffCommand(makeCtx([A, B]), deps);

  assert.equal(stub.calls.length, 0, 'diffSnapshotsFn must NOT be called when first arg is not a snapshot id');
  assert.equal(out.code, 0, 'file mode computed the diff');
});

// ── 4. MANIFEST MODE stub → code 0; ok:false stub → code 1 ─────────────────────────

test('manifest mode stub ok:true → code 0', async () => {
  const stub = makeSnapshotStub({
    mode: 'manifest', ok: true, idA: VALID_ID_A, idB: VALID_ID_B,
    added: ['agents/foo.md'], removed: [], modified: [], unchanged: 3, diagnostics: [],
  });
  const deps = { existsFn: () => true, diffSnapshotsFn: stub };

  const out = await configDiffCommand(makeCtx([VALID_ID_A, VALID_ID_B]), deps);
  assert.equal(out.code, 0);
  assert.equal(out.result.mode, 'manifest');
  assert.deepEqual(out.result.added, ['agents/foo.md']);
});

test('manifest mode stub ok:false → code 1', async () => {
  const stub = makeSnapshotStub({
    mode: 'manifest', ok: false, idA: VALID_ID_A, idB: VALID_ID_B,
    added: [], removed: [], modified: [], unchanged: 0,
    diagnostics: [{ severity: 'error', code: 'snapshot-diff-not-found', phase: 'snapshot-diff', message: 'not found' }],
  });
  const deps = { existsFn: () => true, diffSnapshotsFn: stub };

  const out = await configDiffCommand(makeCtx([VALID_ID_A, VALID_ID_B]), deps);
  assert.equal(out.code, 1, `expected code 1, got ${out.code}`);
  assert.ok(out.diagnostics.some((d) => d.code === 'snapshot-diff-not-found'), 'diagnostic threaded through');
});

// ── 5. CONTENT MODE: 3 positionals → relpath passed through ────────────────────────

test('content mode: 3 positionals → relpath passed to diffSnapshotsFn', async () => {
  const stub = makeSnapshotStub({
    mode: 'content', ok: true, idA: VALID_ID_A, idB: VALID_ID_B,
    relpath: 'settings.json', aLabel: `${VALID_ID_A}:settings.json`,
    bLabel: `${VALID_ID_B}:settings.json`,
    stats: { added: 1, deleted: 0 }, hunks: [], unified: '--- a\n+++ b', changed: true,
    diagnostics: [],
  });
  const deps = { existsFn: () => true, diffSnapshotsFn: stub };

  const out = await configDiffCommand(
    makeCtx([VALID_ID_A, VALID_ID_B, 'settings.json']), deps,
  );

  assert.equal(stub.calls.length, 1, 'diffSnapshotsFn called once');
  assert.equal(stub.calls[0].relpath, 'settings.json', 'relpath passed through');
  assert.equal(out.code, 0);
  assert.equal(out.result.mode, 'content');
});

// ── 6. NO SPEC (1 positional) → code 2, unchanged ─────────────────────────────────

test('no-spec (1 positional) → code 2, config-diff-no-spec (unchanged)', async () => {
  const out = await configDiffCommand(makeCtx(['onlyone']));
  assert.equal(out.code, 2, `expected code 2, got ${out.code}`);
  assert.ok(out.diagnostics.some((d) => d.code === 'config-diff-no-spec'), 'expected config-diff-no-spec');
});
