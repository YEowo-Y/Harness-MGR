/**
 * Audit-log WRITE side (P3.U20) — the sibling of the U10 READ viewer (audit.mjs).
 *
 * Appends metadata-only entries to `<stateDir>/audit.log`, the JSONL log the
 * reader consumes. Two exports:
 *   - buildAuditEntry(opts)  — PURE: build a metadata-only entry (the M3 contract).
 *   - appendAuditEntry(opts) — GATED I/O: append one entry via O_APPEND.
 *
 * SECURITY — metadata only (decided-item M3): an audit entry holds EXACTLY six
 * fields { timestamp, command, planVersion, snapshotId, exitCode, opCount } and
 * NOTHING else — never file contents, diffs, or before/after values. The whitelist
 * is enforced in ONE place, `normalizeEntry`, called by BOTH the pure builder and
 * the I/O appender (defense-in-depth re-whitelist at the write boundary), so a
 * careless caller who stuffs a `diff`/`before`/`after` into the raw entry cannot
 * leak it to disk.
 *
 * O_APPEND ATOMICITY: a single ≤4 KiB append via the 'a' open flag is atomic on
 * POSIX and Windows, so concurrent appends never tear/interleave a line. Entries
 * over 4 KiB break that guarantee, so they are SPLIT: the full entry is written to
 * `audit-large/<uuid>.json` and a tiny pointer line (always < 4 KiB) is appended
 * to audit.log instead. The byte cap is measured in BYTES (Buffer.byteLength),
 * not chars.
 *
 * OPT-IN CHAIN (decided-item L2): with `chain:true`, each appended line embeds a
 * `prevHash` = sha256 of the previous log line, for tamper detection. The hash is
 * computed by the WRITER from the log bytes (not caller data), so it is safe to
 * add. The chain assumes SERIALIZED writes — the apply lock provides this in the
 * apply path; concurrent CHAINED appends may fork the chain (documented tradeoff).
 *
 * assertWritable is INJECTED + REQUIRED (fail-safe — refuses with a diagnostic if
 * absent, never silently bypasses the gate), mirroring lock.mjs / apply-journal-
 * writer.mjs. Audit files live under `.mgr-state`, which paths.mjs::assertWritable
 * permits in the default 'apply' context, so NO new write context is needed.
 *
 * Ops-layer constraint: imports only node:* stdlib + src/lib/** + the sibling
 * snapshot-manifest helpers (isObject/errMsg). Never throws. Zero npm deps.
 */

import { mkdirSync, writeFileSync, readFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { isObject, errMsg } from './snapshot-manifest.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/** JSONL filename inside stateDir — MUST match the reader's AUDIT_LOG_NAME. */
export const AUDIT_LOG_NAME = 'audit.log';

/** Subdir under stateDir holding full entries that exceeded the inline byte cap. */
export const AUDIT_LARGE_DIRNAME = 'audit-large';

/** Inline-append byte ceiling. A single 'a'-flag write at/under this size is
 *  atomic (no torn lines under concurrency); larger entries are split out. */
export const MAX_INLINE_BYTES = 4096;

/**
 * @typedef {Object} AuditEntry
 * @property {string}      timestamp   ISO timestamp the entry was built
 * @property {string}      command     CLI command ('' if unknown)
 * @property {number}      planVersion plan schema version (>=1; defaults 1)
 * @property {string|null} snapshotId  associated snapshot id, or null
 * @property {number|null} exitCode    process exit code, or null
 * @property {number}      opCount     number of ops in the plan (>=0; defaults 0)
 */

// ── internal helpers ────────────────────────────────────────────────────────────

/** Best-effort ISO from an injected clock; never throws. (Mirrors
 *  apply-journal-writer.mjs::clockIso.) */
function clockIso(now) {
  try {
    const d = now();
    if (d instanceof Date && !Number.isNaN(d.getTime())) return d.toISOString();
  } catch { /* fall through */ }
  return new Date(0).toISOString();
}

/**
 * THE M3 ENFORCEMENT POINT — the single field whitelist + coercion. Reads ONLY
 * the six named fields from `raw` (never spreads it), so any extra caller field
 * (diff/before/after/fileContents/...) is dropped. Returns a fixed-key-order
 * object. Both buildAuditEntry and appendAuditEntry route through this, keeping
 * the field list in ONE place.
 *
 * @param {{timestamp?:unknown, command?:unknown, planVersion?:unknown,
 *          snapshotId?:unknown, exitCode?:unknown, opCount?:unknown}} raw
 * @returns {AuditEntry}
 */
function normalizeEntry(raw) {
  const r = isObject(raw) ? raw : {};
  return {
    timestamp: typeof r.timestamp === 'string' ? r.timestamp : '',
    command: typeof r.command === 'string' ? r.command : '',
    planVersion: Number.isInteger(r.planVersion) && r.planVersion >= 1 ? r.planVersion : 1,
    snapshotId: typeof r.snapshotId === 'string' ? r.snapshotId : null,
    exitCode: Number.isInteger(r.exitCode) ? r.exitCode : null,
    opCount: Number.isInteger(r.opCount) && r.opCount >= 0 ? r.opCount : 0,
  };
}

/** sha256 hex of a string (utf8). */
function sha256Hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Last trimmed non-empty line of `text`, or null. */
function lastNonEmptyLine(text) {
  const lines = String(text).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t) return t;
  }
  return null;
}

