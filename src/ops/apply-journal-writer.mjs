/**
 * Apply-journal writer (P3.U11) — the journal write/read primitives + the apply
 * state machine. This is the first of the audit's P0-3 split (the un-splittable
 * state machine, landed as writer → planned-snapshotted → applying-committed →
 * recover-mark-failed across U11-U14). NO apply logic yet: this unit only builds
 * the journal record, validates state transitions, and persists / reads the
 * `apply-journal.json` file. Later units (U12-U14) DRIVE the transitions; the
 * table below is the contract they consume, so they extend USAGE, not the table.
 *
 * The journal lives at `<stateDir>/snapshots/<id>/apply-journal.json` and records
 * the apply lifecycle so a crash mid-apply can be recovered:
 *
 *   { journalVersion, planVersion, command, snapshotId, targetClaudeDir,
 *     state, createdAt, updatedAt, ops: [<redacted PlanOp>, ...] }
 *
 * State machine (each edge maps to a documented operation — plan lines 493-519):
 *
 *   planned ──▶ snapshotted ──▶ applying ──▶ committed
 *               (snapshot)      (writes)         │
 *      every active state can be marked `failed`;│
 *      a snapshot, once taken, can be `rolled-back`.
 *
 *   planned     → snapshotted | failed
 *   snapshotted → applying | failed | rolled-back
 *   applying    → committed | failed | rolled-back
 *   committed   → rolled-back
 *   failed      → rolled-back
 *   rolled-back → (terminal)
 *
 * `planned` has no edge to `rolled-back` on purpose: a rollback restores FROM a
 * snapshot, and the snapshot is only captured at the `snapshotted` transition.
 *
 * Ops are REDACTED via plan.mjs::redactPatchOp before persistence, so a patch op
 * under a *secret* / *token* / … pointer is stored as {redacted:true, sha256} —
 * the journal never holds a plaintext secret (plan L491). Other op fields
 * (e.g. create/overwrite `content`) are stored verbatim, as recovery replay needs
 * them; the plan scopes journal redaction to sensitive patch values only.
 *
 * writeJournal writes ONLY into the tool's own `.mgr-state` snapshots dir, never
 * the governed `~/.claude` config. assertWritable is INJECTED + REQUIRED
 * (fail-safe — refuses if absent, never silently bypasses the gate), mirroring
 * lock.mjs / snapshot-manifest-io.mjs; the apply path MUST inject
 * paths.mjs::assertWritable.
 *
 * Ops-layer constraint: imports only node:* stdlib + src/lib/** + the sibling
 * manifest model (id/path helpers). Pure logic never throws; the I/O primitives
 * never throw. Zero npm dependencies.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { redactPatchOp, PLAN_VERSION } from '../lib/plan.mjs';
import {
  isObject, errMsg, serialize, isValidSnapshotId, snapshotDir, SNAPSHOT_ID_RE,
} from './snapshot-manifest.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */
/** @typedef {import('../lib/plan.mjs').PlanOp} PlanOp */

/** Journal schema version. readJournal refuses a GREATER version (a newer tool
 *  wrote it; we cannot safely interpret it). */
export const JOURNAL_VERSION = 1;

/** The journal filename inside a snapshot dir. */
export const JOURNAL_NAME = 'apply-journal.json';

/** The apply lifecycle states, in lifecycle order. */
export const JOURNAL_STATES = Object.freeze([
  'planned', 'snapshotted', 'applying', 'committed', 'failed', 'rolled-back',
]);

/** The state an apply begins in. */
export const INITIAL_STATE = 'planned';

/**
 * Valid state transitions (see the module header for the per-edge rationale).
 * `rolled-back` is terminal. Frozen so no later unit can mutate the contract.
 * @type {Readonly<Record<string, ReadonlyArray<string>>>}
 */
const TRANSITIONS = Object.freeze({
  planned: Object.freeze(['snapshotted', 'failed']),
  snapshotted: Object.freeze(['applying', 'failed', 'rolled-back']),
  applying: Object.freeze(['committed', 'failed', 'rolled-back']),
  committed: Object.freeze(['rolled-back']),
  failed: Object.freeze(['rolled-back']),
  'rolled-back': Object.freeze([]),
});

// ── shared helpers ─────────────────────────────────────────────────────────────

/** Reject prototype-poisoning keys (JSON.parse can make `__proto__` an own key). */
function isSafeKey(key) {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
}

/** Shallow-strip prototype-poisoning own keys from a parsed object. */
function stripProto(obj) {
  const out = {};
  for (const k of Object.keys(obj)) if (isSafeKey(k)) out[k] = obj[k];
  return out;
}

/** Best-effort ISO from an injected clock; never throws. */
function clockIso(now) {
  try {
    const d = now();
    if (d instanceof Date && !Number.isNaN(d.getTime())) return d.toISOString();
  } catch { /* fall through */ }
  return new Date(0).toISOString();
}

/** @param {string} stateDir @param {string} snapshotId @returns {string} */
export function journalPath(stateDir, snapshotId) {
  return join(snapshotDir(stateDir, snapshotId), JOURNAL_NAME);
}

