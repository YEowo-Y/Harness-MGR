/**
 * P2.U7a — doctor-active-checks.test.mjs
 *
 * Tests for active check #4 hook-node-syntax, exercised through runDoctor().
 *
 * Key gate: in PASSIVE mode (no activeProbes), #4 must NOT run even when
 * hookSyntax facts are present — the probeLevel:'active' dispatch invariant.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor } from '../src/analysis/doctor/index.mjs';

/** Filter diagnostics by code. */
const byCode = (diags, code) => diags.filter((d) => d.code === code);

/** Build a minimal HookSyntaxFact. */
const mkSyntaxFact = (over) => ({
  event: 'PreToolUse',
  path: '/h/x.mjs',
  status: 'syntax-error',
  detail: 'SyntaxError: Unexpected token',
  ...over,
});

// ---------------------------------------------------------------------------
// A. Basic firing in active mode
// ---------------------------------------------------------------------------

test('#4: syntax-error fact in active mode → exactly one hook-node-syntax error', () => {
  const r = runDoctor(
    { hookSyntax: [mkSyntaxFact()] },
    { activeProbes: true },
  );
  const found = byCode(r.diagnostics, 'hook-node-syntax');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'error');
  assert.match(found[0].message, /PreToolUse/);
  assert.match(found[0].message, /\/h\/x\.mjs/);
  assert.equal(found[0].phase, 'doctor');
  assert.equal(typeof found[0].fix, 'string');
  assert.ok(found[0].fix.length > 0);
});

test('#4: status ok (active mode) → 0 findings', () => {
  const r = runDoctor(
    { hookSyntax: [mkSyntaxFact({ status: 'ok', detail: '' })] },
    { activeProbes: true },
  );
  assert.equal(byCode(r.diagnostics, 'hook-node-syntax').length, 0);
});

test('#4: status indeterminate (active mode) → 0 findings (no false positive)', () => {
  const r = runDoctor(
    { hookSyntax: [mkSyntaxFact({ status: 'indeterminate', detail: 'node --check could not be run' })] },
    { activeProbes: true },
  );
  assert.equal(byCode(r.diagnostics, 'hook-node-syntax').length, 0);
});

// ---------------------------------------------------------------------------
// B. GATE TEST — passive mode must NOT run #4
// ---------------------------------------------------------------------------

test('GATE: passive mode with syntax-error facts → #4 does NOT run; 0 hook-node-syntax findings', () => {
  const r = runDoctor({ hookSyntax: [mkSyntaxFact()] });
  assert.equal(r.probeLevel, 'passive');
  assert.equal(byCode(r.diagnostics, 'hook-node-syntax').length, 0);
  const s4 = r.checks.find((c) => c.id === 4);
  assert.ok(s4, 'check #4 must appear in registry even in passive mode');
  assert.equal(s4.ran, false, 'check #4 must not have run in passive mode');
  assert.equal(s4.findings, 0);
});

// ---------------------------------------------------------------------------
// C. active mode metadata
// ---------------------------------------------------------------------------

test('active mode → probeLevel is active and doctor-active-probes notice is emitted', () => {
  const r = runDoctor({}, { activeProbes: true });
  assert.equal(r.probeLevel, 'active');
  const notice = byCode(r.diagnostics, 'doctor-active-probes');
  assert.equal(notice.length, 1);
  assert.equal(notice[0].severity, 'info');
});

test('active-probes notice discloses the transient agents/ probe-file write', () => {
  const r = runDoctor({}, { activeProbes: true });
  const msg = byCode(r.diagnostics, 'doctor-active-probes')[0].message;
  assert.ok(msg.includes('agents'), 'notice must name the agents/ directory');
  assert.ok(
    /write|probe|temporary/.test(msg),
    'notice must disclose the write/probe/temporary file',
  );
});

test('active mode → check #4 summary has ran===true', () => {
  const r = runDoctor(
    { hookSyntax: [mkSyntaxFact()] },
    { activeProbes: true },
  );
  const s4 = r.checks.find((c) => c.id === 4);
  assert.ok(s4, 'check #4 must be in registry');
  assert.equal(s4.ran, true);
  assert.equal(s4.findings, 1);
});

// ---------------------------------------------------------------------------
// D. Sorting
// ---------------------------------------------------------------------------

test('#4: two syntax-error facts → findings sorted by message ascending', () => {
  const r = runDoctor(
    {
      hookSyntax: [
        mkSyntaxFact({ event: 'Stop', path: '/h/z.mjs', detail: 'SyntaxError: z' }),
        mkSyntaxFact({ event: 'PreToolUse', path: '/h/a.mjs', detail: 'SyntaxError: a' }),
      ],
    },
    { activeProbes: true },
  );
  const found = byCode(r.diagnostics.filter((d) => d.code === 'hook-node-syntax'), 'hook-node-syntax');
  assert.equal(found.length, 2);
  // "PreToolUse" < "Stop" lexicographically → /h/a.mjs message comes first
  assert.match(found[0].message, /PreToolUse/);
  assert.match(found[1].message, /Stop/);
});

