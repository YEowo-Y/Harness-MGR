/**
 * P3.U7 — snapshot-tar.mjs PURE unit tests.
 *
 * No real tar is spawned here: every spawning path uses an injected spawnFn, and
 * the security-gate assertions reconstruct the EXACT schema the module builds and
 * run it through the pure validateSpawnSpec (the same gate safeSpawn uses before
 * execFile). The real-tar byte-identical round-trip lives in
 * test/integration/snapshot-tar-roundtrip.test.mjs.
 *
 * The file list is passed to tar as DIRECT ARGV (not a `-T` list file) because
 * Windows bsdtar's list-file reader cannot decode unicode names — see the module
 * header. So these tests assert the argv shape `-c -f <archive> -C <baseDir> ...`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSpawnSpec } from '../src/lib/safe-spawn.mjs';
import {
  resolveTar, probeTarVersion, createSnapshotTar, extractSnapshotTar,
} from '../src/ops/snapshot-tar.mjs';

const TAR = 'C:\\Windows\\System32\\tar.exe';
const CWD = 'C:\\Users\\me\\AppData\\Local\\Temp';

/**
 * A recording spawn seam. Captures the spec it was called with and resolves /
 * rejects per the configured outcome, so we can both (a) assert the constructed
 * argv/schema and (b) exercise success / failure branches.
 */
function makeSpawn(outcome) {
  const calls = [];
  const fn = (spec) => {
    calls.push(spec);
    if (outcome.throw) return Promise.reject(outcome.throw);
    return Promise.resolve({ stdout: outcome.stdout ?? '', stderr: outcome.stderr ?? '' });
  };
  fn.calls = calls;
  return fn;
}

// ── (1) the security gate is wired: the constructed spec passes for legit inputs
//        and is REJECTED for injected malicious args ────────────────────────────

test('gate: createSnapshotTar builds a spec that passes validateSpawnSpec', async () => {
  const spawnFn = makeSpawn({ stdout: '' });
  const res = await createSnapshotTar({
    tarPath: TAR,
    archivePath: 'C:\\t\\snap.tar',
    baseDir: 'C:\\Users\\me\\.claude',
    files: ['skills/a/SKILL.md', 'agents/b.md'],
    cwd: CWD,
    spawnFn,
  });
  assert.equal(res.ok, true);
  assert.equal(spawnFn.calls.length, 1);
  const spec = spawnFn.calls[0];
  // Direct-argv create: the relative file paths are positionals after -C <baseDir>.
  assert.deepEqual(spec.args, ['-c', '-f', 'C:\\t\\snap.tar', '-C', 'C:\\Users\\me\\.claude', 'skills/a/SKILL.md', 'agents/b.md']);
  assert.equal(spec.shell, undefined, 'never shell:true');
  // maxArgs is the exact argv length (tight bound).
  assert.equal(spec.schema.maxArgs, spec.args.length);
  // The spec the module built must pass the REAL gate.
  assert.doesNotThrow(() => validateSpawnSpec(spec));
});

test('gate: extractSnapshotTar builds a spec that passes validateSpawnSpec', async () => {
  const spawnFn = makeSpawn({ stdout: '' });
  const res = await extractSnapshotTar({
    tarPath: TAR, archivePath: 'C:\\t\\snap.tar', destDir: 'C:\\dest', cwd: CWD, spawnFn,
  });
  assert.equal(res.ok, true);
  const spec = spawnFn.calls[0];
  assert.deepEqual(spec.args, ['-x', '-f', 'C:\\t\\snap.tar', '-C', 'C:\\dest']);
  assert.equal(spec.schema.maxArgs, spec.args.length);
  assert.doesNotThrow(() => validateSpawnSpec(spec));
});

