/**
 * probe-state-apple-metadata.test.mjs — gatherTrackedState must NOT hash macOS
 * Apple metadata (.DS_Store / ._* / .AppleDouble) into the drift fingerprint. Else
 * a mac Finder visit that drops a .DS_Store into a tracked dir reads as SPURIOUS
 * config drift on the next `doctor`. PRE-FIX these ARE hashed into state.files.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gatherTrackedState } from '../src/discovery/probe-state.mjs';

function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-probestate-apple-'));
  return { dir, cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } };
}

function writeAt(root, rel) {
  const abs = join(root, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, 'x');
}

test('gatherTrackedState omits Apple metadata from the drift fingerprint', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    writeAt(dir, 'skills/my-skill/SKILL.md');   // real tracked file — MUST be hashed
    writeAt(dir, 'skills/my-skill/.DS_Store');
    writeAt(dir, 'skills/my-skill/._SKILL.md');
    writeAt(dir, 'skills/.AppleDouble/data');    // AppleDouble DIR — must not be walked into
    writeAt(dir, 'agents/.DS_Store');

    const { state } = gatherTrackedState({ configDir: dir });
    assert.ok(typeof state.files['skills/my-skill/SKILL.md'] === 'string', 'the real tracked file is still hashed');
    for (const k of ['skills/my-skill/.DS_Store', 'skills/my-skill/._SKILL.md', 'skills/.AppleDouble/data', 'agents/.DS_Store']) {
      assert.equal(state.files[k], undefined, `${k} must NOT be hashed`);
    }
    // Belt: no hashed key is apple metadata.
    for (const k of Object.keys(state.files)) {
      const base = k.split('/').pop();
      assert.equal(base === '.DS_Store' || base.startsWith('._'), false, `${k} is apple metadata`);
      assert.equal(k.includes('/.AppleDouble/'), false, `${k} is under .AppleDouble`);
    }
  } finally {
    cleanup();
  }
});
