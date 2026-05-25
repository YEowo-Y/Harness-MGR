/**
 * P2.U7a — probe-hook-syntax.test.mjs
 *
 * Unit tests for gatherHookSyntaxProbes and isNodeScript from
 * src/discovery/probe-hook-syntax.mjs.
 *
 * All tests inject `runNodeCheck` — no real spawning happens here.
 * The integration test (test/integration/doctor-no-hook-execution.test.mjs)
 * exercises the real node --check path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { gatherHookSyntaxProbes, isNodeScript } from '../src/discovery/probe-hook-syntax.mjs';

// ---------------------------------------------------------------------------
// Helper: build a minimal HookFact-shaped object
// ---------------------------------------------------------------------------

/**
 * @param {Partial<{event:string, command:string, kind:string, target:string, status:string}>} over
 */
const mkFact = (over) => ({
  event: 'PreToolUse',
  command: 'node x',
  kind: 'file',
  target: '/h/x.mjs',
  status: 'found',
  ...over,
});

// ---------------------------------------------------------------------------
// A. isNodeScript
// ---------------------------------------------------------------------------

test('isNodeScript: .mjs → true', () => {
  assert.equal(isNodeScript('a.mjs'), true);
});

test('isNodeScript: .MJS (uppercase) → true (case-insensitive)', () => {
  assert.equal(isNodeScript('A.MJS'), true);
});

test('isNodeScript: .cjs → true', () => {
  assert.equal(isNodeScript('b.cjs'), true);
});

test('isNodeScript: .js → true', () => {
  assert.equal(isNodeScript('c.js'), true);
});

test('isNodeScript: .py → false', () => {
  assert.equal(isNodeScript('d.py'), false);
});

test('isNodeScript: .sh → false', () => {
  assert.equal(isNodeScript('e.sh'), false);
});

test('isNodeScript: empty string → false', () => {
  assert.equal(isNodeScript(''), false);
});

test('isNodeScript: non-string (number) → false', () => {
  assert.equal(isNodeScript(/** @type {any} */ (42)), false);
});

test('isNodeScript: non-string (null) → false', () => {
  assert.equal(isNodeScript(/** @type {any} */ (null)), false);
});

test('isNodeScript: no extension → false', () => {
  assert.equal(isNodeScript('noext'), false);
});

// ---------------------------------------------------------------------------
// B. gatherHookSyntaxProbes — return shape
// ---------------------------------------------------------------------------

test('returns a Promise and never throws (sync guard)', () => {
  const result = gatherHookSyntaxProbes({ hookFacts: [], runNodeCheck: async () => ({ status: 'ok', detail: '' }) });
  assert.ok(result instanceof Promise);
  assert.doesNotThrow(() => result);
});

test('hookFacts empty array → {hookSyntax:[], diagnostics:[]}', async () => {
  const r = await gatherHookSyntaxProbes({ hookFacts: [], runNodeCheck: async () => ({ status: 'ok', detail: '' }) });
  assert.deepEqual(r.hookSyntax, []);
  assert.deepEqual(r.diagnostics, []);
});

test('hookFacts undefined → {hookSyntax:[], diagnostics:[]}, no throw', async () => {
  const r = await gatherHookSyntaxProbes({ runNodeCheck: async () => ({ status: 'ok', detail: '' }) });
  assert.deepEqual(r.hookSyntax, []);
  assert.deepEqual(r.diagnostics, []);
});

test('no opts at all → {hookSyntax:[], diagnostics:[]}, no throw', async () => {
  // no opts means the default runNodeCheck would be used, but hookFacts is empty so it's never called
  const r = await gatherHookSyntaxProbes();
  assert.deepEqual(r.hookSyntax, []);
  assert.deepEqual(r.diagnostics, []);
});

test('hookFacts is a string (non-array) → empty, no throw', async () => {
  const r = await gatherHookSyntaxProbes({ hookFacts: /** @type {any} */ ('bad'), runNodeCheck: async () => ({ status: 'ok', detail: '' }) });
  assert.deepEqual(r.hookSyntax, []);
});