test('gate: an option-injection arg is REJECTED by the module schema', async () => {
  // Reuse the schema the module attaches to its real calls, then feed it a
  // malicious arg through validateSpawnSpec to PROVE the gate blocks it. The
  // schema must admit enough argv for these synthetic specs, so use a generous one
  // matching the module's pattern/flags (maxArgs widened to isolate the gate logic
  // under test from the length cap).
  const spawnFn = makeSpawn({ stdout: '' });
  await createSnapshotTar({
    tarPath: TAR, archivePath: 'C:\\t\\a.tar', baseDir: 'C:\\b', files: ['x'], cwd: CWD, spawnFn,
  });
  const base = spawnFn.calls[0].schema;
  const schema = { allowedFlags: base.allowedFlags, positionalPattern: base.positionalPattern, maxArgs: 16 };

  // tar option-injection (the classic --checkpoint-action=exec=...) → flag-not-allowed
  assert.throws(
    () => validateSpawnSpec({ exe: TAR, args: ['-c', '-f', 'C:\\t\\a.tar', '--checkpoint-action=exec=calc', 'x'], cwd: CWD, allowedCwds: [CWD], schema }),
    (e) => e.code === 'spawn-flag-not-allowed',
  );
  // a newline-laden member path → positional-rejected (control char in the class)
  assert.throws(
    () => validateSpawnSpec({ exe: TAR, args: ['-c', '-f', 'C:\\t\\a.tar', '-C', 'C:\\b', 'evil\nrm -rf /'], cwd: CWD, allowedCwds: [CWD], schema }),
    (e) => e.code === 'spawn-positional-rejected',
  );
  // a Windows mutation /flag → flag-not-allowed (no allowSlashPositionals)
  assert.throws(
    () => validateSpawnSpec({ exe: TAR, args: ['-c', '-f', 'C:\\t\\a.tar', '/grant', 'x'], cwd: CWD, allowedCwds: [CWD], schema }),
    (e) => e.code === 'spawn-flag-not-allowed',
  );
  // a -z codec flag is NOT allowlisted → flag-not-allowed
  assert.throws(
    () => validateSpawnSpec({ exe: TAR, args: ['-c', '-z', '-f', 'C:\\t\\a.tar', 'x'], cwd: CWD, allowedCwds: [CWD], schema }),
    (e) => e.code === 'spawn-flag-not-allowed',
  );
  // a pipe metacharacter in a member path → positional-rejected
  assert.throws(
    () => validateSpawnSpec({ exe: TAR, args: ['-c', '-f', 'C:\\t\\a.tar', '-C', 'C:\\b', 'x|calc'], cwd: CWD, allowedCwds: [CWD], schema }),
    (e) => e.code === 'spawn-positional-rejected',
  );
  // a command-substitution metacharacter in a member path → positional-rejected
  assert.throws(
    () => validateSpawnSpec({ exe: TAR, args: ['-c', '-f', 'C:\\t\\a.tar', '-C', 'C:\\b', 'x$(calc)'], cwd: CWD, allowedCwds: [CWD], schema }),
    (e) => e.code === 'spawn-positional-rejected',
  );
});

test('gate: a malicious file entry is REJECTED end-to-end (createSnapshotTar real gate)', async () => {
  // Use the REAL safeSpawn (no injected spawnFn): a member with a newline must be
  // rejected by the gate BEFORE any spawn — never throws, returns a diagnostic.
  const res = await createSnapshotTar({
    tarPath: TAR, archivePath: 'C:\\t\\a.tar', baseDir: 'C:\\b',
    files: ['ok.md', 'evil\nname.md'], cwd: CWD,
  });
  assert.equal(res.ok, false);
  // The newline trips the spawn gate's positionalPattern → surfaced as tar-create-failed.
  assert.equal(res.diagnostics[0].code, 'tar-create-failed');
  assert.match(res.diagnostics[0].message, /positional rejected/);
});

// ── (2) resolveTar with injected seams (System32 preference / PATH / not-found) ─

/** A statFn that reports the System32 tar is ABSENT (forces the PATH fallback). */
const noSystem32 = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };

test('resolveTar: win32 prefers System32 bsdtar (statFn finds it) without touching PATH', () => {
  let pathSearched = false;
  const resolveFn = () => { pathSearched = true; return { resolved: true, path: 'C:\\Program Files\\Git\\usr\\bin\\tar.exe' }; };
  const res = resolveTar({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, resolveFn, statFn: () => ({}) });
  assert.equal(res.tarPath, 'C:\\Windows\\System32\\tar.exe');
  assert.equal(res.diagnostics.length, 0);
  assert.equal(pathSearched, false, 'PATH search is skipped when System32 tar exists');
});

test('resolveTar: win32 honors a custom %SystemRoot% for the System32 probe', () => {
  const res = resolveTar({ platform: 'win32', env: { SystemRoot: 'D:\\WinDir' }, resolveFn: () => ({ resolved: false, path: null }), statFn: () => ({}) });
  assert.equal(res.tarPath, 'D:\\WinDir\\System32\\tar.exe');
});

test('resolveTar: win32 with no SystemRoot env falls back to C:\\Windows for the probe', () => {
  const res = resolveTar({ platform: 'win32', env: {}, resolveFn: () => ({ resolved: false, path: null }), statFn: () => ({}) });
  assert.equal(res.tarPath, 'C:\\Windows\\System32\\tar.exe');
});

test('resolveTar: found on PATH (no System32) → returns the resolved path', () => {
  const resolveFn = () => ({ resolved: true, path: TAR });
  const res = resolveTar({ platform: 'win32', resolveFn, statFn: noSystem32 });
  assert.equal(res.tarPath, TAR);
  assert.equal(res.diagnostics.length, 0);
});

