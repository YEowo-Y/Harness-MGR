/**
 * Skill-proposal SELECTION + STALE-GUARD helper (P5.U9 sub-unit B helper) — split
 * from accept.mjs to keep that orchestrator under the 200-SLOC ceiling (the
 * sanctioned helper split, like propose-provenance.mjs).
 *
 * Owns the read-only, never-mutating front half of `skill accept`:
 *   - selectProposal: resolve which `SKILL.proposed-<ts>.md` to accept (design §2 Q1
 *     — explicit id with single-fallback), lstat-guard the skill dir / SKILL.md / the
 *     chosen proposal (never follow a symlink), and read the proposed bytes.
 *   - staleGuard: read the provenance record `.mgr-state/proposals/<name>-<ts>.json`
 *     and compare sha256(current SKILL.md) === record.sourceSha256 (design §2 stale
 *     guard). Returns a verdict { stale, provenanceFound, sourceSha256 } the caller
 *     turns into a refusal (apply) or a preview note (dry-run).
 *
 * Both functions are PURE over INJECTED seams (readFileFn / lstatFn / readdirFn);
 * they NEVER throw (every fs error is caught) and NEVER mutate anything. The actual
 * write sequence lives in accept.mjs.
 *
 * M2-SAFETY: imports ONLY node:path / node:crypto. NEVER imports src/paths.mjs —
 * the dirs + seams are INJECTED params, keeping this module's static graph
 * paths.mjs-free (the M2-safe property the boundary self-check enforces). The fs
 * reads go through seams forwarded by accept.mjs.
 *
 * Spec: docs/phase-5-u9-accept-design.md §2 / §4.
 */

import { join } from 'node:path';
import { createHash } from 'node:crypto';

/** A valid skill name leaf: no separators, no traversal, no ADS, no spaces. */
export const NAME_RE = /^[A-Za-z0-9._-]+$/;

/** The proposal-leaf shape: SKILL.proposed-<snapshot-id>.md (mirrors paths.mjs PROPOSAL_NAME_RE). */
export const PROPOSAL_NAME_RE = /^SKILL\.proposed-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.md$/i;

/** Just the <ts> portion (a snapshot id). */
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/i;

/** sha256 hex of a Buffer/string; never throws on a Buffer/string. */
export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Message from an unknown thrown value; never throws. */
export function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Normalize a caller-supplied proposalId to its full leaf `SKILL.proposed-<ts>.md`.
 * Accepts either the full leaf OR just the bare `<ts>` portion. Returns
 * `{ leaf, ts }` on success, or null when the id is not a recognizable proposal id.
 * @param {string} id
 * @returns {{leaf:string, ts:string}|null}
 */
export function normalizeProposalId(id) {
  if (typeof id !== 'string' || id.length === 0) return null;
  if (PROPOSAL_NAME_RE.test(id)) {
    const ts = id.slice('SKILL.proposed-'.length, id.length - '.md'.length);
    return { leaf: id, ts };
  }
  if (TS_RE.test(id)) return { leaf: 'SKILL.proposed-' + id + '.md', ts: id };
  return null;
}

/** Extract the `<ts>` from a known-good proposal leaf. */
export function tsFromLeaf(leaf) {
  return leaf.slice('SKILL.proposed-'.length, leaf.length - '.md'.length);
}

/**
 * lstat a path through the seam; return the stat or null (never throws).
 * @param {(p:string)=>import('node:fs').Stats} lstatFn @param {string} p
 */
function lstatOrNull(lstatFn, p) {
  try { return lstatFn(p); } catch { return null; }
}

/**
 * Resolve which proposal to accept + read its bytes. Validates the name, lstat-
 * guards the skill dir / SKILL.md / the chosen proposal (never follows a symlink),
 * and returns the selection. Returns `{ refusal:{code,message} }` on any refusal.
 *
 * @param {object} a
 * @param {string} a.name              the skill name
 * @param {string|undefined} a.proposalId  explicit id (full leaf or bare ts), optional
 * @param {string} a.targetClaudeDir   absolute governed dir
 * @param {{readFileFn:Function, lstatFn:Function, readdirFn:Function}} a.seams
 * @returns {{name,skillDir,skillPath,proposalId,proposalPath,ts,proposedBuf,skillMdExists,skillMdSt}
 *           | {refusal:{code,message}}}
 */
