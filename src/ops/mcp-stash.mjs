/**
 * MCP toggle STASH — persist a disabled server's config in .mgr-state so `enable` can re-add it.
 *
 * The stash IS the mcp toggle's undo point (there is NO ~/.claude.json snapshot — claude-mgr
 * never writes that OAuth-secret-bearing file; the official `claude mcp remove`/`add-json` CLI
 * does). disable stashes the server's config + delegates the removal; enable reads the stash +
 * delegates the re-add + deletes the stash. claude-mgr only ever writes
 * `<mgrStateDir>/mcp-disabled/<name>.json` (GATED — .mgr-state is always-writable), NEVER
 * ~/.claude.json.
 *
 * SECRET SAFETY: NO secret is ever stashed. `readRawEntry` reads the secret-bearing
 * ~/.claude.json but returns ONLY the one named mcpServers entry (never the rest); the ENGINE
 * refuses (via entryHasEnv) to stash a server that carries an `env` block BEFORE calling
 * writeStash, so the stash file holds only command/args/type/timeout-shaped config.
 *
 * M2-SAFETY: imports node:fs/path + ../lib/diagnostic + the sibling mcp-write.mjs (NAME_RE,
 * pure leaf). NEVER src/paths.mjs. Injectable fs seams. NEVER throws. Zero npm deps.
 */

import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { sniffSecretContent } from '../lib/secrets-content-sniff.mjs';
import { NAME_RE } from './mcp-write.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

const PHASE = 'mcp';

/** The .mgr-state subdir holding one JSON file per disabled server. */
export const STASH_SUBDIR = 'mcp-disabled';

/** The stash file path for a server. `name` MUST be NAME_RE-valid (no separators/traversal). */
export function stashPath(mgrStateDir, name) {
  return join(mgrStateDir, STASH_SUBDIR, `${name}.json`);
}

/** True when an entry carries credential material that must NOT be stashed: a non-empty `env`
 *  (stdio env vars) OR a non-empty `headers` (http/sse Bearer / API-key) block — the two
 *  STRUCTURAL credential homes — OR any PEM / token-shaped / high-entropy value anywhere in the
 *  serialized entry (a content backstop that also catches an inline `url`/`args` token). The
 *  engine refuses such a server BEFORE stashing AND writeStash self-guards on it. A field-name
 *  guard alone is the wrong shape for "never stash a secret" (DoD review HIGH: headers leak).
 *  Pure; never throws. */
