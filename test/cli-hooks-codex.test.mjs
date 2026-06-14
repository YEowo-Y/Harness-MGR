/**
 * cli-hooks-codex.test.mjs (P6.U4) — end-to-end codex hooks through run().
 *
 * Drives the FULL stack: cli.mjs → resolve-target (--target codex) → hooks /
 * doctor commands → gatherEffectiveHooks reading a real hooks.json → the shared
 * classify/probe/explain walkers. The PowerShell `-ExecutionPolicy Bypass -File`
 * shape is the real Codex hook command; the oracles pin found/missing status,
 * the golden English sentence, the doctor #3 codex path (the falsifiable proof
 * that the doctor now consumes codex hooks), and the secret-redaction surface.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { run } from '../src/cli.mjs';

const GHP = `ghp_${'Z'.repeat(36)}`;

/**
 * Build a codex config dir with a hooks.json. `present` references a real .ps1
 * via -File (→ found); `missing` references a non-existent .ps1 (→ missing); a
 * Stop hook carries an embedded token (the secret oracle). Returns { dir, realPs1 }.
 */
function makeCodexDir() {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-codex-hooks-'));
  const realPs1 = join(dir, 'real-hook.ps1');
  writeFileSync(realPs1, '# a real hook script', 'utf8');
  const missingPs1 = join(dir, 'does-not-exist.ps1');
  const hooksJson = {
    hooks: {
      SessionStart: [
        { matcher: 'startup|resume|clear', hooks: [{ type: 'command', command: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${realPs1}"` }] },
      ],
      PreToolUse: [
        { hooks: [{ type: 'command', command: `powershell.exe -ExecutionPolicy Bypass -File "${missingPs1}"` }] },
      ],
      Stop: [
        { hooks: [{ type: 'command', command: `deploy-tool --token=${GHP}` }] },
      ],
    },
    // codex carries a trust-hash sibling alongside .hooks — it must be ignored.
    state: { 'x:session_start:0:0': { trusted_hash: 'sha256:abc' } },
  };
  writeFileSync(join(dir, 'hooks.json'), JSON.stringify(hooksJson), 'utf8');
  return { dir };
}

// ── hooks --target codex ──────────────────────────────────────────────────────

test('hooks --target codex: reads hooks.json, classifies PowerShell -File, found/missing status', async () => {
  const { dir } = makeCodexDir();
  try {
    const out = await run(['hooks', '--target', 'codex', '--config-dir', dir, '--format', 'json']);
    assert.equal(out.code, 0, `exit 0 expected: ${out.stdout}`);
    const env = JSON.parse(out.stdout);
    const ex = env.result.explanations;
    assert.equal(ex.length, 3, 'one explanation per hook entry');

    const byEvent = Object.fromEntries(ex.map((e) => [e.event, e]));

    // SessionStart → real .ps1 present → kind file, FOUND (the -ExecutionPolicy
    // Bypass value was correctly skipped; -File arg is the script).
    assert.equal(byEvent.SessionStart.kind, 'file');
    assert.equal(byEvent.SessionStart.status, 'found');
    assert.ok(byEvent.SessionStart.target.endsWith('real-hook.ps1'), 'script is the -File arg, not "Bypass"');

    // PreToolUse → missing .ps1 → file, MISSING.
    assert.equal(byEvent.PreToolUse.kind, 'file');
    assert.equal(byEvent.PreToolUse.status, 'missing');

    // golden English sentence for the found hook (matcher-bearing, non-tool event).
    assert.equal(
      byEvent.SessionStart.explanation,
      `On SessionStart (when a session starts or resumes), matching "startup|resume|clear", runs the script "${byEvent.SessionStart.target}" (file, found).`,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hooks --target codex: an embedded token in a hook command is redacted (secret oracle)', async () => {
  const { dir } = makeCodexDir();
  try {
    const out = await run(['hooks', '--target', 'codex', '--config-dir', dir, '--format', 'json']);
    assert.ok(!out.stdout.includes(GHP), 'token plaintext must not appear anywhere in stdout');
    assert.ok(out.stdout.includes('<redacted>'), 'redaction marker expected');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── doctor --target codex (the #3 falsifiable proof) ──────────────────────────

test('doctor --target codex: #3 hook-file-exists fires on a missing codex hook script', async () => {
  const { dir } = makeCodexDir();
  try {
    const out = await run(['doctor', '--target', 'codex', '--config-dir', dir, '--format', 'json']);
    const env = JSON.parse(out.stdout);
    const check3 = env.result.checks.find((c) => c.id === 3);
    assert.ok(check3, '#3 hook-file-exists is registered');
    assert.equal(check3.ran, true, '#3 ran (passive)');
    // PRE-U4 the doctor never saw codex hooks (it read settings.json only) → #3
    // would have 0 findings. Now it judges the codex hooks.json → the missing
    // PreToolUse .ps1 produces exactly one finding (findings is a COUNT).
    assert.ok(check3.findings >= 1, 'a missing codex hook script is flagged');
    // The finding's severity lives in the top-level diagnostics (doctorCommand
    // merges the doctor findings there). #3 missing-file is an error.
    assert.ok(
      env.diagnostics.some((d) => d.code === 'hook-file-exists' && d.severity === 'error'),
      'the missing-file finding is an error diagnostic',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('doctor --target codex: #3 has ZERO findings when every codex hook script exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-codex-clean-'));
  try {
    const realPs1 = join(dir, 'hook.ps1');
    writeFileSync(realPs1, '# ok', 'utf8');
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${realPs1}"` }] }] },
    }), 'utf8');
    const out = await run(['doctor', '--target', 'codex', '--config-dir', dir, '--format', 'json']);
    const env = JSON.parse(out.stdout);
    const check3 = env.result.checks.find((c) => c.id === 3);
    assert.equal(check3.findings, 0, 'a present .ps1 → no #3 finding (no false positive)');
    assert.ok(
      !env.diagnostics.some((d) => d.code === 'hook-file-exists'),
      'no hook-file-exists diagnostic when the script resolves',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
