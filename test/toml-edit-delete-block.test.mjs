/**
 * Tests for the config-block-delete primitive (src/lib/toml-edit.mjs::deleteBlock +
 * src/lib/toml-edit-locate.mjs::findBlockSpan) — P6 prune-config unit.
 *
 * deleteBlock splices out a whole `[[skills.config]]` element (header + body + trailing
 * blanks), preserving EVERY other byte, with fail-closed V1/V2/V4 verification:
 *   - V4-before: the selector resolves to EXACTLY one element (a duplicate name is refused,
 *     never half-deleted);
 *   - V2: bytes outside [headerStart, regionEnd) are byte-identical (secret-safe);
 *   - V1: the result still parses; V4-after: the element is gone, siblings intact.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deleteBlock } from '../src/lib/toml-edit.mjs';
import { findBlockSpan } from '../src/lib/toml-edit-locate.mjs';
import { parseToml } from '../src/lib/toml-parser.mjs';

const PATH_ALPHA = 'C:/Users/x/.codex/skills/alpha/SKILL.md';

// A representative config: a comment, an mcp server WITH an env secret, and a mix of
// name-keyed / path-keyed / duplicate-name skills.config blocks.
const FIXTURE = [
  '# top comment — must survive',                     // 0
  '[mcp_servers.ctx]',                                  // 1
  'command = "npx"',                                    // 2
  '',                                                   // 3
  '[mcp_servers.ctx.env]',                              // 4
  'SECRET = "sk-do-not-touch"',                         // 5
  '',                                                   // 6
  '[[skills.config]]',                                  // 7  alpha (name)
  'name = "alpha"',                                     // 8
  'enabled = true',                                     // 9
  '',                                                   // 10
  '[[skills.config]]',                                  // 11 alpha (path)
  `path = "${PATH_ALPHA}"`,                             // 12
  'enabled = false',                                    // 13
  '',                                                   // 14
  '[[skills.config]]',                                  // 15 beta (name)
  'name = "beta"',                                      // 16
  'enabled = true',                                     // 17
  '',                                                   // 18
  '[[skills.config]]',                                  // 19 dupe #1
  'name = "dupe"',                                      // 20
  'enabled = false',                                    // 21
  '',                                                   // 22
  '[[skills.config]]',                                  // 23 dupe #2
  'name = "dupe"',                                      // 24
  'enabled = true',                                     // 25
  '',                                                   // 26
].join('\n');

const nameSel = (v) => ({ kind: 'skill', match: { field: 'name', value: v } });
const pathSel = (v) => ({ kind: 'skill', match: { field: 'path', value: v } });

/** Names present in the parsed skills.config array. */
function skillNames(text) {
  const { value, errors } = parseToml(text);
  assert.equal(errors.length, 0, 'result parses clean');
  return (value.skills?.config ?? []).map((e) => e.name).filter((n) => typeof n === 'string').sort();
}

