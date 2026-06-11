/**
 * cli-hooks-explain.test.mjs (P5.U4) — the user-visible `hooks` command now
 * carries `explanations` alongside the byte-compatible raw `hooks` key.
 *
 * HEADLINE (P1 secret oracle): a settings.json whose hooks include a command
 * with an embedded ghp_-style token → run(['hooks','--format','json']) exits 0,
 * `explanations` is present with the expected fixed sentence, the raw `hooks`
 * key is still present, AND the token plaintext is ABSENT from the WHOLE stdout
 * (the new explanation surface must not bypass redactSecretsDeep).
 *
 * Plus: table rendering of explanation rows, the legacy count fallback, the
 * throwing-gather degrade path (status 'unprobed'), and render defensiveness.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { run } from '../src/cli.mjs';
import { hooksCommand } from '../src/cli/hooks-command.mjs';
import { renderTable } from '../src/cli/render.mjs';

// Realistic github classic token shape (ghp_ + exactly 36 alnum) so the
// high-confidence redaction rule fires — same convention as
// output-secret-redaction.test.mjs.
const GHP = `ghp_${'Z'.repeat(36)}`;

const SETTINGS = {
  hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'definitely-not-on-path-xyz check' }] },
    ],
    Stop: [
      { hooks: [{ type: 'command', command: `deploy-tool --token=${GHP}` }] },
    ],
  },
};

/** Write SETTINGS into a fresh temp config dir. Caller cleans up. */
function makeConfig(settings) {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-hooks-explain-'));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings), 'utf8');
  return dir;
}

// ── 1. HEADLINE: json output + secret oracle ──────────────────────────────────

test('hooks --format json: explanations present, hooks key kept, token absent from stdout', async () => {
  const dir = makeConfig(SETTINGS);
  try {
    const out = await run(['hooks', '--format', 'json', '--config-dir', dir]);
    assert.equal(out.code, 0, `expected exit 0, got ${out.code}: ${out.stdout}`);
    const env = JSON.parse(out.stdout);

    // old `hooks` result key still present with the merged event structure
    assert.ok(env.result.hooks && Array.isArray(env.result.hooks.PreToolUse), 'raw hooks key present');
    assert.ok(Array.isArray(env.result.hooks.Stop), 'raw hooks Stop event present');

    // explanations: sorted (event, matcher, command) → PreToolUse first
    const ex = env.result.explanations;
    assert.ok(Array.isArray(ex), 'explanations must be an array');
    assert.equal(ex.length, 2, 'one explanation per hook entry');
    assert.equal(ex[0].event, 'PreToolUse');
    assert.equal(ex[0].status, 'missing', 'a command not on PATH probes as missing');
    assert.equal(
      ex[0].explanation,
      'On PreToolUse (before a tool call runs), for tools matching "Bash", runs the external command "definitely-not-on-path-xyz" (external, missing — not found on PATH).',
    );
    assert.equal(ex[1].event, 'Stop');
    assert.equal(ex[1].kind, 'external');
    assert.equal(ex[1].target, 'deploy-tool');

    // P1 SECRET ORACLE: the token plaintext is absent from the WHOLE stdout —
    // covers the raw hooks AND the new explanations surface in one assertion.
    assert.ok(!out.stdout.includes(GHP), 'token plaintext must not appear anywhere in stdout');
    assert.ok(out.stdout.includes('<redacted>'), 'redaction marker expected');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 2. table format renders explanation rows ──────────────────────────────────

test('hooks (table): one row per explanation with event/status/explanation columns', async () => {
  const dir = makeConfig(SETTINGS);
  try {
    const out = await run(['hooks', '--config-dir', dir]);
    assert.equal(out.code, 0);
    assert.match(out.stdout, /explanation/, 'explanation column header');
    assert.match(out.stdout, /On PreToolUse \(before a tool call runs\)/, 'the sentence reaches the table');
    assert.match(out.stdout, /missing/, 'status column populated');
    assert.ok(!out.stdout.includes(GHP), 'token must not leak in table format either');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 3. throwing gather seam degrades to unprobed ──────────────────────────────

test('hooksCommand: throwing gather seam degrades to unprobed explanations (never throws)', async () => {
  const dir = makeConfig(SETTINGS);
  try {
    const out = await hooksCommand(
      { configDir: dir, args: {} },
      { gatherFn: () => { throw new Error('boom'); }, env: {} },
    );
    const ex = out.result.explanations;
    assert.equal(ex.length, 2);
    for (const e of ex) assert.equal(e.status, 'unprobed');
    assert.match(ex[0].explanation, /unprobed — not resolved this run/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 4. legacy fallback + render defensiveness ─────────────────────────────────

test('renderTable hooks: legacy shape (no explanations) falls back to event+count rows', () => {
  const out = renderTable('hooks', { hooks: { PreToolUse: [{}, {}], Stop: [{}] } });
  assert.match(out, /PreToolUse/);
  assert.match(out, /count/);
  assert.ok(!out.includes('explanation'), 'no explanation column on the legacy shape');
});

test('renderTable hooks: malformed explanation entries never throw', () => {
  const out = renderTable('hooks', { explanations: [null, 42, { event: 'X' }, { explanation: 'y only' }] });
  assert.match(out, /explanation/);
  assert.match(out, /y only/);
});
