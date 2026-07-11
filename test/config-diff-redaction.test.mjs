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
 * These are OUTPUT-surface oracles: the raw secret substring must be ABSENT from the
 * unified diff AND the structured hunks, and the `<redacted>` marker must be PRESENT.
 * Secrets are placed on ADDED lines so they surface as `+` lines (a rotated secret on a
 * changed line would redact to an identical `<redacted>` on both sides → no diff body,
 * which is the desired non-leak but not an observable oracle).
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

test('file mode: a benign change is NOT over-redacted (no false positive)', async () => {
  const out = await configDiffCommand(
    makeCtx(['/A', '/B']),
    { readFn: cannedReader({ '/A': 'color: red\n', '/B': 'color: blue\n' }), cwd: '/' },
  );
  assert.equal(out.result.changed, true);
  assert.ok(out.result.unified.includes('-color: red'));
  assert.ok(out.result.unified.includes('+color: blue'));
  assert.ok(!out.result.unified.includes('<redacted>'), 'benign lines must not be redacted');
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