// ---------------------------------------------------------------------------
// E. Never-throws: bad hookSyntax input
// ---------------------------------------------------------------------------

test('never-throws: hookSyntax non-array (string) in active mode → 0 findings, no throw', () => {
  let r;
  assert.doesNotThrow(() => {
    r = runDoctor({ hookSyntax: /** @type {any} */ ('bad') }, { activeProbes: true });
  });
  assert.equal(byCode(r.diagnostics, 'hook-node-syntax').length, 0);
});

test('never-throws: hookSyntax contains null/number entries in active mode → 0 findings, no throw', () => {
  let r;
  assert.doesNotThrow(() => {
    r = runDoctor({ hookSyntax: /** @type {any} */ ([null, 42, {}]) }, { activeProbes: true });
  });
  assert.equal(byCode(r.diagnostics, 'hook-node-syntax').length, 0);
});

// ---------------------------------------------------------------------------
// G. #15 claude-cli-resolvable
// ---------------------------------------------------------------------------

/** Build a minimal CliFact. */
const mkCliFact = (over) => ({
  command: 'claude',
  status: 'ok',
  resolvedPath: '/usr/local/bin/claude',
  version: '2.1.0',
  ...over,
});

test('#15: status unresolved → exactly one claude-cli-resolvable WARN', () => {
  const r = runDoctor(
    { cli: mkCliFact({ status: 'unresolved', resolvedPath: null, version: null }) },
    { activeProbes: true },
  );
  const found = byCode(r.diagnostics, 'claude-cli-resolvable');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'warn');
  assert.equal(found[0].phase, 'doctor');
  assert.equal(typeof found[0].fix, 'string');
  assert.ok(found[0].fix.length > 0);
  assert.match(found[0].message, /not found on PATH/);
});

