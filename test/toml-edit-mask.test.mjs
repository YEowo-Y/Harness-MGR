/**
 * Tests for the locator span-mask (src/lib/toml-edit-mask.mjs) + its effect on the
 * locator (src/lib/toml-edit-locate.mjs) — P6 config-edit mcp-insert unit.
 *
 * The mask decouples the line-scanner locator's safety from parseToml's matching blind
 * spot. These falsifiable oracles pin: a `[`-header or `enabled =` line that lives INSIDE
 * a multi-line string (""" / ''') or an inline-table brace region ({ … }) is NOT
 * interpreted as structure; an unterminated span fails CLOSED (findEnableSpan returns
 * `unparseable-multiline`, applyVerifiedEdit returns the ORIGINAL text); a secret next to
 * such a construct is never read/echoed; and — crucially — the mask is a strict NO-OP on
 * an ordinary multi-table config (brace/bracket/triple-quote-looking characters that live
 * inside ORDINARY single-line quoted values, and legitimate multi-line ARRAYS, are NOT
 * masked, so existing plugin flips still work).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spanMask } from '../src/lib/toml-edit-mask.mjs';
import { findEnableSpan } from '../src/lib/toml-edit-locate.mjs';
import { setEnabled, applyVerifiedEdit } from '../src/lib/toml-edit.mjs';
import { parseToml } from '../src/lib/toml-parser.mjs';

const MCP = (name) => ({ kind: 'mcp', name });
const PLUGIN = (name) => ({ kind: 'plugin', name });

// ── multi-line strings: a fake header/enabled inside a """ span is not structure ──

test('a fake [mcp_servers.evil] + enabled inside a """ span is NOT located', () => {
  const doc = [
    '[mcp_servers.real]',
    'desc = """',
    '[mcp_servers.evil]',
    'enabled = true',
    '"""',
    'url = "https://x"',
    'bearer_token_env_var = "SECRET_NAME"',
  ].join('\n') + '\n';
  // the in-string table is invisible to the locator
  const evil = findEnableSpan(doc, MCP('evil'));
  assert.equal(evil.found, false);
  assert.equal(evil.absent, true);
  // the REAL table is still found (the mask skips the string, not the document) → mechanic inserts
  const real = setEnabled(doc, MCP('real'), false);
  assert.equal(real.reason, 'inserted');
  // defense layer 2: applyVerifiedEdit fails CLOSED — parseToml rejects the unsupported """ doc (V1)
  const v = applyVerifiedEdit(doc, MCP('real'), false);
  assert.equal(v.ok, false);
  assert.equal(v.text, doc);
  // the secret name is never echoed in any diff field
  assert.equal(real.before, '');
  assert.ok(!String(real.after).includes('SECRET_NAME'));
});

test("a '''literal''' span also masks a fake header/enabled", () => {
  const doc = [
    '[mcp_servers.real]',
    "note = '''",
    '[mcp_servers.evil]',
    'enabled = true',
    "'''",
    'command = "node"',
  ].join('\n') + '\n';
  assert.equal(findEnableSpan(doc, MCP('evil')).found, false);
  assert.equal(setEnabled(doc, MCP('real'), false).reason, 'inserted');
});

// ── inline tables: an in-brace `enabled` + secret is not structure ──

test('an inline-table { enabled = true, token = "SECRET" } is NOT a real enabled line', () => {
  const doc = [
    '[mcp_servers.y]',
    'endpoints = { enabled = true, token = "SECRET-INLINE" }',
  ].join('\n') + '\n';
  const span = findEnableSpan(doc, MCP('y'));
  assert.equal(span.found, true);
  assert.equal(span.mode, 'insert', 'the in-brace enabled is masked → the server has no real enabled key');
  // a disable would INSERT at bodyStart (before the brace line), never inside the braces
  const r = setEnabled(doc, MCP('y'), false);
  assert.equal(r.reason, 'inserted');
  assert.ok(r.text.indexOf('enabled = false') < r.text.indexOf('endpoints ='));
  assert.ok(r.text.includes('token = "SECRET-INLINE"'));        // the secret is untouched
  assert.ok(!String(r.after).includes('SECRET-INLINE'));        // and never echoed
});

// ── unterminated spans: fail CLOSED ──

test('an unterminated """ → findEnableSpan unparseable-multiline; applyVerifiedEdit returns ORIGINAL', () => {
  const doc = '[mcp_servers.x]\ndesc = """\nunclosed forever\n';
  const span = findEnableSpan(doc, MCP('x'));
  assert.equal(span.found, false);
  assert.equal(span.error.code, 'unparseable-multiline');
  const v = applyVerifiedEdit(doc, MCP('x'), false);
  assert.equal(v.ok, false);
  assert.equal(v.error.code, 'unparseable-multiline');
  assert.equal(v.text, doc);
});

test('an unterminated inline table { → fail closed', () => {
  const doc = '[mcp_servers.x]\nendpoints = { enabled = true\n';
  const span = findEnableSpan(doc, MCP('x'));
  assert.equal(span.found, false);
  assert.equal(span.error.code, 'unparseable-multiline');
  assert.equal(spanMask(doc).malformed, true);
});

// ── negative controls: the mask must NOT over-claim ranges ──

test('brace/bracket/triple-quote-looking chars INSIDE an ordinary single-line value are NOT masked', () => {
  const doc = [
    'note = "use [brackets] {braces} and \\"\\"\\" here"',
    '[plugins."b@x"]',
    'enabled = true',
  ].join('\n') + '\n';
  assert.equal(spanMask(doc).malformed, false);
  const r = setEnabled(doc, PLUGIN('b@x'), false);   // the real plugin still flips
  assert.equal(r.changed, true);
  assert.equal(r.after, 'enabled = false');
  assert.equal(applyVerifiedEdit(doc, PLUGIN('b@x'), false).ok, true);
});

test('a legitimate multi-line ARRAY is NOT masked (args = [ … ]) — the next enabled still flips', () => {
  const doc = [
    '[mcp_servers.z]',
    'args = [',
    '  "-y",',
    '  "pkg"',
    ']',
    'enabled = true',
  ].join('\n') + '\n';
  assert.equal(spanMask(doc).malformed, false);
  const r = setEnabled(doc, MCP('z'), false);   // existing enabled=true → flip, not insert
  assert.equal(r.changed, true);
  assert.equal(r.reason, 'flipped');
  assert.equal(parseToml(r.text).value.mcp_servers.z.enabled, false);
  assert.equal(parseToml(r.text).value.mcp_servers.z.args.length, 2);
});

test('spanMask is a strict NO-OP on an ordinary multi-table config (nothing masked, not malformed)', () => {
  const doc = [
    'model = "gpt-5.5"',
    '[mcp_servers.a]',
    'command = "x"',
    '[[skills.config]]',
    'name = "s"',
    'enabled = false',
    '[plugins."p@m"]',
    'enabled = true',
  ].join('\n') + '\n';
  const mask = spanMask(doc);
  assert.equal(mask.malformed, false);
  for (let i = 0; i < doc.length; i += 1) assert.equal(mask.skip(i), false, `offset ${i} must not be masked`);
});

test('a # comment containing { and """ does not open a span (comments are skipped)', () => {
  const doc = [
    '# a comment with { an unclosed brace and """ a triple quote',
    '[plugins."c@m"]',
    'enabled = true',
  ].join('\n') + '\n';
  assert.equal(spanMask(doc).malformed, false);
  assert.equal(setEnabled(doc, PLUGIN('c@m'), false).changed, true);
});