export function entryHasSecret(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const nonEmptyObj = (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0;
  if (nonEmptyObj(entry.env) || nonEmptyObj(entry.headers)) return true;
  try { return sniffSecretContent(JSON.stringify(entry)).match === true; } catch { return false; }
}

/** True when a stash file exists for `name`. Pure read; never throws. */
export function stashExists(mgrStateDir, name, existsFn = existsSync) {
  try { return typeof name === 'string' && NAME_RE.test(name) && existsFn(stashPath(mgrStateDir, name)); }
  catch { return false; }
}

/**
 * Read ~/.claude.json and return ONLY `mcpServers[name]` (the RAW entry), or null when absent /
 * unreadable / not a plain object. Reads the secret-bearing app file but returns just the one
 * entry — never the rest. Proto-safe (own-key check). Never throws.
 * @param {string} appFilePath @param {string} name @param {(p:string)=>string} [readFn]
 */
export function readRawEntry(appFilePath, name, readFn = (p) => readFileSync(p, 'utf8')) {
  try {
    if (typeof name !== 'string' || !NAME_RE.test(name)) return null;
    const j = JSON.parse(readFn(appFilePath));
    const ms = j && typeof j === 'object' ? j.mcpServers : null;
    if (!ms || typeof ms !== 'object' || !Object.prototype.hasOwnProperty.call(ms, name)) return null;
    const e = ms[name];
    return e && typeof e === 'object' && !Array.isArray(e) ? e : null;
  } catch { return null; }
}

/**
 * Write the stash record (GATED — .mgr-state is always-writable; the gate re-confirms the path
 * is in-bounds, defense-in-depth atop NAME_RE). The `entry` MUST be env-free (caller-checked).
 * @param {object} opts {mgrStateDir, name, entry, scope, assertWritable, now, writeFn, mkdirFn}
 * @returns {{written:boolean, path:string|null, diagnostics:Diagnostic[]}}
 */
export function writeStash(opts) {
  const bag = new DiagnosticBag();
  const fail = (code, message) => { bag.add({ severity: 'error', code, message, phase: PHASE }); return { written: false, path: null, diagnostics: bag.all() }; };
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    const { mgrStateDir, name, entry, assertWritable } = o;
    const scope = typeof o.scope === 'string' && o.scope.length ? o.scope : 'user';
    const writeFn = typeof o.writeFn === 'function' ? o.writeFn : writeFileSync;
    const mkdirFn = typeof o.mkdirFn === 'function' ? o.mkdirFn : mkdirSync;
    if (typeof mgrStateDir !== 'string' || mgrStateDir.length === 0) return fail('mcp-stash-bad-args', 'mgrStateDir required');
    if (typeof name !== 'string' || !NAME_RE.test(name)) return fail('mcp-stash-bad-name', `invalid stash name ${JSON.stringify(name)}`);
    if (!entry || typeof entry !== 'object') return fail('mcp-stash-bad-entry', 'entry must be an object');
    // Self-guard: never write credential material to .mgr-state even if a caller forgot the
    // pre-check (defense-in-depth behind the engine's mcp-toggle-has-secret refusal).
    if (entryHasSecret(entry)) return fail('mcp-stash-refused-secret', 'refusing to stash a server that carries credential material (env/headers/token-shaped value)');
    if (typeof assertWritable !== 'function') return fail('mcp-stash-bad-args', 'assertWritable (the gate) is required');
    const p = stashPath(mgrStateDir, name);
    assertWritable(p, 'apply'); // throws WriteForbiddenError if somehow outside .mgr-state
    mkdirFn(join(mgrStateDir, STASH_SUBDIR), { recursive: true });
    const stashedAt = (() => { try { const d = typeof o.now === 'function' ? o.now() : new Date(); return d && typeof d.toISOString === 'function' ? d.toISOString() : null; } catch { return null; } })();
    writeFn(p, JSON.stringify({ name, scope, config: entry, stashedAt }, null, 2));
    return { written: true, path: p, diagnostics: bag.all() };
  } catch (e) { return fail('mcp-stash-write-failed', `could not write the stash: ${e instanceof Error ? e.message : String(e)}`); }
}

/**
 * Read the stash record for `name` → {name, scope, config, stashedAt} or null. Pure read; never throws.
 * @param {string} mgrStateDir @param {string} name @param {(p:string)=>string} [readFn]
 */
export function readStash(mgrStateDir, name, readFn = (p) => readFileSync(p, 'utf8')) {
  try {
    if (typeof name !== 'string' || !NAME_RE.test(name)) return null;
    const rec = JSON.parse(readFn(stashPath(mgrStateDir, name)));
    return rec && typeof rec === 'object' && rec.config && typeof rec.config === 'object' ? rec : null;
  } catch { return null; }
}

/**
 * Delete the stash file for `name` (GATED). Returns {deleted, diagnostics}. Absent file = a
 * benign no-op (deleted:false, no error). Never throws.
 * @param {object} opts {mgrStateDir, name, assertWritable, rmFn}
 */
export function deleteStash(opts) {
  const bag = new DiagnosticBag();
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    const { mgrStateDir, name, assertWritable } = o;
    const rmFn = typeof o.rmFn === 'function' ? o.rmFn : rmSync;
    if (typeof name !== 'string' || !NAME_RE.test(name)) { bag.add({ severity: 'warn', code: 'mcp-stash-bad-name', message: 'invalid stash name', phase: PHASE }); return { deleted: false, diagnostics: bag.all() }; }
    const p = stashPath(mgrStateDir, name);
    if (!existsSync(p)) return { deleted: false, diagnostics: bag.all() };
    if (typeof assertWritable === 'function') assertWritable(p, 'apply');
    rmFn(p, { force: true });
    return { deleted: true, diagnostics: bag.all() };
  } catch (e) { bag.add({ severity: 'warn', code: 'mcp-stash-delete-failed', message: `could not delete the stash: ${e instanceof Error ? e.message : String(e)}`, phase: PHASE }); return { deleted: false, diagnostics: bag.all() }; }
}
