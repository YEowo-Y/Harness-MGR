/**
 * Tests for src/ops/atomic-json-map-edit.mjs (Claude skill-visibility primitive).
 *
 * Exercises read → verified skill-visibility edit → gated atomic write against a REAL temp
 * settings.json (so realpathSync resolves + the genuine atomicApplyWrite .mgr-new/.mgr-old dance
 * runs) through the REAL Claude gate (default CLAUDE_WRITE_SURFACE, 'apply' context — settings.json
 * IS whole-file apply-writable, so NO new gate context). A happy flip changes the one token + leaves
 * env byte-identical; an insert adds a member; a CREATE adds the absent map; a no-op writes NOTHING;
 * a verify failure / read failure / gate denial / bad args all fail-closed without a throw.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { atomicJsonMapEdit } from '../src/ops/atomic-json-map-edit.mjs';
import { makeAssertWritable, MGR_STATE_DIRNAME, WriteForbiddenError } from '../src/paths.mjs';

const WITH_MAP = [
  '{',
  '  "model": "opus",',
  '  "skillOverrides": {',
  '    "deep-research": "off",',
  '    "tdd": "name-only"',
  '  },',
  '  "env": { "SECRET_TOKEN": "sk-do-not-touch-0123456789" }',
  '}',
  '',
].join('\n');

const NO_MAP = [
  '{',
  '  "model": "opus",',
  '  "env": { "SECRET_TOKEN": "sk-do-not-touch-0123456789" }',
  '}',
  '',
].join('\n');

/** Build a temp ~/.claude-shaped dir with settings.json = `fixture` + a real Claude gate. */
async function withSettings(fixture, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-jsonmap-'));
  const target = join(dir, 'settings.json');
  writeFileSync(target, fixture);
  const gate = makeAssertWritable({ configDir: dir, mgrStateDir: join(dir, MGR_STATE_DIRNAME) });
  try { return await fn({ dir, target, gate }); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const SEL = (memberKey) => ({ mapKey: 'skillOverrides', memberKey });

test('happy flip: changes ONE token, leaves env byte-identical', async () => {
  await withSettings(WITH_MAP, async ({ target, gate }) => {
    const r = await atomicJsonMapEdit({ target, selector: SEL('deep-research'), value: 'on', assertWritable: gate });
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    assert.equal(r.wrote, true);
    assert.ok(r.diff.before.includes('off'));
    assert.ok(r.diff.after.includes('on'));
    const after = readFileSync(target, 'utf8');
    assert.equal(after, WITH_MAP.replace('"deep-research": "off"', '"deep-research": "on"'));
    assert.ok(after.includes('sk-do-not-touch-0123456789')); // env secret survives untouched
  });
});

test('happy insert: a member absent from the map is added (valid JSON, env intact)', async () => {
  await withSettings(WITH_MAP, async ({ target, gate }) => {
    const r = await atomicJsonMapEdit({ target, selector: SEL('fresh-skill'), value: 'user-invocable-only', assertWritable: gate });
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    assert.equal(r.wrote, true);
    const after = JSON.parse(readFileSync(target, 'utf8'));
    assert.equal(after.skillOverrides['fresh-skill'], 'user-invocable-only');
    assert.equal(after.skillOverrides['deep-research'], 'off'); // sibling intact
    assert.equal(after.env.SECRET_TOKEN, 'sk-do-not-touch-0123456789'); // env intact
  });
});

test('happy create: an ABSENT map is created (valid JSON, env intact)', async () => {
  await withSettings(NO_MAP, async ({ target, gate }) => {
    const r = await atomicJsonMapEdit({ target, selector: SEL('deep-research'), value: 'off', assertWritable: gate });
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    assert.equal(r.wrote, true);
    const after = JSON.parse(readFileSync(target, 'utf8'));
    assert.equal(after.skillOverrides['deep-research'], 'off');
    assert.equal(after.model, 'opus'); // sibling intact
    assert.equal(after.env.SECRET_TOKEN, 'sk-do-not-touch-0123456789'); // env intact
  });
});

test('no-op: setting a member to its current value writes NOTHING', async () => {
  await withSettings(WITH_MAP, async ({ target, gate }) => {
    const r = await atomicJsonMapEdit({ target, selector: SEL('tdd'), value: 'name-only', assertWritable: gate });
    assert.equal(r.ok, true);
    assert.equal(r.wrote, false);
    assert.equal(r.diff, null);
    assert.equal(readFileSync(target, 'utf8'), WITH_MAP);
    assert.ok(r.diagnostics.some((d) => d.code === 'apply-json-map-edit-noop'));
  });
});

test('verify fail-closed: a non-object skillOverrides writes NOTHING', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-jsonmap-nb-'));
  const target = join(dir, 'settings.json');
  const doc = '{"skillOverrides":"nope"}';
  writeFileSync(target, doc);
  const gate = makeAssertWritable({ configDir: dir, mgrStateDir: join(dir, MGR_STATE_DIRNAME) });
  try {
    const r = await atomicJsonMapEdit({ target, selector: SEL('x'), value: 'off', assertWritable: gate });
    assert.equal(r.ok, false);
    assert.ok(r.diagnostics.some((d) => d.code === 'apply-json-map-edit-verify-failed'));
    assert.equal(readFileSync(target, 'utf8'), doc); // untouched
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read failure: a nonexistent target → fail-closed, no throw', async () => {
  await withSettings(WITH_MAP, async ({ dir, gate }) => {
    const r = await atomicJsonMapEdit({ target: join(dir, 'nope.json'), selector: SEL('x'), value: 'off', assertWritable: gate });
    assert.equal(r.ok, false);
    assert.ok(r.diagnostics.some((d) => d.code === 'apply-json-map-edit-read-failed'));
  });
});

test('gate denial: a denying gate writes NOTHING and surfaces the denial', async () => {
  await withSettings(WITH_MAP, async ({ target }) => {
    const denyGate = () => { throw new WriteForbiddenError('denied', 'write-not-allowed'); };
    const r = await atomicJsonMapEdit({ target, selector: SEL('deep-research'), value: 'on', assertWritable: denyGate });
    assert.equal(r.ok, false);
    assert.ok(r.diagnostics.some((d) => d.code === 'apply-write-gate-denied'));
    assert.equal(readFileSync(target, 'utf8'), WITH_MAP); // untouched
  });
});

test('bad args: missing target / bad selector / non-string value / missing gate → fail-closed', async () => {
  assert.equal((await atomicJsonMapEdit({ selector: SEL('x'), value: 'off', assertWritable: (p) => p })).ok, false);
  assert.equal((await atomicJsonMapEdit({ target: 'x', selector: { mapKey: 'skillOverrides' }, value: 'off', assertWritable: (p) => p })).ok, false);
  assert.equal((await atomicJsonMapEdit({ target: 'x', selector: SEL('x'), value: 5, assertWritable: (p) => p })).ok, false);
  assert.equal((await atomicJsonMapEdit({ target: 'x', selector: SEL('x'), value: 'off' })).ok, false);
});
