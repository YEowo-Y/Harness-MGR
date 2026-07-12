/**
 * Secret redaction for `config diff` (both modes) — defect-audit 2026-07-10 follow-up.
 *
 * `config diff` line-diffs raw config TEXT. Unlike `config show-effective` (which emits
 * {redacted, sha256} per threat-model §5.3), the diff previously printed secret VALUES
 * verbatim: a URL userinfo password, a Bearer token, a self-identifying token, or a PEM
 * block sitting in a settings.json / config.toml flowed straight onto the diff output —
 * i.e. onto the same TUI/Web display surface. The maintainer chose to redact BOTH modes
 * (file mode AND snapshot-content mode), consistent with show-effective.
 *
 * These are OUTPUT-surface oracles: raw text determines change semantics, stats, and
 * hunks; only the displayed line text is redacted. The raw secret substring must be
 * ABSENT from the unified diff AND structured hunks, while a secret-only rotation must
 * remain observable as one deletion plus one insertion.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { configDiffCommand } from '../src/cli/config-diff-command.mjs';
import { diffSnapshots } from '../src/ops/snapshot-diff.mjs';

// ── helpers ──────────────────────────────────────────────────────────────────────

function makeCtx(positionals = [], extra = {}) {
  return {
    configDir: '/fake/claude',
    mgrStateDir: '/fake/claude/.mgr-state',
    args: Object.assign(Object.create(null), { positionals, ...extra }),
  };
}

/** A readFn seam mapping a path string → its canned content. */
function cannedReader(map) {
  return (path) => (Object.prototype.hasOwnProperty.call(map, path) ? { text: map[path] } : { error: 'ENOENT' });
}

/** Assert a diff result never leaks `secret` and does show the `<redacted>` marker. */
function assertRedacted(result, secret) {
  const blob = JSON.stringify(result); // covers unified + hunks + every string leaf
  assert.ok(!blob.includes(secret), `raw secret "${secret}" must not appear anywhere in the diff result`);
  assert.ok(result.unified.includes('<redacted>'), `unified diff should contain the <redacted> marker, got:\n${result.unified}`);
}

// A URL userinfo password and a Bearer token — both high-confidence shapes the
// redactor recognises (URL_USERINFO_RE / BEARER_RE in redact-secrets-text.mjs).
const URL_SECRET = 'hunter2SuperSecretPw';
const BEARER_SECRET = 'AbCdEf0123456789ZyXwVu'; // ≥16 token chars

// ── FILE MODE ─────────────────────────────────────────────────────────────────────

test('file mode: a URL-userinfo password on an added line is redacted, not leaked', async () => {
  const a = '{\n  "name": "app"\n}\n';
  const b = `{\n  "name": "app",\n  "db": "postgres://admin:${URL_SECRET}@db.example.com/prod"\n}\n`;
  const out = await configDiffCommand(makeCtx(['/A', '/B']), { readFn: cannedReader({ '/A': a, '/B': b }), cwd: '/' });
  assert.equal(out.code, 0);
  assert.equal(out.result.changed, true);
  assertRedacted(out.result, URL_SECRET);
  // The benign surrounding structure still diffs normally (not over-redacted).
  assert.ok(out.result.unified.includes('db.example.com'), 'the non-secret host is preserved');
});

test('file mode: a Bearer token on an added line is redacted, not leaked', async () => {
  const a = 'headers:\n';
  const b = `headers:\n  Authorization: Bearer ${BEARER_SECRET}\n`;
  const out = await configDiffCommand(makeCtx(['/A', '/B']), { readFn: cannedReader({ '/A': a, '/B': b }), cwd: '/' });
  assert.equal(out.code, 0);
  assertRedacted(out.result, BEARER_SECRET);
});

