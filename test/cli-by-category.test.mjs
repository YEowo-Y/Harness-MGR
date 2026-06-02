/**
 * CLI surface oracle for `inventory --by-category` (categorize feature v1).
 *
 * Proves the wiring: with the flag, inventoryCommand ADDS a `categories`
 * {summary, byCategory} block grouping skills/agents/commands by purpose; without
 * it, the result is byte-compatible with before (no `categories` key). The
 * categorization logic itself is unit-tested in test/categorize.test.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inventoryCommand } from '../src/cli/commands.mjs';

/** Build a temp configDir with skills/<name>/SKILL.md for each [name, description]. */
function withSkills(skills, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-bycat-'));
  try {
    for (const [name, desc] of skills) {
      mkdirSync(join(dir, 'skills', name), { recursive: true });
      writeFileSync(join(dir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\nbody\n`, 'utf8');
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('inventory --by-category groups components into purpose buckets', () => {
  withSkills([['article-writing', 'write blog posts'], ['rust-reviewer', 'review rust code']], (dir) => {
    const { result } = inventoryCommand({ configDir: dir, args: { 'by-category': true } });
    assert.ok(result.categories, 'categories block present');
    assert.equal(result.categories.summary.writing, 1);
    assert.equal(result.categories.summary.development, 1);
    assert.deepEqual(result.categories.byCategory.writing, ['article-writing']);
    assert.deepEqual(result.categories.byCategory.development, ['rust-reviewer']);
    // counts summary is still present alongside the new block.
    assert.equal(result.counts.skills, 2);
  });
});

test('inventory WITHOUT --by-category omits the categories block (contract unchanged)', () => {
  withSkills([['article-writing', 'write blog posts']], (dir) => {
    const { result } = inventoryCommand({ configDir: dir, args: {} });
    assert.equal(result.categories, undefined, 'no categories key without the flag');
    assert.equal(result.mcpCategories, undefined, 'mcpCategories also absent without the flag');
    assert.ok(result.counts, 'counts still present');
  });
});

test('inventory --by-category also groups MCP servers by purpose (mcpCategories)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-bycat-mcp-'));
  try {
    // project-scope .mcp.json — the server KEY is the name categorizeMcp keys off.
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
        exa: { command: 'npx', args: ['exa-mcp-server'] },
      },
    }), 'utf8');
    const { result } = inventoryCommand({ configDir: dir, args: { 'by-category': true } });
    assert.ok(result.mcpCategories, 'mcpCategories block present');
    // inclusion-only (robust to any user-scope MCP servers the scan may also see):
    assert.ok(result.mcpCategories.byCategory.development.includes('github'), 'github → development');
    assert.ok(result.mcpCategories.byCategory.research.includes('exa'), 'exa → research');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