test('hookFacts contains null/number/empty-object entries → skipped, no throw', async () => {
  let calls = 0;
  const r = await gatherHookSyntaxProbes({
    hookFacts: /** @type {any} */ ([null, 5, {}]),
    runNodeCheck: async () => { calls++; return { status: 'ok', detail: '' }; },
  });
  assert.deepEqual(r.hookSyntax, []);
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// C. Filtering: only kind:'file', status:'found', node-extension targets
// ---------------------------------------------------------------------------

test('file+found+.mjs → calls runNodeCheck once; status ok → fact.status ok', async () => {
  let calls = 0;
  const r = await gatherHookSyntaxProbes({
    hookFacts: [mkFact({ target: '/h/x.mjs', status: 'found' })],
    runNodeCheck: async (p) => { calls++; assert.equal(p, '/h/x.mjs'); return { status: 'ok', detail: '' }; },
  });
  assert.equal(calls, 1);
  assert.equal(r.hookSyntax.length, 1);
  assert.equal(r.hookSyntax[0].status, 'ok');
});

test('file+found+.mjs → status syntax-error → fact.status syntax-error with detail', async () => {
  const r = await gatherHookSyntaxProbes({
    hookFacts: [mkFact({ target: '/h/x.mjs', status: 'found', event: 'PreToolUse' })],
    runNodeCheck: async () => ({ status: 'syntax-error', detail: 'SyntaxError: unexpected token' }),
  });
  assert.equal(r.hookSyntax.length, 1);
  assert.equal(r.hookSyntax[0].status, 'syntax-error');
  assert.equal(r.hookSyntax[0].detail, 'SyntaxError: unexpected token');
  assert.equal(r.hookSyntax[0].event, 'PreToolUse');
});

test('file+found+.mjs → status indeterminate → fact.status indeterminate', async () => {
  const r = await gatherHookSyntaxProbes({
    hookFacts: [mkFact({ target: '/h/x.mjs', status: 'found' })],
    runNodeCheck: async () => ({ status: 'indeterminate', detail: 'node --check could not be run' }),
  });
  assert.equal(r.hookSyntax.length, 1);
  assert.equal(r.hookSyntax[0].status, 'indeterminate');
});

test('file+found+.py → skipped, runNodeCheck NOT called', async () => {
  let calls = 0;
  const r = await gatherHookSyntaxProbes({
    hookFacts: [mkFact({ target: '/h/x.py', status: 'found' })],
    runNodeCheck: async () => { calls++; return { status: 'ok', detail: '' }; },
  });
  assert.equal(calls, 0);
  assert.equal(r.hookSyntax.length, 0);
});

test('file+missing → skipped (missing-file is #3 job), runNodeCheck NOT called', async () => {
  let calls = 0;
  const r = await gatherHookSyntaxProbes({
    hookFacts: [mkFact({ target: '/h/x.mjs', status: 'missing' })],
    runNodeCheck: async () => { calls++; return { status: 'ok', detail: '' }; },
  });
  assert.equal(calls, 0);
  assert.equal(r.hookSyntax.length, 0);
});

test('file+indeterminate → skipped (unexpanded var, must not flag)', async () => {
  let calls = 0;
  const r = await gatherHookSyntaxProbes({
    hookFacts: [mkFact({ target: '/h/x.mjs', status: 'indeterminate' })],
    runNodeCheck: async () => { calls++; return { status: 'ok', detail: '' }; },
  });
  assert.equal(calls, 0);
  assert.equal(r.hookSyntax.length, 0);
});

test('kind:external → skipped, runNodeCheck NOT called', async () => {
  let calls = 0;
  const r = await gatherHookSyntaxProbes({
    hookFacts: [mkFact({ kind: 'external', target: 'some-cmd', status: 'found' })],
    runNodeCheck: async () => { calls++; return { status: 'ok', detail: '' }; },
  });
  assert.equal(calls, 0);
  assert.equal(r.hookSyntax.length, 0);
});

// ---------------------------------------------------------------------------
// D. path resolution: absolute path is preserved; relative is resolved to abs
// ---------------------------------------------------------------------------

test('absolute target → fact.path equals that absolute path', async () => {
  // Use a real absolute path derived from tmpdir() so it is valid on all platforms.
  const absTarget = join(tmpdir(), 'hook.mjs');
  const r = await gatherHookSyntaxProbes({
    hookFacts: [mkFact({ target: absTarget, status: 'found' })],
    runNodeCheck: async () => ({ status: 'ok', detail: '' }),
  });
  assert.equal(r.hookSyntax[0].path, absTarget);
});

test('relative target + explicit cwd → fact.path is absolute and starts with cwd', async () => {
  // Use tmpdir() as cwd so the resolved path is a real absolute path on all platforms.
  const cwd = tmpdir();
  let receivedPath = '';
  const r = await gatherHookSyntaxProbes({
    hookFacts: [mkFact({ target: 'hooks/x.mjs', status: 'found' })],
    cwd,
    runNodeCheck: async (p) => { receivedPath = p; return { status: 'ok', detail: '' }; },
  });
  assert.ok(isAbsolute(r.hookSyntax[0].path), 'path must be absolute');
  assert.ok(r.hookSyntax[0].path.startsWith(cwd), `path ${r.hookSyntax[0].path} should start with cwd ${cwd}`);
  assert.equal(receivedPath, r.hookSyntax[0].path);
});

// ---------------------------------------------------------------------------
// E. event is preserved in the fact
// ---------------------------------------------------------------------------

test('event from hookFact is preserved in returned HookSyntaxFact', async () => {
  const r = await gatherHookSyntaxProbes({
    hookFacts: [mkFact({ event: 'PostToolUse', target: '/h/x.mjs', status: 'found' })],
    runNodeCheck: async () => ({ status: 'ok', detail: '' }),
  });
  assert.equal(r.hookSyntax[0].event, 'PostToolUse');
});

// ---------------------------------------------------------------------------
// F. runNodeCheck THROWS → fact.status indeterminate, no propagation
// ---------------------------------------------------------------------------

test('runNodeCheck throws → fact.status is indeterminate, gatherHookSyntaxProbes does not throw', async () => {
  const r = await gatherHookSyntaxProbes({
    hookFacts: [mkFact({ target: '/h/x.mjs', status: 'found' })],
    runNodeCheck: async () => { throw new Error('spawn failed'); },
  });
  assert.equal(r.hookSyntax.length, 1);
  assert.equal(r.hookSyntax[0].status, 'indeterminate');
});

// ---------------------------------------------------------------------------
// G. runNodeCheck returns junk → coerced to indeterminate
// ---------------------------------------------------------------------------

test('runNodeCheck returns junk status → coerced to indeterminate', async () => {
  const r = await gatherHookSyntaxProbes({
    hookFacts: [mkFact({ target: '/h/x.mjs', status: 'found' })],
    runNodeCheck: async () => /** @type {any} */ ({ status: 'weird', detail: '' }),
  });
  assert.equal(r.hookSyntax[0].status, 'indeterminate');
});

test('runNodeCheck returns null → coerced to indeterminate', async () => {
  const r = await gatherHookSyntaxProbes({
    hookFacts: [mkFact({ target: '/h/x.mjs', status: 'found' })],
    runNodeCheck: async () => /** @type {any} */ (null),
  });
  assert.equal(r.hookSyntax[0].status, 'indeterminate');
});

// ---------------------------------------------------------------------------
// H. multiple facts, mixed filtering
// ---------------------------------------------------------------------------

test('multiple facts: only file+found+node-ext facts produce entries', async () => {
  let calls = 0;
  const r = await gatherHookSyntaxProbes({
    hookFacts: [
      mkFact({ target: '/h/a.mjs', status: 'found', event: 'E1' }),     // included
      mkFact({ target: '/h/b.py', status: 'found', event: 'E2' }),       // skipped: not node
      mkFact({ kind: 'external', target: 'cmd', status: 'found', event: 'E3' }), // skipped: external
      mkFact({ target: '/h/c.cjs', status: 'found', event: 'E4' }),     // included
      mkFact({ target: '/h/d.mjs', status: 'missing', event: 'E5' }),   // skipped: missing
    ],
    runNodeCheck: async () => { calls++; return { status: 'ok', detail: '' }; },
  });
  assert.equal(calls, 2);
  assert.equal(r.hookSyntax.length, 2);
  assert.equal(r.hookSyntax[0].event, 'E1');
  assert.equal(r.hookSyntax[1].event, 'E4');
});