test('file mode: secret-only rotations keep raw stats while unified and structured output stay safe', async () => {
  const cases = [
    {
      name: 'URL userinfo', oldValue: 'oldUrlSecret123', newValue: 'newUrlSecret456',
      a: 'db=postgres://admin:oldUrlSecret123@db.example.com/prod',
      b: 'db=postgres://admin:newUrlSecret456@db.example.com/prod',
      safe: 'db=postgres://<redacted>@db.example.com/prod',
    },
    {
      name: 'JSON camelCase key', oldValue: 'oldOpaqueJsonValue123', newValue: 'newOpaqueJsonValue456',
      a: '{"apiKey":"oldOpaqueJsonValue123"}', b: '{"apiKey":"newOpaqueJsonValue456"}',
      safe: '{"apiKey":"<redacted>"}',
    },
    {
      name: 'YAML key', oldValue: 'oldOpaqueYamlValue123', newValue: 'newOpaqueYamlValue456',
      a: 'password: oldOpaqueYamlValue123', b: 'password: newOpaqueYamlValue456',
      safe: 'password: <redacted>',
    },
    {
      name: 'TOML key', oldValue: 'oldOpaqueTomlValue123', newValue: 'newOpaqueTomlValue456',
      a: 'api_key = "oldOpaqueTomlValue123"', b: 'api_key = "newOpaqueTomlValue456"',
      safe: 'api_key = "<redacted>"',
    },
    {
      name: 'compact TOML key', oldValue: 'oldCompactTomlValue123', newValue: 'newCompactTomlValue456',
      a: 'api_key="oldCompactTomlValue123"', b: 'api_key="newCompactTomlValue456"',
      safe: 'api_key="<redacted>"',
    },
    {
      name: 'quoted compact TOML key', oldValue: 'oldQuotedTomlValue123', newValue: 'newQuotedTomlValue456',
      a: '"api_key"="oldQuotedTomlValue123"', b: '"api_key"="newQuotedTomlValue456"',
      safe: '"api_key"="<redacted>"',
    },
    {
      name: 'JSON acronym key', oldValue: 'oldAcronymJsonValue123', newValue: 'newAcronymJsonValue456',
      a: '{"APIKey":"oldAcronymJsonValue123"}', b: '{"APIKey":"newAcronymJsonValue456"}',
      safe: '{"APIKey":"<redacted>"}',
    },
    {
      name: 'JSON sensitive container', oldValue: 'OLD_CONTAINER_SECRET', newValue: 'NEW_CONTAINER_SECRET',
      a: '{"token":["OLD_CONTAINER_SECRET","SECOND_OLD_SECRET"]}',
      b: '{"token":["NEW_CONTAINER_SECRET","SECOND_NEW_SECRET"]}',
      safe: '<redacted>',
    },
    {
      name: 'YAML sequence key', oldValue: 'oldYamlListValue123', newValue: 'newYamlListValue456',
      a: '- password: oldYamlListValue123', b: '- password: newYamlListValue456',
      safe: '- password: <redacted>',
    },
    {
      name: 'plural credential key', oldValue: 'oldCredentialsValue123', newValue: 'newCredentialsValue456',
      a: 'credentials: oldCredentialsValue123', b: 'credentials: newCredentialsValue456',
      safe: 'credentials: <redacted>',
    },
    {
      name: 'YAML quoted command secret', oldValue: 'oldCommandSecret123', newValue: 'newCommandSecret456',
      a: 'command: tool --token="oldCommandSecret123"',
      b: 'command: tool --token="newCommandSecret456"',
      safe: 'command: tool --token="<redacted>"',
    },
    {
      name: 'JSON-escaped quoted command secret',
      oldValue: 'oldJsonCommandSecret123', newValue: 'newJsonCommandSecret456',
      a: String.raw`{"command":"tool --token=\"oldJsonCommandSecret123\""}`,
      b: String.raw`{"command":"tool --token=\"newJsonCommandSecret456\""}`,
      safe: '<redacted>',
    },
    {
      name: 'unclosed quoted command value with a space',
      oldValue: 'OLD_UNCLOSED_SECRET_SUFFIX', newValue: 'NEW_UNCLOSED_SECRET_SUFFIX',
      a: 'tool --token="LEFT OLD_UNCLOSED_SECRET_SUFFIX',
      b: 'tool --token="RIGHT NEW_UNCLOSED_SECRET_SUFFIX',
      safe: '<redacted>',
    },
    {
      name: 'backslash-escaped command value space',
      oldValue: 'OLD_ESCAPED_SPACE_SECRET', newValue: 'NEW_ESCAPED_SPACE_SECRET',
      a: String.raw`tool --token=LEFT\ OLD_ESCAPED_SPACE_SECRET`,
      b: String.raw`tool --token=RIGHT\ NEW_ESCAPED_SPACE_SECRET`,
      safe: '<redacted>',
    },
    {
      name: 'nested JSON sensitive key',
      oldValue: 'NESTED_OLD_SECRET', newValue: 'NESTED_NEW_SECRET',
      a: '{"config":{"token":"NESTED_OLD_SECRET"}}',
      b: '{"config":{"token":"NESTED_NEW_SECRET"}}',
      safe: '<redacted>',
    },
    {
      name: 'unicode-escaped JSON sensitive key',
      oldValue: 'ESCAPED_OLD_SECRET', newValue: 'ESCAPED_NEW_SECRET',
      a: String.raw`{"API\u004bey":"ESCAPED_OLD_SECRET"}`,
      b: String.raw`{"API\u004bey":"ESCAPED_NEW_SECRET"}`,
      safe: String.raw`{"API\u004bey":"<redacted>"}`,
    },
  ];

  for (const c of cases) {
    const out = await configDiffCommand(
      makeCtx(['/A', '/B'], { context: 0 }),
      { readFn: cannedReader({ '/A': c.a, '/B': c.b }), cwd: '/' },
    );
    assert.equal(out.code, 0, c.name);
    assert.equal(out.result.changed, true, c.name);
    assert.deepEqual(out.result.stats, { added: 1, deleted: 1, unchanged: 0 }, c.name);
    assert.deepEqual(out.result.hunks, [{
      aStart: 1, aCount: 1, bStart: 1, bCount: 1,
      lines: [
        { type: 'delete', text: c.safe },
        { type: 'insert', text: c.safe },
      ],
    }], c.name);
    const blob = JSON.stringify(out.result);
    assert.ok(!blob.includes(c.oldValue), `${c.name}: old value leaked`);
    assert.ok(!blob.includes(c.newValue), `${c.name}: new value leaked`);
    assert.match(out.result.unified, /^-.*<redacted>.*$/m, c.name);
    assert.match(out.result.unified, /^\+.*<redacted>.*$/m, c.name);
  }
});

