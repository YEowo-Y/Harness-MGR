/**
 * components-apple-metadata.test.mjs — discoverComponents must NOT treat a macOS
 * AppleDouble sidecar (._roster.md / ._agent.toml) or a .DS_Store as a real
 * component. Else a mac-touched ~/.claude grows PHANTOM agents/commands/skills in
 * `inventory` that the snapshot / drift / orphan walkers (all filtered in this same
 * unit) never see — the exact cross-choke-point inconsistency deferred item #2
 * exists to remove. PRE-FIX a ._roster.md yields a phantom `._roster` agent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverComponents } from '../src/discovery/components.mjs';

function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-components-apple-'));
  return { dir, cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } };
}

test('discoverComponents ignores AppleDouble sidecars + .DS_Store (no phantom components)', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    // A real agent + command + skill, each SHADOWED by a mac AppleDouble sidecar,
    // plus loose .DS_Store files Finder drops in.
    mkdirSync(join(dir, 'agents'), { recursive: true });
    writeFileSync(join(dir, 'agents', 'roster.md'), '---\nname: roster\n---\nbody\n');
    writeFileSync(join(dir, 'agents', '._roster.md'), 'AppleDouble-resource-fork-bytes'); // phantom pre-fix
    writeFileSync(join(dir, 'agents', '.DS_Store'), 'finder');
    mkdirSync(join(dir, 'commands'), { recursive: true });
    writeFileSync(join(dir, 'commands', 'build.md'), 'build\n');
    writeFileSync(join(dir, 'commands', '._build.md'), 'AppleDouble'); // phantom pre-fix
    mkdirSync(join(dir, 'skills', 'real-skill'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'real-skill', 'SKILL.md'), '---\nname: real-skill\n---\n');
    writeFileSync(join(dir, 'skills', '._real-skill'), 'AppleDouble'); // loose ._ file in skills/
    mkdirSync(join(dir, 'skills', '.AppleDouble'));                     // AppleDouble DIR in skills/

    const { components } = discoverComponents(dir);
    const names = components.map((c) => `${c.kind}:${c.name}`).sort();
    // EXACTLY the three real components — no ._roster / ._build / ._real-skill phantoms.
    assert.deepEqual(names, ['agent:roster', 'command:build', 'skill:real-skill']);
    assert.equal(components.some((c) => c.name.startsWith('._')), false, 'no AppleDouble phantom component');
    assert.equal(components.some((c) => c.name === '.DS_Store'), false);
  } finally {
    cleanup();
  }
});
