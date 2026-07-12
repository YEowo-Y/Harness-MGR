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
 * GRACEFUL SKIP: runtime parity needs more than a launchable `sh`/`bash`: the
 * shell must execute the supported `node` major and expose the repo cwd in its
 * own path syntax. The selected runtime is then held to the full parity checks.
 * Incapable candidates skip only the runtime legs; structural wrapper assertions
 * always run, so capability detection cannot hide a source regression.
 *
 * WINDOWS GOTCHA (empirically verified): Git Bash and WSL map the same Windows
 * cwd differently (`/c/...` versus `/mnt/c/...`). The capability probe returns
 * `pwd -P`; runtime wrapper and fixture paths are derived from that shell-native
 * root rather than guessing a mount convention.
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
import { resolvePosixRuntime } from '../helpers/posix-shell-capability.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..'); // test/integration/ -> repo root
const SCRIPT = join(ROOT, 'harness-mgr.sh');
const CLI = join(ROOT, 'src', 'cli.mjs');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'real-snapshot');

const POSIX = resolvePosixRuntime({ cwd: ROOT });
const SHELL = POSIX?.shell ?? null;
const SHELL_ROOT = POSIX?.root?.replace(/\/$/, '') ?? '';
const SHELL_SCRIPT = `${SHELL_ROOT}/harness-mgr.sh`;
const SHELL_FIXTURE = `${SHELL_ROOT}/test/fixtures/real-snapshot`;
const NO_CAPABILITY = 'no POSIX shell with supported in-shell Node and a shell-native repo path';

/** Run the fat core directly: `node <cli> ...argv`. */
function runNode(argv, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...argv], { cwd: ROOT, encoding: 'utf8', ...opts });
}

/** Run the shell wrapper: `<shell> <scriptPath> ...argv`. */
function runShell(scriptPath, argv, opts = {}) {
  const shellArgv = argv.map((arg) => (arg === FIXTURE ? SHELL_FIXTURE : arg));
  return spawnSync(SHELL, [scriptPath, ...shellArgv], { cwd: ROOT, encoding: 'utf8', ...opts });
}

function requireRuntime(t) {
  if (POSIX) return true;
  if (process.platform === 'win32') {
    t.skip(`${NO_CAPABILITY} — skipping runtime parity`);
    return false;
  }
  assert.fail(NO_CAPABILITY);
}

// Representative argv: a read command, a usage error, completion output, and a
// two-word subcommand — covering exit codes 0 and 2 and both JSON + raw output.
const PARITY_COMMANDS = [
  { label: 'inventory json', argv: ['inventory', '--config-dir', FIXTURE, '--format', 'json'], expectStatus: 0 },
  { label: 'unknown command (usage)', argv: ['no-such-command', '--format', 'json'], expectStatus: 2 },
  { label: 'completion bash', argv: ['completion', 'bash'], expectStatus: 0 },
  { label: 'config show-effective json', argv: ['config', 'show-effective', '--config-dir', FIXTURE, '--format', 'json'], expectStatus: 0 },
];

test('harness-mgr.sh — structural: thin delegating POSIX wrapper', () => {
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
  if (!requireRuntime(t)) return;
  // From cwd:ROOT, invoke the wrapper by RELATIVE path: $0='./harness-mgr.sh',
  // dirname='.', `cd .` => ROOT, so SCRIPT_DIR resolves portably.
  const scriptRel = './harness-mgr.sh';
  for (const { label, argv, expectStatus } of PARITY_COMMANDS) {
    const nodeRun = runNode(argv);
    const shRun = runShell(scriptRel, argv);
    assert.ifError(shRun.error);
    assert.ifError(nodeRun.error);
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
  if (!requireRuntime(t)) return;
  const neutralCwd = os.tmpdir();
  // Use an ABSOLUTE --config-dir so the fixture resolves regardless of cwd; the
  // node baseline likewise runs from the neutral cwd for a true apples-to-apples
  // comparison (its output is cwd-invariant given the absolute --config-dir).
  const argv = ['inventory', '--config-dir', FIXTURE, '--format', 'json'];
  const nodeRun = runNode(argv, { cwd: neutralCwd });
  const shRun = runShell(SHELL_SCRIPT, argv, { cwd: neutralCwd });
  assert.ifError(shRun.error);
  assert.ifError(nodeRun.error);
  assert.equal(shRun.status, nodeRun.status, 'exit status must match from a neutral cwd');
  assert.equal(
    shRun.stdout, nodeRun.stdout,
    'stdout must be byte-identical from a neutral cwd (proves SCRIPT_DIR is cwd-independent)',
  );
  assert.equal(nodeRun.status, 0, 'inventory baseline exits 0');
});