test('file mode: benign sensitive-looking names are NOT over-redacted', async () => {
  const cases = [
    ['color: red', 'color: blue'],
    ['{"publicKey":"id-a.pub"}', '{"publicKey":"id-b.pub"}'],
    ['public_key = "id-a.pub"', 'public_key = "id-b.pub"'],
    ['key-id: build-a', 'key-id: build-b'],
    ['monkey: capuchin', 'monkey: macaque'],
  ];
  for (const [a, b] of cases) {
    const out = await configDiffCommand(
      makeCtx(['/A', '/B'], { context: 0 }),
      { readFn: cannedReader({ '/A': a, '/B': b }), cwd: '/' },
    );
    assert.equal(out.result.changed, true, `${a} -> ${b}`);
    assert.ok(out.result.unified.includes(`-${a}`), out.result.unified);
    assert.ok(out.result.unified.includes(`+${b}`), out.result.unified);
    assert.ok(!JSON.stringify(out.result).includes('<redacted>'), `benign lines must stay visible: ${a}`);
  }
});

// ── SNAPSHOT CONTENT MODE ──────────────────────────────────────────────────────────

const STATE = '/abs/.mgr-state';
const ID_A = '2026-07-10T00-00-00Z';
const ID_B = '2026-07-10T01-00-00Z';
const RELPATH = 'settings.json';

/** Content-mode seams feeding two text versions without a real tar (mirrors ops-snapshot-diff.test.mjs). */
function contentSeams({ textA, textB }) {
  const order = [];
  const dirText = new Map();
  const memberAbs = (dir) => resolve(join(dir, ...RELPATH.split('/')));
  let dirN = 0;
  return {
    resolveFn: () => ({ tarPath: '/abs/tar', diagnostics: [] }),
    tmpRootFn: () => { const dir = `/tmp/diffredact-${dirN}`; order.push(dir); dirN += 1; return dir; },
    extractFn: async ({ destDir }) => {
      dirText.set(memberAbs(destDir), order.indexOf(destDir) === 0 ? textA : textB);
      return { ok: true, diagnostics: [] };
    },
    readFileFn: (abs) => {
      const t = dirText.get(abs);
      if (t === undefined) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return t;
    },
    rmFn: () => {},
  };
}

// ── LARGE FILE (past the redactor's 64 KiB per-string cap) ──────────────────────────

test('file mode: a secret PAST the 64 KiB cap is still redacted (per-line, not whole-file)', async () => {
  // redactSecretsInString returns a >64 KiB string UNCHANGED (cost backstop). Applying it to
  // the WHOLE file would leak every secret in a large config; per-line redaction bounds the
  // cap to one line, so the secret is still redacted regardless of file size.
  const filler = Array.from({ length: 1200 }, (_, i) => `setting_${i} = value_${i}`).join('\n'); // ~30 KiB × … > 64 KiB
  const big = `${filler}\n${filler}\n${filler}`; // comfortably over 64 KiB
  const a = `${big}\n`;
  const b = `${big}\n"db": "postgres://admin:${URL_SECRET}@db.example.com/prod"\n`;
  assert.ok(a.length > 64 * 1024, 'precondition: input exceeds the 64 KiB cap');
  const out = await configDiffCommand(makeCtx(['/A', '/B']), { readFn: cannedReader({ '/A': a, '/B': b }), cwd: '/' });
  assert.equal(out.code, 0);
  assertRedacted(out.result, URL_SECRET);
});

