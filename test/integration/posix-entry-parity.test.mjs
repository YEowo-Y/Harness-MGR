/**
 * P4b.U12 — POSIX entry-point parity (`harness-mgr.sh`).
 *
 * Proves `harness-mgr.sh` is a BEHAVIOR-EXACT POSIX parity of `node src/cli.mjs`
 * — the DoD bar for U12: "runs on WSL / macOS / Linux fixture; matches the
 * `harness-mgr.ps1` behavior." The shell wrapper is a THIN delegator:
 *
 *     SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
 *     exec node "$SCRIPT_DIR/src/cli.mjs" "$@"
 *
 * so for any argv the wrapper's stdout and exit status MUST be byte-for-byte
 * identical to invoking the fat core directly. We assert that on a set of
 * representative read/usage/completion commands, plus a cwd-INDEPENDENCE leg
 * (run from a neutral cwd with the script passed by absolute path — proving
 * `SCRIPT_DIR` resolves correctly regardless of where the caller stands).
 *
 * GRACEFUL SKIP: when no POSIX shell (`sh`/`bash`) resolves on this host (a
 * pure-Windows CI box without Git Bash / WSL), every leg `t.skip`s cleanly so
 * the suite stays green — the `.sh` wrapper is simply not exercisable there.
 *
 * WINDOWS GOTCHA (empirically verified): POSIX `dirname` on a BACKSLASH Windows
 * path (`C:\Dev\...\harness-mgr.sh`) returns "." (there is no `/` separator),
 * which would break `SCRIPT_DIR`. So when this test hands the shell an ABSOLUTE
 * script path on win32 it converts `C:\Dev\Projects\harness-mgr\harness-mgr.sh`
 * → `/c/Dev/Projects/harness-mgr/harness-mgr.sh` (lowercase drive letter,
 * backslashes → forward slashes — the MSYS/Git-Bash mount form). On POSIX
 * platforms the native absolute path is used as-is.
 *
 * TEST-ONLY: no `src/` changes, no `harness-mgr.sh` changes, never writes to any
 * governed config (every command is read / usage / completion; no `--apply`,
 * no `HARNESS_MGR_ENABLE_WRITES`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..'); // test/integration/ -> repo root
const SCRIPT = join(ROOT, 'harness-mgr.sh');
const CLI = join(ROOT, 'src', 'cli.mjs');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'real-snapshot');

/**
 * Convert a Windows absolute path to the MSYS / Git-Bash mount form that a
 * POSIX shell on win32 understands, e.g.
 *   C:\Dev\Projects\harness-mgr\harness-mgr.sh -> /c/Dev/Projects/harness-mgr/harness-mgr.sh
 * On non-win32 platforms the path is already POSIX — returned unchanged.
 */
function toPosixAbs(p) {
  if (process.platform !== 'win32') return p;
  return p.replace(/^([A-Za-z]):/, (_m, d) => '/' + d.toLowerCase()).replace(/\\/g, '/');
}

/**
 * Resolve a usable POSIX shell. Probes `sh` then `bash` with a no-op `-c 'exit 0'`.
 * Returns the first launcher whose spawn did not error (ENOENT etc.), or null.
 */
function resolvePosixShell() {
  for (const shell of ['sh', 'bash']) {
    const probe = spawnSync(shell, ['-c', 'exit 0'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return shell;
  }
  return null;
}

const SHELL = resolvePosixShell();

/** Run the fat core directly: `node <cli> ...argv`. */
function runNode(argv, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...argv], { cwd: ROOT, encoding: 'utf8', ...opts });
}

/** Run the shell wrapper: `<shell> <scriptPath> ...argv`. */
function runShell(scriptPath, argv, opts = {}) {
  return spawnSync(SHELL, [scriptPath, ...argv], { cwd: ROOT, encoding: 'utf8', ...opts });
}

// Representative argv: a read command, a usage error, completion output, and a
// two-word subcommand — covering exit codes 0 and 2 and both JSON + raw output.
const PARITY_COMMANDS = [
  { label: 'inventory json', argv: ['inventory', '--config-dir', FIXTURE, '--format', 'json'], expectStatus: 0 },
  { label: 'unknown command (usage)', argv: ['no-such-command', '--format', 'json'], expectStatus: 2 },
  { label: 'completion bash', argv: ['completion', 'bash'], expectStatus: 0 },
  { label: 'config show-effective json', argv: ['config', 'show-effective', '--config-dir', FIXTURE, '--format', 'json'], expectStatus: 0 },
];

