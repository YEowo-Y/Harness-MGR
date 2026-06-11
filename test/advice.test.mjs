/**
 * Tests for src/analysis/advice.mjs + src/config/best-practice-rules.json (P5.U3).
 *
 * PACK VALIDITY (the traceability gate): every shipped rule passes the REAL
 * validity predicate, ids are unique, every docUrl points at the official docs
 * site, every docVersion/sourceStatement is non-empty, and every triggerCode is
 * in the LITERAL emitted-code vocabulary embedded below — a future rule with an
 * invented code goes RED here (drift-guard).
 *
 * GOLDEN (the DoD headline): a synthetic known-config fact set spanning all
 * THREE channels (scan diagnostics + doctor diagnostics + a U2 health reason)
 * → deepEqual of the ENTIRE { advice, summary } against a hand-written LITERAL
 * — pinning which rules fire, affectedPaths union/sort/dedupe, matchedCodes,
 * and severity-then-ruleId ordering. The literal copies the pack's strings, so
 * an unreviewed edit to a shipped rule's text also goes RED (golden lock-in).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeAdvice, isValidAdviceRule, BUNDLED_RULE_PACK } from '../src/analysis/advice.mjs';
import pack from '../src/config/best-practice-rules.json' with { type: 'json' };

// ── LITERAL copy of the tool's emitted diagnostic-code vocabulary ─────────────
// (doctor checks + conflicts/health template codes + discovery codes; verified
// against src at distillation time. A rule citing a code outside this set is a
// distillation bug.)
const EMITTED_CODES = new Set([
  // doctor checks
  'mcp-auth-stale', 'mcp-server-resolvable', 'hook-file-exists', 'hook-external-command',
  'hook-node-syntax', 'settings-json-valid', 'plugin-enabled-not-installed',
  'plugin-installed-not-enabled', 'plugin-marketplace-unknown', 'plugin-cache-missing',
  'duplicate-component-shadowing', 'orphan-files', 'claude-config-schema-version',
  'permissions-overbroad', 'claude-md-backup-bloat', 'snapshot-retention', 'disk-budget',
  'probe-residue', 'apply-leftover-files', 'config-rules-stale', 'windows-file-locks',
  'insecure-permissions', 'statusline-resolvable', 'claude-cli-resolvable', 'loader-probe',
  // conflicts/health template codes (kind ∈ skill|agent|command)
  'skill-shadowing', 'agent-shadowing', 'command-shadowing',
  'skill-shadowing-winner', 'agent-shadowing-winner', 'command-shadowing-winner',
  // discovery
  'settings-duplicate-key', 'settings-unreadable',
]);

// ── PACK VALIDITY oracle ──────────────────────────────────────────────────────

test('pack: rules array is non-empty and exported bundle is the same pack', () => {
  assert.ok(Array.isArray(pack.rules) && pack.rules.length > 0, 'rules must be a non-empty array');
  assert.equal(pack.rulesVersion, 1);
  assert.deepEqual(BUNDLED_RULE_PACK, pack);
});

test('pack: every rule passes the validity predicate', () => {
  for (const rule of pack.rules) {
    assert.ok(isValidAdviceRule(rule), `invalid rule: ${rule && rule.id}`);
  }
});

test('pack: rule ids are unique', () => {
  const ids = pack.rules.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids in: ${ids.join(', ')}`);
});

test('pack: every docUrl is an official docs page', () => {
  const re = /^https:\/\/code\.claude\.com\/docs\/en\//;
  for (const rule of pack.rules) {
    assert.match(rule.docUrl, re, `rule ${rule.id} docUrl not official: ${rule.docUrl}`);
  }
});

test('pack: every docVersion and sourceStatement is a non-empty string (QC audit trail)', () => {
  for (const rule of pack.rules) {
    assert.ok(typeof rule.docVersion === 'string' && rule.docVersion.length > 0, `rule ${rule.id} missing docVersion`);
    assert.ok(typeof rule.sourceStatement === 'string' && rule.sourceStatement.length > 0, `rule ${rule.id} missing sourceStatement`);
    assert.ok(rule.sourceStatement.length <= 250, `rule ${rule.id} sourceStatement over 250 chars (${rule.sourceStatement.length})`);
  }
});

test('pack: every triggerCode is in the emitted-code vocabulary (drift-guard)', () => {
  for (const rule of pack.rules) {
    for (const code of rule.triggerCodes) {
      assert.ok(EMITTED_CODES.has(code), `rule ${rule.id} cites un-emitted code "${code}"`);
    }
  }
});

// ── BILINGUAL (TUI-bilingual B1): zh fields present + passed through ───────────

test('pack: every bundled rule carries non-empty titleZh/adviceZh/fixZh (bilingual drift-guard)', () => {
  // A future rule added without a Simplified-Chinese translation goes RED here.
  for (const rule of pack.rules) {
    assert.ok(typeof rule.titleZh === 'string' && rule.titleZh.length > 0, `rule ${rule.id} missing titleZh`);
    assert.ok(typeof rule.adviceZh === 'string' && rule.adviceZh.length > 0, `rule ${rule.id} missing adviceZh`);
    assert.ok(typeof rule.fixZh === 'string' && rule.fixZh.length > 0, `rule ${rule.id} missing fixZh`);
  }
});

test('record built from the bundled pack carries the rule\'s zh fields', () => {
  // mcp-auth-stale fires advice-mcp-auth-stale from the bundled pack.
  const rule = pack.rules.find((r) => r.id === 'advice-mcp-auth-stale');
  const r = analyzeAdvice({ diagnostics: [{ code: 'mcp-auth-stale', severity: 'warn', message: '', path: '/p' }] });
  const rec = r.advice.find((a) => a.ruleId === 'advice-mcp-auth-stale');
  assert.ok(rec, 'advice-mcp-auth-stale must fire');
  assert.equal(rec.titleZh, rule.titleZh);
  assert.equal(rec.adviceZh, rule.adviceZh);
  assert.equal(rec.fixZh, rule.fixZh);
});

test('a custom injected rule WITHOUT zh still fires and yields \'\' zh (fallback + optional validity)', () => {
  const custom = [{
    id: 'advice-no-zh', title: 'T', severity: 'warn', triggerCodes: ['code-x'],
    advice: 'a', fix: 'f', docUrl: 'https://code.claude.com/docs/en/x', docVersion: 'v',
  }];
  // optional-validity: a pack without zh is still valid
  assert.equal(isValidAdviceRule(custom[0]), true);
  const r = analyzeAdvice({ rules: custom, diagnostics: [{ code: 'code-x', severity: 'warn', message: '', path: '/p' }] });
  assert.equal(r.advice.length, 1);
  assert.equal(r.advice[0].titleZh, '');
  assert.equal(r.advice[0].adviceZh, '');
  assert.equal(r.advice[0].fixZh, '');
});

// ── GOLDEN: known config → known advice set (literal, not computed) ───────────

/** Deep-frozen synthetic fact set: 5 distinct trigger codes across all 3 channels. */
function goldenInput() {
  return Object.freeze({
    diagnostics: Object.freeze([
      Object.freeze({ severity: 'warn', code: 'settings-duplicate-key', message: 'duplicate key "model" at line 3, column 3 (last value wins)', path: '/cfg/settings.json', phase: 'settings' }),
      Object.freeze({ severity: 'error', code: 'settings-unreadable', message: 'invalid JSONC: unexpected token (line 1, column 1)', path: '/cfg/settings.local.json', phase: 'settings' }),
    ]),
    doctorDiagnostics: Object.freeze([
      Object.freeze({ severity: 'error', code: 'hook-file-exists', message: 'hook script not found', path: '/cfg/hooks/missing.mjs', phase: 'doctor' }),
      // deliberately path-LESS: must fire its rule with affectedPaths []
      Object.freeze({ severity: 'warn', code: 'permissions-overbroad', message: 'allow rule "Bash(*)" contains a wildcard', phase: 'doctor' }),
    ]),
    health: Object.freeze({
      components: Object.freeze([
        Object.freeze({
          kind: 'skill', name: 'deploy', path: '/cfg/skills/deploy/SKILL.md', scope: 'user',
          status: 'not-loaded', worstSeverity: 'warn',
          reasons: Object.freeze([
            Object.freeze({ code: 'skill-shadowing', severity: 'warn', message: "shadowed by 'deploy'" }),
          ]),
        }),
      ]),
      summary: Object.freeze({ total: 1, loadable: 0, degraded: 0, notLoaded: 1 }),
      groups: Object.freeze([]),
      diagnostics: Object.freeze([]),
    }),
  });
}