/**
 * O_APPEND primitive: open with the 'a' flag (atomic append for ≤4 KiB writes),
 * write, close. The 'a' flag is the whole point of the byte cap.
 * @param {string} path @param {string} line @param {Function} [appendSeam]
 */
function appendLine(path, line, appendSeam) {
  const fn = appendSeam ?? ((p, data) => {
    const fd = openSync(p, 'a');
    try { writeSync(fd, data); } finally { closeSync(fd); }
  });
  fn(path, line);
}

/** Add an error diag and return a failure result (mirrors lock.mjs::fail). */
function fail(bag, code, message, path, extra = {}) {
  bag.add({ severity: 'error', code, message, phase: 'audit', ...(path ? { path } : {}) });
  return { written: false, large: false, ref: null, path: path ?? null, ...extra, diagnostics: bag.all() };
}

// ── buildAuditEntry (pure) ──────────────────────────────────────────────────────

/**
 * Build a metadata-only audit entry. PURE; never throws.
 *
 * The returned object is built by reading ONLY the named fields (never spreading
 * `opts`); this WHITELIST is the M3 enforcement point — an entry can never carry
 * file contents / diffs / before-after values.
 *
 * @param {object} opts
 * @param {string}  [opts.command]      kept if a string, else ''
 * @param {number}  [opts.planVersion]  integer >=1, else 1
 * @param {string}  [opts.snapshotId]   kept if a string, else null
 * @param {number}  [opts.exitCode]     integer, else null
 * @param {number}  [opts.opCount]      integer >=0, else 0
 * @param {() => Date} [opts.now]        clock injection (default () => new Date())
 * @returns {AuditEntry}
 */
export function buildAuditEntry(opts) {
  const o = isObject(opts) ? opts : {};
  const now = typeof o.now === 'function' ? o.now : () => new Date();
  // Read ONLY the whitelisted fields, then normalize (single field list).
  return normalizeEntry({
    timestamp: clockIso(now),
    command: o.command,
    planVersion: o.planVersion,
    snapshotId: o.snapshotId,
    exitCode: o.exitCode,
    opCount: o.opCount,
  });
}

// ── appendAuditEntry (gated I/O) ────────────────────────────────────────────────

/**
 * Append one entry to `<stateDir>/audit.log` via O_APPEND. Entries over 4 KiB are
 * split to `audit-large/<uuid>.json` with a tiny pointer line appended instead.
 * Never throws — every failure path adds a diagnostic and returns written:false.
 *
 * assertWritable is REQUIRED (fail-safe): a missing gate refuses the write.
 *
 * @param {object} opts
 * @param {string}  opts.stateDir
 * @param {object}  opts.entry          an entry (ideally from buildAuditEntry)
 * @param {(path:string, ctx:string)=>string} opts.assertWritable  REQUIRED gate
 * @param {boolean} [opts.chain]        opt-in: embed prevHash for tamper detection
 * @param {{mkdir?:Function, append?:Function, write?:Function, read?:Function, uuid?:Function}} [opts.seams]
 * @returns {{ written:boolean, large:boolean, ref:string|null, path:string|null, diagnostics:Diagnostic[] }}
 */
