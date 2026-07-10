/**
 * SECURITY regression (audit 2026-06-02) — read-json-symlink.test.mjs
 *
 * Falsifiable oracle for the symlink refusal in readJsonFile / readJsoncFile
 * (src/discovery/read-json.mjs). A symlinked settings.json / .mcp.json /
 * installed_plugins.json / known_marketplaces.json that points OUTSIDE the
 * config dir must NOT be read through to the foreign target — the audit proved a
 * symlinked settings.json/.mcp.json leaked statusLine.command + MCP
 * command/url/envKeys from the foreign file.
 *
 * PRE-FIX these FAIL: the foreign JSON is parsed and returned in `value`.
 * POST-FIX: `value:null` + a non-empty `error` string, never the foreign content.
 * A REAL (non-symlink) file must still parse (no regression).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readJsonFile, readJsoncFile } from '../src/discovery/read-json.mjs';

function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-readjson-symlink-'));
  return { dir, cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } };
}
function trySymlink(target, linkPath) {
  try { symlinkSync(target, linkPath, 'file'); return true; }
  catch { return false; }
}

const SENTINEL = 'MUSTNOTLEAK-ghp_FAKEAUDITSECRET';

test('readJsonFile refuses a symlink (no foreign content in value)', (t) => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const foreign = join(dir, 'OUTSIDE.json');
    writeFileSync(foreign, JSON.stringify({ statusLine: { command: `x --token=${SENTINEL}` } }));
    const link = join(dir, 'settings.json');
    if (!trySymlink(foreign, link)) { t.skip('symlinks not permitted'); return; }

    const r = readJsonFile(link);
    assert.equal(r.value, null, 'value must be null (foreign content not read)');
    assert.ok(typeof r.error === 'string' && r.error.length > 0, 'an error reason is reported');
    assert.equal(r.missing, false);
    assert.equal(JSON.stringify(r).includes(SENTINEL), false, 'sentinel must not leak anywhere in the result');
  } finally {
    cleanup();
  }
});

test('readJsoncFile refuses a symlink (no foreign content, duplicateKeys:[])', (t) => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const foreign = join(dir, 'OUTSIDE.jsonc');
    writeFileSync(foreign, `{ // comment\n  "statusLine": { "command": "x --token=${SENTINEL}" },\n}`);
    const link = join(dir, '.mcp.json');
    if (!trySymlink(foreign, link)) { t.skip('symlinks not permitted'); return; }

    const r = readJsoncFile(link);
    assert.equal(r.value, null);
    assert.ok(typeof r.error === 'string' && r.error.length > 0);
    assert.equal(r.missing, false);
    assert.deepEqual(r.duplicateKeys, []);
    assert.equal(JSON.stringify(r).includes(SENTINEL), false);
  } finally {
    cleanup();
  }
});

test('readJsonFile: a JSON syntax error near a secret does not echo file content', () => {
  // Node's JSON.parse "Unexpected token" messages embed a verbatim ~20-char excerpt
  // of the file around the error position. A user hand-editing .mcp.json / settings.json
  // who leaves a syntax error next to an env secret would have that secret's prefix
  // forwarded through the (unredacted) `error` string to stdout/JSON/the TUI. The
  // error must localize the fault WITHOUT reproducing any file bytes.
  const { dir, cleanup } = makeTmpDir();
  try {
    const bad = join(dir, 'installed_plugins.json');
    // Unquoted value → "Unexpected token" family, which is the leaking shape. V8
    // embeds a ~10-char excerpt starting at the fault, so it echoes the KEY NAME and
    // the first bytes of the secret value (e.g. `..."API_KEY": MUSTNOTLEA"...`).
    writeFileSync(bad, `{ "API_KEY": ${SENTINEL} }`);
    const r = readJsonFile(bad);
    assert.equal(r.value, null);
    assert.ok(typeof r.error === 'string' && r.error.length > 0, 'an error reason is reported');
    // Assert on the ACTUAL leaked bytes: the secret's 10-char prefix and the key name,
    // both verbatim file content. (Do NOT assert on the full sentinel — V8 truncates
    // it, which would give a false green.)
    assert.equal(r.error.includes('MUSTNOTLEA'), false, 'the secret prefix must not appear in the error');
    assert.equal(r.error.includes('API_KEY'), false, 'no verbatim file content (key name) in the error');
  } finally {
    cleanup();
  }
});

test('no regression: a REAL (non-symlink) JSON/JSONC file still parses', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const realJson = join(dir, 'real.json');
    writeFileSync(realJson, JSON.stringify({ ok: true, n: 1 }));
    const rj = readJsonFile(realJson);
    assert.equal(rj.error, null);
    assert.deepEqual(rj.value, { ok: true, n: 1 });

    const realJsonc = join(dir, 'real.jsonc');
    writeFileSync(realJsonc, `{ // ok\n  "ok": true,\n}`);
    const rc = readJsoncFile(realJsonc);
    assert.equal(rc.error, null);
    assert.equal(rc.value.ok, true);
    assert.deepEqual(rc.duplicateKeys, []);
  } finally {
    cleanup();
  }
});