const GOLDEN_EXPECTED = {
  advice: [
    {
      ruleId: 'advice-hook-file-missing',
      title: 'Restore or remove a missing hook script',
      titleZh: '恢复或移除一个缺失的钩子脚本',
      severity: 'error',
      advice: 'A hook in your settings points at a script file that does not exist. Hooks run automatically at lifecycle events, so this hook will error every time its event fires.',
      adviceZh: '你设置里的一个钩子指向了一个并不存在的脚本文件。钩子会在生命周期事件发生时自动运行，所以每次触发它对应的事件，这个钩子都会报错。',
      fix: 'Restore the script at the configured path, or delete that hook entry from settings.json.',
      fixZh: '把脚本恢复到配置里指定的路径，或者从 settings.json 里删掉那条钩子记录。',
      affectedPaths: ['/cfg/hooks/missing.mjs'],
      matchedCodes: ['hook-file-exists'],
      docUrl: 'https://code.claude.com/docs/en/hooks',
      docVersion: '2026-06-10',
    },
    {
      ruleId: 'advice-settings-invalid',
      title: 'Repair a broken settings.json',
      titleZh: '修复损坏的 settings.json',
      severity: 'error',
      advice: 'A settings file is malformed or contains duplicate keys. settings.json is how Claude Code is configured, so broken JSON means some or all of your settings are dropped or applied unpredictably (for duplicate keys, the last value wins).',
      adviceZh: '一个设置文件格式有误或包含重复的键。settings.json 是配置 Claude Code 的地方，所以 JSON 损坏意味着你的部分或全部设置会被丢弃、或以不可预测的方式生效（出现重复键时，以最后一个值为准）。',
      fix: 'Edit the file at the reported line and column until it is valid JSON, then verify the result with claude-mgr `config show-effective`.',
      fixZh: '在报告指出的行和列处编辑文件，直到它成为合法的 JSON，然后用 claude-mgr 的 `config show-effective` 核对结果。',
      affectedPaths: ['/cfg/settings.json', '/cfg/settings.local.json'],
      matchedCodes: ['settings-duplicate-key', 'settings-unreadable'],
      docUrl: 'https://code.claude.com/docs/en/settings',
      docVersion: '2026-06-10',
    },
    {
      ruleId: 'advice-component-shadowing',
      title: 'Resolve duplicate component names',
      titleZh: '处理重名的组件',
      severity: 'warn',
      advice: 'Two or more of your components resolve to the same name, so Claude Code applies its precedence rules and loads only one of them — the shadowed copies are silently inactive.',
      adviceZh: '你有两个或更多组件解析成了同一个名字，于是 Claude Code 按优先级规则只加载其中一个，被遮蔽的那几份会悄悄失效、不再生效。',
      fix: "Rename one copy, or delete the duplicate you don't want. claude-mgr `remove <kind>:<name>` (kind = skill/agent/command) is dry-run by default and snapshots before deleting, so it is reversible.",
      fixZh: '给其中一份改名，或删掉你不想要的那份重复项。claude-mgr 的 `remove <kind>:<name>`（kind 为 skill/agent/command，即技能/智能体/命令）默认只是预演，删除前会先做快照，所以可以撤销。',
      affectedPaths: ['/cfg/skills/deploy/SKILL.md'],
      matchedCodes: ['skill-shadowing'],
      docUrl: 'https://code.claude.com/docs/en/skills',
      docVersion: '2026-06-10',
    },
    {
      ruleId: 'advice-permissions-overbroad',
      title: 'Narrow wildcard permission allow rules',
      titleZh: '收窄带通配符的权限允许规则',
      severity: 'warn',
      advice: 'One or more entries in your permissions allow list contain a wildcard (*). Allow rules let Claude Code use the matching tools without asking you first, so a broad pattern can auto-approve far more than you intended.',
      adviceZh: '你的权限允许列表里有一条或多条规则带了通配符（*）。允许规则会让 Claude Code 不经询问就直接使用匹配到的工具，所以一条过宽的规则可能自动放行远超你本意的范围。',
      fix: 'Run `permissions --audit` to list the overbroad entries, then tighten each rule in settings.json (or via /permissions inside Claude Code) to the narrowest pattern you actually need.',
      fixZh: '运行 `permissions --audit` 列出过宽的条目，然后在 settings.json 里（或在 Claude Code 内用 /permissions）把每条规则收紧到你真正需要的最小范围。',
      affectedPaths: [],
      matchedCodes: ['permissions-overbroad'],
      docUrl: 'https://code.claude.com/docs/en/permissions',
      docVersion: '2026-06-10',
    },
  ],
  summary: { total: 4, error: 2, warn: 2, info: 0 },
};

