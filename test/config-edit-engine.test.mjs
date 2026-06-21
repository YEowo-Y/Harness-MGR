/**
 * Tests for the config-edit engine (src/ops/config-edit.mjs::setComponentEnabled) — P6.
 *
 * Hermetic: an injected readFn supplies the config fixture (no real fs) and an injected
 * applyFn stands in for the apply lifecycle. Proves: dry-run previews the flip + builds a
 * one-op config-edit plan; an already-in-state request is a safe no-op that NEVER calls
 * applyFn (no snapshot for a no-op); a real --apply forwards the plan+scope to applyFn and
 * surfaces the restart note; unsupported kinds (mcp/skill), bad names, not-found, an
 * unreadable config, and a gateless --apply are all clean refusals (never a throw).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { setComponentEnabled } from '../src/ops/config-edit.mjs';

const FIXTURE = [
  '[plugins."superpowers@openai-curated"]',
  'enabled = true',
  '',
  '[plugins."off@openai-curated"]',
  'enabled = false',
  '',
  '[mcp_servers.context7]',
  'command = "npx"',
  '',
  '[mcp_servers.n8n]',
  'url = "http://localhost:5678/mcp"',
  'bearer_token_env_var = "N8N_MCP_TOKEN"',
  '',
  '[mcp_servers.n8n.env]',
  'SECRET = "sk-do-not-touch"',
  '',
  '[[skills.config]]',
  'name = "off-skill"',
  'enabled = false',
  '',
  '[[skills.config]]',
  'name = "on-skill"',
  'enabled = true',
  '',
  '[[skills.config]]',
  'path = "C:/Users/alice/.codex/skills/off-skill/SKILL.md"',
  'enabled = false',
  '',
  '[[skills.config]]',         // a name shared by TWO entries → bare-name select is ambiguous
  'name = "dupe"',
  'enabled = false',
  '',
  '[[skills.config]]',
  'name = "dupe"',
  'enabled = true',
  '',
  '[[skills.config]]',         // a skill with NO enabled key → key-insert refusal (skills always carry one)
  'name = "keyless"',
  'description = "no enabled line here"',
].join('\n');

const base = { targetClaudeDir: 'C:\\codex', mgrStateDir: 'C:\\codex\\.mgr-state', configFile: 'config.toml', readFn: () => FIXTURE };
const PASS = (p) => p;

test('dry-run disable: previews the flip, writes nothing, builds a one-op config-edit plan', async () => {
  const r = await setComponentEnabled({ ...base, kind: 'plugin', name: 'superpowers@openai-curated', desired: false });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.alreadyInState, false);
  assert.deepEqual(r.diff, { line: 2, before: 'enabled = true', after: 'enabled = false' });
  assert.equal(r.plan.ops.length, 1);
  assert.equal(r.plan.ops[0].kind, 'config-edit');
  assert.deepEqual(r.plan.ops[0].selector, { kind: 'plugin', name: 'superpowers@openai-curated' });
  assert.equal(r.plan.ops[0].desired, false);
  assert.equal(r.plan.ops[0].target, 'C:\\codex\\config.toml');
});

test('dry-run enable of an already-enabled plugin → alreadyInState (safe no-op), diff null', async () => {
  const r = await setComponentEnabled({ ...base, kind: 'plugin', name: 'superpowers@openai-curated', desired: true });
  assert.equal(r.ok, true);
  assert.equal(r.alreadyInState, true);
  assert.equal(r.diff, null);
});

test('apply an already-in-state request → ok and NO applyFn call (no snapshot for a no-op)', async () => {
  let called = 0;
  const r = await setComponentEnabled({
    ...base, kind: 'plugin', name: 'off@openai-curated', desired: false, enableWrites: true,
    assertWritable: PASS, seams: { applyFn: async () => { called += 1; return { ok: true }; } },
  });
  assert.equal(r.ok, true);
  assert.equal(r.alreadyInState, true);
  assert.equal(called, 0, 'an already-in-state apply must not snapshot or write');
});

test('apply a real change → forwards the config-edit plan + scope to applyFn, surfaces restart note', async () => {
  let seen = null;
  const r = await setComponentEnabled({
    ...base, kind: 'plugin', name: 'superpowers@openai-curated', desired: false, enableWrites: true,
    assertWritable: PASS, scope: { walkDirs: ['skills'] },
    seams: { applyFn: async (o) => { seen = o; return { ok: true, applied: true, snapshotId: 'S1', diagnostics: [] }; } },
  });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, false);
  assert.equal(seen.enableWrites, true);
  assert.equal(seen.plan.ops[0].kind, 'config-edit');
  assert.deepEqual(seen.scope, { walkDirs: ['skills'] });
  assert.equal(seen.assertWritable, PASS);
  assert.ok(r.diagnostics.some((d) => d.code === 'config-edit-restart-needed'));
});

test('unsupported kind (bogus) → clean refusal', async () => {
  const r = await setComponentEnabled({ ...base, kind: 'widget', name: 'x', desired: false });
  assert.equal(r.refused, true);
  assert.ok(r.diagnostics.some((d) => d.code === 'config-edit-unsupported-kind'));
});

// ── skill: flip a [[skills.config]] element selected by name OR path ──────────────────

test('dry-run enable skill by NAME → previews the flip (false→true), field=name', async () => {
  const r = await setComponentEnabled({ ...base, kind: 'skill', name: 'off-skill', desired: true });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.field, 'name');
  assert.deepEqual(r.diff, { line: 19, before: 'enabled = false', after: 'enabled = true' });
  assert.deepEqual(r.plan.ops[0].selector, { kind: 'skill', match: { field: 'name', value: 'off-skill' } });
});

test('dry-run disable skill by PATH (selectorField:path) → previews the flip, field=path', async () => {
  const r = await setComponentEnabled({ ...base, kind: 'skill', name: 'C:/Users/alice/.codex/skills/off-skill/SKILL.md', selectorField: 'path', desired: false });
  assert.equal(r.ok, true);
  assert.equal(r.field, 'path');
  // already false → disable is a safe no-op (alreadyInState), diff null
  assert.equal(r.alreadyInState, true);
  assert.deepEqual(r.plan.ops[0].selector, { kind: 'skill', match: { field: 'path', value: 'C:/Users/alice/.codex/skills/off-skill/SKILL.md' } });
});

test('dry-run enable skill by PATH → real flip (false→true)', async () => {
  const r = await setComponentEnabled({ ...base, kind: 'skill', name: 'C:/Users/alice/.codex/skills/off-skill/SKILL.md', selectorField: 'path', desired: true });
  assert.equal(r.ok, true);
  assert.equal(r.alreadyInState, false);
  assert.equal(r.diff.before, 'enabled = false');
  assert.equal(r.diff.after, 'enabled = true');
});

test('skill enable that is already enabled → alreadyInState no-op (diff null)', async () => {
  const r = await setComponentEnabled({ ...base, kind: 'skill', name: 'on-skill', desired: true });
  assert.equal(r.ok, true);
  assert.equal(r.alreadyInState, true);
  assert.equal(r.diff, null);
});

test('ambiguous bare skill NAME (matches 2 entries) → refused with a --path hint', async () => {
  const r = await setComponentEnabled({ ...base, kind: 'skill', name: 'dupe', desired: false });
  assert.equal(r.refused, true);
  const d = r.diagnostics.find((x) => x.code === 'config-edit-ambiguous');
  assert.ok(d, 'config-edit-ambiguous emitted');
  assert.match(d.message, /--path/);
});

test('absent skill name → target-not-found refusal (no edit)', async () => {
  const r = await setComponentEnabled({ ...base, kind: 'skill', name: 'ghost-skill', desired: false });
  assert.equal(r.refused, true);
  assert.ok(r.diagnostics.some((d) => d.code === 'config-edit-target-not-found'));
});

test('skill with NO enabled key → no-enabled-key refusal (skills are never key-inserted)', async () => {
  const r = await setComponentEnabled({ ...base, kind: 'skill', name: 'keyless', desired: false });
  assert.equal(r.refused, true);
  assert.ok(r.diagnostics.some((d) => d.code === 'config-edit-no-enabled-key'));
});

test('bad skill name (slash / @) → refused; permissive PATH selector accepts a real path', async () => {
  for (const name of ['a/b', 'x@y']) {
    const r = await setComponentEnabled({ ...base, kind: 'skill', name, desired: false });
    assert.equal(r.refused, true);
    assert.ok(r.diagnostics.some((d) => d.code === 'config-edit-bad-name'));
  }
  // a control char in a path is rejected; a normal absolute path is accepted (reaches locate)
  const ctrl = await setComponentEnabled({ ...base, kind: 'skill', name: 'C:/x//SKILL.md', selectorField: 'path', desired: false });
  assert.ok(ctrl.diagnostics.some((d) => d.code === 'config-edit-bad-name'));
});

test('apply a real skill flip → forwards the skill selector + scope to applyFn', async () => {
  let seen = null;
  const r = await setComponentEnabled({
    ...base, kind: 'skill', name: 'off-skill', desired: true, enableWrites: true,
    assertWritable: PASS, scope: { walkDirs: ['skills'] },
    seams: { applyFn: async (o) => { seen = o; return { ok: true, applied: true, snapshotId: 'S1', diagnostics: [] }; } },
  });
  assert.equal(r.ok, true);
  assert.equal(r.field, 'name');
  assert.deepEqual(seen.plan.ops[0].selector, { kind: 'skill', match: { field: 'name', value: 'off-skill' } });
  assert.deepEqual(seen.scope, { walkDirs: ['skills'] });
});

// ── mcp: disable INSERTS enabled=false; enable on a key-absent server is a default-enabled no-op ──

test('dry-run disable mcp (no enabled key) → INSERT preview + loader-unverified caveat', async () => {
  const r = await setComponentEnabled({ ...base, kind: 'mcp', name: 'context7', desired: false });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.alreadyInState, false);
  assert.equal(r.diff.before, '');           // nothing was there — it's an insert
  assert.equal(r.diff.after, 'enabled = false');
  assert.equal(r.plan.ops[0].kind, 'config-edit');
  assert.deepEqual(r.plan.ops[0].selector, { kind: 'mcp', name: 'context7' });
  assert.ok(r.diagnostics.some((d) => d.code === 'config-edit-mcp-loader-unverified'), 'honest caveat present');
});

test('dry-run enable mcp on a key-absent (default-enabled) server → alreadyInState no-op, no caveat', async () => {
  const r = await setComponentEnabled({ ...base, kind: 'mcp', name: 'context7', desired: true });
  assert.equal(r.ok, true);
  assert.equal(r.alreadyInState, true);
  assert.equal(r.diff, null);
  assert.ok(!r.diagnostics.some((d) => d.code === 'config-edit-mcp-loader-unverified'));
  assert.ok(r.diagnostics.some((d) => /defaults to enabled/.test(d.message)));
});

test('apply disable mcp → forwards a config-edit op for the mcp selector', async () => {
  let seen = null;
  const r = await setComponentEnabled({
    ...base, kind: 'mcp', name: 'n8n', desired: false, enableWrites: true,
    assertWritable: PASS, scope: { walkDirs: ['skills'] },
    seams: { applyFn: async (o) => { seen = o; return { ok: true, applied: true, snapshotId: 'S1', diagnostics: [] }; } },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(seen.plan.ops[0].selector, { kind: 'mcp', name: 'n8n' });
  assert.equal(seen.plan.ops[0].desired, false);
  assert.ok(r.diagnostics.some((d) => d.code === 'config-edit-mcp-loader-unverified'));
});

test('bad mcp name (has @ / separators) → refused', async () => {
  for (const name of ['n8n@x', 'a/b', '../etc']) {
    const r = await setComponentEnabled({ ...base, kind: 'mcp', name, desired: false });
    assert.equal(r.refused, true);
    assert.ok(r.diagnostics.some((d) => d.code === 'config-edit-bad-name'));
  }
});

test('bad plugin name (whitespace) → refused', async () => {
  const r = await setComponentEnabled({ ...base, kind: 'plugin', name: 'has space', desired: false });
  assert.equal(r.refused, true);
  assert.ok(r.diagnostics.some((d) => d.code === 'config-edit-bad-name'));
});

test('plugin absent from the config → target-not-found refusal (no edit)', async () => {
  const r = await setComponentEnabled({ ...base, kind: 'plugin', name: 'ghost@x', desired: false });
  assert.equal(r.refused, true);
  assert.ok(r.diagnostics.some((d) => d.code === 'config-edit-target-not-found'));
});

test('unreadable config file → refused, never throws', async () => {
  const r = await setComponentEnabled({ ...base, kind: 'plugin', name: 'a@b', desired: false, readFn: () => { throw new Error('nope'); } });
  assert.equal(r.refused, true);
  assert.ok(r.diagnostics.some((d) => d.code === 'config-edit-config-not-found'));
});

test('--apply without an injected gate → refused before any apply', async () => {
  const r = await setComponentEnabled({ ...base, kind: 'plugin', name: 'superpowers@openai-curated', desired: false, enableWrites: true });
  assert.equal(r.refused, true);
  assert.ok(r.diagnostics.some((d) => d.code === 'config-edit-bad-args'));
});

// ── unsupported config shape (P6 §9): a clear refusal instead of a generic/misleading one ──
// The in-place editor can only flip a bare `enabled = true|false` token inside a real
// `[header]` region. A component present in some OTHER TOML shape (a non-boolean enabled,
// an inline table/array, or a file with a """ string the whole-doc verifier rejects) can
// never be flipped — these used to surface a cryptic locate-error, a misleading
// "not found", or (only at --apply) a verify-reparse-failed. Each is now one clear
// `config-edit-unsupported-shape` refusal (still fail-closed: refused, no write).

test('A — enabled value is a quoted string (not a bare boolean) → unsupported-shape', async () => {
  const text = '[plugins."x@y"]\nenabled = "true"\n';
  const r = await setComponentEnabled({ ...base, kind: 'plugin', name: 'x@y', desired: false, readFn: () => text });
  assert.equal(r.refused, true);
  const d = r.diagnostics.find((x) => x.code === 'config-edit-unsupported-shape');
  assert.ok(d, 'config-edit-unsupported-shape emitted');
  assert.match(d.message, /by hand/i);
  assert.ok(!r.diagnostics.some((x) => x.code === 'config-edit-locate-error'), 'no longer the generic locate-error');
});

test('B — file has an unterminated/multi-line construct → unsupported-shape (not locate-error)', async () => {
  const text = '[plugins."x@y"]\nenabled = true\ndesc = """\nunterminated\n';
  const r = await setComponentEnabled({ ...base, kind: 'plugin', name: 'x@y', desired: false, readFn: () => text });
  assert.equal(r.refused, true);
  assert.ok(r.diagnostics.some((x) => x.code === 'config-edit-unsupported-shape'));
  assert.ok(!r.diagnostics.some((x) => x.code === 'config-edit-locate-error'));
});

test('C — plugin defined as an INLINE TABLE → unsupported-shape (not the misleading target-not-found)', async () => {
  const text = 'plugins."x@y" = { enabled = true, version = "1.0" }\n';
  const r = await setComponentEnabled({ ...base, kind: 'plugin', name: 'x@y', desired: false, readFn: () => text });
  assert.equal(r.refused, true);
  assert.ok(r.diagnostics.some((x) => x.code === 'config-edit-unsupported-shape'));
  assert.ok(!r.diagnostics.some((x) => x.code === 'config-edit-target-not-found'));
});

test('C — skills written as an INLINE ARRAY → unsupported-shape', async () => {
  const text = 'skills.config = [ { name = "foo", enabled = true } ]\n';
  const r = await setComponentEnabled({ ...base, kind: 'skill', name: 'foo', desired: false, readFn: () => text });
  assert.equal(r.refused, true);
  assert.ok(r.diagnostics.some((x) => x.code === 'config-edit-unsupported-shape'));
  assert.ok(!r.diagnostics.some((x) => x.code === 'config-edit-target-not-found'));
});

test('C-negative — a genuinely absent component on a clean file STAYS target-not-found', async () => {
  // ghost@x is not defined in any shape → the honest message is still "not found", not unsupported-shape.
  const r = await setComponentEnabled({ ...base, kind: 'plugin', name: 'ghost@x', desired: false });
  assert.equal(r.refused, true);
  assert.ok(r.diagnostics.some((x) => x.code === 'config-edit-target-not-found'));
  assert.ok(!r.diagnostics.some((x) => x.code === 'config-edit-unsupported-shape'));
});

test('D — a flip that locates fine but would not reparse → unsupported-shape (predicts the apply-time verify failure)', async () => {
  // The locator+mask flip `enabled` fine, but the doc carries a """ string the whole-doc
  // verifier (and apply V1) rejects. dry-run now refuses with the friendly message instead
  // of letting --apply fail later with a cryptic verify-reparse-failed.
  const text = '[plugins."x@y"]\nenabled = true\ndesc = """\nhi\n"""\n';
  const r = await setComponentEnabled({ ...base, kind: 'plugin', name: 'x@y', desired: false, readFn: () => text });
  assert.equal(r.refused, true);
  assert.ok(r.diagnostics.some((x) => x.code === 'config-edit-unsupported-shape'));
});

test('unsupported-shape refusals all map to exit-relevant refused:true (no write, fail-closed)', async () => {
  const text = '[plugins."x@y"]\nenabled = "true"\n';
  const r = await setComponentEnabled({ ...base, kind: 'plugin', name: 'x@y', desired: false, readFn: () => text });
  assert.equal(r.refused, true);
  assert.equal(r.ok, false);
  assert.equal(r.apply, null, 'never reached the apply path');
});

test('positive — a clean header flip still PROCEEDS (the new preview gate never over-refuses)', async () => {
  // Pins the "never over-refuse" invariant right beside classifyPreview: a normal, flippable
  // plugin in a clean [header] file must still reach ok:true / dryRun:true with NO
  // unsupported-shape (or any) refusal now that the gate sits in the path.
  const r = await setComponentEnabled({ ...base, kind: 'plugin', name: 'superpowers@openai-curated', desired: false });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.ok(!(r.diagnostics || []).some((d) => d.code === 'config-edit-unsupported-shape'));
});
