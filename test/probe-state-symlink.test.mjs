/**
 * SECURITY regression (audit 2026-06-02) — probe-state-symlink.test.mjs
 *
 * Falsifiable oracle for the symlink-never-follow guard on gatherTrackedState's
 * TOP-LEVEL tracked files (src/discovery/probe-state.mjs). The TRACKED_DIRS roots
 * were already guarded (follow-up #7), but the top-level file loop hashed via
 * readFileSync, which FOLLOWS a symlink — so a symlinked settings.json/.mcp.json/
 * CLAUDE.md/plugins JSON had its FOREIGN target hashed into the drift fingerprint
 * + lockfile (an integrity defect, same class as the snapshot-walk root leak).
 *
 * PRE-FIX the symlinked file IS hashed (its key is present). POST-FIX it is OMITTED
 * (never followed). A REAL (non-symlink) tracked file must still be hashed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gatherTrackedState } from '../src/discovery/probe-state.mjs';

function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-probestate-symlink-'));
  return { dir, cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } };
}
function trySymlink(target, linkPath) {
  try { symlinkSync(target, linkPath, 'file'); return true; }
  catch { return false; }
}

const FOREIGN = 'FOREIGN-CONTENT-do-not-track-into-the-fingerprint';

test('gatherTrackedState does NOT follow a symlinked top-level tracked file', (t) => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const foreign = join(dir, 'OUTSIDE.json');
    writeFileSync(foreign, JSON.stringify({ leak: FOREIGN }));
    // settings.json is a SYMLINK to the foreign file.
    if (!trySymlink(foreign, join(dir, 'settings.json'))) { t.skip('symlinks not permitted'); return; }
    // A REAL tracked file that MUST still be hashed (no regression).
    writeFileSync(join(dir, 'CLAUDE.md'), 'real claude md');

    const { state } = gatherTrackedState({ configDir: dir });
    // The symlinked settings.json is OMITTED — never followed/hashed.
    assert.equal(state.files['settings.json'], undefined, 'symlinked settings.json must not be hashed');
    // The real file IS hashed (no over-rejection).
    assert.ok(typeof state.files['CLAUDE.md'] === 'string', 'real tracked file still hashed');
  } finally {
    cleanup();
  }
});

test('gatherTrackedState still hashes a REAL (non-symlink) top-level file', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    writeFileSync(join(dir, 'settings.json'), '{"model":"opus"}');
    const { state } = gatherTrackedState({ configDir: dir });
    assert.ok(typeof state.files['settings.json'] === 'string', 'real settings.json must still be hashed');
  } finally {
    cleanup();
  }
});
