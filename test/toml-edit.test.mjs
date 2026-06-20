/**
 * Tests for the surgical TOML editor (src/lib/toml-edit{,-locate}.mjs) — P6 config-edit unit.
 *
 * Falsifiable oracles for the FLIP primitive + the fail-closed applyVerifiedEdit wrapper:
 * a single-token byte splice (everything else byte-identical incl. secret regions),
 * comment/CRLF/key-order preservation, idempotent no-ops, plugin/skill(name|path)/mcp
 * selectors, ambiguity + non-boolean refusal, and the duplicate-enabled fail-closed guard.
 * Secret regions in the fixture (a fake sk- token + bearer_token_env_var) must never move
 * or appear in a diff. Structure is compared via a JSON round-trip (null-proto → plain).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { setEnabled, applyVerifiedEdit } from '../src/lib/toml-edit.mjs';
import { findEnableSpan } from '../src/lib/toml-edit-locate.mjs';
import { parseToml } from '../src/lib/toml-parser.mjs';

const plain = (v) => JSON.parse(JSON.stringify(v));

/** A realistic multi-table config.toml: mcp_servers (with a secret env sub-table +
 *  bearer token), name- AND path-keyed skills.config entries, plugins with a trailing
 *  comment, and a features table. LF document. */
const FIXTURE = [
  'model = "gpt-5.5"',
  '',
  '[mcp_servers.n8n_official]',
  'url = "http://localhost:5678/mcp"',
  'bearer_token_env_var = "N8N_MCP_TOKEN"',
  '',
  '[mcp_servers.n8n_community]',
  'command = "npx.cmd"',
  'args = [ "-y", "n8n-mcp" ]',
  '',
  '[mcp_servers.n8n_community.env]',
  'SECRET_TOKEN = "sk-do-not-touch-0123456789"',
  'LOG_LEVEL = "error"',
  '',
  '[[skills.config]]',
  'name = "ab-test-setup"',
  'enabled = false',
  '',
  '[[skills.config]]',
  'path = "C:/Users/alice/.codex/skills/x-twitter-growth/SKILL.md"',
  'enabled = false',
  '',
  '[plugins."superpowers@openai-curated"]',
  'enabled = true',
  '',
  '[plugins."build-ios-apps@openai-curated"]',
  'enabled = false',
  '',
  '[plugins."pinned@openai-curated"]',
  'enabled = true # pinned, do not disable',
  '',
  '[features]',
  'multi_agent = true',
].join('\n');

const PLUGIN = (name) => ({ kind: 'plugin', name });
const SKILL = (field, value) => ({ kind: 'skill', match: { field, value } });

// ── flip: the single-token splice ────────────────────────────────────────────────

test('disable a plugin: flips true→false, ONLY that token changes', () => {
  const r = setEnabled(FIXTURE, PLUGIN('superpowers@openai-curated'), false);
  assert.equal(r.changed, true);
  assert.equal(r.reason, 'flipped');
  assert.equal(r.before, 'enabled = true');
  assert.equal(r.after, 'enabled = false');
  const expected = FIXTURE.replace(
    '[plugins."superpowers@openai-curated"]\nenabled = true\n',
    '[plugins."superpowers@openai-curated"]\nenabled = false\n',
  );
  assert.equal(r.text, expected);
});

test('enable a plugin: flips false→true', () => {
  const r = setEnabled(FIXTURE, PLUGIN('build-ios-apps@openai-curated'), true);
  assert.equal(r.changed, true);
  assert.notEqual(r.text, FIXTURE);
  assert.equal(parseToml(r.text).value.plugins['build-ios-apps@openai-curated'].enabled, true);
});

test('trailing comment after the boolean is preserved byte-for-byte', () => {
  const r = setEnabled(FIXTURE, PLUGIN('pinned@openai-curated'), false);
  assert.equal(r.changed, true);
  assert.equal(r.after, 'enabled = false # pinned, do not disable');
  assert.ok(r.text.includes('enabled = false # pinned, do not disable'));
});

