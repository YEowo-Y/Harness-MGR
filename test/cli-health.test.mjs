/**
 * cli-health.test.mjs (P5.U5) — the `health` command: one read-only command
 * wiring analyzeHealth (U2) + analyzeAdvice (U3) + explainHooks (U4) behind a
 * severity-layered render.
 *
 * HEADLINE oracles:
 *   - GOLDEN JSON envelope: a temp config exercising all three sections
 *     (a hooks entry probing missing, a frontmatter-invalid diagnostic driving
 *     degraded, a duplicate settings key firing advice + doctor error) →
 *     exact envelope/section shapes + exit 1 (error finding inherits doctor
 *     exit semantics).
 *   - GOLDEN render snapshot: healthTable over a FIXED synthetic result equals
 *     a literal multi-line string pinning tier order + textual markers. The
 *     FIXED advice list is deliberately fed UNSORTED (warn, info, error) so the
 *     error→warn→info grouping is mutation-falsifiable.
 *   - P1 secret oracle: a ghp_-style token in a hook command is absent from the
 *     WHOLE health stdout (json AND table).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { run } from '../src/cli.mjs';
import { healthCommand } from '../src/cli/health-command.mjs';
import { healthTable } from '../src/cli/health-render.mjs';
import { gatherDoctorInput } from '../src/cli/doctor-facts.mjs';

// Realistic github classic token shape (ghp_ + exactly 36 alnum) so the
// high-confidence redaction rule fires — same convention as cli-hooks-explain.
const GHP = `ghp_${'Z'.repeat(36)}`;

/**
 * The golden temp config: duplicate settings key (→ scan settings-duplicate-key
 * warn + doctor settings-json-valid ERROR + advice-settings-invalid), one hook
 * whose command is not on PATH (→ probe missing + doctor hook-external-command
 * warn + advice-hook-command-missing), one agent with malformed frontmatter
 * (→ frontmatter-invalid warn at the component path → DEGRADED), one clean
 * command (→ loadable).
 */
function makeGoldenConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-health-'));
  writeFileSync(join(dir, 'settings.json'), [
    '{',
    '  "model": "sonnet",',
    '  "model": "opus",',
    '  "hooks": {',
    '    "PreToolUse": [',
    '      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "definitely-not-on-path-xyz check" }] }',
    '    ]',
    '  }',
    '}',
  ].join('\n'), 'utf8');
  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(join(dir, 'agents', 'broken.md'), '---\nname: [unclosed\n---\n# broken\n', 'utf8');
  mkdirSync(join(dir, 'commands'), { recursive: true });
  writeFileSync(join(dir, 'commands', 'ok.md'), '---\nname: ok\n---\n# ok\n', 'utf8');
  return dir;
}

// ── 1. GOLDEN JSON envelope (end-to-end, all three sections) ──────────────────

