import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POSIX_CAPABILITY_COMMAND,
  resolvePosixRuntime,
} from './helpers/posix-shell-capability.mjs';

test('rejects a launch-only shell and returns the capable shell-side repo root', () => {
  const calls = [];
  const spawnFn = (shell, argv, options) => {
    calls.push({ shell, argv, options });
    return shell === 'sh'
      ? { status: 127, stdout: '' }
      : { status: 0, stdout: '/mnt/c/repo with spaces\n' };
  };

  const runtime = resolvePosixRuntime({
    candidates: ['sh', 'bash'], spawnFn, cwd: 'C:\\repo with spaces',
  });

  assert.deepEqual(runtime, { shell: 'bash', root: '/mnt/c/repo with spaces' });
  assert.deepEqual(calls.map((call) => call.shell), ['sh', 'bash']);
  for (const call of calls) {
    assert.deepEqual(call.argv, ['-c', POSIX_CAPABILITY_COMMAND]);
    assert.equal(call.options.cwd, 'C:\\repo with spaces');
    assert.equal(call.options.encoding, 'utf8');
  }
  assert.match(POSIX_CAPABILITY_COMMAND, /node -e/);
  assert.match(POSIX_CAPABILITY_COMMAND, />= 24/);
  assert.match(POSIX_CAPABILITY_COMMAND, /pwd -P/);
  assert.doesNotMatch(POSIX_CAPABILITY_COMMAND, /harness-mgr|test -r/);
});

test('returns null when candidates throw, fail to spawn, or fail the full probe', () => {
  const spawnFn = (shell) => {
    if (shell === 'throwing') throw new Error('boom');
    if (shell === 'missing') return { error: new Error('ENOENT'), status: null };
    return { status: 1 };
  };
  assert.equal(resolvePosixRuntime({
    candidates: ['throwing', 'missing', 'launch-only'],
    spawnFn,
    cwd: '/repo',
  }), null);
  assert.doesNotThrow(() => resolvePosixRuntime(null));
  assert.equal(resolvePosixRuntime(null), null);
});

test('rejects ambiguous probe output instead of guessing a shell-side root', () => {
  const outputs = new Map([
    ['multiline', '/mnt/c/repo\n/unexpected\n'],
    ['relative', 'repo\n'],
    ['empty', ''],
  ]);
  assert.equal(resolvePosixRuntime({
    candidates: [...outputs.keys()],
    spawnFn: (shell) => ({ status: 0, stdout: outputs.get(shell) }),
    cwd: 'C:\\repo',
  }), null);
});