test('idempotent: disabling an already-disabled plugin is a strict === no-op', () => {
  const r = setEnabled(FIXTURE, PLUGIN('build-ios-apps@openai-curated'), false);
  assert.equal(r.changed, false);
  assert.equal(r.reason, 'noop-already');
  assert.equal(r.text === FIXTURE, true); // strict identity, not just equality
  assert.equal(r.error, null);
});

test('absent table → noop-absent-table, text unchanged, no error', () => {
  const r = setEnabled(FIXTURE, PLUGIN('does-not-exist@x'), false);
  assert.equal(r.changed, false);
  assert.equal(r.reason, 'noop-absent-table');
  assert.equal(r.text === FIXTURE, true);
  assert.equal(r.error, null);
});

test('enabled value that is not a boolean → error, text unchanged', () => {
  const doc = '[plugins."weird@x"]\nenabled = "yes"\n';
  const r = setEnabled(doc, PLUGIN('weird@x'), false);
  assert.equal(r.changed, false);
  assert.equal(r.error.code, 'enabled-not-boolean');
  assert.equal(r.text, doc);
});

// ── skills: name and path selectors ───────────────────────────────────────────────

test('skill by NAME: flips the right element; the path-keyed sibling is untouched', () => {
  const r = setEnabled(FIXTURE, SKILL('name', 'ab-test-setup'), true);
  assert.equal(r.changed, true);
  assert.equal(r.before, 'enabled = false');
  assert.equal(r.after, 'enabled = true');
  const cfg = parseToml(r.text).value.skills.config;
  const byName = cfg.find((e) => e.name === 'ab-test-setup');
  const byPath = cfg.find((e) => e.path && e.path.includes('x-twitter-growth'));
  assert.equal(byName.enabled, true);
  assert.equal(byPath.enabled, false); // sibling unchanged
});

test('skill by PATH: flips the path-keyed element; the name-keyed sibling is untouched', () => {
  const r = setEnabled(FIXTURE, SKILL('path', 'C:/Users/alice/.codex/skills/x-twitter-growth/SKILL.md'), true);
  assert.equal(r.changed, true);
  const cfg = parseToml(r.text).value.skills.config;
  assert.equal(cfg.find((e) => e.path && e.path.includes('x-twitter-growth')).enabled, true);
  assert.equal(cfg.find((e) => e.name === 'ab-test-setup').enabled, false);
});

// ── mcp: no enabled key → disable INSERTS `enabled = false`; enable is a default-enabled no-op ──

const MCP = (name) => ({ kind: 'mcp', name });

test('mcp disable (no enabled key) → INSERTS enabled=false as the first body line', () => {
  const r = setEnabled(FIXTURE, MCP('n8n_official'), false);
  assert.equal(r.changed, true);
  assert.equal(r.reason, 'inserted');
  assert.equal(r.before, '');
  assert.equal(r.after, 'enabled = false');
  // inserted immediately after the header, BEFORE the existing url/bearer lines
  assert.ok(r.text.includes('[mcp_servers.n8n_official]\nenabled = false\nurl = "http://localhost:5678/mcp"'));
  assert.equal(parseToml(r.text).value.mcp_servers.n8n_official.enabled, false);
  assert.deepEqual(parseToml(r.text).errors, []);
});

test('mcp insert lands BEFORE the [..env] secret sub-table; secret bytes byte-identical', () => {
  const r = setEnabled(FIXTURE, MCP('n8n_community'), false);
  const ins = r.text.indexOf('enabled = false');
  const env = r.text.indexOf('[mcp_servers.n8n_community.env]');
  assert.ok(ins !== -1 && env !== -1 && ins < env, 'insert is before the .env header');
  assert.ok(r.text.includes('SECRET_TOKEN = "sk-do-not-touch-0123456789"'));
  assert.ok(r.text.includes('bearer_token_env_var = "N8N_MCP_TOKEN"'));
  assert.ok(!String(r.before).includes('sk-') && !String(r.after).includes('sk-'));
});