describe('deleteBlock — config-block-delete primitive', () => {

  it('deletes a name-keyed block; siblings + secret survive; parses clean', () => {
    const r = deleteBlock(FIXTURE, nameSel('beta'));
    assert.equal(r.ok, true);
    assert.equal(r.deleted, true);
    assert.ok(!r.text.includes('name = "beta"'), 'beta block gone');
    // siblings intact
    assert.deepEqual(skillNames(r.text), ['alpha', 'dupe', 'dupe']);
    // secret + comment untouched
    assert.ok(r.text.includes('SECRET = "sk-do-not-touch"'), 'mcp secret preserved');
    assert.ok(r.text.includes('# top comment — must survive'), 'comment preserved');
  });

  it('V2 byte-preservation: every byte outside the deleted span is identical', () => {
    const sel = nameSel('beta');
    const span = findBlockSpan(FIXTURE, sel);
    assert.equal(span.found, true);
    const r = deleteBlock(FIXTURE, sel);
    // prefix [0, headerStart) and suffix [regionEnd, end) are verbatim in the result.
    assert.equal(r.text.slice(0, span.headerStart), FIXTURE.slice(0, span.headerStart));
    assert.equal(r.text.slice(span.headerStart), FIXTURE.slice(span.regionEnd));
    assert.equal(r.text.length, FIXTURE.length - (span.regionEnd - span.headerStart));
  });

  it('deletes a path-keyed block (alpha path) leaving the alpha NAME block', () => {
    const r = deleteBlock(FIXTURE, pathSel(PATH_ALPHA));
    assert.equal(r.deleted, true);
    assert.ok(!r.text.includes(PATH_ALPHA), 'path block gone');
    assert.ok(r.text.includes('name = "alpha"'), 'alpha NAME block remains');
    assert.deepEqual(skillNames(r.text), ['alpha', 'beta', 'dupe', 'dupe']);
  });

  it('sequential delete (name then path of the same skill) removes BOTH alpha blocks', () => {
    const r1 = deleteBlock(FIXTURE, nameSel('alpha'));
    assert.equal(r1.deleted, true);
    const r2 = deleteBlock(r1.text, pathSel(PATH_ALPHA));
    assert.equal(r2.deleted, true);
    assert.ok(!r2.text.includes('name = "alpha"') && !r2.text.includes(PATH_ALPHA), 'both alpha blocks gone');
    assert.deepEqual(skillNames(r2.text), ['beta', 'dupe', 'dupe']);
    assert.ok(r2.text.includes('SECRET = "sk-do-not-touch"'), 'secret still intact after two deletes');
  });

  it('REFUSES a duplicate-name selector (unique-or-refuse, fail-closed, no write)', () => {
    const r = deleteBlock(FIXTURE, nameSel('dupe'));
    assert.equal(r.ok, false);
    assert.equal(r.deleted, false);
    assert.equal(r.text, FIXTURE, 'original text returned unchanged');
    assert.ok(/ambiguous|not-unique/.test(r.error.code), `fail-closed code: ${r.error.code}`);
  });

  it('ABSENT selector is a safe no-op (ok, not deleted, text unchanged)', () => {
    const r = deleteBlock(FIXTURE, nameSel('ghost'));
    assert.equal(r.ok, true);
    assert.equal(r.deleted, false);
    assert.equal(r.text, FIXTURE);
    assert.equal(r.reason, 'noop-absent');
  });

  it('non-skill selector → block-delete-kind-unsupported (skill-only primitive)', () => {
    const r = deleteBlock(FIXTURE, { kind: 'plugin', name: 'x@y' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'block-delete-kind-unsupported');
  });

  it('non-string input → input-not-string, never throws', () => {
    for (const junk of [null, undefined, 42, {}, []]) {
      assert.doesNotThrow(() => deleteBlock(junk, nameSel('beta')));
      const r = deleteBlock(junk, nameSel('beta'));
      assert.equal(r.ok, false);
      assert.equal(r.error.code, 'input-not-string');
    }
  });

  it('deletes the LAST block (regionEnd = EOF) leaving a clean tail', () => {
    const txt = '[[skills.config]]\nname = "only"\nenabled = true\n\n[[skills.config]]\nname = "last"\nenabled = false\n';
    const r = deleteBlock(txt, nameSel('last'));
    assert.equal(r.deleted, true);
    assert.deepEqual(skillNames(r.text), ['only']);
    assert.ok(!r.text.includes('name = "last"'));
  });

  it('deletes the FIRST/only block down to empty skills.config', () => {
    const txt = '# lead\n[[skills.config]]\nname = "solo"\nenabled = true\n';
    const r = deleteBlock(txt, nameSel('solo'));
    assert.equal(r.deleted, true);
    assert.ok(r.text.includes('# lead'), 'leading comment preserved');
    assert.ok(!r.text.includes('name = "solo"'));
    const { errors } = parseToml(r.text);
    assert.equal(errors.length, 0, 'still valid TOML');
  });

  it('MUTATION GUARD: an unterminated multi-line string → refuse to locate (no delete)', () => {
    const txt = '[[skills.config]]\nname = "x"\nenabled = true\ndesc = """\nunterminated\n';
    const r = deleteBlock(txt, nameSel('x'));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'unparseable-multiline');
    assert.equal(r.text, txt);
  });

});
