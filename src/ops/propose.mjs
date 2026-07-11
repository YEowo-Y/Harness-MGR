/**
 * Skill self-iteration proposal builder/engine (P5.U8 sub-unit B) — the user-facing
 * entry for `skill propose <name> --from <file>`.
 *
 * It writes an ITERATED version of an existing user-tier skill as a NEW file —
 * `skills/<name>/SKILL.proposed-<ts>.md` — and NEVER touches the original
 * `SKILL.md`. The proposed content is the EXACT bytes of `--from <file>` (harness-mgr
 * stays zero-network + content-agnostic; it is the safe-write mechanism, not the
 * content generator — viewpoint-review S3). The proposal file IS the diff shown, so
 * the future `skill accept` (U9) becomes a pure rename.
 *
 *   proposeSkill(opts)
 *      ├─ validate args + name + source + skill (the §4 refusal matrix)  →  clean
 *      │     refusal, never writes, never locks
 *      ├─ enableWrites !== true (DEFAULT):  read both, build the unified diff, return
 *      │     a PREVIEW — writes NOTHING (no gate required, no lock, no fs mutation)
 *      └─ enableWrites === true:  acquireLock → re-read original → re-check no-change
 *            → refuse if the target already exists → atomicApplyWrite(context:'propose')
 *            → BEST-EFFORT provenance JSON in .mgr-state/proposals/ → releaseLock
 *
 * REFUSAL MATRIX (docs/phase-5-u8-propose-design.md §4) — each is a clean refusal with
 * a clear error Diagnostic + `{ ok:false, refused:true }`; NO write, NO lock:
 *   - targetClaudeDir/mgrStateDir missing; --apply without injected gate → propose-bad-args
 *   - name ∉ /^[A-Za-z0-9._-]+$/, '.'/'..', separators, ADS                → propose-name-invalid
 *   - --from not given                                                     → propose-no-source
 *   - --from missing/unreadable (EISDIR included)                          → propose-from-unreadable
 *   - skills/<name>/SKILL.md absent                                        → propose-skill-not-found
 *   - skill dir OR SKILL.md is a symlink (lstat, never followed)           → propose-skill-is-symlink
 *   - SKILL.md exists but cannot be read                                   → propose-skill-unreadable
 *   - proposed bytes == current bytes (--apply refuses; dry-run warns, exit 0) → propose-no-change
 *   - the <ts>-named target already exists (same-second collision)         → propose-already-exists
 *   - apply lock held by a live foreign holder                             → propose-lock-failed
 *
 * SECURITY / SAFETY:
 *   - DRY-RUN BY DEFAULT. Without enableWrites it reads both files, builds the diff +
 *     preview, and touches NOTHING — no gate, no lock, no fs mutation, no snapshot.
 *   - The ONLY governed write is the atomicApplyWrite of the .proposed file under the
 *     least-authority 'propose' gate context (paths.mjs::assertProposeContext) — which
 *     STRUCTURALLY cannot overwrite SKILL.md. assertWritable is INJECTED + REQUIRED for
 *     --apply, never imported here.
 *   - lstat (never follows symlinks) is the only fs read on the dry-run refusal path.
 *   - NO auto-snapshot at propose time (design §5 #5): propose only ADDS a file; its
 *     undo is deletion. The snapshot-before-overwrite belongs to U9 accept.
 *
 * M2-SAFETY: imports ONLY node:fs / node:path / node:crypto, ../output/diff.mjs (the
 * ops→output precedent: snapshot-diff.mjs), and sibling src/ops/* (snapshot-manifest
 * for makeSnapshotId, lock, atomic-write). NEVER imports src/paths.mjs — the assertWritable
 * gate + dirs are injected params, keeping this module's static graph paths.mjs-free (the
 * M2-safe property the boundary self-check enforces).
 * assertWritable + acquireLock/releaseLock/atomicApplyWrite are injected (lock/write)
 * or imported only as M2-safe siblings.
 *
 * Ops-layer constraint: node:* stdlib + src/lib/** + src/output/diff + sibling
 * src/ops/* + the pure, paths-free secret sanitizer src/analysis/redact-secrets-text.mjs
 * (its transitive graph is node:crypto + src/lib/** + src/analysis/redact-mcp-args.mjs, none
 * importing paths.mjs, so the M2-safe/paths-free property holds; it runs on the diff TEXT so
 * a secret in a proposed SKILL.md never reaches the unified diff — same contract as
 * `config show-effective` / `config diff`). Zero npm deps. NEVER THROWS — the whole body is wrapped; any
 * unexpected error becomes a Diagnostic + `{ ok:false }`. A ProposeResult ALWAYS
 * carries the full shape so callers / render never see undefined.
 *
 * Spec: docs/phase-5-u8-propose-design.md §1–§5/§7.
 */

import { lstatSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { computeLineDiff, formatUnified } from '../output/diff.mjs';
import { redactSecretsLines } from '../analysis/redact-secrets-text.mjs';
import { makeSnapshotId } from './snapshot-manifest.mjs';
import { acquireLock, releaseLock } from './lock.mjs';
import { atomicApplyWrite } from './atomic-write.mjs';
import { writeProvenance } from './propose-provenance.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/** Stable diagnostic phase tag for this module's own findings. */
const PHASE = 'propose';

/** A valid skill name leaf: no separators, no traversal, no ADS, no spaces. */
const NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * @typedef {Object} ProposeResult
 * @property {boolean} ok                 true on a clean dry-run preview or a successful apply.
 * @property {boolean} refused            true when validation refused (no write/lock).
 * @property {boolean} dryRun             true for the preview path; false for the apply path.
 * @property {string|null} name           the validated skill name, null on early refusal.
 * @property {string|null} skillPath      absolute skills/<name>/SKILL.md, null on early refusal.
 * @property {string|null} target         absolute .proposed target file, null on early refusal.
 * @property {string|null} proposalId     the SKILL.proposed-<ts>.md leaf name, null early.
 * @property {string|null} sourceSha256   hex sha256 of the current SKILL.md bytes.
 * @property {string|null} proposedSha256 hex sha256 of the --from bytes.
 * @property {boolean} changed            true when proposed bytes differ from current.
 * @property {object|null} stats          the Myers diff stats {added,deleted,unchanged}.
 * @property {string|null} unified        the unified-diff string (redaction is the CLI's job).
 * @property {string|null} provenancePath absolute .mgr-state/proposals/<name>-<ts>.json, null early.
 * @property {boolean} provenanceWritten  true when the provenance record was persisted (--apply).
 * @property {{acquired:boolean, reason?:string}|null} lock  the apply-lock outcome (--apply only).
 * @property {Diagnostic[]} diagnostics   this module's findings + any from the primitives.
 */

/** Default seams; overridable for hermetic tests. */
const DEFAULT_SEAMS = Object.freeze({
  readFileFn: (p) => readFileSync(p),          // returns a Buffer (binary-safe)
  lstatFn: (p) => lstatSync(p),
  atomicWriteFn: atomicApplyWrite,
  acquireLockFn: acquireLock,
  releaseLockFn: releaseLock,
  mkdirFn: (p) => mkdirSync(p, { recursive: true }),
  writeFileFn: (p, c) => writeFileSync(p, c),
});

/** sha256 hex of a Buffer/string. */
function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Message from an unknown thrown value; never throws. */
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Build a ProposeResult, defaulting every field so callers always get the full
 * shape (no undefined). `diagnostics` is written LAST from the bag.
 * @param {Partial<ProposeResult>} fields @param {DiagnosticBag} bag @returns {ProposeResult}
 */
function buildResult(fields, bag) {
  const defaults = {
    ok: false, refused: false, dryRun: false,
    name: null, skillPath: null, target: null, proposalId: null,
    sourceSha256: null, proposedSha256: null, changed: false,
    stats: null, unified: null,
    provenancePath: null, provenanceWritten: false, lock: null,
  };
  return { ...defaults, ...fields, diagnostics: bag.all() };
}

/** Add an error diagnostic and return a refused ProposeResult carrying known fields. */
function refuse(bag, code, message, fields) {
  bag.add({ severity: 'error', code, message, phase: PHASE });
  return buildResult({ refused: true, ...fields }, bag);
}

/**
 * Validate the name + read the source + the skill's SKILL.md (the §4 refusal matrix
 * up to the read). Returns `{ name, skillPath, target, sourceBuf, proposedBuf }` on
 * success, or `{ refusal }` on any refusal. lstat never follows symlinks. Never throws.
 * @param {object} a { name, fromPath, targetClaudeDir, ts, seams }
 * @returns {{name,skillPath,target,sourceBuf,proposedBuf}|{refusal:{code,message}}}
 */
function validateAndRead(a) {
  const { name, fromPath, targetClaudeDir, ts, seams } = a;
  const r = (code, message) => ({ refusal: { code, message } });

  if (typeof name !== 'string' || name.length === 0
      || name === '.' || name === '..'
      || name.includes('/') || name.includes('\\') || !NAME_RE.test(name)) {
    return r('propose-name-invalid',
      `invalid skill name ${JSON.stringify(name)}; must be a plain leaf matching ${NAME_RE} (no path, traversal, or special chars)`);
  }
  if (typeof fromPath !== 'string' || fromPath.length === 0) {
    return r('propose-no-source', 'a source file is required (--from <file>)');
  }

  // Read --from (the proposed bytes). EISDIR / ENOENT / EACCES all land here.
  let proposedBuf;
  try { proposedBuf = seams.readFileFn(fromPath); }
  catch (e) { return r('propose-from-unreadable', `cannot read --from source ${fromPath}: ${errMsg(e)}`); }

  // Resolve the skill dir + its SKILL.md; lstat BOTH (never follow a symlink).
  const skillDir = join(targetClaudeDir, 'skills', name);
  const skillPath = join(skillDir, 'SKILL.md');
  const target = join(skillDir, 'SKILL.proposed-' + ts + '.md');

  let dirSt;
  try { dirSt = seams.lstatFn(skillDir); }
  catch { return r('propose-skill-not-found', `no skill to iterate: ${skillPath} does not exist`); }
  if (dirSt.isSymbolicLink()) {
    return r('propose-skill-is-symlink', `refusing to follow a symlinked skill dir: ${skillDir} is a symlink`);
  }

  let fileSt;
  try { fileSt = seams.lstatFn(skillPath); }
  catch { return r('propose-skill-not-found', `no skill to iterate: ${skillPath} does not exist`); }
  if (fileSt.isSymbolicLink()) {
    return r('propose-skill-is-symlink', `refusing to follow a symlinked SKILL.md: ${skillPath} is a symlink`);
  }

  let sourceBuf;
  try { sourceBuf = seams.readFileFn(skillPath); }
  catch (e) { return r('propose-skill-unreadable', `cannot read the current skill ${skillPath}: ${errMsg(e)}`); }

  return { name, skillPath, target, sourceBuf, proposedBuf };
}

/** Compute the diff fields ({ changed, stats, unified }) for the preview/result. */
function buildDiff(v, ts) {
  const aLabel = 'skills/' + v.name + '/SKILL.md';
  const bLabel = 'SKILL.proposed-' + ts + '.md';
  // Redact secret VALUES per-line before diffing so a credential in a SKILL.md never reaches
  // the unified diff (same no-secret-values contract as config show-effective / config diff;
  // threat-model §5.3). The sha256 provenance is computed from the RAW bufs elsewhere and is
  // unaffected — only the human-facing diff is redacted.
  const diff = computeLineDiff(redactSecretsLines(v.sourceBuf.toString('utf8')), redactSecretsLines(v.proposedBuf.toString('utf8')));
  const unified = formatUnified(diff, { aLabel, bLabel });
  const changed = diff.stats.added > 0 || diff.stats.deleted > 0;
  return { changed, stats: diff.stats, unified };
}

/**
 * The --apply write sequence (design §5): lock → re-read + re-check no-change →
 * refuse already-exists → atomicApplyWrite('propose') → best-effort provenance →
 * release. Never throws. `base` carries the shared name/skillPath/target/sha/diff.
 * @returns {Promise<ProposeResult>}
 */
async function applyProposal(a) {
  const { v, ts, mgrStateDir, assertWritable, reason, pid, now, seams, base, bag } = a;
  const proposalId = 'SKILL.proposed-' + ts + '.md';

  // 1. Lock (no auto-snapshot — propose only ADDS a file; design §5 #5).
  const lockPid = Number.isInteger(pid) ? pid : process.pid;
  const acq = seams.acquireLockFn({ stateDir: mgrStateDir, assertWritable, pid: lockPid, now });
  for (const d of acq.diagnostics ?? []) bag.add(d);
  if (!acq.acquired) {
    bag.add({ severity: 'error', code: 'propose-lock-failed', phase: PHASE,
      message: `could not acquire the apply lock (${acq.reason ?? 'unknown'}); another apply may be running` });
    return buildResult({ ...base, refused: true, proposalId, lock: { acquired: false, reason: acq.reason } }, bag);
  }

  try {
    // 2. Re-read original AT APPLY TIME + re-check no-change (the diff was made vs these bytes).
    let sourceBuf;
    try { sourceBuf = seams.readFileFn(v.skillPath); }
    catch (e) {
      return refuse(bag, 'propose-skill-unreadable',
        `cannot re-read the current skill ${v.skillPath}: ${errMsg(e)}`,
        { ...base, proposalId, lock: { acquired: true } });
    }
    const sourceSha256 = sha256Hex(sourceBuf);
    if (sourceSha256 === base.proposedSha256) {
      return refuse(bag, 'propose-no-change',
        'the proposed content is byte-identical to the current SKILL.md; nothing to propose',
        { ...base, sourceSha256, proposalId, lock: { acquired: true } });
    }

    // 3. Refuse if the <ts>-named target already exists (same-second collision; never overwrite).
    let exists = true;
    try { seams.lstatFn(v.target); }
    catch { exists = false; }
    if (exists) {
      return refuse(bag, 'propose-already-exists',
        `a proposal already exists at ${v.target}; refusing to overwrite (re-run to get a fresh timestamp)`,
        { ...base, sourceSha256, proposalId, lock: { acquired: true } });
    }

    // 4. The ONLY governed write — the .proposed file under the 'propose' gate context.
    const wr = await seams.atomicWriteFn({ target: v.target, content: v.proposedBuf, assertWritable, context: 'propose' });
    for (const d of wr.diagnostics ?? []) bag.add(d);
    if (!wr.ok) {
      bag.add({ severity: 'error', code: 'propose-write-failed', phase: PHASE,
        message: `could not write the proposal file ${v.target}` });
      return buildResult({ ...base, sourceSha256, proposalId, lock: { acquired: true } }, bag);
    }

    // 5. BEST-EFFORT provenance (design §5 #5/§5-record): a failure is a VISIBLE warn,
    //    never flips the already-landed proposal to failed.
    const prov = writeProvenance({ v, ts, mgrStateDir, sourceSha256, reason, now, seams, bag });

    bag.add({ severity: 'info', code: 'propose-written', phase: PHASE,
      message: `wrote the proposal ${v.target}; the original ${v.skillPath} is unchanged. ` +
        'Review the diff; accept or discard the proposal later.' });
    return buildResult({
      ...base, ok: true, sourceSha256, proposalId,
      provenancePath: prov.path, provenanceWritten: prov.written, lock: { acquired: true },
    }, bag);
  } finally {
    const rel = seams.releaseLockFn({ stateDir: mgrStateDir, pid: lockPid });
    for (const d of rel?.diagnostics ?? []) bag.add(d);
  }
}

/**
 * Propose an iterated version of a user-tier skill (`skill propose <name> --from
 * <file>`). Validates name/source/skill, builds the unified diff, and either previews
 * it (dry-run, the DEFAULT — writes nothing) or writes ONLY skills/<name>/SKILL
 * .proposed-<ts>.md under the least-authority 'propose' gate (NEVER touching the
 * original SKILL.md). NEVER throws; every failure is a Diagnostic + a full-shape
 * `{ ok:false }` ProposeResult.
 *
 * @param {object} opts
 * @param {string}  opts.name                            the skill name
 * @param {string}  opts.fromPath                        the --from source file
 * @param {string}  opts.targetClaudeDir                 absolute governed dir
 * @param {string}  opts.mgrStateDir                     absolute .mgr-state dir
 * @param {(p:string,ctx:string)=>string} [opts.assertWritable]  gate; REQUIRED for --apply
 * @param {boolean} [opts.enableWrites]                  true = write the proposal; false/absent = dry-run
 * @param {string}  [opts.reason]                        provenance reason
 * @param {number}  [opts.pid]                           lock pid
 * @param {() => Date} [opts.now]                         clock injection (id + createdAt share the instant)
 * @param {object}  [opts.seams]                         { readFileFn, lstatFn, atomicWriteFn, acquireLockFn, releaseLockFn, mkdirFn, writeFileFn }
 * @returns {Promise<ProposeResult>}
 */
export async function proposeSkill(opts) {
  const bag = new DiagnosticBag();
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    const { name, fromPath, targetClaudeDir, mgrStateDir, assertWritable, reason, pid } = o;
    const enableWrites = o.enableWrites === true;
    const now = typeof o.now === 'function' ? o.now : () => new Date();
    const seams = resolveSeams(o.seams);

    // 0. Arg shape — targetClaudeDir/mgrStateDir are required for both paths.
    if (typeof targetClaudeDir !== 'string' || targetClaudeDir.length === 0) {
      return refuse(bag, 'propose-bad-args', 'targetClaudeDir must be a non-empty string', {});
    }
    if (typeof mgrStateDir !== 'string' || mgrStateDir.length === 0) {
      return refuse(bag, 'propose-bad-args', 'mgrStateDir must be a non-empty string', {});
    }

    // 1. Sample now() ONCE: the id (+ provenance createdAt) share one instant (design §2 #7).
    const stamp = now();
    const ts = makeSnapshotId(stamp instanceof Date && !Number.isNaN(stamp.getTime()) ? stamp : new Date());
    const fixedNow = () => stamp;

    // 2. Validate + read both files (§4 refusal matrix up to the read).
    const v = validateAndRead({ name, fromPath, targetClaudeDir, ts, seams });
    if ('refusal' in v) return refuse(bag, v.refusal.code, v.refusal.message, {});

    // 3. Shared diff + sha fields (computed once for both the preview and the apply result).
    const { changed, stats, unified } = buildDiff(v, ts);
    const proposedSha256 = sha256Hex(v.proposedBuf);
    const sourceSha256 = sha256Hex(v.sourceBuf);
    const proposalId = 'SKILL.proposed-' + ts + '.md';
    const base = {
      name: v.name, skillPath: v.skillPath, target: v.target,
      proposedSha256, sourceSha256, changed, stats, unified,
    };

    // 4a. DRY-RUN (default): preview only — write NOTHING (no gate, no lock).
    if (!enableWrites) {
      if (!changed) {
        bag.add({ severity: 'warn', code: 'propose-no-change', phase: PHASE,
          message: `the proposed content is byte-identical to ${v.skillPath}; nothing would be written` });
        return buildResult({ ...base, ok: true, dryRun: true, proposalId }, bag);
      }
      bag.add({ severity: 'info', code: 'propose-dry-run', phase: PHASE,
        message: `would write ${v.target} (the original ${v.skillPath} is never touched); ` +
          're-run with --apply to write the proposal' });
      return buildResult({ ...base, ok: true, dryRun: true, proposalId }, bag);
    }

    // 4b. APPLY: require the gate, then run the write sequence.
    if (typeof assertWritable !== 'function') {
      return refuse(bag, 'propose-bad-args',
        'assertWritable (the governed-write gate) must be injected to --apply a proposal',
        { ...base, proposalId });
    }
    return await applyProposal({ v, ts, mgrStateDir, assertWritable, reason, pid, now: fixedNow, seams, base, bag });
  } catch (e) {
    bag.add({ severity: 'error', code: 'propose-unexpected-error', phase: PHASE,
      message: `unexpected error during propose: ${errMsg(e)}` });
    return buildResult({}, bag);
  }
}

/** Merge caller seams over the production defaults so a partial override keeps the rest. */
function resolveSeams(seams) {
  const s = seams && typeof seams === 'object' ? seams : {};
  const out = {};
  for (const k of Object.keys(DEFAULT_SEAMS)) {
    out[k] = typeof s[k] === 'function' ? s[k] : DEFAULT_SEAMS[k];
  }
  return out;
}
