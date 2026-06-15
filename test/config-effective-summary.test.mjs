/**
 * config-effective-summary.test.mjs (P6 — codex effective table summary).
 *
 * Unit oracles for src/cli/config-effective-render.mjs: the codex single-source
 * effective view is rendered (in TABLE format) as a per-top-level-key SUMMARY, not a
 * ~49 KB dump. A scalar shows its (truncated) value; a redaction sentinel shows
 * `<redacted>`; an array shows `[array: N]`; a nested table shows `{table: N keys}`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveSummary, summarizeValue } from '../src/cli/config-effective-render.mjs';

test('summarizeValue: scalars / redaction sentinel / array / table / truncation', () => {
  assert.equal(summarizeValue(null), 'null');
  assert.equal(summarizeValue('gpt-5.5'), 'gpt-5.5');
  assert.equal(summarizeValue(250000), '250000');
  assert.equal(summarizeValue(true), 'true');
  assert.equal(summarizeValue({ redacted: true, sha256: 'deadbeef' }), '<redacted>');
  assert.equal(summarizeValue([1, 2, 3, 4]), '[array: 4]');
  assert.equal(summarizeValue({ a: 1, b: 2, c: 3 }), '{table: 3 keys}');
  const long = 'x'.repeat(80);
  const out = summarizeValue(long);
  assert.ok(out.length <= 60 && out.endsWith('…'), `long strings truncate with …; got len ${out.length}`);
});

test('effectiveSummary: sorted rows + note/count, collections SUMMARIZED (not dumped), redaction shown', () => {
  const eff = {
    model: 'gpt-5.5',
    mcp_servers: { pencil: {}, deployer: {}, github: {} },
    notify: ['a', 'b'],
    secret: { redacted: true, sha256: 'h' },
  };
  const out = effectiveSummary(eff);
  const lines = out.split('\n');

  // header note names the count + how to get full values.
  assert.match(lines[0], /^config summary — 4 top-level key\(s\); use --key <name> or --format json for full values$/);
  // each top-level key summarized — collections as counts, never expanded.
  assert.match(out, /mcp_servers\s+\{table: 3 keys\}/);
  assert.match(out, /model\s+gpt-5\.5/);
  assert.match(out, /notify\s+\[array: 2\]/);
  assert.match(out, /secret\s+<redacted>/);
  // sorted by key (mcp_servers < model < notify < secret).
  assert.ok(out.indexOf('mcp_servers') < out.indexOf('\nmodel') && out.indexOf('\nmodel') < out.indexOf('notify') && out.indexOf('notify') < out.indexOf('secret'),
    'rows sorted by key');
  // a summary, NOT a dump: 4 keys → note + header + separator + 4 rows ≈ 7 lines.
  assert.ok(lines.length <= 8, `compact summary expected; got ${lines.length} lines`);
  // the nested mcp_servers child names are NOT surfaced as their own rows.
  assert.equal(/^\s*pencil\b/m.test(out), false, 'nested table keys are not expanded');
});

test('effectiveSummary: empty / non-object input → just the note, never throws', () => {
  assert.match(effectiveSummary({}), /^config summary — 0 top-level key\(s\)/);
  assert.equal(typeof effectiveSummary(/** @type {any} */ (null)), 'string');
});