test('resolveTar: non-win32 skips the System32 probe and uses PATH', () => {
  let probed = false;
  const resolveFn = () => ({ resolved: true, path: '/usr/bin/tar' });
  const res = resolveTar({ platform: 'linux', resolveFn, statFn: () => { probed = true; return {}; } });
  assert.equal(res.tarPath, '/usr/bin/tar');
  assert.equal(probed, false, 'System32 probe must not run off win32');
});

test('resolveTar: not-found → null + tar-not-found diagnostic (never throws)', () => {
  const resolveFn = () => ({ resolved: false, path: null });
  const res = resolveTar({ platform: 'win32', resolveFn, statFn: noSystem32 });
  assert.equal(res.tarPath, null);
  assert.equal(res.diagnostics.length, 1);
  assert.equal(res.diagnostics[0].code, 'tar-not-found');
  assert.equal(res.diagnostics[0].severity, 'error');
});

test('resolveTar: a throwing resolveFn degrades to tar-not-found (never throws)', () => {
  const resolveFn = () => { throw new Error('boom'); };
  const res = resolveTar({ platform: 'win32', resolveFn, statFn: noSystem32 });
  assert.equal(res.tarPath, null);
  assert.equal(res.diagnostics[0].code, 'tar-not-found');
});

// ── (3) probeTarVersion / create / extract via injected spawnFn ────────────────

test('probeTarVersion: success → parses first banner line', async () => {
  const spawnFn = makeSpawn({ stdout: 'bsdtar 3.7.2 - libarchive 3.7.2\nextra\n' });
  const res = await probeTarVersion({ tarPath: TAR, cwd: CWD, spawnFn });
  assert.equal(res.available, true);
  assert.equal(res.version, 'bsdtar 3.7.2 - libarchive 3.7.2');
  assert.equal(res.diagnostics.length, 0);
  // the version spawn used exactly --version, maxArgs tight
  assert.deepEqual(spawnFn.calls[0].args, ['--version']);
  assert.equal(spawnFn.calls[0].schema.maxArgs, 1);
});

test('probeTarVersion: spawn throw → available:false + tar-version-failed (never throws)', async () => {
  const spawnFn = makeSpawn({ throw: new Error('ENOENT') });
  const res = await probeTarVersion({ tarPath: TAR, cwd: CWD, spawnFn });
  assert.equal(res.available, false);
  assert.equal(res.version, null);
  assert.equal(res.diagnostics[0].code, 'tar-version-failed');
});

test('probeTarVersion: missing tarPath → tar-not-found, no spawn', async () => {
  const spawnFn = makeSpawn({ stdout: '' });
  const res = await probeTarVersion({ tarPath: '', spawnFn });
  assert.equal(res.available, false);
  assert.equal(res.diagnostics[0].code, 'tar-not-found');
  assert.equal(spawnFn.calls.length, 0);
});

test('createSnapshotTar: non-zero exit (spawn rejects) → ok:false + tar-create-failed', async () => {
  const spawnFn = makeSpawn({ throw: Object.assign(new Error('tar: exit 1'), { code: 1 }) });
  const res = await createSnapshotTar({
    tarPath: TAR, archivePath: 'C:\\t\\a.tar', baseDir: 'C:\\b', files: ['x'], cwd: CWD, spawnFn,
  });
  assert.equal(res.ok, false);
  assert.equal(res.archivePath, null);
  assert.equal(res.diagnostics[0].code, 'tar-create-failed');
});

test('extractSnapshotTar: non-zero exit (spawn rejects) → ok:false + tar-extract-failed', async () => {
  const spawnFn = makeSpawn({ throw: Object.assign(new Error('tar: exit 2'), { code: 2 }) });
  const res = await extractSnapshotTar({
    tarPath: TAR, archivePath: 'C:\\t\\a.tar', destDir: 'C:\\dest', cwd: CWD, spawnFn,
  });
  assert.equal(res.ok, false);
  assert.equal(res.diagnostics[0].code, 'tar-extract-failed');
});

test('createSnapshotTar: a spawn that rejects with a NON-Error value is coerced (never throws)', async () => {
  // errMsg must handle a thrown string/object without throwing itself.
  const spawnFn = makeSpawn({ throw: 'plain string failure' });
  const res = await createSnapshotTar({
    tarPath: TAR, archivePath: 'C:\\t\\a.tar', baseDir: 'C:\\b', files: ['x'], cwd: CWD, spawnFn,
  });
  assert.equal(res.ok, false);
  assert.equal(res.diagnostics[0].code, 'tar-create-failed');
  assert.match(res.diagnostics[0].message, /plain string failure/);
});

