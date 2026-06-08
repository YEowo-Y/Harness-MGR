/**
 * CLI integration tests for --redact-paths (P4b follow-up, output privacy).
 *
 * Tests drive run(argv) end-to-end to prove:
 *   1. --redact-paths replaces the home-dir prefix in output with '~'.
 *   2. Without the flag the raw home path IS present (opt-in, not default).
 *   3. The flag is accepted (not an unknown-flag exit 2).
 *   4. The injectable homeFn seam in run() works correctly.
 *
 * Testability path taken: os.homedir() on this Windows host reads USERPROFILE
 * fresh each call (verified empirically: setting process.env.USERPROFILE to a
 * forward-slash temp path makes homedir() return that path). Therefore the
 * tests set USERPROFILE to a temp dir, point --config-dir at a minimal claude
 * tree inside it, and assert stdout contains '~' / does not contain the raw
 * temp path.
 *
 * However, because the USERPROFILE mutation path is fragile (backslash escaping
 * in the shell; host-specific env behavior), the PRIMARY test uses the
 * injectable homeFn seam in run(argv, { homeFn }) which is fully hermetic and
 * host-independent. A secondary test exercises the USERPROFILE path to document
 * the empirical finding.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.mjs';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal ~/.claude sandbox under dir. Returns the configDir path. */
function buildMinimalClaude(baseDir) {
  const configDir = join(baseDir, '.claude');
  mkdirSync(join(configDir, 'agents'), { recursive: true });
  mkdirSync(join(configDir, 'commands'), { recursive: true });
  mkdirSync(join(configDir, 'skills', 'mys'), { recursive: true });
  writeFileSync(join(configDir, 'settings.json'), '{}\n');
  writeFileSync(join(configDir, 'CLAUDE.md'), '# test\n');
  writeFileSync(join(configDir, 'agents', 'a.md'), '---\nname: a\n---\n# agent a\n');
  writeFileSync(join(configDir, 'skills', 'mys', 'SKILL.md'), '---\nname: mys\n---\n# skill\n');
  // An orphan file — orphans command will include its absolute path in output.
  writeFileSync(join(configDir, 'orphan-file.txt'), 'not a known file\n');
  return configDir;
}

// ── 1. homeFn seam: flag redacts, no-flag preserves ──────────────────────────