test('mcp enable on a key-absent (default-enabled) server → noop-default-enabled, text unchanged', () => {
  const r = setEnabled(FIXTURE, MCP('n8n_official'), true);
  assert.equal(r.changed, false);
  assert.equal(r.reason, 'noop-default-enabled');
  assert.equal(r.text === FIXTURE, true);
  assert.equal(r.error, null);
});

test('mcp disable is idempotent: after the insert, a second disable is a strict === no-op', () => {
  const once = setEnabled(FIXTURE, MCP('n8n_official'), false);
  const twice = setEnabled(once.text, MCP('n8n_official'), false);
  assert.equal(twice.changed, false);
  assert.equal(twice.reason, 'noop-already');
  assert.equal(twice.text === once.text, true);
});

test('applyVerifiedEdit mcp insert → ok, every ORIGINAL byte preserved (V2-insert), diff present', () => {
  const v = applyVerifiedEdit(FIXTURE, MCP('n8n_official'), false);
  assert.equal(v.ok, true);
  assert.equal(v.reason, 'inserted');
  assert.equal(v.diff.before, '');
  assert.equal(v.diff.after, 'enabled = false');
  const insertAt = findEnableSpan(FIXTURE, MCP('n8n_official')).insertAt;
  assert.equal(v.text.slice(0, insertAt), FIXTURE.slice(0, insertAt));               // prefix preserved
  assert.equal(v.text.slice(v.text.length - (FIXTURE.length - insertAt)), FIXTURE.slice(insertAt)); // tail preserved
});

test('mcp disable→enable round-trip leaves an EXPLICIT enabled=true line (+1-line residue, documented)', () => {
  const sel = MCP('n8n_official');
  const d = applyVerifiedEdit(FIXTURE, sel, false);
  const e = applyVerifiedEdit(d.text, sel, true);
  assert.equal(e.ok, true);
  assert.equal(parseToml(e.text).value.mcp_servers.n8n_official.enabled, true);
  assert.notEqual(e.text, FIXTURE);                                   // NOT pristine — the key persists
  assert.ok(e.text.includes('[mcp_servers.n8n_official]\nenabled = true\n'));
});

test('mcp insert at a header at EOF with NO trailing newline → clean insert, no header gluing (HIGH fix)', () => {
  const eof = '[mcp_servers.solo]'; // header is the last line, no trailing newline
  const r = setEnabled(eof, MCP('solo'), false);
  assert.equal(r.changed, true);
  assert.ok(r.text.startsWith('[mcp_servers.solo]\nenabled = false'), 'leading newline prevents gluing onto the header');
  assert.deepEqual(parseToml(r.text).errors, []);
  assert.equal(applyVerifiedEdit(eof, MCP('solo'), false).ok, true);
});

test('mcp insert in a CRLF document uses \\r\\n; no lone \\n is introduced', () => {
  const crlf = ['[mcp_servers.c]', 'url = "https://x"', ''].join('\r\n');
  const r = setEnabled(crlf, MCP('c'), false);
  assert.equal(r.changed, true);
  assert.ok(r.text.includes('enabled = false\r\n'));
  assert.equal((r.text.match(/(^|[^\r])\n/g) || []).length, 0);
});

// ── secret safety: an unrelated flip never moves or echoes secret bytes ─────────────

test('secret env + bearer token bytes are byte-identical after an unrelated flip', () => {
  const r = setEnabled(FIXTURE, PLUGIN('superpowers@openai-curated'), false);
  assert.ok(r.text.includes('SECRET_TOKEN = "sk-do-not-touch-0123456789"'));
  assert.ok(r.text.includes('bearer_token_env_var = "N8N_MCP_TOKEN"'));
  // the secret never leaks into the diff fields
  assert.ok(!String(r.before).includes('sk-do-not-touch'));
  assert.ok(!String(r.after).includes('sk-do-not-touch'));
});

