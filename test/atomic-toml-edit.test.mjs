/**
 * Tests for src/ops/atomic-toml-edit.mjs (P6 config-edit unit).
 *
 * Exercises the read → verified single-token edit → gated atomic write primitive
 * against a REAL temp config.toml (so realpathSync resolves + the genuine
 * atomicApplyWrite .mgr-new/.mgr-old dance runs). Proves: a happy flip changes the
 * one token + leaves secret bytes byte-identical; a no-op writes NOTHING; a verify
 * failure (duplicate enabled lines) writes NOTHING; a read failure and a gate denial
 * surface as fail-closed results. Uses the REAL codex gate (least-authority surface).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { atomicConfigEdit } from '../src/ops/atomic-toml-edit.mjs';
import { makeAssertWritable, MGR_STATE_DIRNAME, WriteForbiddenError } from '../src/paths.mjs';
import { codexDescriptor } from '../src/targets/codex.mjs';

const FIXTURE = [
  'model = "gpt-5.5"',
  '',
  '[mcp_servers.n8n_community.env]',
  'SECRET_TOKEN = "sk-do-not-touch-0123456789"',
  '',
  '[plugins."superpowers@openai-curated"]',
  'enabled = true',
  '',
  '[plugins."already-off@openai-curated"]',
  'enabled = false',
].join('\n');

/** Build a temp ~/.codex-shaped dir with config.toml = FIXTURE + a real codex gate.
 *  ASYNC + `await fn` so the finally cleanup waits for the async body (a plain
 *  `try { return fn() } finally { rmSync }` would delete the dir mid-write). */
async function withConfig(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-cfgedit-'));
  const target = join(dir, 'config.toml');
  writeFileSync(target, FIXTURE);
  const gate = makeAssertWritable({ configDir: dir, mgrStateDir: join(dir, MGR_STATE_DIRNAME), surface: codexDescriptor.writeSurface });
  try { return await fn({ dir, target, gate }); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const PLUGIN = (name) => ({ kind: 'plugin', name });

test('happy flip: disables a plugin, changes ONE token, leaves the secret byte-identical', async () => {
  await withConfig(async ({ target, gate }) => {
    const r = await atomicConfigEdit({ target, selector: PLUGIN('superpowers@openai-curated'), desired: false, assertWritable: gate });
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    assert.equal(r.wrote, true);
    assert.equal(r.diff.before, 'enabled = true');
    assert.equal(r.diff.after, 'enabled = false');
    const after = readFileSync(target, 'utf8');
    // exactly the FIXTURE with that one token flipped:
    assert.equal(after, FIXTURE.replace('[plugins."superpowers@openai-curated"]\nenabled = true\n', '[plugins."superpowers@openai-curated"]\nenabled = false\n'));
    assert.ok(after.includes('SECRET_TOKEN = "sk-do-not-touch-0123456789"'));
  });
});

test('no-op: disabling an already-disabled plugin writes NOTHING (file byte-identical)', async () => {
  await withConfig(async ({ target, gate }) => {
    const r = await atomicConfigEdit({ target, selector: PLUGIN('already-off@openai-curated'), desired: false, assertWritable: gate });
    assert.equal(r.ok, true);
    assert.equal(r.wrote, false);
    assert.equal(r.diff, null);
    assert.equal(readFileSync(target, 'utf8'), FIXTURE); // untouched
    assert.ok(r.diagnostics.some((d) => d.code === 'apply-config-edit-noop'));
  });
});

test('absent table: a missing plugin name is a no-op (no write)', async () => {
  await withConfig(async ({ target, gate }) => {
    const r = await atomicConfigEdit({ target, selector: PLUGIN('nope@x'), desired: false, assertWritable: gate });
    assert.equal(r.ok, true);
    assert.equal(r.wrote, false);
    assert.equal(readFileSync(target, 'utf8'), FIXTURE);
  });
});

test('verify fail-closed: a region with duplicate enabled lines writes NOTHING', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-cfgedit-dup-'));
  const target = join(dir, 'config.toml');
  const doc = ['[plugins."dup@x"]', 'enabled = true', 'enabled = true', '', '[features]', 'k = 1'].join('\n');
  writeFileSync(target, doc);
  const gate = makeAssertWritable({ configDir: dir, mgrStateDir: join(dir, MGR_STATE_DIRNAME), surface: codexDescriptor.writeSurface });
  try {
    const r = await atomicConfigEdit({ target, selector: PLUGIN('dup@x'), desired: false, assertWritable: gate });
    assert.equal(r.ok, false);
    assert.ok(r.diagnostics.some((d) => d.code === 'apply-config-edit-verify-failed'));
    assert.equal(readFileSync(target, 'utf8'), doc); // untouched
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read failure: a nonexistent target → fail-closed, no throw', async () => {
  await withConfig(async ({ dir, gate }) => {
    const r = await atomicConfigEdit({ target: join(dir, 'does-not-exist.toml'), selector: PLUGIN('a@b'), desired: false, assertWritable: gate });
    assert.equal(r.ok, false);
    assert.ok(r.diagnostics.some((d) => d.code === 'apply-config-edit-read-failed'));
  });
});

test('gate denial: a denying gate writes NOTHING and surfaces the denial', async () => {
  await withConfig(async ({ target }) => {
    const denyGate = () => { throw new WriteForbiddenError('denied', 'write-config-edit-only'); };
    const r = await atomicConfigEdit({ target, selector: PLUGIN('superpowers@openai-curated'), desired: false, assertWritable: denyGate });
    assert.equal(r.ok, false);
    assert.ok(r.diagnostics.some((d) => d.code === 'apply-write-gate-denied'));
    assert.equal(readFileSync(target, 'utf8'), FIXTURE); // untouched
  });
});

test('bad args: missing target / non-boolean desired / missing gate → fail-closed', async () => {
  assert.equal((await atomicConfigEdit({ selector: PLUGIN('a@b'), desired: false, assertWritable: (p) => p })).ok, false);
  assert.equal((await atomicConfigEdit({ target: 'x', selector: PLUGIN('a@b'), desired: 'no', assertWritable: (p) => p })).ok, false);
  assert.equal((await atomicConfigEdit({ target: 'x', selector: PLUGIN('a@b'), desired: false })).ok, false);
});