test('harness-mgr.sh — structural: thin delegating POSIX wrapper', (t) => {
  if (!SHELL) { t.skip('no POSIX shell (sh/bash) — skipping .sh parity'); return; }
  const src = readFileSync(SCRIPT, 'utf8');
  assert.ok(src.startsWith('#!'), 'script must begin with a #! shebang');
  assert.match(src, /exec node/, 'script must exec node');
  assert.match(src, /src\/cli\.mjs/, 'script must invoke src/cli.mjs');
  assert.match(src, /"\$@"/, 'script must forward all args via "$@"');
  // Reject ANY errexit form (`set -e`, `set -eu`, `set -euo pipefail`, `set -o errexit`)
  // — a non-zero CLI exit must PROPAGATE, not abort the wrapper early. (The leading-`#`
  // comment in the script that mentions `set -e` is not matched: `^\s*set` needs the line
  // to start with `set`, not `#`.)
  assert.ok(
    !/^\s*set\s+(-[a-z]*e[a-z]*|-o\s+errexit)\b/m.test(src),
    'script must NOT enable errexit (set -e / -eu / -o errexit) — the CLI exit code must propagate',
  );
});

test('harness-mgr.sh — core parity: byte-identical stdout + exit code vs `node src/cli.mjs`', (t) => {
  if (!SHELL) { t.skip('no POSIX shell (sh/bash) — skipping .sh parity'); return; }
  // From cwd:ROOT, invoke the wrapper by RELATIVE path: $0='./harness-mgr.sh',
  // dirname='.', `cd .` => ROOT, so SCRIPT_DIR resolves portably.
  const scriptRel = './harness-mgr.sh';
  for (const { label, argv, expectStatus } of PARITY_COMMANDS) {
    const nodeRun = runNode(argv);
    const shRun = runShell(scriptRel, argv);
    if (shRun.error) { t.skip(`shell launch failed for "${label}": ${shRun.error.message}`); return; }
    if (nodeRun.error) { t.skip(`node launch failed for "${label}": ${nodeRun.error.message}`); return; }
    assert.equal(
      shRun.stdout, nodeRun.stdout,
      `stdout must be byte-identical for "${label}"`,
    );
    assert.equal(
      shRun.status, nodeRun.status,
      `exit status must match for "${label}"`,
    );
    // Sanity-check the expected code so a both-broken-the-same regression
    // (e.g. both crash to 2) can't pass via stdout-equality alone.
    assert.equal(nodeRun.status, expectStatus, `node baseline exit code for "${label}"`);
  }
});

test('harness-mgr.sh — cwd-independence: SCRIPT_DIR resolves from a neutral cwd via absolute path', (t) => {
  if (!SHELL) { t.skip('no POSIX shell (sh/bash) — skipping .sh parity'); return; }
  const neutralCwd = os.tmpdir();
  const scriptAbs = toPosixAbs(SCRIPT);
  // Use an ABSOLUTE --config-dir so the fixture resolves regardless of cwd; the
  // node baseline likewise runs from the neutral cwd for a true apples-to-apples
  // comparison (its output is cwd-invariant given the absolute --config-dir).
  const argv = ['inventory', '--config-dir', FIXTURE, '--format', 'json'];
  const nodeRun = runNode(argv, { cwd: neutralCwd });
  const shRun = runShell(scriptAbs, argv, { cwd: neutralCwd });
  if (shRun.error) { t.skip(`shell launch failed (abs path "${scriptAbs}"): ${shRun.error.message}`); return; }
  if (nodeRun.error) { t.skip(`node launch failed from neutral cwd: ${nodeRun.error.message}`); return; }
  assert.equal(shRun.status, nodeRun.status, 'exit status must match from a neutral cwd');
  assert.equal(
    shRun.stdout, nodeRun.stdout,
    'stdout must be byte-identical from a neutral cwd (proves SCRIPT_DIR is cwd-independent)',
  );
  assert.equal(nodeRun.status, 0, 'inventory baseline exits 0');
});