test('GOLDEN: known config facts → the exact literal advice set', () => {
  const result = analyzeAdvice(goldenInput());
  assert.deepEqual({ advice: result.advice, summary: result.summary }, GOLDEN_EXPECTED);
  assert.deepEqual(result.diagnostics, []);
});

test('GOLDEN: deterministic (twice → deepEqual) and frozen input not mutated', () => {
  const input = goldenInput();
  const snapshot = structuredClone(input);
  const a = analyzeAdvice(input);
  const b = analyzeAdvice(input);
  assert.deepEqual(a, b);
  assert.deepEqual(input, snapshot); // ESM strict mode: a mutation of frozen input would also have thrown
});

// ── engine legs ───────────────────────────────────────────────────────────────

test('unknown fact codes fire nothing', () => {
  const r = analyzeAdvice({ diagnostics: [{ severity: 'info', code: 'no-such-code-xyz', message: 'x' }] });
  assert.deepEqual(r.advice, []);
  assert.deepEqual(r.summary, { total: 0, error: 0, warn: 0, info: 0 });
});

test('same code at several paths → ONE record with merged sorted unique affectedPaths', () => {
  const rules = [{
    id: 'advice-t', title: 'T', severity: 'warn', triggerCodes: ['code-x'],
    advice: 'a', fix: 'f', docUrl: 'https://code.claude.com/docs/en/x', docVersion: 'v',
  }];
  const r = analyzeAdvice({
    rules,
    diagnostics: [
      { code: 'code-x', severity: 'warn', message: '', path: '/b' },
      { code: 'code-x', severity: 'warn', message: '', path: '/a' },
      { code: 'code-x', severity: 'warn', message: '', path: '/b' }, // dup
    ],
    doctorDiagnostics: [{ code: 'code-x', severity: 'warn', message: '', path: '/c' }],
  });
  assert.equal(r.advice.length, 1);
  assert.deepEqual(r.advice[0].affectedPaths, ['/a', '/b', '/c']);
  assert.deepEqual(r.advice[0].matchedCodes, ['code-x']);
});