export function appendAuditEntry(opts) {
  const { stateDir, entry, assertWritable, chain = false, seams = {} } = opts ?? {};
  const mkdir = seams.mkdir ?? ((p) => mkdirSync(p, { recursive: true }));
  const write = seams.write ?? ((p, data) => writeFileSync(p, data, 'utf8'));
  const read = seams.read ?? ((p) => readFileSync(p, 'utf8'));
  const bag = new DiagnosticBag();

  if (typeof stateDir !== 'string' || stateDir.length === 0) {
    return fail(bag, 'audit-write-error', 'stateDir must be a non-empty string');
  }
  if (!isObject(entry)) {
    return fail(bag, 'audit-write-error', 'entry must be an object');
  }
  // Fail-safe: the governed-write gate is REQUIRED (no default).
  if (typeof assertWritable !== 'function') {
    return fail(bag, 'audit-write-error', 'assertWritable (the governed-write gate) must be injected');
  }

  // Re-whitelist at the I/O boundary (defense-in-depth): drops any extra caller
  // fields (diff/before/after/...) even if the entry did not come from builder.
  // Guarded: this runs during apply commit/fail, so a hostile accessor getter on
  // a raw entry must not throw and abort the in-flight apply — a clean refuse
  // instead (every other op in this fn is likewise wrapped; the pure builder is
  // not, matching the codebase's value-input never-throws scope).
  let safeEntry;
  try { safeEntry = normalizeEntry(entry); }
  catch (e) { return fail(bag, 'audit-entry-invalid', `entry fields unreadable: ${errMsg(e)}`); }
  if (typeof safeEntry.timestamp !== 'string' || safeEntry.timestamp.length === 0) {
    return fail(bag, 'audit-entry-invalid',
      'entry.timestamp must be a string; build it via buildAuditEntry');
  }

  const auditLogPath = join(stateDir, AUDIT_LOG_NAME);
  try { assertWritable(auditLogPath, 'apply'); }
  catch (e) { return fail(bag, 'audit-write-error', `write gate denied: ${errMsg(e)}`, auditLogPath); }

  try { mkdir(stateDir); }
  catch (e) { return fail(bag, 'audit-write-error', `could not create state dir: ${errMsg(e)}`, auditLogPath); }

  // prevHash (chain): hash the LAST existing log line; absent/empty log → genesis.
  let prevHash = null;
  if (chain) {
    let existing = '';
    try { existing = read(auditLogPath); }
    catch (e) { if (!(e && e.code === 'ENOENT')) {
      return fail(bag, 'audit-write-error', `could not read log for chain: ${errMsg(e)}`, auditLogPath);
    } }
    const last = lastNonEmptyLine(existing);
    prevHash = last ? sha256Hex(last) : null;
  }

  const lineObject = chain ? { ...safeEntry, prevHash } : safeEntry;
  let line;
  // normalizeEntry coerced to primitives, so stringify cannot throw; guard anyway
  // (never-throws contract; belt-and-suspenders).
  try { line = `${JSON.stringify(lineObject)}\n`; }
  catch (e) { return fail(bag, 'audit-write-error', `could not serialize entry: ${errMsg(e)}`, auditLogPath); }

  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes <= MAX_INLINE_BYTES) {
    try { appendLine(auditLogPath, line, seams.append); }
    catch (e) { return fail(bag, 'audit-write-error', `could not append entry: ${errMsg(e)}`, auditLogPath); }
    return { written: true, large: false, ref: null, path: auditLogPath, diagnostics: bag.all() };
  }

  return appendLargeEntry({
    bag, stateDir, auditLogPath, safeEntry, lineObject, chain, prevHash,
    seams, mkdir, write, assertWritable,
  });
}

/**
 * SPLIT path: write the oversized full entry to `audit-large/<uuid>.json` and
 * append a tiny (< 4 KiB) pointer line to audit.log. Extracted to keep
 * appendAuditEntry ≤80 SLOC. The single object param keeps it ≤5 params.
 * @param {object} a  bundled state from appendAuditEntry
 * @returns {{ written:boolean, large:boolean, ref:string|null, path:string|null, diagnostics:Diagnostic[] }}
 */
function appendLargeEntry(a) {
  const { bag, stateDir, auditLogPath, safeEntry, lineObject, chain, prevHash, seams, mkdir, write, assertWritable } = a;
  const uuid = (seams.uuid ?? randomUUID)();
  const ref = `${uuid}.json`;
  const largeDir = join(stateDir, AUDIT_LARGE_DIRNAME);
  const largeFile = join(largeDir, ref);

  try { assertWritable(largeFile, 'apply'); }
  catch (e) { return fail(bag, 'audit-write-error', `write gate denied: ${errMsg(e)}`, largeFile); }

  let fullContent;
  try { fullContent = `${JSON.stringify(lineObject, null, 2)}\n`; }
  catch (e) { return fail(bag, 'audit-write-error', `could not serialize large entry: ${errMsg(e)}`, largeFile); }

  try { mkdir(largeDir); write(largeFile, fullContent); }
  catch (e) { return fail(bag, 'audit-write-error', `could not write large entry: ${errMsg(e)}`, largeFile); }

  const sha256 = sha256Hex(fullContent);
  // MINIMAL pointer — deliberately OMITS command/snapshotId so it is always tiny
  // (< 4 KiB) regardless of how pathological the full entry was. timestamp is
  // kept so the reader can still sort/filter the pointer line.
  const pointer = { timestamp: safeEntry.timestamp, large: true, ref, sha256, ...(chain ? { prevHash } : {}) };
  const pointerLine = `${JSON.stringify(pointer)}\n`;
  try { appendLine(auditLogPath, pointerLine, seams.append); }
  catch (e) { return fail(bag, 'audit-write-error', `could not append pointer line: ${errMsg(e)}`, auditLogPath); }

  bag.add({ severity: 'info', code: 'audit-entry-split', phase: 'audit', path: largeFile,
    message: `entry exceeded ${MAX_INLINE_BYTES} bytes; wrote full entry to ${AUDIT_LARGE_DIRNAME}/${ref} and a pointer line to ${AUDIT_LOG_NAME}` });
  return { written: true, large: true, ref, path: auditLogPath, diagnostics: bag.all() };
}
