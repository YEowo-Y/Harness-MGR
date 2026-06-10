/**
 * P5.U1 — zero-network machine-verified invariant (src/selftest/zero-network.mjs).
 *
 * RED oracles prove each violation form is caught; the false-positive battery
 * pins the projection/lookbehind precision; the wiring oracle proves the check
 * fires through the checkBoundary ORCHESTRATOR (non-vacuous integration); the
 * real-tree oracle machine-verifies the live zero-network property on src/.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkZeroNetwork,
  checkZeroNetworkImports,
  checkZeroNetworkCalls,
  NETWORK_IMPORT_PREFIXES,
} from '../src/selftest/zero-network.mjs';
import { checkBoundary } from '../src/selftest/boundary.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoSrc = join(here, '..', 'src');

/** One in-memory file record. */
const rec = (path, source) => [{ path, source }];

// ── A. RED oracles: each violation form is caught ─────────────────────────

test('static node:http import -> exactly one zero-network-import error', () => {
  const src = "import http from 'node:http';\nexport const x = 1;\n";
  const diags = checkZeroNetwork(rec('bad-static.mjs', src));
  assert.equal(diags.length, 1, `expected exactly 1, got: ${JSON.stringify(diags)}`);
  const d = diags[0];
  assert.equal(d.code, 'zero-network-import');
  assert.equal(d.severity, 'error');
  assert.equal(d.phase, 'boundary');
  assert.equal(d.path, 'bad-static.mjs');
  assert.match(d.message, /node:http/);
  assert.match(d.message, /bad-static\.mjs/);
});

test('dynamic import of node:https -> caught (prefix node:http covers it)', () => {
  const src = "const mod = await import('node:https');\n";
  const diags = checkZeroNetworkImports(rec('bad-dynamic.mjs', src));
  assert.equal(diags.length, 1);
  assert.equal(diags[0].code, 'zero-network-import');
  assert.match(diags[0].message, /node:https/);
  assert.match(diags[0].message, /'node:http'/); // the matching prefix is named
});

test("bare un-prefixed builtin form (from 'net') -> caught", () => {
  const src = "import net from 'net';\nexport default net;\n";
  const diags = checkZeroNetworkImports(rec('bad-bare.mjs', src));
  assert.equal(diags.length, 1);
  assert.equal(diags[0].code, 'zero-network-import');
  assert.match(diags[0].message, /'net'/);
});

test("side-effect import (no from clause) of node:http -> caught exactly once", () => {
  // RED oracle for the SIDE_EFFECT_IMPORT_RE extension: a bare side-effect
  // import has no `from` clause and no `(`, so neither mirrored regex sees it.
  const src = "import 'node:http';\nexport const x = 1;\n";
  const diags = checkZeroNetworkImports(rec('bad-side-effect.mjs', src));
  assert.equal(diags.length, 1, `expected exactly 1, got: ${JSON.stringify(diags)}`);
  assert.equal(diags[0].code, 'zero-network-import');
  assert.equal(diags[0].severity, 'error');
  assert.match(diags[0].message, /node:http/);
  assert.match(diags[0].message, /bad-side-effect\.mjs/);
});

test('bare fetch(...) call -> zero-network-call with correct 1-based line', () => {
  const src = 'const url = makeUrl();\n\nfetch(url);\n';
  const diags = checkZeroNetworkCalls(rec('bad-fetch.mjs', src));
  assert.equal(diags.length, 1, `expected exactly 1, got: ${JSON.stringify(diags)}`);
  assert.equal(diags[0].code, 'zero-network-call');
  assert.equal(diags[0].severity, 'error');
  assert.equal(diags[0].phase, 'boundary');
  assert.match(diags[0].message, /line 3\b/);
  assert.match(diags[0].message, /bad-fetch\.mjs/);
});

test('globalThis.fetch( -> caught exactly once (qualified form)', () => {
  const src = 'globalThis.fetch(makeUrl());\n';
  const diags = checkZeroNetworkCalls(rec('bad-global.mjs', src));
  assert.equal(diags.length, 1);
  assert.equal(diags[0].code, 'zero-network-call');
  assert.match(diags[0].message, /globalThis\.fetch/);
  assert.match(diags[0].message, /line 1\b/);
});

test('new WebSocket( -> caught', () => {
  const src = 'const sock = new WebSocket(target);\n';
  const diags = checkZeroNetworkCalls(rec('bad-ws.mjs', src));
  assert.equal(diags.length, 1);
  assert.equal(diags[0].code, 'zero-network-call');
  assert.match(diags[0].message, /WebSocket/);
});