test('injected rules seam fully overrides the bundle (including an empty pack)', () => {
  const fact = { code: 'mcp-auth-stale', severity: 'warn', message: '', path: '/p' };
  // bundled pack fires on this code…
  assert.equal(analyzeAdvice({ diagnostics: [fact] }).advice.length, 1);
  // …but an injected pack replaces it entirely
  const custom = [{
    id: 'advice-custom', title: 'C', severity: 'info', triggerCodes: ['mcp-auth-stale'],
    advice: 'a', fix: 'f', docUrl: 'https://code.claude.com/docs/en/mcp', docVersion: 'v',
  }];
  const r = analyzeAdvice({ diagnostics: [fact], rules: custom });
  assert.deepEqual(r.advice.map((a) => a.ruleId), ['advice-custom']);
  // empty injected pack → nothing fires
  assert.deepEqual(analyzeAdvice({ diagnostics: [fact], rules: [] }).advice, []);
});

test('one rule, two matched codes sharing a path → affectedPaths has it exactly once (buildRecord dedupe)', () => {
  // Pins the per-record dedupe Set in buildRecord: indexFacts already dedupes
  // WITHIN a code, so only a shared path across TWO codes of one rule exercises it.
  const rules = [{
    id: 'advice-two-codes', title: 'T', severity: 'warn', triggerCodes: ['c1', 'c2'],
    advice: 'a', fix: 'f', docUrl: 'https://code.claude.com/docs/en/settings', docVersion: 'v',
  }];
  const r = analyzeAdvice({
    diagnostics: [
      { code: 'c1', severity: 'warn', message: '', path: '/shared' },
      { code: 'c2', severity: 'warn', message: '', path: '/shared' },
    ],
    rules,
  });
  assert.equal(r.advice.length, 1);
  assert.deepEqual(r.advice[0].affectedPaths, ['/shared']);
  assert.deepEqual(r.advice[0].matchedCodes, ['c1', 'c2']);
});

test('malformed rule entries are skipped silently; the valid one still fires', () => {
  const rules = [
    null, 42, 'junk', {},
    { id: '', title: 't', severity: 'warn', triggerCodes: ['c'], advice: 'a', fix: 'f', docUrl: 'u' }, // empty id
    { id: 'r1', title: 't', severity: 'fatal', triggerCodes: ['c'], advice: 'a', fix: 'f', docUrl: 'u' }, // bad severity
    { id: 'r2', title: 't', severity: 'warn', triggerCodes: [], advice: 'a', fix: 'f', docUrl: 'u' }, // empty triggers
    { id: 'r3', title: 't', severity: 'warn', triggerCodes: ['c', 7], advice: 'a', fix: 'f', docUrl: 'u' }, // non-string trigger
    { id: 'r4', title: 't', severity: 'warn', triggerCodes: ['c'], advice: 'a', fix: 'f', docUrl: 'u' }, // VALID (no docVersion needed)
  ];
  const r = analyzeAdvice({ rules, diagnostics: [{ code: 'c', severity: 'warn', message: '' }] });
  assert.deepEqual(r.advice.map((a) => a.ruleId), ['r4']);
  assert.equal(r.advice[0].docVersion, ''); // absent docVersion coerces to ''
});

