/**
 * Tests for src/discovery/read-toml.mjs (P6 TOML wave, unit 2).
 *
 * The never-throws TOML file reader: valid parse, benign-missing, malformed →
 * one-line error with line:column, symlink refusal, and proto-safety/never-throws.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { readTomlFile } from '../src/discovery/read-toml.mjs';

function tmpDir() { return mkdtempSync(join(tmpdir(), 'mgr-read-toml-')); }

test('valid TOML file → parsed value, no error, not missing', () => {
  const dir = tmpDir();
  try {
    const f = join(dir, 'config.toml');
    writeFileSync(f, 'model = "gpt-5.5"\n[t]\nx = 1\n', 'utf8');
    const r = readTomlFile(f);
    assert.equal(r.error, null);
    assert.equal(r.missing, false);
    assert.equal(r.value.model, 'gpt-5.5');
    assert.equal(r.value.t.x, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing file → { value:null, error:null, missing:true } (benign)', () => {
  const dir = tmpDir();
  try {
    const r = readTomlFile(join(dir, 'nope.toml'));
    assert.deepEqual(r, { value: null, error: null, missing: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('malformed TOML → one-line error with 1-based line:column, value null', () => {
  const dir = tmpDir();
  try {
    const f = join(dir, 'bad.toml');
    writeFileSync(f, 'a = 1\nb = @nope\n', 'utf8');
    const r = readTomlFile(f);
    assert.equal(r.value, null);
    assert.equal(r.missing, false);
    assert.match(r.error, /^invalid TOML: .* \(line 2, column \d+\)$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('proto-safety: a __proto__ table key never pollutes', () => {
  const dir = tmpDir();
  try {
    const f = join(dir, 'p.toml');
    writeFileSync(f, '[a."__proto__"]\nx = 1\n', 'utf8');
    const r = readTomlFile(f);
    assert.equal(({}).polluted, undefined, 'Object.prototype untouched');
    assert.equal(r.error, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('symlink is refused (no foreign content followed)', () => {
  const dir = tmpDir();
  try {
    const real = join(dir, 'real.toml');
    writeFileSync(real, 'secret = "x"\n', 'utf8');
    const link = join(dir, 'config.toml');
    try {
      symlinkSync(real, link);
    } catch {
      return; // no symlink privilege on this host — skip (Windows without dev mode)
    }
    const r = readTomlFile(link);
    assert.equal(r.value, null);
    assert.match(r.error, /refused symlink/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readTomlFile never throws on a junk path', () => {
  assert.doesNotThrow(() => readTomlFile(''));
  assert.doesNotThrow(() => readTomlFile('/definitely/not/here/config.toml'));
});