test('checkZeroNetwork concatenates both legs (import + call in one file)', () => {
  const src = "import http from 'node:http';\nfetch(u);\n";
  const diags = checkZeroNetwork(rec('bad-both.mjs', src));
  const codes = diags.map((d) => d.code).sort();
  assert.deepEqual(codes, ['zero-network-call', 'zero-network-import']);
});

// ── B. FALSE-POSITIVE battery: all of these must stay clean ───────────────

test('false-positive battery: comments, strings, member calls, identifiers, relative imports', () => {
  const src = [
    '// refetch the data later',
    'const s = "fetch(this) is a string";',
    'cache.fetch(key);',
    'prefetch(x);',
    'const fetched = load();',
    "import helpers from './http-helpers.mjs';", // relative -> startsWith('http') is false
    "import './side-effect-helper.mjs';", // relative side-effect import -> clean
  ].join('\n') + '\n';
  const diags = checkZeroNetwork(rec('clean.mjs', src));
  assert.deepEqual(diags, [], `false positives: ${JSON.stringify(diags)}`);
});

test('fetch inside a block comment / JSDoc is not flagged (projection strips it)', () => {
  const src = '/**\n * call fetch(url) to refetch — prose only\n */\nexport const x = 1;\n';
  assert.deepEqual(checkZeroNetworkCalls(rec('clean-jsdoc.mjs', src)), []);
});

test('fetch inside a regex literal is not flagged (projection blanks it)', () => {
  const src = 'const RE = /(?:web-?fetch|fetch\\s*\\()/;\nexport { RE };\n';
  assert.deepEqual(checkZeroNetworkCalls(rec('clean-regex.mjs', src)), []);
});

// ── C. WIRING oracle: the check fires through the checkBoundary orchestrator ─

test('wiring: checkBoundary({srcDir}) surfaces zero-network-import from a violating tree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zero-net-wiring-'));
  try {
    writeFileSync(join(dir, 'bad.mjs'), "import http from 'node:http';\nexport default http;\n");
    const { diagnostics } = checkBoundary({ srcDir: dir });
    const hits = diagnostics.filter((d) => d.code === 'zero-network-import');
    assert.equal(hits.length, 1, `expected the orchestrator to surface it: ${JSON.stringify(diagnostics)}`);
    assert.equal(hits[0].severity, 'error');
    assert.equal(hits[0].phase, 'boundary');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── D. REAL-TREE oracle: the live src/ is zero-network, machine-verified ──

test('real tree: checkBoundary over live src/ emits zero zero-network-* diagnostics', () => {
  const { diagnostics } = checkBoundary({ srcDir: repoSrc });
  const hits = diagnostics.filter(
    (d) => d.code === 'zero-network-import' || d.code === 'zero-network-call',
  );
  assert.deepEqual(hits, [], `live src/ must be zero-network: ${JSON.stringify(hits)}`);
});

test('unit on a real loaded file: executes without throwing and does not flag itself', () => {
  const p = join(repoSrc, 'selftest', 'zero-network.mjs');
  const source = readFileSync(p, 'utf-8');
  const diags = checkZeroNetwork([{ path: p, source }]);
  assert.ok(Array.isArray(diags));
  assert.deepEqual(diags, [], `the guard must not flag its own source: ${JSON.stringify(diags)}`);
});

// ── E. never-throws on junk input ──────────────────────────────────────────

test('never-throws: junk inputs return [] without throwing', () => {
  assert.deepEqual(checkZeroNetwork(null), []);
  assert.deepEqual(checkZeroNetwork(undefined), []);
  assert.deepEqual(checkZeroNetwork([{ path: 1, source: null }]), []);
  assert.deepEqual(checkZeroNetwork([null, {}, { path: 'x.mjs' }, { source: 'fetch(u);' }]), []);
  assert.deepEqual(checkZeroNetworkImports('junk'), []);
  assert.deepEqual(checkZeroNetworkCalls({}), []);
});

// ── F. prefix list shape ───────────────────────────────────────────────────

test('NETWORK_IMPORT_PREFIXES is frozen and contains the spec minimum', () => {
  assert.ok(Object.isFrozen(NETWORK_IMPORT_PREFIXES));
  for (const p of ['node:http', 'node:net', 'http', 'https', 'net']) {
    assert.ok(NETWORK_IMPORT_PREFIXES.includes(p), `missing prefix '${p}'`);
  }
});