test('severity ordering: error before warn before info, then ruleId', () => {
  const mk = (id, severity, code) => ({
    id, title: 't', severity, triggerCodes: [code], advice: 'a', fix: 'f', docUrl: 'u',
  });
  const rules = [mk('advice-z', 'info', 'c1'), mk('advice-a', 'warn', 'c2'), mk('advice-m', 'error', 'c3'), mk('advice-b', 'warn', 'c4')];
  const facts = ['c1', 'c2', 'c3', 'c4'].map((code) => ({ code, severity: 'info', message: '' }));
  const r = analyzeAdvice({ rules, diagnostics: facts });
  assert.deepEqual(r.advice.map((a) => a.ruleId), ['advice-m', 'advice-a', 'advice-b', 'advice-z']);
  assert.deepEqual(r.summary, { total: 4, error: 1, warn: 2, info: 1 });
});

test('health channel: reasons attach the component path; junk components skipped', () => {
  const rules = [{
    id: 'advice-h', title: 't', severity: 'warn', triggerCodes: ['agent-shadowing'],
    advice: 'a', fix: 'f', docUrl: 'u',
  }];
  const health = {
    components: [
      { kind: 'agent', name: 'x', path: '/cfg/agents/x.md', reasons: [{ code: 'agent-shadowing', severity: 'warn', message: '' }] },
      { kind: 'agent', name: 'noPath', reasons: [{ code: 'agent-shadowing', severity: 'warn', message: '' }] }, // path-less: fires, adds no path
      null, 7, { reasons: 'junk' }, { reasons: [null, 'x', { code: 7 }] },
    ],
  };
  const r = analyzeAdvice({ rules, health });
  assert.equal(r.advice.length, 1);
  assert.deepEqual(r.advice[0].affectedPaths, ['/cfg/agents/x.md']);
});

test('never-throws battery: junk inputs degrade to an empty (or partial) result', () => {
  const empty = { advice: [], summary: { total: 0, error: 0, warn: 0, info: 0 }, diagnostics: [] };
  assert.deepEqual(analyzeAdvice(), empty);
  assert.deepEqual(analyzeAdvice(null), empty);
  assert.deepEqual(analyzeAdvice({}), empty);
  assert.deepEqual(analyzeAdvice({ diagnostics: 'junk', doctorDiagnostics: 42, health: 'x' }), empty);
  assert.deepEqual(analyzeAdvice({ diagnostics: [null, 7, 'x', {}], health: { components: 'x' } }), empty);
  assert.deepEqual(analyzeAdvice({ rules: 'not-an-array-falls-back-to-bundle', diagnostics: [] }).advice, []);
  // hostile throwing getter → backstopped empty result, not a throw
  const hostile = {};
  Object.defineProperty(hostile, 'diagnostics', { get() { throw new Error('boom'); } });
  assert.deepEqual(analyzeAdvice(hostile), empty);
});

test('proto-key facts are handled safely (Map-keyed, no prototype pollution)', () => {
  const rules = [{
    id: 'advice-p', title: 't', severity: 'warn', triggerCodes: ['__proto__'],
    advice: 'a', fix: 'f', docUrl: 'u',
  }];
  const r = analyzeAdvice({ rules, diagnostics: [{ code: '__proto__', severity: 'warn', message: '', path: '/p' }] });
  assert.deepEqual(r.advice.map((a) => a.ruleId), ['advice-p']);
  assert.deepEqual(r.advice[0].matchedCodes, ['__proto__']);
  assert.equal(Object.prototype.polluted, undefined);
});

test('isValidAdviceRule: never throws on junk and accepts a minimal valid rule', () => {
  for (const junk of [null, undefined, 7, 'x', [], {}, { id: 'a' }]) {
    assert.equal(isValidAdviceRule(junk), false);
  }
  assert.equal(isValidAdviceRule({
    id: 'advice-ok', title: 't', severity: 'info', triggerCodes: ['c'], advice: 'a', fix: 'f', docUrl: 'u',
  }), true);
});
