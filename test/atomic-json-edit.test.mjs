/**
 * Tests for src/ops/atomic-json-edit.mjs (Claude plugin-toggle primitive).
 *
 * Exercises read → verified plugin-toggle → gated atomic write against a REAL temp
 * settings.json (so realpathSync resolves + the genuine atomicApplyWrite .mgr-new/.mgr-old
 * dance runs) through the REAL Claude gate (default CLAUDE_WRITE_SURFACE, 'apply' context —
 * settings.json IS whole-file apply-writable, so NO new gate context). A happy flip changes
 * the one token + leaves env byte-identical; an enable-insert adds a member; a no-op writes
 * NOTHING; a verify failure (non-boolean) / read failure / gate denial / bad args all
 * fail-closed without a throw.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { atomicJsonEdit } from '../src/ops/atomic-json-edit.mjs';
import { makeAssertWritable, MGR_STATE_DIRNAME, WriteForbiddenError } from '../src/paths.mjs';

const FIXTURE = [
  '{',
  '  "model": "opus",',
  '  "enabledPlugins": {',
  '    "ecc@everything-claude-code": true,',
  '    "gsap-skills@gsap-skills": false',
  '  },',
  '  "env": { "SECRET_TOKEN": "sk-do-not-touch-0123456789" }',
  '}',
  '',
].join('\n');

/** Build a temp ~/.claude-shaped dir with settings.json = FIXTURE + a real Claude gate. */
async function withSettings(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-jsonedit-'));
  const target = join(dir, 'settings.json');
  writeFileSync(target, FIXTURE);
  const gate = makeAssertWritable({ configDir: dir, mgrStateDir: join(dir, MGR_STATE_DIRNAME) });
  try { return await fn({ dir, target, gate }); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const SEL = (key) => ({ key });

test('happy flip: disables a plugin, changes ONE token, leaves env byte-identical', async () => {
  await withSettings(async ({ target, gate }) => {
    const r = await atomicJsonEdit({ target, selector: SEL('ecc@everything-claude-code'), desired: false, assertWritable: gate });
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    assert.equal(r.wrote, true);
    assert.ok(r.diff.before.includes('true'));
    assert.ok(r.diff.after.includes('false'));
    const after = readFileSync(target, 'utf8');
    assert.equal(after, FIXTURE.replace('"ecc@everything-claude-code": true', '"ecc@everything-claude-code": false'));
    assert.ok(after.includes('sk-do-not-touch-0123456789')); // env secret survives untouched
  });
});

test('happy insert: enabling an absent plugin adds a member (valid JSON, env intact)', async () => {
  await withSettings(async ({ target, gate }) => {
    const r = await atomicJsonEdit({ target, selector: SEL('fresh@mkt'), desired: true, assertWritable: gate });
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    assert.equal(r.wrote, true);
    const after = JSON.parse(readFileSync(target, 'utf8'));
    assert.equal(after.enabledPlugins['fresh@mkt'], true);
    assert.equal(after.enabledPlugins['ecc@everything-claude-code'], true); // sibling intact
    assert.equal(after.env.SECRET_TOKEN, 'sk-do-not-touch-0123456789'); // env intact
  });
});

test('no-op: enabling an already-enabled plugin writes NOTHING', async () => {
  await withSettings(async ({ target, gate }) => {
    const r = await atomicJsonEdit({ target, selector: SEL('ecc@everything-claude-code'), desired: true, assertWritable: gate });
    assert.equal(r.ok, true);
    assert.equal(r.wrote, false);
    assert.equal(r.diff, null);
    assert.equal(readFileSync(target, 'utf8'), FIXTURE);
    assert.ok(r.diagnostics.some((d) => d.code === 'apply-json-edit-noop'));
  });
});

test('no-op: disabling an absent plugin writes NOTHING (already not-enabled)', async () => {
  await withSettings(async ({ target, gate }) => {
    const r = await atomicJsonEdit({ target, selector: SEL('nope@x'), desired: false, assertWritable: gate });
    assert.equal(r.ok, true);
    assert.equal(r.wrote, false);
    assert.equal(readFileSync(target, 'utf8'), FIXTURE);
  });
});

test('verify fail-closed: a non-boolean value writes NOTHING', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-jsonedit-nb-'));
  const target = join(dir, 'settings.json');
  const doc = '{"enabledPlugins":{"x@m":"true"}}';
  writeFileSync(target, doc);
  const gate = makeAssertWritable({ configDir: dir, mgrStateDir: join(dir, MGR_STATE_DIRNAME) });
  try {
    const r = await atomicJsonEdit({ target, selector: SEL('x@m'), desired: false, assertWritable: gate });
    assert.equal(r.ok, false);
    assert.ok(r.diagnostics.some((d) => d.code === 'apply-json-edit-verify-failed'));
    assert.equal(readFileSync(target, 'utf8'), doc); // untouched
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read failure: a nonexistent target → fail-closed, no throw', async () => {
  await withSettings(async ({ dir, gate }) => {
    const r = await atomicJsonEdit({ target: join(dir, 'nope.json'), selector: SEL('a@b'), desired: false, assertWritable: gate });
    assert.equal(r.ok, false);
    assert.ok(r.diagnostics.some((d) => d.code === 'apply-json-edit-read-failed'));
  });
});

test('gate denial: a denying gate writes NOTHING and surfaces the denial', async () => {
  await withSettings(async ({ target }) => {
    const denyGate = () => { throw new WriteForbiddenError('denied', 'write-not-allowed'); };
    const r = await atomicJsonEdit({ target, selector: SEL('ecc@everything-claude-code'), desired: false, assertWritable: denyGate });
    assert.equal(r.ok, false);
    assert.ok(r.diagnostics.some((d) => d.code === 'apply-write-gate-denied'));
    assert.equal(readFileSync(target, 'utf8'), FIXTURE); // untouched
  });
});

test('bad args: missing target / non-string key / non-boolean desired / missing gate → fail-closed', async () => {
  assert.equal((await atomicJsonEdit({ selector: SEL('a@b'), desired: false, assertWritable: (p) => p })).ok, false);
  assert.equal((await atomicJsonEdit({ target: 'x', selector: {}, desired: false, assertWritable: (p) => p })).ok, false);
  assert.equal((await atomicJsonEdit({ target: 'x', selector: SEL('a@b'), desired: 'no', assertWritable: (p) => p })).ok, false);
  assert.equal((await atomicJsonEdit({ target: 'x', selector: SEL('a@b'), desired: false })).ok, false);
});