test('#15: status unresponsive with resolvedPath → one WARN whose message includes the path', () => {
  const path = '/usr/local/bin/claude';
  const r = runDoctor(
    { cli: mkCliFact({ status: 'unresponsive', resolvedPath: path, version: null }) },
    { activeProbes: true },
  );
  const found = byCode(r.diagnostics, 'claude-cli-resolvable');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'warn');
  assert.match(found[0].message, new RegExp(path.replace(/\//g, '\\/')));
  assert.equal(found[0].path, path);
});

test('#15: status ok → 0 findings', () => {
  const r = runDoctor({ cli: mkCliFact({ status: 'ok' }) }, { activeProbes: true });
  assert.equal(byCode(r.diagnostics, 'claude-cli-resolvable').length, 0);
});

test('#15: status resolved (Windows shim present) → 0 findings (no false positive)', () => {
  const r = runDoctor(
    { cli: mkCliFact({ status: 'resolved', resolvedPath: 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude', version: null }) },
    { activeProbes: true },
  );
  assert.equal(byCode(r.diagnostics, 'claude-cli-resolvable').length, 0);
});

test('#15: status indeterminate → 0 findings (no false positive)', () => {
  const r = runDoctor(
    { cli: mkCliFact({ status: 'indeterminate', resolvedPath: null, version: null }) },
    { activeProbes: true },
  );
  assert.equal(byCode(r.diagnostics, 'claude-cli-resolvable').length, 0);
});

test('GATE: passive mode with unresolved cli → #15 does NOT run; 0 claude-cli-resolvable findings', () => {
  const r = runDoctor({ cli: mkCliFact({ status: 'unresolved', resolvedPath: null, version: null }) });
  assert.equal(r.probeLevel, 'passive');
  assert.equal(byCode(r.diagnostics, 'claude-cli-resolvable').length, 0);
  const s15 = r.checks.find((c) => c.id === 15);
  assert.ok(s15, 'check #15 must appear in registry even in passive mode');
  assert.equal(s15.ran, false, 'check #15 must not have run in passive mode');
  assert.equal(s15.findings, 0);
});

test('never-throws: cli missing → 0 findings, no throw', () => {
  let r;
  assert.doesNotThrow(() => { r = runDoctor({}, { activeProbes: true }); });
  assert.equal(byCode(r.diagnostics, 'claude-cli-resolvable').length, 0);
});

test('never-throws: cli is a string → 0 findings, no throw', () => {
  let r;
  assert.doesNotThrow(() => {
    r = runDoctor({ cli: /** @type {any} */ ('bad') }, { activeProbes: true });
  });
  assert.equal(byCode(r.diagnostics, 'claude-cli-resolvable').length, 0);
});

test('never-throws: cli is empty object → 0 findings, no throw', () => {
  let r;
  assert.doesNotThrow(() => {
    r = runDoctor({ cli: /** @type {any} */ ({}) }, { activeProbes: true });
  });
  assert.equal(byCode(r.diagnostics, 'claude-cli-resolvable').length, 0);
});

test('active mode → check #15 summary has ran===true when cli is present', () => {
  const r = runDoctor(
    { cli: mkCliFact({ status: 'unresolved', resolvedPath: null, version: null }) },
    { activeProbes: true },
  );
  const s15 = r.checks.find((c) => c.id === 15);
  assert.ok(s15, 'check #15 must be in registry');
  assert.equal(s15.ran, true);
  assert.equal(s15.findings, 1);
});

// ---------------------------------------------------------------------------
// F. Registry assertion — #4, #15, and #19 appended LAST
// ---------------------------------------------------------------------------

test('registry: full id order is [1,2,3,5,18,6,7,8,9,10,11,12,22,23,13,14,16,20,21,25,17,24,26,27,4,15,19]', () => {
  const r = runDoctor({}, { activeProbes: true });
  assert.deepEqual(
    r.checks.map((c) => c.id),
    [1, 2, 3, 5, 18, 6, 7, 8, 9, 10, 11, 12, 22, 23, 13, 14, 16, 20, 21, 25, 17, 24, 26, 27, 4, 15, 19],
  );
});

test('registry: CHECKS length is now 27 (24 passive + 3 active)', () => {
  const r = runDoctor({}, { activeProbes: true });
  assert.equal(r.checks.length, 27);
});

// ---------------------------------------------------------------------------
// G. #19 loader-probe
// ---------------------------------------------------------------------------

/** Build a minimal LoaderProbeFact. */
const mkLoaderFact = (over) => ({
  probeName: '__mgr-probe-0000',
  wrote: true,
  observed: true,
  cleanedUp: true,
  ccVersion: '2.1.5',
  ...over,
});

test('#19: cleanedUp:false → one loader-probe WARN mentioning the probe file name', () => {
  const r = runDoctor(
    { loader: mkLoaderFact({ cleanedUp: false }) },
    { activeProbes: true },
  );
  const found = r.diagnostics.filter((d) => d.code === 'loader-probe');
  assert.ok(found.length >= 1, 'expected at least one loader-probe diagnostic');
  const warn = found.find((d) => d.severity === 'warn' && d.message.includes('residue'));
  assert.ok(warn, 'expected a residue warn');
  assert.match(warn.message, /__mgr-probe-0000/);
  assert.equal(typeof warn.fix, 'string');
  assert.ok(warn.fix.length > 0);
});

test('#19: wrote:true + observed:false → one loader-probe WARN about discovery misconfiguration', () => {
  const r = runDoctor(
    { loader: mkLoaderFact({ observed: false }) },
    { activeProbes: true },
  );
  const found = r.diagnostics.filter((d) => d.code === 'loader-probe' && d.severity === 'warn');
  const disc = found.find((d) => d.message.includes('discovery did not detect'));
  assert.ok(disc, 'expected a discovery warn');
  assert.equal(disc.phase, 'doctor');
  assert.equal(typeof disc.fix, 'string');
});

test('#19: wrote:true + observed:true + cleanedUp:true + ccVersion 2.1.5 → 0 findings (verified → silent)', () => {
  const r = runDoctor(
    { loader: mkLoaderFact({ ccVersion: '2.1.5' }) },
    { activeProbes: true },
  );
  const found = r.diagnostics.filter((d) => d.code === 'loader-probe');
  assert.equal(found.length, 0, 'verified ccVersion must produce no loader-probe findings');
});

test('#19: wrote:true + observed:true + cleanedUp:true + ccVersion:null → one loader-probe INFO (best-effort)', () => {
  const r = runDoctor(
    { loader: mkLoaderFact({ ccVersion: null }) },
    { activeProbes: true },
  );
  const found = r.diagnostics.filter((d) => d.code === 'loader-probe');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'info');
  assert.match(found[0].message, /best-effort/);
  assert.match(found[0].message, /unknown/);
});

test('GATE: passive mode with loader fact → #19 does NOT run; 0 loader-probe findings', () => {
  const r = runDoctor({ loader: mkLoaderFact({ cleanedUp: false }) });
  assert.equal(r.probeLevel, 'passive');
  assert.equal(r.diagnostics.filter((d) => d.code === 'loader-probe').length, 0);
  const s19 = r.checks.find((c) => c.id === 19);
  assert.ok(s19, 'check #19 must appear in registry even in passive mode');
  assert.equal(s19.ran, false, 'check #19 must not have run in passive mode');
  assert.equal(s19.findings, 0);
});

test('never-throws: loader undefined in active mode → 0 findings, no throw', () => {
  let r;
  assert.doesNotThrow(() => { r = runDoctor({}, { activeProbes: true }); });
  assert.equal(r.diagnostics.filter((d) => d.code === 'loader-probe').length, 0);
});

test('never-throws: loader is a string in active mode → 0 findings, no throw', () => {
  let r;
  assert.doesNotThrow(() => {
    r = runDoctor({ loader: /** @type {any} */ ('bad') }, { activeProbes: true });
  });
  assert.equal(r.diagnostics.filter((d) => d.code === 'loader-probe').length, 0);
});

test('active mode → check #19 summary has ran===true', () => {
  const r = runDoctor(
    { loader: mkLoaderFact({ cleanedUp: false }) },
    { activeProbes: true },
  );
  const s19 = r.checks.find((c) => c.id === 19);
  assert.ok(s19, 'check #19 must be in registry');
  assert.equal(s19.ran, true);
  assert.ok(s19.findings >= 1);
});