export function selectProposal(a) {
  const { name, proposalId, targetClaudeDir, seams } = a;
  const r = (code, message) => ({ refusal: { code, message } });

  // 1. name validation (§4 accept-name-invalid).
  if (typeof name !== 'string' || name.length === 0
      || name === '.' || name === '..'
      || name.includes('/') || name.includes('\\') || !NAME_RE.test(name)) {
    return r('accept-name-invalid',
      `invalid skill name ${JSON.stringify(name)}; must be a plain leaf matching ${NAME_RE} (no path, traversal, or special chars)`);
  }

  const skillDir = join(targetClaudeDir, 'skills', name);
  const skillPath = join(skillDir, 'SKILL.md');

  // 2. skill dir + SKILL.md symlink guard (lstat, never follow). The skill dir
  //    must exist (it holds the proposals); SKILL.md MAY be absent (a --force
  //    re-create from the proposal — the stale guard handles that), but if present
  //    it must not be a symlink.
  const dirSt = lstatOrNull(seams.lstatFn, skillDir);
  if (!dirSt) return r('accept-no-proposal', `no skill directory to accept into: ${skillDir} does not exist`);
  if (dirSt.isSymbolicLink()) {
    return r('accept-skill-is-symlink', `refusing to follow a symlinked skill dir: ${skillDir} is a symlink`);
  }
  const skillMdSt = lstatOrNull(seams.lstatFn, skillPath);
  if (skillMdSt && skillMdSt.isSymbolicLink()) {
    return r('accept-skill-is-symlink', `refusing to follow a symlinked SKILL.md: ${skillPath} is a symlink`);
  }

  // 3. Resolve the proposal leaf — explicit id, or single-fallback (§2 Q1).
  const sel = resolveProposalLeaf({ proposalId, skillDir, seams });
  if ('refusal' in sel) return sel;
  const { leaf, ts } = sel;
  const proposalPath = join(skillDir, leaf);

  // 4. The chosen proposal must be a regular, non-symlink file.
  const propSt = lstatOrNull(seams.lstatFn, proposalPath);
  if (!propSt) return r('accept-proposal-not-found', `the proposal ${proposalPath} does not exist`);
  if (propSt.isSymbolicLink()) {
    return r('accept-skill-is-symlink', `refusing to follow a symlinked proposal: ${proposalPath} is a symlink`);
  }
  if (!propSt.isFile()) return r('accept-proposal-not-found', `the proposal ${proposalPath} is not a regular file`);

  // 5. Read the proposed bytes (binary-safe Buffer).
  let proposedBuf;
  try { proposedBuf = seams.readFileFn(proposalPath); }
  catch (e) { return r('accept-proposal-unreadable', `cannot read the proposal ${proposalPath}: ${errMsg(e)}`); }

  return {
    name, skillDir, skillPath, proposalId: leaf, proposalPath, ts,
    proposedBuf, skillMdExists: !!skillMdSt, skillMdSt,
  };
}

/**
 * Resolve the proposal leaf: an explicit id (normalized) → must exist as a
 * proposal-shaped name; or NO id → list the dir's `SKILL.proposed-*.md`: 0 →
 * accept-no-proposal, 1 → that one, >1 → accept-ambiguous (LISTS the sorted ids).
 * @param {object} a @returns {{leaf,ts}|{refusal:{code,message}}}
 */
function resolveProposalLeaf(a) {
  const { proposalId, skillDir, seams } = a;
  const r = (code, message) => ({ refusal: { code, message } });

  if (proposalId !== undefined && proposalId !== null && proposalId !== '') {
    const norm = normalizeProposalId(proposalId);
    if (!norm) return r('accept-proposal-not-found',
      `the proposal id ${JSON.stringify(proposalId)} is not a recognizable proposal (expected SKILL.proposed-<ts>.md or <ts>)`);
    return norm;
  }

  // No id — enumerate the dir for proposal leaves.
  let entries;
  try { entries = seams.readdirFn(skillDir); }
  catch (e) { return r('accept-no-proposal', `could not list the skill directory ${skillDir}: ${errMsg(e)}`); }
  const proposals = (Array.isArray(entries) ? entries : [])
    .filter((n) => typeof n === 'string' && PROPOSAL_NAME_RE.test(n))
    .sort();
  if (proposals.length === 0) {
    return r('accept-no-proposal', `the skill has no proposals to accept (no SKILL.proposed-*.md in ${skillDir})`);
  }
  if (proposals.length > 1) {
    return r('accept-ambiguous',
      `the skill has ${proposals.length} proposals; specify one: ${proposals.join(', ')}`);
  }
  const leaf = proposals[0];
  return { leaf, ts: tsFromLeaf(leaf) };
}

/**
 * Stale guard (design §2): read the provenance record + compare
 * sha256(current SKILL.md bytes) === record.sourceSha256. Returns a verdict — never
 * throws, never mutates. A missing/unreadable/parse-failing provenance record →
 * `{ provenanceFound:false }`; a present record with a mismatching source sha →
 * `{ stale:true }`. The caller decides whether that refuses (apply, no --force) or
 * is just previewed (dry-run).
 *
 * @param {object} a
 * @param {string} a.name             the skill name
 * @param {string} a.ts               the selected proposal's <ts>
 * @param {string} a.skillPath        absolute skills/<name>/SKILL.md
 * @param {boolean} a.skillMdExists   whether SKILL.md is present on disk
 * @param {string} a.mgrStateDir      absolute .mgr-state dir
 * @param {{readFileFn:Function}} a.seams
 * @returns {{stale:boolean, provenanceFound:boolean, sourceSha256:string|null, provenancePath:string}}
 */
export function staleGuard(a) {
  const { name, ts, skillPath, skillMdExists, mgrStateDir, seams } = a;
  const provenancePath = join(mgrStateDir, 'proposals', name + '-' + ts + '.json');

  // Current SKILL.md sha (null when absent — then it can never match, so it reads
  // as stale unless the provenance is also missing; documented in design §4 note).
  let currentSha = null;
  if (skillMdExists) {
    try { currentSha = sha256Hex(seams.readFileFn(skillPath)); }
    catch { currentSha = null; }
  }

  // Provenance record.
  let record = null;
  try {
    const raw = seams.readFileFn(provenancePath);
    record = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch { record = null; }

  if (!record || typeof record !== 'object' || typeof record.sourceSha256 !== 'string') {
    return { stale: currentSha === null ? true : false, provenanceFound: false, sourceSha256: currentSha, provenancePath };
  }
  const stale = currentSha === null ? true : currentSha !== record.sourceSha256;
  return { stale, provenanceFound: true, sourceSha256: currentSha, provenancePath };
}
