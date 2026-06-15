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
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, lstatSync, rmSync } from 'node:fs';
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

/**
 * True only if `made` AND linkPath is now ACTUALLY a symlink. Guards a cold-start
 * Windows Dev-Mode race where symlinkSync returns success but the link isn't yet
 * observable as a symlink to a follow-up lstat (which would make a root-symlink test
 * walk it as a real dir and false-fail). A test that gets false here should skip.
 */
function symlinkReady(made, linkPath) {
  if (!made) return false;
  try { return lstatSync(linkPath).isSymbolicLink(); } catch { return false; }
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

test('symlinked skills/ ROOT → entire dir skipped (no foreign content), real agents/ still discovered', (t) => {
  const { dir, cleanup } = makeTmpDir();
  try {
    // A FOREIGN skills tree holding a real skill with a secret-shaped frontmatter.
    const foreign = join(dir, 'OUTSIDE-skills');
    mkdirSync(join(foreign, 'pwn'), { recursive: true });
    writeFileSync(join(foreign, 'pwn', 'SKILL.md'), `---\nname: pwn\nleaked_token: ${FOREIGN_TOKEN}\n---\nbody\n`);
    // The skills/ ROOT itself is a SYMLINK to the foreign tree (the vector this closes).
    const made = trySymlink(foreign, join(dir, 'skills'), 'dir');
    if (!symlinkReady(made, join(dir, 'skills'))) { t.skip('dir symlinks not reliably created in this environment'); return; }
    // A real, NON-symlinked agents/ root that MUST still be discovered (no over-rejection).
    mkdirSync(join(dir, 'agents'), { recursive: true });
    writeFileSync(join(dir, 'agents', 'helper.md'), `---\nname: helper\n---\nok\n`);

    const { components, diagnostics } = discoverComponents(dir);

    for (const c of components) assert.equal(leaks(c.frontmatter), false, `record ${c.kind}/${c.name} leaked foreign content`);
    assert.equal(components.some((c) => c.kind === 'skill'), false, 'a symlinked skills/ root must yield NO skills');
    const skipped = diagnostics.filter((d) => d.code === 'component-dir-symlink-skipped');
    assert.equal(skipped.length, 1, 'exactly one component-dir-symlink-skipped diagnostic for the skills/ root');
    assert.equal(skipped[0].severity, 'warn');
    assert.match(skipped[0].path, /skills$/);
    assert.ok(components.some((c) => c.kind === 'agent' && c.name === 'helper'), 'a real (non-symlinked) agents/ root is NOT over-rejected');
  } finally { cleanup(); }
});

test('symlinked agents/ ROOT → skipped too (the guard is at the shared safeReaddir chokepoint, all kinds)', (t) => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const foreign = join(dir, 'OUTSIDE-agents');
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, 'evil.md'), `---\nname: evil\nleaked_token: ${FOREIGN_TOKEN}\n---\n`);
    const made = trySymlink(foreign, join(dir, 'agents'), 'dir');
    if (!symlinkReady(made, join(dir, 'agents'))) { t.skip('dir symlinks not reliably created in this environment'); return; }

    const { components, diagnostics } = discoverComponents(dir);
    for (const c of components) assert.equal(leaks(c.frontmatter), false);
    assert.equal(components.some((c) => c.kind === 'agent'), false, 'a symlinked agents/ root must yield NO agents');
    const skipped = diagnostics.filter((d) => d.code === 'component-dir-symlink-skipped');
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].path, /agents$/, 'the warn names the agents/ root');
  } finally { cleanup(); }
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
