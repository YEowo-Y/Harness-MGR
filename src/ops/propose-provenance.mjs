/**
 * Skill-proposal provenance writer (P5.U8 sub-unit B helper) — split from
 * propose.mjs to keep that module under the 200-SLOC ceiling (the sanctioned
 * pure-vs-I/O / helper split). Owns ONLY the `.mgr-state/proposals/<name>-<ts>.json`
 * record write (design §5): the single source the future `skill accept` (U9) reads
 * for its stale guard.
 *
 * BEST-EFFORT by design: any failure → a VISIBLE `propose-provenance-failed` warn +
 * `written:false`; it NEVER throws and NEVER flips the already-landed proposal to
 * failed (precedent: the lock-break audit degrade). The proposal file on disk is the
 * exact proposed bytes regardless of whether this record persists.
 *
 * M2-SAFETY: imports ONLY node:path / node:crypto + ../lib/diagnostic. The actual fs
 * writes go through INJECTED seams (mkdirFn / writeFileFn) forwarded by propose.mjs,
 * which themselves write only into the tool's own `.mgr-state` (gated by the
 * `.mgr-state` passthrough in the caller's assertWritable). NEVER src/paths.mjs.
 */

import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

/** @typedef {import('../lib/diagnostic.mjs').DiagnosticBag} DiagnosticBag */

const PHASE = 'propose';

/** sha256 hex of a Buffer/string. */
function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Message from an unknown thrown value; never throws. */
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

/** Best-effort ISO from an injected clock; never throws. */
function clockIso(now) {
  try {
    const d = typeof now === 'function' ? now() : new Date();
    if (d instanceof Date && !Number.isNaN(d.getTime())) return d.toISOString();
  } catch { /* fall through */ }
  return new Date().toISOString();
}

/**
 * Write the provenance JSON to `.mgr-state/proposals/<name>-<ts>.json` (design §5
 * record, proposalVersion 1; paths POSIX-relative to the config dir). BEST-EFFORT:
 * any failure → a `propose-provenance-failed` warn + `written:false`; never throws.
 *
 * @param {object} a
 * @param {{name:string, skillPath:string, target:string, proposedBuf:Buffer}} a.v
 * @param {string} a.ts                snapshot-id timestamp shared with the proposal leaf
 * @param {string} a.mgrStateDir       absolute .mgr-state dir
 * @param {string} a.sourceSha256      hex sha256 of the (re-read at apply time) SKILL.md
 * @param {string|undefined} a.reason  user-supplied provenance reason
 * @param {() => Date} a.now           clock (shares the proposal's instant)
 * @param {{mkdirFn:Function, writeFileFn:Function}} a.seams
 * @param {DiagnosticBag} a.bag
 * @returns {{ path: string, written: boolean }}
 */
export function writeProvenance(a) {
  const { v, ts, mgrStateDir, sourceSha256, reason, now, seams, bag } = a;
  const path = join(mgrStateDir, 'proposals', v.name + '-' + ts + '.json');
  try {
    seams.mkdirFn(dirname(path));
    const record = {
      proposalVersion: 1,
      kind: 'skill',
      name: v.name,
      proposalFile: 'SKILL.proposed-' + ts + '.md',
      proposalPath: 'skills/' + v.name + '/SKILL.proposed-' + ts + '.md',
      sourcePath: 'skills/' + v.name + '/SKILL.md',
      sourceSha256,
      proposedSha256: sha256Hex(v.proposedBuf),
      createdAt: clockIso(now),
      reason: typeof reason === 'string' ? reason : '',
    };
    seams.writeFileFn(path, JSON.stringify(record, null, 2) + '\n');
    return { path, written: true };
  } catch (e) {
    bag.add({ severity: 'warn', code: 'propose-provenance-failed', phase: PHASE, path,
      message: `the proposal was written but its provenance record could not be saved: ${errMsg(e)} ` +
        '(the proposal file is intact; U9 accept will require --force without the record)' });
    return { path, written: false };
  }
}