/** @param {unknown} s @returns {boolean} true for a known lifecycle state */
export function isJournalState(s) {
  return typeof s === 'string' && JOURNAL_STATES.includes(s);
}

/**
 * Structural guard the state machine relies on: an object whose `state` is a
 * known lifecycle state. Field-level schema is validated where it matters.
 * @param {unknown} j @returns {boolean}
 */
export function isJournal(j) {
  return isObject(j) && isJournalState(j.state);
}

// ── createJournal (pure) ──────────────────────────────────────────────────────

/**
 * Build an initial journal in the `planned` state from a Plan. Each op is REDACTED
 * via redactPatchOp before storage (a sensitive patch op keeps only a hash), so
 * the persisted journal never holds a plaintext secret. Pure; never throws.
 * Returns null on invalid input (the caller diagnoses).
 *
 * @param {object} opts
 * @param {string}  opts.snapshotId
 * @param {string}  opts.targetClaudeDir
 * @param {{planVersion?:number, command?:string, ops?:PlanOp[]}} opts.plan
 * @param {() => Date} [opts.now]
 * @returns {{ journal: object|null, diagnostics: Diagnostic[] }}
 */
export function createJournal(opts) {
  const { snapshotId, targetClaudeDir, plan, now = () => new Date() } = opts ?? {};
  const bag = new DiagnosticBag();
  const bail = (code, message) => {
    bag.add({ severity: 'error', code, message, phase: 'apply' });
    return { journal: null, diagnostics: bag.all() };
  };

  if (!isValidSnapshotId(snapshotId)) {
    return bail('journal-snapshot-id-invalid', `snapshotId must match ${SNAPSHOT_ID_RE}`);
  }
  if (typeof targetClaudeDir !== 'string' || targetClaudeDir.length === 0) {
    return bail('journal-target-invalid', 'targetClaudeDir must be a non-empty string');
  }
  if (!isObject(plan)) {
    return bail('journal-plan-invalid', 'plan must be an object');
  }

  const ops = Array.isArray(plan.ops) ? plan.ops : [];
  /** @type {PlanOp[]} */
  const redacted = [];
  for (const op of ops) {
    if (isObject(op)) redacted.push(redactPatchOp(op));
    else bag.add({ severity: 'warn', code: 'journal-op-skipped', phase: 'apply',
      message: 'skipped malformed plan op (must be an object)' });
  }

  const ts = clockIso(now);
  // FIXED key order → readable, stable journal serialization.
  const journal = {
    journalVersion: JOURNAL_VERSION,
    planVersion: Number.isInteger(plan.planVersion) && plan.planVersion >= 1
      ? plan.planVersion : PLAN_VERSION,
    command: typeof plan.command === 'string' ? plan.command : '',
    snapshotId,
    targetClaudeDir,
    state: INITIAL_STATE,
    createdAt: ts,
    updatedAt: ts,
    ops: redacted,
  };
  return { journal, diagnostics: bag.all() };
}

// ── transition (pure state-machine move) ──────────────────────────────────────

/**
 * Validate + apply a state transition, returning a NEW journal (no mutation of
 * the input). On an illegal / unknown transition: ok:false + an error diagnostic,
 * and the input journal is returned unchanged so the caller can inspect its state.
 * The `ops` array is shared by reference (transition never touches ops). Pure;
 * never throws.
 *
 * @param {object} journal  a journal from createJournal / readJournal
 * @param {string} toState
 * @param {{ now?: () => Date }} [opts]
 * @returns {{ ok: boolean, journal: object|null, diagnostics: Diagnostic[] }}
 */
export function transition(journal, toState, opts = {}) {
  const { now = () => new Date() } = opts ?? {};
  const bag = new DiagnosticBag();
  const bail = (code, message) => {
    bag.add({ severity: 'error', code, message, phase: 'apply' });
    return { ok: false, journal: isObject(journal) ? journal : null, diagnostics: bag.all() };
  };

  if (!isJournal(journal)) {
    return bail('journal-invalid', 'journal must be an object with a known state');
  }
  if (!isJournalState(toState)) {
    return bail('journal-invalid-state', `unknown target state ${JSON.stringify(toState)}`);
  }
  const from = journal.state;
  const allowed = TRANSITIONS[from] ?? [];
  if (!allowed.includes(toState)) {
    return bail('journal-illegal-transition',
      `cannot move from '${from}' to '${toState}' (allowed: ${allowed.join(', ') || 'none'})`);
  }
  const next = { ...journal, state: toState, updatedAt: clockIso(now) };
  return { ok: true, journal: next, diagnostics: bag.all() };
}

// ── writeJournal (gated I/O + verify-after-write) ─────────────────────────────

/**
 * Serialize + write `apply-journal.json` into `<stateDir>/snapshots/<id>/`, then
 * read it back and byte-compare to prove the write landed intact. Never throws.
 *
 * assertWritable is REQUIRED (fail-safe): a missing gate refuses the write rather
 * than bypassing it. The seams mkdir/write/read are injectable for tests.
 *
 * @param {object} opts
 * @param {string}  opts.stateDir
 * @param {string}  opts.snapshotId
 * @param {object}  opts.journal
 * @param {(path:string, ctx:string)=>string} opts.assertWritable  governed-write gate
 * @param {{mkdir?:Function, write?:Function, read?:Function}} [opts.seams]
 * @returns {{ written: boolean, path: string|null, diagnostics: Diagnostic[] }}
 */
