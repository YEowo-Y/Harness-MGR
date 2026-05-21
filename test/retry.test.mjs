import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { withRetry, readFileWithRetry, DEFAULT_RETRY_CODES, DEFAULT_BACKOFF_MS } from '../src/lib/retry.mjs';

function transientError(code) {
  const e = new Error(`transient ${code}`);
  e.code = code;
  return e;
}

test('withRetry retries on EBUSY then succeeds', async () => {
  let calls = 0;
  const result = await withRetry(
    () => {
      calls++;
      if (calls < 3) throw transientError('EBUSY');
      return 'ok';
    },
    { tries: 5, backoffMs: [1, 1, 1, 1] },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('withRetry retries on EPERM then succeeds', async () => {
  let calls = 0;
  const result = await withRetry(
    () => {
      calls++;
      if (calls < 2) throw transientError('EPERM');
      return 42;
    },
    { tries: 4, backoffMs: [1] },
  );
  assert.equal(result, 42);
  assert.equal(calls, 2);
});

test('withRetry gives up after N tries and rethrows the last error', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        () => {
          calls++;
          throw transientError('EBUSY');
        },
        { tries: 3, backoffMs: [1, 1] },
      ),
    (err) => err.code === 'EBUSY',
  );
  assert.equal(calls, 3, 'should attempt exactly `tries` times');
});

test('withRetry does NOT retry a non-transient code (fails fast)', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        () => {
          calls++;
          throw transientError('ENOENT');
        },
        { tries: 5, backoffMs: [1] },
      ),
    (err) => err.code === 'ENOENT',
  );
  assert.equal(calls, 1, 'non-transient error must not be retried');
});

test('defaults match the plan: tries=5, codes=[EBUSY,EPERM], backoff schedule', () => {
  assert.deepEqual([...DEFAULT_RETRY_CODES], ['EBUSY', 'EPERM']);
  assert.deepEqual([...DEFAULT_BACKOFF_MS], [50, 100, 200, 400, 800]);
});

test('withRetry honors a custom codes list', async () => {
  let calls = 0;
  const result = await withRetry(
    () => {
      calls++;
      if (calls < 2) throw transientError('ENOTEMPTY');
      return 'recovered';
    },
    { tries: 3, backoffMs: [1], codes: ['ENOTEMPTY'] },
  );
  assert.equal(result, 'recovered');
  assert.equal(calls, 2);
});

test('readFileWithRetry reads an existing file', async () => {
  const self = fileURLToPath(import.meta.url);
  const text = await readFileWithRetry(self);
  assert.ok(text.includes('readFileWithRetry reads an existing file'));
});
