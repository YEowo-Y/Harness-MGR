/**
 * U2 oracle for src/ops/mcp-stash.mjs — the mcp-toggle stash (the undo point).
 *
 * Real temp ~/.claude tree + the REAL Claude gate. Pins: readRawEntry extracts ONLY the named
 * mcpServers entry (never the file's other/secret keys); entryHasEnv detects env (the
 * stash-refusal trigger); writeStash is gated + env-free + round-trips via readStash; deleteStash
 * is gated + absent=no-op; bad name / missing gate fail closed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { readRawEntry, entryHasEnv, writeStash, readStash, deleteStash, stashExists, stashPath } from '../src/ops/mcp-stash.mjs';
import { makeAssertWritable, MGR_STATE_DIRNAME } from '../src/paths.mjs';

const APP = {
  oauthAccount: { accountUuid: 'SECRET-UUID-must-not-leak', emailAddress: 'x@y.z' },
  mcpServers: {
    context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'], type: 'stdio', timeout: 30000 },
    withenv: { command: 'node', args: ['s.js'], env: { API_KEY: 'sk-secret' }, type: 'stdio' },
  },
};

function withTree(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-mcpstash-'));
  const stateDir = join(dir, MGR_STATE_DIRNAME);
  mkdirSync(stateDir, { recursive: true });
  const appFile = join(dir, '.claude.json');
  writeFileSync(appFile, JSON.stringify(APP, null, 2));
  const gate = makeAssertWritable({ configDir: dir, mgrStateDir: stateDir });
  try { return fn({ dir, stateDir, appFile, gate }); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('readRawEntry returns ONLY the named entry — never the file\'s other (secret) keys', () => {
  withTree(({ appFile }) => {
    const e = readRawEntry(appFile, 'context7');
    assert.deepEqual(e, { command: 'npx', args: ['-y', '@upstash/context7-mcp'], type: 'stdio', timeout: 30000 });
    // the secret-bearing oauthAccount is never part of the returned entry
    assert.ok(!JSON.stringify(e).includes('SECRET-UUID'));
    assert.equal(readRawEntry(appFile, 'nope'), null);
    assert.equal(readRawEntry(appFile, 'bad name!'), null);
    assert.equal(readRawEntry(join(appFile, 'missing'), 'context7'), null); // unreadable → null, no throw
  });
});

test('entryHasEnv detects an env block (the stash-refusal trigger)', () => {
  assert.equal(entryHasEnv(APP.mcpServers.withenv), true);
  assert.equal(entryHasEnv(APP.mcpServers.context7), false);
  assert.equal(entryHasEnv({ env: {} }), false); // empty env is not a secret
  assert.equal(entryHasEnv(null), false);
});

test('writeStash → readStash round-trips an env-free record (gated)', () => {
  withTree(({ stateDir, gate }) => {
    const w = writeStash({ mgrStateDir: stateDir, name: 'context7', entry: APP.mcpServers.context7, scope: 'user', assertWritable: gate, now: () => new Date(1700000000000) });
    assert.equal(w.written, true);
    assert.equal(stashExists(stateDir, 'context7'), true);
    const rec = readStash(stateDir, 'context7');
    assert.equal(rec.name, 'context7');
    assert.equal(rec.scope, 'user');
    assert.deepEqual(rec.config, APP.mcpServers.context7);
    assert.equal(rec.stashedAt, '2023-11-14T22:13:20.000Z');
  });
});

test('writeStash fails closed without a gate or with a bad name', () => {
  withTree(({ stateDir, gate }) => {
    assert.equal(writeStash({ mgrStateDir: stateDir, name: 'context7', entry: {}, /* no gate */ }).written, false);
    assert.equal(writeStash({ mgrStateDir: stateDir, name: 'bad name!', entry: {}, assertWritable: gate }).written, false);
    assert.equal(writeStash({ mgrStateDir: stateDir, name: 'x', entry: null, assertWritable: gate }).written, false);
  });
});

test('deleteStash removes the file (gated); absent = benign no-op', () => {
  withTree(({ stateDir, gate }) => {
    writeStash({ mgrStateDir: stateDir, name: 'context7', entry: APP.mcpServers.context7, assertWritable: gate });
    assert.equal(deleteStash({ mgrStateDir: stateDir, name: 'context7', assertWritable: gate }).deleted, true);
    assert.equal(stashExists(stateDir, 'context7'), false);
    assert.equal(deleteStash({ mgrStateDir: stateDir, name: 'context7', assertWritable: gate }).deleted, false); // absent no-op
  });
});

test('readStash returns null for an absent / malformed stash', () => {
  withTree(({ stateDir }) => {
    assert.equal(readStash(stateDir, 'context7'), null);
    mkdirSync(join(stateDir, 'mcp-disabled'), { recursive: true });
    writeFileSync(stashPath(stateDir, 'broken'), '{ not json');
    assert.equal(readStash(stateDir, 'broken'), null);
  });
});
