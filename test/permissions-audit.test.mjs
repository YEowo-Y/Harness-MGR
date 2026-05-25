/**
 * Permissions audit tests (P2.U8).
 *
 * A) Pure unit tests for auditPermissions, findOverbroadAllow, isOverbroadRule
 *    from src/analysis/permissions.mjs.
 * B) CLI integration tests using run() against the permissions-wildcards fixture.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { auditPermissions, findOverbroadAllow, isOverbroadRule } from '../src/analysis/permissions.mjs';
import { run } from '../src/cli.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'permissions-wildcards');

// ── A. Pure unit tests ────────────────────────────────────────────────────────

test('isOverbroadRule: true for strings containing *', () => {
  assert.equal(isOverbroadRule('a*'), true);
  assert.equal(isOverbroadRule('mcp__*'), true);
  assert.equal(isOverbroadRule('Edit(*)'), true);
  assert.equal(isOverbroadRule('*'), true);
});

test('isOverbroadRule: false for non-wildcards and non-strings', () => {
  assert.equal(isOverbroadRule('abc'), false);
  assert.equal(isOverbroadRule(''), false);
  assert.equal(isOverbroadRule(42), false);
  assert.equal(isOverbroadRule(null), false);
  assert.equal(isOverbroadRule(undefined), false);
  assert.equal(isOverbroadRule({ includes: () => true }), false);
});

test('findOverbroadAllow: dedup and sort ascending', () => {
  const result = findOverbroadAllow(['mcp__*', 'mcp__*', 'Edit(*)']);
  assert.deepEqual(result, ['Edit(*)', 'mcp__*']);
});

test('findOverbroadAllow: ignores non-wildcard and non-string entries', () => {
  const result = findOverbroadAllow(['Bash(git status)', 1, null, 'Edit(*)']);
  assert.deepEqual(result, ['Edit(*)']);
});

test('findOverbroadAllow: empty / non-array input → []', () => {
  assert.deepEqual(findOverbroadAllow([]), []);
  assert.deepEqual(findOverbroadAllow('nope'), []);
  assert.deepEqual(findOverbroadAllow(null), []);
  assert.deepEqual(findOverbroadAllow(undefined), []);
});

test('auditPermissions: flags wildcards in allow, sorted ascending', () => {
  const perms = { allow: ['Bash(git status)', 'Edit(*)', 'mcp__*', 'WebFetch(domain:*)'], ask: [], deny: [] };
  const result = auditPermissions(perms);
  assert.deepEqual(result.overbroad, ['Edit(*)', 'WebFetch(domain:*)', 'mcp__*']);
  assert.equal(result.diagnostics.length, 3);
  for (const d of result.diagnostics) {
    assert.equal(d.severity, 'warn');
    assert.equal(d.code, 'permissions-overbroad');
    assert.equal(d.phase, 'permissions');
    assert.equal(typeof d.message, 'string');
    assert.ok(d.message.includes('"'), 'message should quote the offending entry');
    assert.equal(typeof d.fix, 'string');
  }
  assert.ok(result.diagnostics[0].message.includes('Edit(*)'));
  assert.ok(result.diagnostics[1].message.includes('WebFetch(domain:*)'));
  assert.ok(result.diagnostics[2].message.includes('mcp__*'));
  // non-wildcard not flagged
  assert.ok(!result.overbroad.includes('Bash(git status)'));
});

test('auditPermissions: ask/deny wildcards are NOT flagged', () => {
  const perms = { allow: [], ask: ['X(*)'], deny: ['Y(*)'] };
  const result = auditPermissions(perms);
  assert.deepEqual(result.overbroad, []);
  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(result.ask, ['X(*)']);
  assert.deepEqual(result.deny, ['Y(*)']);
});

test('auditPermissions: deduplicates overbroad allow entries', () => {
  const perms = { allow: ['mcp__*', 'mcp__*'] };
  const result = auditPermissions(perms);
  assert.deepEqual(result.overbroad, ['mcp__*']);
  assert.equal(result.diagnostics.length, 1);
});

test('auditPermissions: non-array allow (string) → no throw, only string wildcards counted', () => {
  const result = auditPermissions({ allow: 'nope' });
  assert.deepEqual(result.overbroad, []);
  assert.equal(result.diagnostics.length, 0);
});

test('auditPermissions: non-string entries in allow array are ignored', () => {
  const result = auditPermissions({ allow: [1, null, 'Edit(*)'] });
  assert.deepEqual(result.overbroad, ['Edit(*)']);
  assert.equal(result.diagnostics.length, 1);
});

test('auditPermissions: junk/missing permissions → empty result, no throw', () => {
  for (const input of [undefined, null, 42, {}]) {
    const result = auditPermissions(input);
    assert.deepEqual(result.allow, []);
    assert.deepEqual(result.ask, []);
    assert.deepEqual(result.deny, []);
    assert.deepEqual(result.overbroad, []);
    assert.deepEqual(result.diagnostics, []);
  }
});

// ── B. CLI integration tests ──────────────────────────────────────────────────

test('permissions --audit --format json: flags wildcards, code 0', async () => {
  const out = await run(['permissions', '--audit', '--config-dir', FIX, '--format', 'json']);
  assert.equal(out.code, 0, `expected code 0, got ${out.code}; stdout: ${out.stdout}`);
  const env = JSON.parse(out.stdout);
  assert.equal(env.version, 1);
  assert.equal(env.command, 'permissions');

  // overbroad entries: Edit(*), mcp__*, WebFetch(domain:*) — NOT Bash(git status)
  assert.ok(Array.isArray(env.result.overbroad), 'result.overbroad should be an array');
  assert.ok(env.result.overbroad.includes('Edit(*)'), 'should include Edit(*)');
  assert.ok(env.result.overbroad.includes('mcp__*'), 'should include mcp__*');
  assert.ok(env.result.overbroad.includes('WebFetch(domain:*)'), 'should include WebFetch(domain:*)');
  assert.ok(!env.result.overbroad.includes('Bash(git status)'), 'should NOT include Bash(git status)');

  // 3 permissions-overbroad warns (duplicate Bash(git status) deduped; only wildcards flagged)
  const warns = env.diagnostics.filter((d) => d.code === 'permissions-overbroad');
  assert.equal(warns.length, 3, `expected 3 overbroad warns, got ${warns.length}`);
});

test('permissions (no --audit) --format json: plain read, no overbroad key, no warns', async () => {
  const out = await run(['permissions', '--config-dir', FIX, '--format', 'json']);
  assert.equal(out.code, 0, `expected code 0, got ${out.code}; stdout: ${out.stdout}`);
  const env = JSON.parse(out.stdout);
  assert.ok(Array.isArray(env.result.allow), 'result.allow should be an array');
  assert.ok(Array.isArray(env.result.ask), 'result.ask should be an array');
  assert.ok(Array.isArray(env.result.deny), 'result.deny should be an array');
  assert.ok(!('overbroad' in env.result), 'result should NOT have overbroad key without --audit');
  const warns = env.diagnostics.filter((d) => d.code === 'permissions-overbroad');
  assert.equal(warns.length, 0, 'should have 0 permissions-overbroad warns without --audit');
});

test('permissions --audit table format: code 0, stdout includes category and overbroad', async () => {
  const out = await run(['permissions', '--audit', '--config-dir', FIX]);
  assert.equal(out.code, 0, `expected code 0, got ${out.code}; stdout: ${out.stdout}`);
  assert.ok(out.stdout.includes('permissions'), 'table output should include "permissions"');
  assert.ok(out.stdout.includes('overbroad'), 'table output should include "overbroad"');
  // Verify that a known wildcard allow rule is rendered with the 'yes' overbroad marker
  // on the same line — proving permissionsTable actually flags the row, not just the header.
  const lines = out.stdout.split('\n');
  const mcpLine = lines.find((l) => l.includes('mcp__*'));
  assert.ok(mcpLine, 'table output should contain a row for mcp__*');
  assert.ok(mcpLine.includes('yes'), 'the mcp__* row should be marked as overbroad (yes)');
});
