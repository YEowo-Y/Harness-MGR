/**
 * P2.U5b — doctor-probe-checks.test.mjs
 *
 * Tests for the two pure probe-fact doctor checks (#1 mcp-auth-stale,
 * #2 mcp-server-resolvable) exercised through the public runDoctor() API.
 * All tests use a fixed reference time (NOW) so they are deterministic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor, CHECKS } from '../src/analysis/doctor/index.mjs';

const byCode = (diags, code) => diags.filter((d) => d.code === code);

const DAY = 86400000;
const NOW = 1800000000000;

// ── A. #1 mcp-auth-stale ──────────────────────────────────────────────────────

test('#1: a fresh auth entry (10 days old) produces no findings', () => {
  const r = runDoctor({ now: NOW, mcpAuth: [{ name: 'fresh', timestamp: NOW - 10 * DAY }] });
  assert.equal(byCode(r.diagnostics, 'mcp-auth-stale').length, 0);
});

test('#1: a 45-day-old entry produces one warn mentioning "45 days" and the server name', () => {
  const r = runDoctor({ now: NOW, mcpAuth: [{ name: 'my-server', timestamp: NOW - 45 * DAY }] });
  const found = byCode(r.diagnostics, 'mcp-auth-stale');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'warn');
  assert.match(found[0].message, /45 days/);
  assert.match(found[0].message, /my-server/);
});

test('#1: a 120-day-old entry produces one error', () => {
  const r = runDoctor({ now: NOW, mcpAuth: [{ name: 's', timestamp: NOW - 120 * DAY }] });
  const found = byCode(r.diagnostics, 'mcp-auth-stale');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'error');
});

test('#1: exactly 30 days old produces no findings (strictly greater threshold)', () => {
  const r = runDoctor({ now: NOW, mcpAuth: [{ name: 's', timestamp: NOW - 30 * DAY }] });
  assert.equal(byCode(r.diagnostics, 'mcp-auth-stale').length, 0);
});

test('#1: exactly 90 days old produces one warn (not error — error threshold is strictly >90)', () => {
  const r = runDoctor({ now: NOW, mcpAuth: [{ name: 's', timestamp: NOW - 90 * DAY }] });
  const found = byCode(r.diagnostics, 'mcp-auth-stale');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'warn');
});

test('#1: now absent with a 120-day-old fact → 0 findings (purity: no Date.now() fallback)', () => {
  const r = runDoctor({ mcpAuth: [{ name: 's', timestamp: NOW - 120 * DAY }] });
  assert.equal(byCode(r.diagnostics, 'mcp-auth-stale').length, 0);
});

test('#1: future timestamp (NOW + 10 days) → 0 findings (negative age is not stale)', () => {
  const r = runDoctor({ now: NOW, mcpAuth: [{ name: 's', timestamp: NOW + 10 * DAY }] });
  assert.equal(byCode(r.diagnostics, 'mcp-auth-stale').length, 0);
});

test('#1: two stale facts produce output sorted by server name (ascending)', () => {
  const r = runDoctor({
    now: NOW,
    mcpAuth: [
      { name: 'zebra', timestamp: NOW - 45 * DAY },
      { name: 'apple', timestamp: NOW - 45 * DAY },
    ],
  });
  const found = byCode(r.diagnostics, 'mcp-auth-stale');
  assert.equal(found.length, 2);
  assert.match(found[0].message, /apple/);
  assert.match(found[1].message, /zebra/);
});

test('#1: malformed fact with no timestamp is skipped, never throws', () => {
  let r;
  assert.doesNotThrow(() => { r = runDoctor({ now: NOW, mcpAuth: [{ name: 'x' }] }); });
  assert.equal(byCode(r.diagnostics, 'mcp-auth-stale').length, 0);
});

// ── B. #2 mcp-server-resolvable ───────────────────────────────────────────────

test('#2: resolved===false fact → one warn mentioning the command and "not found"', () => {
  const r = runDoctor({ mcpResolution: [{ name: 'srv', command: 'uvx', resolved: false }] });
  const found = byCode(r.diagnostics, 'mcp-server-resolvable');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'warn');
  assert.match(found[0].message, /uvx/);
  assert.match(found[0].message, /not found/);
});

test('#2: resolved===true fact → 0 findings', () => {
  const r = runDoctor({ mcpResolution: [{ name: 'srv', command: 'node', resolved: true }] });
  assert.equal(byCode(r.diagnostics, 'mcp-server-resolvable').length, 0);
});

test('#2: mix of true/false facts → only the false ones are flagged', () => {
  const r = runDoctor({
    mcpResolution: [
      { name: 'ok', command: 'node', resolved: true },
      { name: 'bad', command: 'missing-cmd', resolved: false },
      { name: 'also-ok', command: 'npx', resolved: true },
    ],
  });
  const found = byCode(r.diagnostics, 'mcp-server-resolvable');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /missing-cmd/);
});

test('#2: empty mcpResolution → 0 findings', () => {
  const r = runDoctor({ mcpResolution: [] });
  assert.equal(byCode(r.diagnostics, 'mcp-server-resolvable').length, 0);
});

test('#2: missing mcpResolution field → 0 findings, no throw', () => {
  let r;
  assert.doesNotThrow(() => { r = runDoctor({}); });
  assert.equal(byCode(r.diagnostics, 'mcp-server-resolvable').length, 0);
});

// ── C. INTEGRATION — both checks in a full runDoctor call ────────────────────

test('integration: checks array is [1,2,3,5,6,7,8,9,10,11,12,22,23] with #1 error + #2 warn', () => {
  const r = runDoctor({
    now: NOW,
    mcpAuth: [{ name: 's', timestamp: NOW - 120 * DAY }],
    mcpResolution: [{ name: 'a', command: 'x', resolved: false }],
  });

  assert.deepEqual(r.checks.map((c) => c.id), [1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 22, 23]);
  assert.equal(r.probeLevel, 'passive');

  const s1 = r.checks.find((c) => c.id === 1);
  assert.ok(s1.ran);
  assert.equal(s1.findings, 1);

  const s2 = r.checks.find((c) => c.id === 2);
  assert.ok(s2.ran);
  assert.equal(s2.findings, 1);

  assert.equal(byCode(r.diagnostics, 'mcp-auth-stale')[0].severity, 'error');
  assert.equal(byCode(r.diagnostics, 'mcp-server-resolvable')[0].severity, 'warn');
});

test('integration: CHECKS registry has 13 entries starting with ids 1 and 2', () => {
  assert.equal(CHECKS.length, 13);
  assert.equal(CHECKS[0].id, 1);
  assert.equal(CHECKS[1].id, 2);
});

// ── D. NEVER-THROWS boundary ──────────────────────────────────────────────────

test('never-throws: malformed mcpAuth/mcpResolution/now → no throw, 0 mcp-* findings', () => {
  let r;
  assert.doesNotThrow(() => {
    r = runDoctor(/** @type {any} */ ({ mcpAuth: 'x', mcpResolution: 7, now: 'nope' }));
  });
  assert.equal(byCode(r.diagnostics, 'mcp-auth-stale').length, 0);
  assert.equal(byCode(r.diagnostics, 'mcp-server-resolvable').length, 0);
});
