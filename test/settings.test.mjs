/**
 * P1.U9 — settings.test.mjs
 *
 * Golden assertions for discoverSettings (statusLine capture) and
 * discoverTopLevelDirs (the 19-known-dir classification) against the
 * settings-mcp/ fixture, plus malformed-JSON and edge-case coverage.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverSettings, discoverTopLevelDirs, KNOWN_TOP_DIRS } from '../src/discovery/settings.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fix = (rel) => join(here, 'fixtures', rel);
const bySeverity = (diags, sev) => diags.filter((d) => d.severity === sev);

/** Run `fn` against a throwaway dir holding settings.json. */
function withTempSettings(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-u9-set-'));
  try {
    writeFileSync(join(dir, 'settings.json'), content, 'utf-8');
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── discoverSettings ────────────────────────────────────────────────────────

test('settings-mcp: captures statusLine type + command', () => {
  const { present, statusLine, diagnostics } = discoverSettings(fix('settings-mcp'));
  assert.equal(present, true);
  assert.equal(bySeverity(diagnostics, 'error').length, 0);
  assert.deepEqual(statusLine, { type: 'command', command: 'node $HOME/.claude/hud/omc-hud.mjs' });
});

test('minimal: present but no statusLine → null', () => {
  const { present, statusLine } = discoverSettings(fix('minimal'));
  assert.equal(present, true);
  assert.equal(statusLine, null);
});

test('broken: trailing-comma settings.json → unreadable error, present false, no throw', () => {
  let result;
  assert.doesNotThrow(() => {
    result = discoverSettings(fix('broken'));
  });
  assert.equal(result.present, false);
  assert.equal(result.statusLine, null);
  const err = result.diagnostics.find((d) => d.code === 'settings-unreadable');
  assert.ok(err);
  assert.equal(err.severity, 'error');
});

test('non-string root → discover-bad-root, never throws', () => {
  let result;
  assert.doesNotThrow(() => {
    result = discoverSettings(/** @type {any} */ (undefined));
  });
  assert.equal(result.present, false);
  assert.equal(result.diagnostics[0].code, 'discover-bad-root');
});

test('a statusLine that is not an object is captured as null (best-effort)', () => {
  withTempSettings(JSON.stringify({ statusLine: 'oops' }), (dir) => {
    const { present, statusLine } = discoverSettings(dir);
    assert.equal(present, true);
    assert.equal(statusLine, null);
  });
});

test('an empty statusLine ({}) collapses to null (no usable content)', () => {
  withTempSettings(JSON.stringify({ statusLine: {} }), (dir) => {
    const { present, statusLine } = discoverSettings(dir);
    assert.equal(present, true);
    assert.equal(statusLine, null);
  });
});

// ── discoverTopLevelDirs ────────────────────────────────────────────────────

test('settings-mcp: 4 known dirs present, 1 unknown (experimental)', () => {
  const { known, unknown, diagnostics } = discoverTopLevelDirs(fix('settings-mcp'));
  assert.equal(bySeverity(diagnostics, 'error').length, 0);
  assert.equal(known.length, 19, 'all 19 known dirs accounted for');

  const present = known.filter((d) => d.present).map((d) => d.name).sort();
  assert.deepEqual(present, ['agents', 'hud', 'plugins', 'skills']);
  assert.deepEqual(unknown, ['experimental']);
});

test('settings-mcp: hud/ is among the present known dirs', () => {
  const { known } = discoverTopLevelDirs(fix('settings-mcp'));
  const hud = known.find((d) => d.name === 'hud');
  assert.ok(hud);
  assert.equal(hud.present, true);
});

test('minimal: 3 known dirs present (agents, commands, skills), no unknown', () => {
  const { known, unknown } = discoverTopLevelDirs(fix('minimal'));
  const present = known.filter((d) => d.present).map((d) => d.name).sort();
  assert.deepEqual(present, ['agents', 'commands', 'skills']);
  assert.deepEqual(unknown, []);
});

test('KNOWN_TOP_DIRS has exactly the 19 verified directories', () => {
  assert.equal(KNOWN_TOP_DIRS.length, 19);
  assert.ok(KNOWN_TOP_DIRS.includes('hud'));
  assert.ok(KNOWN_TOP_DIRS.includes('plugins'));
});

test('top-dirs on a non-string root → discover-bad-root, all known absent', () => {
  let result;
  assert.doesNotThrow(() => {
    result = discoverTopLevelDirs(/** @type {any} */ (null));
  });
  assert.equal(result.known.length, 19);
  assert.equal(result.known.every((d) => d.present === false), true);
  assert.equal(result.diagnostics[0].code, 'discover-bad-root');
});
