/**
 * doctor-facts gather tests (P2.U11).
 *
 * Exercises src/cli/doctor-facts.mjs `gatherDoctorInput` against the committed
 * `minimal` fixture: the returned shape, the passive-vs-active side-effect
 * boundary (the active probe facts must be absent in a passive run), the fact
 * arrays the doctor judges, and the never-throws guarantee on bad input.
 *
 * No spawns are asserted here — the passive run never spawns, and the active
 * facts' own behaviour is covered by the per-probe tests. These tests only
 * confirm the ORCHESTRATION boundary: which facts are gathered, and that the
 * gather never throws.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { gatherDoctorInput } from '../src/cli/doctor-facts.mjs';
import { codexDescriptor } from '../src/targets/codex.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fix = (rel) => join(here, 'fixtures', rel);
const MIN = fix('minimal');
const STATE = join(MIN, '.mgr-state');

test('gatherDoctorInput: returns { input, diagnostics } without throwing', async () => {
  const out = await gatherDoctorInput({ configDir: MIN, mgrStateDir: STATE });
  assert.equal(typeof out, 'object');
  assert.ok(out.input && typeof out.input === 'object', 'input is an object');
  assert.ok(Array.isArray(out.diagnostics), 'diagnostics is an array');
});

test('gatherDoctorInput passive: active probe facts are absent (zero side effects)', async () => {
  const { input } = await gatherDoctorInput({ configDir: MIN, mgrStateDir: STATE, activeProbes: false });
  assert.equal(input.hookSyntax, undefined, 'no node --check facts in a passive run');
  assert.equal(input.cli, undefined, 'no claude --version fact in a passive run');
  assert.equal(input.loader, undefined, 'no loader-probe fact in a passive run');
});

test('gatherDoctorInput passive: carries the fact arrays the doctor judges', async () => {
  const { input } = await gatherDoctorInput({ configDir: MIN, mgrStateDir: STATE });
  for (const key of ['installedPlugins', 'marketplaces', 'conflicts', 'orphans']) {
    assert.ok(Array.isArray(input[key]), `${key} should be an array`);
  }
  // Passive probe facts are present (the probes always run in a passive gather).
  assert.ok(Array.isArray(input.mcpAuth), 'mcpAuth array present');
  assert.ok(Array.isArray(input.mcpResolution), 'mcpResolution array present');
  assert.ok(Array.isArray(input.hookFacts), 'hookFacts array present');
  assert.ok(input.fsFacts && typeof input.fsFacts === 'object', 'fsFacts present');
  assert.equal(typeof input.now, 'number', 'now is a number for age-based checks');
});

test('gatherDoctorInput active: gathers the active probe facts', async () => {
  const { input } = await gatherDoctorInput({ configDir: MIN, mgrStateDir: STATE, activeProbes: true });
  assert.ok(Array.isArray(input.hookSyntax), 'hookSyntax gathered under activeProbes');
  assert.ok(input.cli && typeof input.cli === 'object', 'cli fact gathered under activeProbes');
  // loader fact is present unless the loader probe was unavailable (dynamic import
  // guarded) — either way the gather must not throw and must return an object.
  assert.ok('loader' in input, 'loader key present under activeProbes');
});

test('gatherDoctorInput: never throws on an empty configDir', async () => {
  await assert.doesNotReject(async () => {
    const out = await gatherDoctorInput({ configDir: '', mgrStateDir: '' });
    assert.ok(out.input && typeof out.input === 'object');
    assert.ok(Array.isArray(out.diagnostics));
  });
});

test('gatherDoctorInput: never throws on a non-existent configDir', async () => {
  await assert.doesNotReject(async () => {
    const bad = fix('does-not-exist');
    const out = await gatherDoctorInput({ configDir: bad, mgrStateDir: join(bad, '.mgr-state') });
    assert.ok(out.input && typeof out.input === 'object');
    assert.ok(Array.isArray(out.diagnostics));
  });
});

test('gatherDoctorInput: respects an injected `now`', async () => {
  const fixedNow = 1.8e12;
  const { input } = await gatherDoctorInput({ configDir: MIN, mgrStateDir: STATE, now: fixedNow });
  assert.equal(input.now, fixedNow);
});

// ── P6.U4: target-aware hook source + branch coverage ─────────────────────────

test('gatherDoctorInput: codex descriptor sources hookFacts from hooks.json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-df-codex-'));
  try {
    const ps1 = join(dir, 'h.ps1');
    writeFileSync(ps1, '# hook', 'utf8');
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `powershell.exe -ExecutionPolicy Bypass -File "${ps1}"` }] }] },
    }), 'utf8');
    const { input, facts } = await gatherDoctorInput({ configDir: dir, mgrStateDir: join(dir, '.mgr-state'), descriptor: codexDescriptor });
    // the codex hooks.json hook is classified + probed → one found file fact.
    assert.equal(input.hookFacts.length, 1, 'one codex hook fact');
    assert.equal(input.hookFacts[0].kind, 'file');
    assert.equal(input.hookFacts[0].status, 'found');
    // buildHealthFacts exposes the same codex hooks map (true arm of the object guard).
    assert.ok(Array.isArray(facts.effectiveHooks.SessionStart), 'effectiveHooks carries codex events');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('gatherDoctorInput: a malformed codex .hooks (array) → effectiveHooks normalises to {} (false arm)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-df-codex-bad-'));
  try {
    // .hooks is an ARRAY (malformed) — gatherEffectiveHooks passes it through, and
    // buildHealthFacts's object-guard false arm must normalise it to {}.
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: [] }), 'utf8');
    const { facts } = await gatherDoctorInput({ configDir: dir, mgrStateDir: join(dir, '.mgr-state'), descriptor: codexDescriptor });
    assert.deepEqual(facts.effectiveHooks, {}, 'non-object hooks map → {}');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