// ── CRLF preservation ──────────────────────────────────────────────────────────────

test('CRLF document: the edited line keeps \\r\\n; no lone \\n is introduced', () => {
  const crlf = ['[plugins."a@x"]', 'enabled = true', '', '[features]', 'k = 1'].join('\r\n');
  const r = setEnabled(crlf, PLUGIN('a@x'), false);
  assert.equal(r.changed, true);
  assert.ok(r.text.includes('enabled = false\r\n'));
  // every '\n' is preceded by '\r' (no lone LF)
  const loneLf = (r.text.match(/(^|[^\r])\n/g) || []).length;
  assert.equal(loneLf, 0);
});

// ── ambiguity refusal ───────────────────────────────────────────────────────────────

test('a selector matching two tables → ambiguous error, text unchanged', () => {
  const doc = ['[plugins."dup@x"]', 'enabled = true', '', '[plugins."dup@x"]', 'enabled = false'].join('\n');
  const r = setEnabled(doc, PLUGIN('dup@x'), false);
  assert.equal(r.changed, false);
  assert.equal(r.error.code, 'ambiguous-selector');
  assert.equal(r.text, doc);
});

// ── applyVerifiedEdit: the fail-closed wrapper ──────────────────────────────────────

test('applyVerifiedEdit: happy flip → ok, valid TOML, diff present', () => {
  const r = applyVerifiedEdit(FIXTURE, PLUGIN('superpowers@openai-curated'), false);
  assert.equal(r.ok, true);
  assert.equal(r.error, null);
  assert.equal(r.diff.before, 'enabled = true');
  assert.equal(r.diff.after, 'enabled = false');
  assert.ok(r.text !== FIXTURE);
});

test('applyVerifiedEdit: a safe no-op → ok, text unchanged, diff null', () => {
  const r = applyVerifiedEdit(FIXTURE, PLUGIN('build-ios-apps@openai-curated'), false);
  assert.equal(r.ok, true);
  assert.equal(r.diff, null);
  assert.equal(r.text === FIXTURE, true);
});

test('applyVerifiedEdit: FAIL-CLOSED on a region with duplicate enabled lines (V3)', () => {
  // last-wins TOML: flipping the first enabled does not reliably change the effective
  // value, so the post-locate guard (exactly one enabled line) must refuse and return original.
  const doc = ['[plugins."twolines@x"]', 'enabled = true', 'enabled = true', '', '[features]', 'k = 1'].join('\n');
  const r = applyVerifiedEdit(doc, PLUGIN('twolines@x'), false);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'verify-postlocate-mismatch');
  assert.equal(r.text, doc); // ORIGINAL text returned
});

test('applyVerifiedEdit: disable→enable round-trip is byte-identical to the original', () => {
  const sel = PLUGIN('superpowers@openai-curated');
  const d = applyVerifiedEdit(FIXTURE, sel, false);
  assert.equal(d.ok, true);
  const e = applyVerifiedEdit(d.text, sel, true);
  assert.equal(e.ok, true);
  assert.equal(e.text, FIXTURE);
});

// ── structural: exactly one leaf differs ────────────────────────────────────────────

test('whole-doc structural: flipping one plugin changes EXACTLY one leaf', () => {
  const before = plain(parseToml(FIXTURE).value);
  const r = setEnabled(FIXTURE, PLUGIN('superpowers@openai-curated'), false);
  const after = parseToml(r.text);
  assert.deepEqual(after.errors, []);
  const patched = plain(after.value);
  patched.plugins['superpowers@openai-curated'].enabled = true; // reset the one leaf
  assert.deepStrictEqual(patched, before);
});
