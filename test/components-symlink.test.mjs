/**
 * SECURITY regression (audit 2026-06-02) — components-symlink.test.mjs
 *
 * Falsifiable oracle for the symlink-never-follow guard in collectSkills
 * (src/discovery/components.mjs). A skill directory whose SKILL.md is a SYMLINK
 * to a file OUTSIDE the config dir must NOT have its (foreign) content read into
 * a ComponentRecord — that frontmatter flows straight to `inventory --format
 * json`. The audit empirically reproduced a `ghp_`-shaped token leaking through
 * such a link.
 *
 * PRE-FIX these tests FAIL: the evil skill is discovered and its frontmatter
 * carries the foreign `leaked_token`. POST-FIX it is skipped with a
 * `component-symlink-skipped` warn, and the foreign content never appears.
 *
 * Existing SAFE behavior must NOT regress: a symlinked agents/commands `.md` is
 * already skipped by the `ent.isFile()` gate, and a top-level skill DIR-symlink
 * by the `ent.isDirectory()` gate. Two guard tests pin those.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverComponents } from '../src/discovery/components.mjs';

function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-comp-symlink-'));
  return { dir, cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } };
}

/** Attempt a symlink; return false if the OS/env forbids it (skip the test then). */
function trySymlink(target, linkPath, type) {
  try { symlinkSync(target, linkPath, type); return true; }
  catch { return false; }
}

const FOREIGN_TOKEN = 'ghp_FAKEAUDITSECRET0000000000000000000000';
/** True if a frontmatter map carries the foreign secret in any form. */
const leaks = (fm) => JSON.stringify(fm).includes(FOREIGN_TOKEN)
  || Object.prototype.hasOwnProperty.call(fm, 'leaked_token');

test('symlinked skills/<n>/SKILL.md → foreign content is NOT read into any record', (t) => {
  const { dir, cleanup } = makeTmpDir();
  try {
    // A foreign file holding secret-shaped frontmatter (the planted target).
    const foreign = join(dir, 'OUTSIDE-foreign-secret.md');
    writeFileSync(foreign, `---\nname: pwn\nleaked_token: ${FOREIGN_TOKEN}\n---\nbody\n`);

    // A real skill dir whose SKILL.md is a SYMLINK to the foreign file.
    const evilDir = join(dir, 'skills', 'evil');
    mkdirSync(evilDir, { recursive: true });
    const made = trySymlink(foreign, join(evilDir, 'SKILL.md'), 'file');
    if (!made) { t.skip('symlinks not permitted in this environment'); return; }

    // A normal real skill that MUST still be discovered (no regression).
    const goodDir = join(dir, 'skills', 'good');
    mkdirSync(goodDir, { recursive: true });
    writeFileSync(join(goodDir, 'SKILL.md'), `---\nname: good\nmodel: haiku\n---\nok\n`);

    const { components, diagnostics } = discoverComponents(dir);

    // No record may carry the foreign secret.
    for (const c of components) {
      assert.equal(leaks(c.frontmatter), false, `record ${c.kind}/${c.name} leaked foreign content`);
    }
    // The evil skill is skipped entirely.
    assert.equal(
      components.some((c) => c.kind === 'skill' && c.name === 'evil'), false,
      'evil skill (symlinked SKILL.md) must be skipped',
    );
    // A loud, visible diagnostic explains the skip.
    const skipped = diagnostics.filter((d) => d.code === 'component-symlink-skipped');
    assert.equal(skipped.length, 1, 'exactly one component-symlink-skipped diagnostic');
    assert.equal(skipped[0].severity, 'warn');
    assert.match(skipped[0].path, /evil[\\/]SKILL\.md$/);
    // The real skill is still discovered with its real frontmatter.
    const good = components.find((c) => c.kind === 'skill' && c.name === 'good');
    assert.ok(good, 'real skill still discovered (no regression)');
    assert.equal(good.frontmatter.model, 'haiku');
  } finally {
    cleanup();
  }
});

test('SAFE behavior preserved: symlinked agents/*.md is still skipped (no foreign read)', (t) => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const foreign = join(dir, 'OUTSIDE-agent.md');
    writeFileSync(foreign, `---\nname: pwn-agent\nleaked_token: ${FOREIGN_TOKEN}\n---\n`);
    mkdirSync(join(dir, 'agents'), { recursive: true });
    const made = trySymlink(foreign, join(dir, 'agents', 'evil.md'), 'file');
    if (!made) { t.skip('symlinks not permitted in this environment'); return; }

    const { components } = discoverComponents(dir);
    for (const c of components) assert.equal(leaks(c.frontmatter), false);
    assert.equal(components.some((c) => c.kind === 'agent'), false, 'symlinked agent .md must not be read');
  } finally {
    cleanup();
  }
});

test('SAFE behavior preserved: a top-level skill DIR-symlink is still skipped', (t) => {
  const { dir, cleanup } = makeTmpDir();
  try {
    // A foreign dir containing a real SKILL.md, linked in as skills/linked.
    const foreignSkill = join(dir, 'OUTSIDE-skilldir');
    mkdirSync(foreignSkill, { recursive: true });
    writeFileSync(join(foreignSkill, 'SKILL.md'), `---\nname: pwn\nleaked_token: ${FOREIGN_TOKEN}\n---\n`);
    mkdirSync(join(dir, 'skills'), { recursive: true });
    const made = trySymlink(foreignSkill, join(dir, 'skills', 'linked'), 'dir');
    if (!made) { t.skip('dir symlinks not permitted in this environment'); return; }

    const { components } = discoverComponents(dir);
    for (const c of components) assert.equal(leaks(c.frontmatter), false);
    assert.equal(components.some((c) => c.name === 'linked'), false, 'dir-symlinked skill must be skipped');
  } finally {
    cleanup();
  }
});
