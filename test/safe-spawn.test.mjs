import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSpawnSpec, safeSpawn, SafeSpawnError } from '../src/lib/safe-spawn.mjs';

const ABS_EXE = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : '/usr/bin/tar';
const ALLOWED_CWD = process.platform === 'win32' ? 'C:\\tmp' : '/tmp';

function baseSpec(overrides = {}) {
  return {
    exe: ABS_EXE,
    args: ['-C', ALLOWED_CWD, '--version'],
    cwd: ALLOWED_CWD,
    allowedCwds: [ALLOWED_CWD],
    schema: { allowedFlags: ['-C', '--version'], positionalPattern: /^([A-Za-z]:\\|\/)/, maxArgs: 8 },
    ...overrides,
  };
}

test('validateSpawnSpec rejects shell:true', () => {
  assert.throws(
    () => validateSpawnSpec(baseSpec({ shell: true })),
    (err) => err instanceof SafeSpawnError && err.code === 'spawn-shell-forbidden',
  );
});

test('validateSpawnSpec rejects a relative (non-absolute) exe', () => {
  assert.throws(
    () => validateSpawnSpec(baseSpec({ exe: 'tar' })),
    (err) => err.code === 'spawn-exe-not-absolute',
  );
});

test('validateSpawnSpec rejects a cwd outside the allowlist', () => {
  assert.throws(
    () => validateSpawnSpec(baseSpec({ cwd: process.platform === 'win32' ? 'C:\\evil' : '/evil' })),
    (err) => err.code === 'spawn-cwd-not-allowed',
  );
});

test('validateSpawnSpec rejects a non-allowlisted flag in argv', () => {
  assert.throws(
    () => validateSpawnSpec(baseSpec({ args: ['--mirror', '/etc'] })),
    (err) => err.code === 'spawn-flag-not-allowed',
  );
});

test('validateSpawnSpec rejects argv longer than maxArgs', () => {
  assert.throws(
    () => validateSpawnSpec(baseSpec({ args: ['-C', '-C', '-C', '-C', '-C', '-C', '-C', '-C', '-C'] })),
    (err) => err.code === 'spawn-argv-too-long',
  );
});

test('validateSpawnSpec enforces positionalPattern', () => {
  assert.throws(
    () =>
      validateSpawnSpec(
        baseSpec({
          args: ['notallowed'],
          schema: { positionalPattern: /^ok-/, maxArgs: 8 },
        }),
      ),
    (err) => err.code === 'spawn-positional-rejected',
  );
});

test('validateSpawnSpec rejects a non-object spec', () => {
  assert.throws(
    () => validateSpawnSpec(/** @type {any} */ (null)),
    (err) => err.code === 'spawn-bad-spec',
  );
});

test('validateSpawnSpec passes a well-formed spec and returns it', () => {
  const spec = baseSpec();
  assert.equal(validateSpawnSpec(spec), spec);
});

test('safeSpawn rejects (before spawning) when shell:true is passed', async () => {
  await assert.rejects(
    () => safeSpawn(baseSpec({ shell: true })),
    (err) => err.code === 'spawn-shell-forbidden',
  );
});

test('safeSpawn rejects (before spawning) a non-allowlisted argv', async () => {
  await assert.rejects(
    () => safeSpawn(baseSpec({ args: ['--mirror', '/etc'] })),
    (err) => err.code === 'spawn-flag-not-allowed',
  );
});

// --- H2: argv schema is mandatory + deny-by-default ---
test('validateSpawnSpec REQUIRES a schema (H2 deny-by-default)', () => {
  const spec = baseSpec();
  delete spec.schema;
  assert.throws(
    () => validateSpawnSpec(spec),
    (err) => err instanceof SafeSpawnError && err.code === 'spawn-schema-required',
  );
});

test('validateSpawnSpec DENIES a positional when no positionalPattern is set (H2)', () => {
  assert.throws(
    () =>
      validateSpawnSpec(
        baseSpec({
          args: ['-C', '/some/target'],
          schema: { allowedFlags: ['-C'], maxArgs: 8 }, // allowedFlags but NO positionalPattern
        }),
      ),
    (err) => err.code === 'spawn-positional-not-allowed',
  );
});

test('safeSpawn SUCCESS path: execFile resolves {stdout} for an allowed command', async () => {
  const { stdout } = await safeSpawn({
    exe: process.execPath, // absolute node binary
    args: ['--version'],
    cwd: process.cwd(),
    allowedCwds: [process.cwd()],
    schema: { allowedFlags: ['--version'], maxArgs: 2 },
  });
  assert.match(String(stdout), /^v\d+\./);
});