export function writeJournal(opts) {
  const { stateDir, snapshotId, journal, assertWritable, seams = {} } = opts ?? {};
  const mkdir = seams.mkdir ?? ((p) => mkdirSync(p, { recursive: true }));
  const write = seams.write ?? ((p, data) => writeFileSync(p, data, 'utf8'));
  const read = seams.read ?? ((p) => readFileSync(p, 'utf8'));
  const bag = new DiagnosticBag();
  const fail = (code, message, path) => {
    bag.add({ severity: 'error', code, message, phase: 'apply', ...(path ? { path } : {}) });
    return { written: false, path: path ?? null, diagnostics: bag.all() };
  };

  if (typeof stateDir !== 'string' || stateDir.length === 0) {
    return fail('journal-write-error', 'stateDir must be a non-empty string');
  }
  if (!isValidSnapshotId(snapshotId)) {
    return fail('journal-snapshot-id-invalid', `snapshotId must match ${SNAPSHOT_ID_RE}`);
  }
  if (!isObject(journal)) {
    return fail('journal-write-error', 'journal must be an object');
  }
  if (typeof assertWritable !== 'function') {
    return fail('journal-write-error', 'assertWritable (the governed-write gate) must be injected');
  }

  const dir = snapshotDir(stateDir, snapshotId);
  const file = journalPath(stateDir, snapshotId);

  try { assertWritable(file, 'apply'); }
  catch (e) { return fail('journal-write-error', `write gate denied: ${errMsg(e)}`, file); }

  // serialize() is JSON.stringify under the hood; a non-sensitive op value that
  // is unserializable (BigInt / cyclic) would otherwise throw here, breaking the
  // never-throws contract — so guard it as a write failure too.
  let data;
  try { data = serialize(journal); }
  catch (e) { return fail('journal-write-error', `could not serialize journal: ${errMsg(e)}`, file); }
  try { mkdir(dir); write(file, data); }
  catch (e) { return fail('journal-write-error', `could not write journal: ${errMsg(e)}`, file); }

  // Verify-after-write: read back and byte-compare (integrity, not just I/O ok).
  let back;
  try { back = read(file); }
  catch (e) { return fail('journal-write-verify-failed', `could not read back journal: ${errMsg(e)}`, file); }
  if (back !== data) {
    return fail('journal-write-verify-failed', 'journal read-back does not match written bytes', file);
  }
  return { written: true, path: file, diagnostics: bag.all() };
}

// ── readJournal (I/O) ─────────────────────────────────────────────────────────

/**
 * Read + parse a snapshot's `apply-journal.json`. Never throws. A missing journal
 * is an error (the caller asked for a specific snapshot). TOP-LEVEL prototype keys
 * are stripped defensively. A journal whose version is GREATER than supported is
 * refused (a newer tool wrote it). Returns the parsed journal otherwise; pass its
 * `state` to `transition` for state-machine validation.
 *
 * @param {object} opts
 * @param {string} opts.stateDir
 * @param {string} opts.snapshotId
 * @param {(path:string)=>string} [opts.readFn]  injectable reader
 * @returns {{ journal: object|null, diagnostics: Diagnostic[] }}
 */
export function readJournal(opts) {
  const { stateDir, snapshotId, readFn } = opts ?? {};
  const bag = new DiagnosticBag();
  const bail = (code, message, path) => {
    bag.add({ severity: 'error', code, message, phase: 'apply', ...(path ? { path } : {}) });
    return { journal: null, diagnostics: bag.all() };
  };

  if (typeof stateDir !== 'string' || stateDir.length === 0) {
    return bail('journal-read-error', 'stateDir must be a non-empty string');
  }
  if (!isValidSnapshotId(snapshotId)) {
    return bail('journal-snapshot-id-invalid', `snapshotId must match ${SNAPSHOT_ID_RE}`);
  }

  const file = journalPath(stateDir, snapshotId);
  let text;
  try { text = readFn ? readFn(file) : readFileSync(file, 'utf8'); }
  catch (e) {
    const code = e && e.code === 'ENOENT' ? 'journal-not-found' : 'journal-unreadable';
    return bail(code, `could not read journal: ${errMsg(e)}`, file);
  }

  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) { return bail('journal-unreadable', `invalid journal JSON: ${errMsg(e)}`, file); }
  if (!isObject(parsed)) {
    return bail('journal-unreadable', 'journal is not a JSON object', file);
  }

  const journal = stripProto(parsed);
  const jv = journal.journalVersion;
  if (Number.isInteger(jv) && jv > JOURNAL_VERSION) {
    return bail('journal-version-unsupported',
      `journal version ${jv} is newer than supported ${JOURNAL_VERSION}; upgrade harness-mgr`, file);
  }
  return { journal, diagnostics: bag.all() };
}