test('createSnapshotTar: bad args (non-string file entry) → tar-create-bad-args, no spawn', async () => {
  const spawnFn = makeSpawn({ stdout: '' });
  const res = await createSnapshotTar({
    tarPath: TAR, archivePath: 'C:\\t\\a.tar', baseDir: 'C:\\b', files: ['ok', 123], cwd: CWD, spawnFn,
  });
  assert.equal(res.ok, false);
  assert.equal(res.diagnostics[0].code, 'tar-create-bad-args');
  assert.equal(spawnFn.calls.length, 0);
});

test('extractSnapshotTar: missing destDir → tar-extract-bad-args, no spawn', async () => {
  const spawnFn = makeSpawn({ stdout: '' });
  const res = await extractSnapshotTar({ tarPath: TAR, archivePath: 'C:\\t\\a.tar', destDir: '', spawnFn });
  assert.equal(res.ok, false);
  assert.equal(res.diagnostics[0].code, 'tar-extract-bad-args');
  assert.equal(spawnFn.calls.length, 0);
});

// ── (4) direct-argv assembly, traversal guard, budget guard ───────────────────

test('createSnapshotTar: file entries become positionals in argv order', async () => {
  const spawnFn = makeSpawn({ stdout: '' });
  const res = await createSnapshotTar({
    tarPath: TAR, archivePath: 'C:\\t\\a.tar', baseDir: 'C:\\b',
    files: ['skills/a/SKILL.md', 'agents/b.md', 'commands/c.md'], cwd: CWD, spawnFn,
  });
  assert.equal(res.ok, true);
  const { args } = spawnFn.calls[0];
  assert.deepEqual(args, ['-c', '-f', 'C:\\t\\a.tar', '-C', 'C:\\b', 'skills/a/SKILL.md', 'agents/b.md', 'commands/c.md']);
});

test('createSnapshotTar: empty files list → archive with no members (still valid)', async () => {
  const spawnFn = makeSpawn({ stdout: '' });
  const res = await createSnapshotTar({
    tarPath: TAR, archivePath: 'C:\\t\\a.tar', baseDir: 'C:\\b', files: [], cwd: CWD, spawnFn,
  });
  assert.equal(res.ok, true);
  assert.deepEqual(spawnFn.calls[0].args, ['-c', '-f', 'C:\\t\\a.tar', '-C', 'C:\\b']);
});

test('createSnapshotTar: a `..` traversal segment in a file entry is REJECTED, no spawn', async () => {
  const spawnFn = makeSpawn({ stdout: '' });
  for (const bad of ['../escape.md', 'skills/../../etc/passwd', '..', 'a/..']) {
    const res = await createSnapshotTar({
      tarPath: TAR, archivePath: 'C:\\t\\a.tar', baseDir: 'C:\\b', files: ['ok.md', bad], cwd: CWD, spawnFn,
    });
    assert.equal(res.ok, false, `should reject ${bad}`);
    assert.equal(res.diagnostics[0].code, 'tar-create-bad-args');
  }
  assert.equal(spawnFn.calls.length, 0, 'no tar spawn when a traversal entry is present');
});

test('createSnapshotTar: a filename that merely CONTAINS dots (not a `..` segment) is allowed', async () => {
  const spawnFn = makeSpawn({ stdout: '' });
  const res = await createSnapshotTar({
    tarPath: TAR, archivePath: 'C:\\t\\a.tar', baseDir: 'C:\\b',
    files: ['file..name.md', 'a.b..c/SKILL.md', 'CLAUDE.md.backup.2026'], cwd: CWD, spawnFn,
  });
  assert.equal(res.ok, true);
});

test('createSnapshotTar: an oversized file list fails cleanly with tar-too-many-files, no spawn', async () => {
  const spawnFn = makeSpawn({ stdout: '' });
  // Build enough long paths to blow the 24000-char argv budget.
  const files = [];
  for (let i = 0; i < 400; i++) files.push(`skills/${String(i).padStart(4, '0')}-${'x'.repeat(60)}/SKILL.md`);
  const res = await createSnapshotTar({
    tarPath: TAR, archivePath: 'C:\\t\\a.tar', baseDir: 'C:\\b', files, cwd: CWD, spawnFn,
  });
  assert.equal(res.ok, false);
  assert.equal(res.diagnostics[0].code, 'tar-too-many-files');
  assert.equal(spawnFn.calls.length, 0, 'oversized list is refused before spawning (never truncates)');
});

// ── never-throws on garbage input ─────────────────────────────────────────────

test('all entry points tolerate undefined opts without throwing', async () => {
  assert.doesNotThrow(() => resolveTar());
  const p = await probeTarVersion();
  assert.equal(p.available, false);
  const c = await createSnapshotTar();
  assert.equal(c.ok, false);
  const x = await extractSnapshotTar();
  assert.equal(x.ok, false);
});