test('file mode: an over-cap single-line diff fails closed with bounded output', async () => {
  const secret = `ghp_${'A'.repeat(36)}`;
  const padding = 'x'.repeat(70 * 1024);
  const a = `{"padding":"${padding}","mode":"old"}`;
  const b = `{"padding":"${padding}","token":"${secret}"}`;
  const out = await configDiffCommand(
    makeCtx(['/A', '/B'], { context: 0 }),
    { readFn: cannedReader({ '/A': a, '/B': b }), cwd: '/' },
  );
  assert.equal(out.result.changed, true);
  assert.deepEqual(out.result.stats, { added: 1, deleted: 1, unchanged: 0 });
  assert.deepEqual(out.result.hunks[0].lines, [
    { type: 'delete', text: '<redacted>' },
    { type: 'insert', text: '<redacted>' },
  ]);
  assert.ok(!JSON.stringify(out.result).includes(secret), 'the token must not leak');
  assert.ok(out.result.unified.length < 1024, 'unified output must be bounded');
  assert.ok(JSON.stringify(out.result.hunks).length < 1024, 'structured output must be bounded');
});

test('snapshot content mode: a URL-userinfo password is redacted in the diff', async () => {
  const seams = contentSeams({
    textA: '{\n  "name": "app"\n}\n',
    textB: `{\n  "name": "app",\n  "db": "postgres://admin:${URL_SECRET}@db.example.com/prod"\n}\n`,
  });
  const r = await diffSnapshots({
    mgrStateDir: STATE, idA: ID_A, idB: ID_B, relpath: RELPATH,
    resolveFn: seams.resolveFn, tmpRootFn: seams.tmpRootFn,
    extractFn: seams.extractFn, readFileFn: seams.readFileFn, rmFn: seams.rmFn,
  });
  assert.equal(r.mode, 'content');
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assertRedacted(r, URL_SECRET);
});

test('snapshot content mode: a CRLF PEM-body rotation keeps raw line semantics and redacts the whole block', async () => {
  const textA = 'before\r\n-----BEGIN PRIVATE KEY-----\r\nOLD_BODY_SENTINEL\r\nCOMMON\r\n-----END PRIVATE KEY-----\r\nafter\r\n';
  const textB = textA.replace('OLD_BODY_SENTINEL', 'NEW_BODY_SENTINEL');
  const seams = contentSeams({ textA, textB });
  const r = await diffSnapshots({
    mgrStateDir: STATE, idA: ID_A, idB: ID_B, relpath: RELPATH, context: 0,
    resolveFn: seams.resolveFn, tmpRootFn: seams.tmpRootFn,
    extractFn: seams.extractFn, readFileFn: seams.readFileFn, rmFn: seams.rmFn,
  });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.deepEqual(r.stats, { added: 1, deleted: 1, unchanged: 6 });
  assert.deepEqual(r.hunks, [{
    aStart: 3, aCount: 1, bStart: 3, bCount: 1,
    lines: [
      { type: 'delete', text: '<redacted>' },
      { type: 'insert', text: '<redacted>' },
    ],
  }]);
  assert.equal(
    r.unified,
    `--- ${ID_A}:${RELPATH}\n+++ ${ID_B}:${RELPATH}\n@@ -3,1 +3,1 @@\n-<redacted>\n+<redacted>`,
  );
  const blob = JSON.stringify(r);
  assert.ok(!blob.includes('OLD_BODY_SENTINEL'));
  assert.ok(!blob.includes('NEW_BODY_SENTINEL'));
});

test('file mode: PEM state on only one side still redacts an equal context line', async () => {
  const body = 'PEM_BODY_CONTEXT_SENTINEL';
  const a = `before\n${body}\nafter`;
  const b = `before\n-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\nafter`;
  const out = await configDiffCommand(
    makeCtx(['/A', '/B']),
    { readFn: cannedReader({ '/A': a, '/B': b }), cwd: '/' },
  );
  assert.equal(out.result.changed, true);
  assert.ok(!JSON.stringify(out.result).includes(body), 'equal hunk context must use the safer side');
  assert.equal(out.result.hunks[0].lines[2].text, '<redacted>');
});