test('health --format json: envelope + all three sections + exit 1 on doctor error', async () => {
  const dir = makeGoldenConfig();
  try {
    const out = await run(['health', '--format', 'json', '--config-dir', dir]);
    const env = JSON.parse(out.stdout);
    assert.equal(env.version, 1, 'version:1 envelope');
    assert.equal(env.command, 'health');
    // the duplicate-key doctor finding is error-severity → exit semantics inherit
    assert.equal(out.code, 1, `expected exit 1 (settings-json-valid error), got ${out.code}`);

    // health section — exact summary + groups + the degraded record
    assert.deepEqual(env.result.health.summary, { total: 2, loadable: 1, degraded: 1, notLoaded: 0 });
    assert.deepEqual(env.result.health.groups, [
      { scope: 'user', kind: 'agent', status: 'degraded', count: 1, names: ['broken'] },
      { scope: 'user', kind: 'command', status: 'loadable', count: 1, names: ['ok'] },
    ]);
    const broken = env.result.health.components[0];
    assert.equal(broken.kind, 'agent');
    assert.equal(broken.name, 'broken');
    assert.equal(broken.status, 'degraded');
    assert.equal(broken.worstSeverity, 'warn');
    assert.equal(broken.reasons[0].code, 'frontmatter-invalid');

    // advice section — exactly the two deterministic rules fire
    assert.deepEqual(env.result.advice.summary, { total: 2, error: 1, warn: 1, info: 0 });
    const [settingsRule, hookRule] = env.result.advice.advice;
    assert.equal(settingsRule.ruleId, 'advice-settings-invalid');
    assert.equal(settingsRule.severity, 'error');
    assert.deepEqual(settingsRule.matchedCodes, ['settings-duplicate-key', 'settings-json-valid'],
      'both the scan fact and the doctor escalation match the rule');
    assert.equal(hookRule.ruleId, 'advice-hook-command-missing');
    assert.equal(hookRule.severity, 'warn');
    assert.deepEqual(hookRule.matchedCodes, ['hook-external-command']);

    // hooks section — exact summary + the explained missing entry
    assert.deepEqual(env.result.hooks.summary,
      { total: 1, missing: 1, indeterminate: 0, byKind: { file: 0, external: 1, opaque: 0 } });
    const ex = env.result.hooks.explanations[0];
    assert.equal(ex.event, 'PreToolUse');
    assert.equal(ex.kind, 'external');
    assert.equal(ex.target, 'definitely-not-on-path-xyz');
    assert.equal(ex.status, 'missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 2. GOLDEN render snapshot (the DoD headline) ──────────────────────────────

/**
 * FIXED synthetic result. NOTE the advice array is deliberately UNSORTED
 * (warn, info, error) — the renderer must regroup error→warn→info, so a
 * dropped-grouping mutation flips the golden red.
 */
const FIXED = {
  health: {
    summary: { total: 4, loadable: 1, degraded: 1, notLoaded: 2 },
    groups: [],
    components: [
      { kind: 'agent', name: 'old-tracer', path: '/cfg/agents/old-tracer.md', scope: 'user', status: 'not-loaded', worstSeverity: 'warn', reasons: [{ code: 'agent-shadowing', severity: 'warn', message: "shadowed by 'tracer' (/cfg/agents/tracer.md); confidence likely" }] },
      { kind: 'skill', name: 'broken', path: '/cfg/skills/broken/SKILL.md', scope: 'user', status: 'not-loaded', worstSeverity: 'error', reasons: [{ code: 'component-read-failed', severity: 'error', message: 'read failed: EACCES' }] },
      { kind: 'agent', name: 'tracer', path: '/cfg/agents/tracer.md', scope: 'user', status: 'degraded', worstSeverity: 'warn', reasons: [{ code: 'agent-shadowing-winner', severity: 'warn', message: 'loads but shadows 1 other(s); confidence likely' }] },
      { kind: 'command', name: 'ok', path: '/cfg/commands/ok.md', scope: 'user', status: 'loadable', worstSeverity: null, reasons: [] },
    ],
  },
  advice: {
    summary: { total: 3, error: 1, warn: 1, info: 1 },
    advice: [
      { ruleId: 'advice-agent-shadowing', title: 'Resolve agent shadowing', severity: 'warn', advice: 'x', fix: 'remove or rename the duplicate agent', affectedPaths: ['/cfg/agents/old-tracer.md'], matchedCodes: ['agent-shadowing'], docUrl: 'https://example', docVersion: '' },
      { ruleId: 'advice-claude-md-backups', title: 'Tidy CLAUDE.md backups', severity: 'info', advice: 'x', fix: 'delete old CLAUDE.md.backup files', affectedPaths: [], matchedCodes: ['claude-md-backup-bloat'], docUrl: 'https://example', docVersion: '' },
      { ruleId: 'advice-settings-invalid', title: 'Fix invalid settings', severity: 'error', advice: 'x', fix: 'remove the duplicate key from settings.json', affectedPaths: ['/cfg/settings.json'], matchedCodes: ['settings-json-valid'], docUrl: 'https://example', docVersion: '' },
    ],
  },
  hooks: {
    summary: { total: 3, missing: 1, indeterminate: 1, byKind: { file: 1, external: 2, opaque: 0 } },
    explanations: [
      { event: 'PreToolUse', matcher: 'Bash', command: 'lint-tool check', kind: 'external', target: 'lint-tool', status: 'found', explanation: 'x' },
      { event: 'SessionStart', matcher: null, command: 'node $CLAUDE_PROJECT_DIR/h.mjs', kind: 'file', target: '$CLAUDE_PROJECT_DIR/h.mjs', status: 'indeterminate', explanation: 'x' },
      { event: 'Stop', matcher: null, command: 'deploy-tool sync', kind: 'external', target: 'deploy-tool', status: 'missing', explanation: 'x' },
    ],
  },
};

const GOLDEN = [
  'summary: total 4 — loadable 1, degraded 1, not-loaded 2',
  '',
  '[!!] not-loaded (2)',
  "  agent old-tracer — shadowed by 'tracer' (/cfg/agents/tracer.md); confidence likely",
  '  skill broken — read failed: EACCES',
  '',
  '[! ] degraded (1)',
  '  agent tracer — loads but shadows 1 other(s); confidence likely',
  '',
  'advice (3)',
  '  [!!] Fix invalid settings — /cfg/settings.json',
  '       fix: remove the duplicate key from settings.json',
  '  [! ] Resolve agent shadowing — /cfg/agents/old-tracer.md',
  '       fix: remove or rename the duplicate agent',
  '  [i ] Tidy CLAUDE.md backups',
  '       fix: delete old CLAUDE.md.backup files',
  '',
  'hooks: 2 problem(s) of 3',
  '  [!!] Stop: deploy-tool sync — missing',
  '  [! ] SessionStart: node $CLAUDE_PROJECT_DIR/h.mjs — indeterminate',
].join('\n');

test('healthTable GOLDEN: literal multi-line snapshot pins tier order + markers', () => {
  assert.equal(healthTable(FIXED), GOLDEN);
});

// ── 3. severity tiering (explicit, mutation-falsifiable) ──────────────────────

test('healthTable: tiers render not-loaded → degraded → advice → hooks; advice error→warn→info', () => {
  const out = healthTable(FIXED);
  const iNot = out.indexOf('[!!] not-loaded');
  const iDeg = out.indexOf('[! ] degraded');
  const iAdv = out.indexOf('advice (');
  const iHooks = out.indexOf('hooks:');
  assert.ok(iNot >= 0 && iNot < iDeg && iDeg < iAdv && iAdv < iHooks, 'section tier order');
  const iErr = out.indexOf('[!!] Fix invalid settings');
  const iWarn = out.indexOf('[! ] Resolve agent shadowing');
  const iInfo = out.indexOf('[i ] Tidy CLAUDE.md backups');
  assert.ok(iErr >= 0 && iErr < iWarn && iWarn < iInfo,
    'advice severity tiers must render error before warn before info even from unsorted input');
  // hooks problems: missing ([!!]) before indeterminate ([! ])
  assert.ok(out.indexOf('[!!] Stop:') < out.indexOf('[! ] SessionStart:'), 'missing before indeterminate');
});

// ── 4. P1 secret oracle (json + table) ────────────────────────────────────────

test('health: a ghp_ token in a hook command never reaches stdout (json + table)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-health-secret-'));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: `deploy-tool --token=${GHP}` }] }] },
  }), 'utf8');
  try {
    const json = await run(['health', '--format', 'json', '--config-dir', dir]);
    assert.ok(!json.stdout.includes(GHP), 'token plaintext must not appear in json stdout');
    assert.ok(json.stdout.includes('<redacted>'), 'redaction marker expected in json');
    const table = await run(['health', '--config-dir', dir]);
    assert.ok(!table.stdout.includes(GHP), 'token plaintext must not appear in table stdout');
    assert.ok(table.stdout.includes('<redacted>'), 'redaction marker expected in table');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 5. exit semantics ─────────────────────────────────────────────────────────

test('health: clean config exits 0 with a loadable summary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-health-clean-'));
  writeFileSync(join(dir, 'settings.json'), '{}\n', 'utf8');
  mkdirSync(join(dir, 'commands'), { recursive: true });
  writeFileSync(join(dir, 'commands', 'ok.md'), '---\nname: ok\n---\n# ok\n', 'utf8');
  try {
    const out = await run(['health', '--format', 'json', '--config-dir', dir]);
    assert.equal(out.code, 0, `clean config must exit 0, got ${out.code}: ${out.stdout}`);
    const env = JSON.parse(out.stdout);
    assert.deepEqual(env.result.health.summary, { total: 1, loadable: 1, degraded: 0, notLoaded: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('health: empty config dir → all sections empty, exit 0, no throw', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-health-empty-'));
  try {
    const out = await run(['health', '--format', 'json', '--config-dir', dir]);
    assert.equal(out.code, 0);
    const env = JSON.parse(out.stdout);
    assert.deepEqual(env.result.health.summary, { total: 0, loadable: 0, degraded: 0, notLoaded: 0 });
    assert.deepEqual(env.result.health.components, []);
    assert.deepEqual(env.result.advice.advice, []);
    assert.deepEqual(env.result.hooks.explanations, []);
    // table form renders the pinned empty-tier lines
    const table = await run(['health', '--config-dir', dir]);
    assert.match(table.stdout, /\[!!\] not-loaded \(0\)\n {2}none/);
    assert.match(table.stdout, /hooks: none configured/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 6. hermetic seams (deps) ──────────────────────────────────────────────────

test('healthCommand: a synthetic shadowing conflict drives not-loaded + agent-shadowing advice', async () => {
  const facts = {
    components: [
      { kind: 'agent', name: 'tracer', path: '/cfg/agents/tracer.md', source: { tier: 'user' } },
      { kind: 'agent', name: 'old', path: '/cfg/agents/old.md', source: { tier: 'user' } },
    ],
    conflicts: [{
      kind: 'agent',
      key: 'tracer',
      confidence: 'likely',
      likelyWinner: { name: 'tracer', path: '/cfg/agents/tracer.md' },
      possibleWinners: [
        { name: 'tracer', path: '/cfg/agents/tracer.md' },
        { name: 'old', path: '/cfg/agents/old.md' },
      ],
    }],
    scanDiagnostics: [],
    effectiveHooks: {},
    hookFacts: [],
  };
  const out = await healthCommand({ configDir: '/x', args: {} }, {
    gatherFn: async () => ({ input: {}, diagnostics: [], facts }),
    runDoctorFn: () => ({ probeLevel: 'passive', checks: [], diagnostics: [] }),
    env: {},
  });
  assert.deepEqual(out.result.health.summary, { total: 2, loadable: 0, degraded: 1, notLoaded: 1 });
  const loser = out.result.health.components.find((c) => c.name === 'old');
  assert.equal(loser.status, 'not-loaded');
  // the shadowing reasons flow through the health channel into the advice engine
  const shadowAdvice = out.result.advice.advice.find((a) => a.ruleId === 'advice-agent-shadowing');
  assert.ok(shadowAdvice, 'advice-agent-shadowing must fire from health reasons');
  assert.deepEqual(shadowAdvice.affectedPaths, ['/cfg/agents/old.md', '/cfg/agents/tracer.md']);
});

test('healthCommand: throwing gather seam degrades to empty sections + warn (never throws)', async () => {
  const out = await healthCommand({ configDir: '/x', args: {} }, {
    gatherFn: () => { throw new Error('boom'); },
  });
  assert.deepEqual(out.result.health.summary, { total: 0, loadable: 0, degraded: 0, notLoaded: 0 });
  assert.deepEqual(out.result.advice.advice, []);
  assert.deepEqual(out.result.hooks.explanations, []);
  assert.equal(out.diagnostics.length, 1);
  assert.equal(out.diagnostics[0].code, 'health-command-failed');
  assert.equal(out.diagnostics[0].severity, 'warn');
});

test('healthCommand: junk ctx (null) never throws', async () => {
  const out = await healthCommand(null, {
    gatherFn: async () => ({ input: {}, diagnostics: [], facts: {} }),
    runDoctorFn: () => ({ probeLevel: 'passive', checks: [], diagnostics: [] }),
    env: {},
  });
  assert.deepEqual(out.result.health.summary, { total: 0, loadable: 0, degraded: 0, notLoaded: 0 });
  assert.deepEqual(out.diagnostics, []);
});

// ── 7. gatherDoctorInput extension stays additive ─────────────────────────────

test('gatherDoctorInput: facts key exposes already-computed values (no recompute)', async () => {
  const dir = makeGoldenConfig();
  try {
    const out = await gatherDoctorInput({
      configDir: dir, mgrStateDir: join(dir, '.mgr-state'), activeProbes: false, now: Date.now(), cwd: dir,
    });
    assert.deepEqual(Object.keys(out).sort(), ['diagnostics', 'facts', 'input'], 'additive third key only');
    assert.deepEqual(Object.keys(out.facts).sort(),
      ['components', 'conflicts', 'effectiveHooks', 'hookFacts', 'scanDiagnostics']);
    assert.ok(out.facts.components.some((c) => c.kind === 'agent' && c.name === 'broken'));
    assert.ok(out.facts.scanDiagnostics.some((d) => d.code === 'frontmatter-invalid'));
    // EXPOSE, not recompute: the same array references the doctor input holds
    assert.equal(out.facts.conflicts, out.input.conflicts, 'conflicts must be the same array');
    assert.equal(out.facts.hookFacts, out.input.hookFacts, 'hookFacts must be the same array');
    assert.ok(Array.isArray(out.facts.effectiveHooks.PreToolUse), 'merged effective.hooks exposed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 8. render defensiveness ───────────────────────────────────────────────────

test('healthTable: malformed input never throws; junk severities are dropped', () => {
  assert.equal(typeof healthTable(null), 'string');
  assert.equal(typeof healthTable(42), 'string');
  const out = healthTable({
    health: { summary: { total: 'x' }, components: [null, 42, { status: 'degraded' }] },
    advice: { advice: [null, { severity: 'bogus', title: 'never-rendered' }] },
    hooks: { explanations: [null, { event: 'Stop', command: 'c', status: 'missing' }] },
  });
  assert.ok(!out.includes('never-rendered'), 'a record with an unknown severity has no tier');
  assert.match(out, /advice \(0\)\n {2}none/, 'junk advice drops to an empty tier');
  assert.match(out, /\[!!\] Stop: c — missing/, 'the well-formed hook problem row still renders');
});
