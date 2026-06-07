/**
 * P4b.U9 — test/cli-completion.test.mjs
 *
 * Tests for the tab-completion engine (src/cli/completion.mjs), the flag
 * single-source (src/cli/flags.mjs), and the CLI wiring (src/cli/commands.mjs +
 * src/cli.mjs run(argv) + src/cli/render.mjs).
 *
 * The headline is the DRIFT-GUARD: the completion model is DERIVED from the live
 * COMMANDS registry + the flag lists, so a future command/flag change is reflected
 * automatically — the test computes its expectations FROM those same sources so it
 * stays honest.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildCompletionModel,
  renderBashCompletion,
  renderPwshCompletion,
  completionCommand,
} from '../src/cli/completion.mjs';
import { COMMANDS } from '../src/cli/commands.mjs';
import { VALUE_FLAGS, BOOLEAN_FLAGS } from '../src/cli/flags.mjs';
import { run } from '../src/cli.mjs';

// ── helpers ────────────────────────────────────────────────────────────────────

function tempCfg() {
  return mkdtempSync(join(tmpdir(), 'cmgr-completion-'));
}

function liveModel() {
  return buildCompletionModel(Object.keys(COMMANDS), VALUE_FLAGS, BOOLEAN_FLAGS);
}

// ── 1. DRIFT-GUARD: model derived from COMMANDS + flag lists ─────────────────────

test('drift-guard: model.commands == sorted unique top-level of COMMANDS keys', () => {
  const model = liveModel();
  const expected = [...new Set(Object.keys(COMMANDS).map((k) => k.split(':')[0]))].sort();
  assert.deepEqual(model.commands, expected);
  // The NEW command must be present (this is what makes the drift-guard catch a
  // future un-registered completion command).
  assert.ok(model.commands.includes('completion'), 'completion must be a top-level command');
});

test('drift-guard: model.subcommands match the colon-keyed groups exactly', () => {
  const model = liveModel();
  // Compute expected sub-verbs FROM COMMANDS so adding a future `x:y` keeps it honest.
  const expected = Object.create(null);
  for (const k of Object.keys(COMMANDS)) {
    const [top, verb] = k.split(':');
    if (verb) {
      if (!expected[top]) expected[top] = [];
      expected[top].push(verb);
    }
  }
  for (const top of Object.keys(expected)) expected[top].sort();

  assert.deepEqual(Object.keys(model.subcommands).sort(), Object.keys(expected).sort());
  for (const top of Object.keys(expected)) {
    assert.deepEqual(model.subcommands[top], expected[top], `subcommands.${top}`);
  }
  // Spot-check the known groups directly.
  assert.deepEqual(model.subcommands.config, ['diff', 'show-effective']);
  assert.deepEqual(model.subcommands.snapshot, ['gc', 'list', 'pin', 'unpin']);
  assert.deepEqual(model.subcommands.mcp, ['remove']);
});

test('drift-guard: model.flags == sorted unique of VALUE_FLAGS + BOOLEAN_FLAGS', () => {
  const model = liveModel();
  const expected = [...new Set([...VALUE_FLAGS, ...BOOLEAN_FLAGS])].sort();
  assert.deepEqual(model.flags, expected);
});

test('model.shells is exactly bash + powershell', () => {
  assert.deepEqual(liveModel().shells, ['bash', 'powershell']);
});

test('snapshot is BOTH a top-level command AND has sub-verbs', () => {
  const model = liveModel();
  assert.ok(model.commands.includes('snapshot'), 'snapshot in commands');
  assert.ok(Array.isArray(model.subcommands.snapshot), 'snapshot in subcommands');
});

// ── 2. bash script content ───────────────────────────────────────────────────────

test('bash script contains every command, sub-verb, sample flags, and the complete -F line', () => {
  const model = liveModel();
  const script = renderBashCompletion(model);
  for (const c of model.commands) assert.ok(script.includes(c), `bash missing command ${c}`);
  for (const top of Object.keys(model.subcommands)) {
    for (const verb of model.subcommands[top]) assert.ok(script.includes(verb), `bash missing sub-verb ${verb}`);
  }
  for (const f of ['--apply', '--cascade', '--format', '--scope']) {
    assert.ok(script.includes(f), `bash missing flag ${f}`);
  }
  assert.ok(script.includes('compgen'), 'bash missing compgen');
  assert.ok(script.includes('complete -F _claude_mgr_complete claude-mgr'), 'bash missing complete -F line');
  // The completion-shells arm must be generated from model.shells.
  assert.ok(script.includes('completion) if [[ $COMP_CWORD -eq 2 ]]'), 'bash missing completion arm');
});

// ── 3. pwsh script content ───────────────────────────────────────────────────────

test('pwsh script contains every command, sub-verb, sample flags, switch arms, and Register-ArgumentCompleter', () => {
  const model = liveModel();
  const script = renderPwshCompletion(model);
  for (const c of model.commands) assert.ok(script.includes(`'${c}'`), `pwsh missing command ${c}`);
  for (const top of Object.keys(model.subcommands)) {
    for (const verb of model.subcommands[top]) assert.ok(script.includes(`'${verb}'`), `pwsh missing sub-verb ${verb}`);
  }
  for (const f of ['--apply', '--cascade', '--format', '--scope']) {
    assert.ok(script.includes(`'${f}'`), `pwsh missing flag ${f}`);
  }
  assert.ok(script.includes('Register-ArgumentCompleter -Native'), 'pwsh missing Register-ArgumentCompleter');
  assert.ok(script.includes("'config' {"), 'pwsh missing config switch arm');
  assert.ok(script.includes("'snapshot' {"), 'pwsh missing snapshot switch arm');
  assert.ok(script.includes("'mcp' {"), 'pwsh missing mcp switch arm');
  assert.ok(script.includes("'completion' {"), 'pwsh missing completion switch arm');
});

// ── 4. handler exit codes via run() ──────────────────────────────────────────────

test('run(completion bash) → code 0, raw bash script (no title, no footer)', async () => {
  const tmp = tempCfg();
  const { code, stdout } = await run(['completion', 'bash', '--config-dir', tmp]);
  assert.equal(code, 0);
  assert.ok(stdout.startsWith('# claude-mgr bash completion'), 'must start with the bash header (no title line)');
  assert.ok(!stdout.startsWith('claude-mgr completion'), 'must NOT emit the title line');
  assert.ok(stdout.includes('complete -F'), 'includes complete -F');
});

test('run(completion powershell) → code 0, Register-ArgumentCompleter', async () => {
  const tmp = tempCfg();
  const { code, stdout } = await run(['completion', 'powershell', '--config-dir', tmp]);
  assert.equal(code, 0);
  assert.ok(stdout.includes('Register-ArgumentCompleter'), 'includes Register-ArgumentCompleter');
  assert.ok(stdout.startsWith('# claude-mgr PowerShell completion'), 'starts with pwsh header');
});

test('run(completion) with no shell → code 2 and mentions valid shells', async () => {
  const tmp = tempCfg();
  const { code, stdout } = await run(['completion', '--config-dir', tmp]);
  assert.equal(code, 2);
  assert.ok(/bash/.test(stdout) && /powershell/.test(stdout), 'mentions the valid shells');
});

test('run(completion klingon) unknown shell → code 2', async () => {
  const tmp = tempCfg();
  const { code } = await run(['completion', 'klingon', '--config-dir', tmp]);
  assert.equal(code, 2);
});

// ── 5. never-throws on junk ──────────────────────────────────────────────────────

test('buildCompletionModel(null,null,null) does not throw and is well-formed', () => {
  const model = buildCompletionModel(null, null, null);
  assert.deepEqual(model.commands, []);
  assert.equal(typeof model.subcommands, 'object');
  assert.deepEqual(model.flags, []);
  assert.deepEqual(model.shells, ['bash', 'powershell']);
});

test('renderBashCompletion(null) / renderPwshCompletion(undefined) do not throw', () => {
  assert.doesNotThrow(() => renderBashCompletion(null));
  assert.doesNotThrow(() => renderPwshCompletion(undefined));
  // Even on an empty model the load-bearing structural lines survive.
  assert.ok(renderBashCompletion(null).includes('complete -F _claude_mgr_complete claude-mgr'));
  assert.ok(renderPwshCompletion(undefined).includes('Register-ArgumentCompleter -Native'));
});

test('completionCommand never throws and emits ZERO diagnostics on success', () => {
  const out = completionCommand({ args: { positionals: ['bash'] } }, { commandKeys: Object.keys(COMMANDS) });
  assert.equal(out.code, 0);
  assert.deepEqual(out.diagnostics, [], 'a sourced script must carry no diagnostics');
});

// ── 6. pwsh / ps aliases ─────────────────────────────────────────────────────────

test("'pwsh' and 'ps' aliases map to the powershell script", async () => {
  const tmp = tempCfg();
  for (const alias of ['pwsh', 'ps']) {
    const out = completionCommand({ args: { positionals: [alias] } }, { commandKeys: Object.keys(COMMANDS) });
    assert.equal(out.code, 0, `${alias} → code 0`);
    assert.equal(out.result.shell, 'powershell', `${alias} → powershell`);
    assert.ok(out.result.script.includes('Register-ArgumentCompleter'), `${alias} script`);
  }
  // And via run() for the 'pwsh' alias end-to-end.
  const { code, stdout } = await run(['completion', 'pwsh', '--config-dir', tmp]);
  assert.equal(code, 0);
  assert.ok(stdout.includes('Register-ArgumentCompleter'));
});
