import test from 'node:test';
import assert from 'node:assert/strict';
import { DiagnosticBag, toDiagnostic } from '../src/lib/diagnostic.mjs';

test('DiagnosticBag accumulates and reports counts', () => {
  const bag = new DiagnosticBag();
  bag.add({ severity: 'info', code: 'a', message: 'one' });
  bag.add({ severity: 'warn', code: 'b', message: 'two' });
  bag.add({ severity: 'error', code: 'c', message: 'three' });

  assert.equal(bag.all().length, 3);
  assert.equal(bag.count(), 3);
  assert.equal(bag.count('error'), 1);
  assert.equal(bag.count('warn'), 1);
  assert.equal(bag.count('info'), 1);
  assert.equal(bag.hasErrors(), true);
});

test('DiagnosticBag NEVER throws on malformed input', () => {
  const bag = new DiagnosticBag();
  // Each of these would crash a naive implementation.
  assert.doesNotThrow(() => bag.add(null));
  assert.doesNotThrow(() => bag.add(undefined));
  assert.doesNotThrow(() => bag.add(42));
  assert.doesNotThrow(() => bag.add('a bare string'));
  assert.doesNotThrow(() => bag.add({ severity: 'NONSENSE' }));
  assert.doesNotThrow(() => bag.add(new Error('boom')));
  assert.doesNotThrow(() => bag.add([]));
  assert.equal(bag.all().length, 7);
});

test('toDiagnostic normalizes unknown severity to error and fills defaults', () => {
  const d = toDiagnostic({ severity: 'banana' });
  assert.equal(d.severity, 'error');
  assert.equal(d.code, 'unknown');
  assert.equal(d.message, '');
});

test('toDiagnostic carries optional path/phase/fix fields', () => {
  const d = toDiagnostic({
    severity: 'warn',
    code: 'orphan-files',
    message: 'orphan detected',
    path: '/c/x/y.md',
    phase: 'discovery',
    fix: 'remove or re-link',
  });
  assert.equal(d.path, '/c/x/y.md');
  assert.equal(d.phase, 'discovery');
  assert.equal(d.fix, 'remove or re-link');
});

test('toDiagnostic extracts message from Error instances', () => {
  const d = toDiagnostic(new Error('disk gone'));
  assert.equal(d.message, 'disk gone');
  assert.equal(d.severity, 'error');
});

test('addError builds an error diagnostic from a thrown value', () => {
  const bag = new DiagnosticBag();
  bag.addError('read-failed', new Error('ENOENT'), { path: '/x' });
  const [d] = bag.all();
  assert.equal(d.code, 'read-failed');
  assert.equal(d.severity, 'error');
  assert.equal(d.message, 'ENOENT');
  assert.equal(d.path, '/x');
});

test('merge folds another bag in and all() returns a copy (private array)', () => {
  const a = new DiagnosticBag();
  a.add({ severity: 'info', code: 'a', message: '' });
  const b = new DiagnosticBag();
  b.add({ severity: 'info', code: 'b', message: '' });
  a.merge(b);
  assert.equal(a.all().length, 2);

  const snapshot = a.all();
  snapshot.push({ severity: 'info', code: 'x', message: '' });
  assert.equal(a.all().length, 2, 'mutating the returned array must not affect the bag');
});

test('toJSON returns diagnostics plus severity counts', () => {
  const bag = new DiagnosticBag();
  bag.add({ severity: 'warn', code: 'w', message: '' });
  bag.add({ severity: 'error', code: 'e', message: '' });
  const json = bag.toJSON();
  assert.equal(json.diagnostics.length, 2);
  assert.deepEqual(json.counts, { info: 0, warn: 1, error: 1 });
});