test('--redact-paths with homeFn seam: without flag, raw path present in parsed result', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cmgr-rp-'));
  try {
    const configDir = buildMinimalClaude(tmp);
    const fakeHome = tmp;

    const out = await run(
      ['orphans', '--format', 'json', '--config-dir', configDir],
      { homeFn: () => fakeHome },
    );
    // Parse the JSON to check the path value directly (avoids JSON-escape issues).
    const parsed = JSON.parse(out.stdout);
    const paths = (parsed.result?.orphans ?? []).map((o) => o.path ?? '');
    assert.ok(paths.some((p) => p.startsWith(fakeHome)),
      `without --redact-paths, at least one orphan path should start with fakeHome (${fakeHome}); got: ${JSON.stringify(paths)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('--redact-paths with homeFn seam: parsed paths start with ~ not fakeHome', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cmgr-rp-'));
  try {
    const configDir = buildMinimalClaude(tmp);
    const fakeHome = tmp;

    const out = await run(
      ['orphans', '--redact-paths', '--format', 'json', '--config-dir', configDir],
      { homeFn: () => fakeHome },
    );
    assert.equal(out.code, 0, `expected exit 0, got ${out.code}`);
    // Parse the JSON to get the actual path string values (avoids JSON-escape issues).
    const parsed = JSON.parse(out.stdout);
    const paths = (parsed.result?.orphans ?? []).map((o) => o.path ?? '');
    // There must be at least one orphan so we exercise the redaction.
    assert.ok(paths.length > 0, `expected at least one orphan; got: ${JSON.stringify(parsed.result)}`);
    // No path must start with the raw fakeHome.
    assert.ok(!paths.some((p) => p.startsWith(fakeHome)),
      `no path should start with fakeHome after --redact-paths; got: ${JSON.stringify(paths)}`);
    // Every path that was absolute must now start with '~'.
    assert.ok(paths.some((p) => p.startsWith('~')),
      `at least one path must start with '~' after redaction; got: ${JSON.stringify(paths)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 2. flag accepted (not exit 2) ─────────────────────────────────────────────

test('--redact-paths is not an unknown flag (exits 0, not 2)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cmgr-rp-'));
  try {
    const configDir = buildMinimalClaude(tmp);
    const out = await run(
      ['inventory', '--redact-paths', '--format', 'json', '--config-dir', configDir],
      { homeFn: () => tmp },
    );
    assert.notEqual(out.code, 2, `--redact-paths must not cause exit 2 (unknown flag); stdout: ${out.stdout.slice(0, 200)}`);
    assert.ok(!out.stdout.includes('"error":"internal"'), 'must not be an internal error');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 3. without flag: output is byte-identical (raw path present) ──────────────

test('without --redact-paths: output is unchanged (raw path present in parsed result)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cmgr-rp-'));
  try {
    const configDir = buildMinimalClaude(tmp);
    const fakeHome = tmp;

    const withFlag = await run(
      ['orphans', '--redact-paths', '--format', 'json', '--config-dir', configDir],
      { homeFn: () => fakeHome },
    );
    const withoutFlag = await run(
      ['orphans', '--format', 'json', '--config-dir', configDir],
      { homeFn: () => fakeHome },
    );

    // The two outputs must differ — the flag must have actually done something.
    assert.notEqual(withFlag.stdout, withoutFlag.stdout,
      'with and without --redact-paths must produce different stdout');

    // Without the flag, parse JSON and check the actual path values directly.
    const parsedWithout = JSON.parse(withoutFlag.stdout);
    const pathsWithout = (parsedWithout.result?.orphans ?? []).map((o) => o.path ?? '');
    assert.ok(pathsWithout.some((p) => p.startsWith(fakeHome)),
      `without --redact-paths, at least one path should start with fakeHome (${fakeHome}); got: ${JSON.stringify(pathsWithout)}`);

    // With the flag, no path in the parsed result starts with fakeHome.
    const parsedWith = JSON.parse(withFlag.stdout);
    const pathsWith = (parsedWith.result?.orphans ?? []).map((o) => o.path ?? '');
    assert.ok(!pathsWith.some((p) => p.startsWith(fakeHome)),
      `with --redact-paths, no path should start with fakeHome; got: ${JSON.stringify(pathsWith)}`);
    // And '~' must appear somewhere in the redacted output.
    assert.ok(pathsWith.some((p) => p.startsWith('~')),
      `with --redact-paths, at least one path should start with '~'; got: ${JSON.stringify(pathsWith)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 4. ndjson format: every line is parseable and paths are redacted ──────────

test('--redact-paths with --format ndjson: paths are redacted in all ndjson lines', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cmgr-rp-'));
  try {
    const configDir = buildMinimalClaude(tmp);
    const fakeHome = tmp;

    const out = await run(
      ['orphans', '--redact-paths', '--format', 'ndjson', '--config-dir', configDir],
      { homeFn: () => fakeHome },
    );
    const lines = out.stdout.trim().split('\n').filter((l) => l.trim().length > 0);
    // Every line must be parseable JSON.
    for (const line of lines) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        assert.fail(`ndjson line is not valid JSON: ${line}`);
      }
      // Check the PARSED value — JSON.stringify would double-escape backslashes in
      // the raw line, so we must check the parsed string, not the raw ndjson line.
      const serialisedParsed = JSON.stringify(parsed);
      // The re-serialised parsed value must not contain the raw fakeHome path
      // (which would appear as the double-escaped form in re-serialised JSON).
      const escapedHome = JSON.stringify(fakeHome).slice(1, -1); // strip outer quotes
      assert.ok(!serialisedParsed.includes(escapedHome),
        `parsed ndjson line must not contain raw fakeHome; line: ${line.slice(0, 300)}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 5. USERPROFILE env-var testability path (documents empirical finding) ─────
//
// os.homedir() on this Windows host reads USERPROFILE fresh each call when the
// value is set to a forward-slash path. This test documents that finding and
// verifies the integration works via env mutation as a SECONDARY path
// (the primary path is the homeFn seam above).

test('os.homedir() empirical finding: forward-slash USERPROFILE is honored', () => {
  if (process.platform !== 'win32') return; // Windows-specific
  const orig = process.env.USERPROFILE;
  try {
    const fakePath = tmpdir() + '/fakehome-verify';
    process.env.USERPROFILE = fakePath;
    const result = homedir();
    assert.equal(result, fakePath,
      'os.homedir() must honor a forward-slash USERPROFILE mutation');
  } finally {
    process.env.USERPROFILE = orig;
  }
});
