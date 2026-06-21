/**
 * mcp-toggle engine — setMcpEnabledClaude (the non-destructive Claude MCP enable/disable).
 *
 * Claude has NO `enabled` flag for user-scope MCP servers and they live in the OAuth-secret-
 * bearing, ungoverned ~/.claude.json — so a "toggle" is delegate + stash, NOT a flag-flip:
 *   - DISABLE: stash the server's config to .mgr-state (the undo) → delegate `claude mcp remove`.
 *   - ENABLE:  read the stash → delegate `claude mcp add-json` → clear the stash.
 * claude-mgr NEVER reads OAuth state or writes ~/.claude.json — the official CLI performs every
 * ~/.claude.json mutation; this engine only writes .mgr-state (the stash, gated) + orchestrates
 * the delegated spawns (mcpRemove / mcpAddJson). Reversibility = the stash. Dry-run-by-default.
 *
 * SECRET + ROUND-TRIP SAFETY: refuses to disable a server whose entry has an `env` block
 * (never stash a secret) OR whose config isn't printable-ASCII (so disable↔enable can never
 * strand a server the add-json schema would later reject). user-scope only (the user's servers).
 *
 * M2-safe (sibling ops + lib only; NEVER paths.mjs). NEVER throws. Injectable seams. Zero deps.
 */

import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { mcpRemove, NAME_RE } from './mcp-write.mjs';
import { mcpAddJson } from './mcp-add.mjs';
import { readRawEntry, entryHasEnv, writeStash, readStash, deleteStash, stashExists } from './mcp-stash.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

const PHASE = 'mcp';
/** Printable ASCII (matches mcp-add's add-json belt) — a config must round-trip through it. */
const PRINTABLE_ASCII_RE = /^[\x20-\x7e]+$/;

/** Full-shape result (no undefined). */
function result(fields, bag) {
  const d = { ok: false, refused: false, dryRun: false, kind: 'mcp', name: null, desired: null,
    action: null, alreadyInState: false, stashWritten: false, stashDeleted: false, command: null };
  return { ...d, ...fields, diagnostics: bag.all() };
}

/**
 * Enable/disable a USER-scope Claude MCP server, non-destructively + reversibly. NEVER throws.
 * @param {object} opts
 * @param {string} opts.name @param {boolean} opts.desired  true=enable, false=disable
 * @param {string} opts.targetClaudeDir @param {string} opts.mgrStateDir
 * @param {string} opts.appFile  absolute ~/.claude.json (read-only here; the CLI mutates it)
 * @param {(p:string,c:string)=>string} [opts.assertWritable]  gate; REQUIRED for --apply
 * @param {boolean} [opts.enableWrites] @param {Record<string,string|undefined>} [opts.env]
 * @param {string} [opts.platform] @param {string} [opts.cwd] @param {()=>Date} [opts.now]
 * @param {{mcpRemoveFn?:Function, mcpAddJsonFn?:Function, readRawEntryFn?:Function}} [opts.seams]
 * @returns {Promise<object>}
 */
export async function setMcpEnabledClaude(opts) {
  const bag = new DiagnosticBag();
  const refuse = (code, message, fields = {}) => { bag.add({ severity: 'error', code, message, phase: PHASE }); return result({ refused: true, ...fields }, bag); };
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    const { name, desired, targetClaudeDir, mgrStateDir, appFile } = o;
    if (typeof desired !== 'boolean') return refuse('mcp-toggle-bad-args', 'desired must be a boolean');
    if (typeof name !== 'string' || !NAME_RE.test(name)) return refuse('mcp-toggle-bad-spec', `invalid MCP server name ${JSON.stringify(name)}; must match ${NAME_RE}`, { name: typeof name === 'string' ? name : null, desired });
    if (typeof targetClaudeDir !== 'string' || !targetClaudeDir.length) return refuse('mcp-toggle-bad-args', 'targetClaudeDir required', { name, desired });
    if (typeof mgrStateDir !== 'string' || !mgrStateDir.length) return refuse('mcp-toggle-bad-args', 'mgrStateDir required', { name, desired });
    if (typeof appFile !== 'string' || !appFile.length) return refuse('mcp-toggle-bad-args', 'appFile (~/.claude.json) required', { name, desired });

    const seams = o.seams && typeof o.seams === 'object' ? o.seams : {};
    const readRawEntryFn = typeof seams.readRawEntryFn === 'function' ? seams.readRawEntryFn : readRawEntry;
    const ctx = {
      o, name, desired, targetClaudeDir, mgrStateDir, appFile,
      assertWritable: o.assertWritable, enableWrites: o.enableWrites === true,
      entry: readRawEntryFn(appFile, name), stashed: stashExists(mgrStateDir, name),
      bag, refuse,
      mcpRemoveFn: typeof seams.mcpRemoveFn === 'function' ? seams.mcpRemoveFn : mcpRemove,
      mcpAddJsonFn: typeof seams.mcpAddJsonFn === 'function' ? seams.mcpAddJsonFn : mcpAddJson,
    };
    return desired === false ? await disableServer(ctx) : await enableServer(ctx);
  } catch (e) {
    bag.add({ severity: 'error', code: 'mcp-toggle-unexpected-error', message: `unexpected error during mcp toggle: ${e instanceof Error ? e.message : String(e)}`, phase: PHASE });
    return result({}, bag);
  }
}

/** DISABLE: stash the current config (the undo) then delegate `claude mcp remove`. */
async function disableServer(ctx) {
  const { name, mgrStateDir, entry, stashed, bag, refuse, enableWrites, o } = ctx;
  if (entry === null) {
    if (stashed) { bag.add({ severity: 'info', code: 'mcp-toggle-already-disabled', phase: PHASE, message: `mcp server '${name}' is already disabled (absent from ~/.claude.json, stash present)` }); return result({ ok: true, dryRun: !enableWrites, name, desired: false, action: 'noop', alreadyInState: true }, bag); }
    return refuse('mcp-toggle-not-found', `mcp server '${name}' is not in ~/.claude.json (user scope); nothing to disable`, { name, desired: false, action: 'not-found' });
  }
  if (entryHasEnv(entry)) return refuse('mcp-toggle-has-env', `mcp server '${name}' carries env values claude-mgr will NOT stash to .mgr-state; disable it by hand with \`claude mcp remove ${name} --scope user\` (and re-add later with \`claude mcp add\`)`, { name, desired: false });
  if (!PRINTABLE_ASCII_RE.test(JSON.stringify(entry))) return refuse('mcp-toggle-unsupported-config', `mcp server '${name}' config has non-ASCII/control characters claude-mgr can't safely round-trip via add-json; disable it by hand with \`claude mcp remove ${name} --scope user\``, { name, desired: false });

  const human = `claude mcp remove ${name} --scope user`;
  if (!enableWrites) {
    bag.add({ severity: 'info', code: 'mcp-toggle-dry-run', phase: PHASE, message: `would stash '${name}' config to .mgr-state, then run \`${human}\` (re-run with --apply). \`enable\` later restores it from the stash.` });
    return result({ ok: true, dryRun: true, name, desired: false, action: 'disable', command: ['mcp', 'remove', name, '--scope', 'user'] }, bag);
  }
  if (typeof ctx.assertWritable !== 'function') return refuse('mcp-toggle-bad-args', 'assertWritable (the gate) must be injected to --apply', { name, desired: false });

  // Stash FIRST (the undo); if it fails, do NOT delegate the removal.
  const ws = writeStash({ mgrStateDir, name, entry, scope: 'user', assertWritable: ctx.assertWritable, now: o.now });
  for (const d of ws.diagnostics) bag.add(d);
  if (!ws.written) return result({ ok: false, name, desired: false, action: 'disable' }, bag);

  const rm = await ctx.mcpRemoveFn({ name, scope: 'user', targetClaudeDir: ctx.targetClaudeDir, mgrStateDir, appFile: ctx.appFile, assertWritable: ctx.assertWritable, enableWrites: true, reason: `mcp disable ${name}`, env: o.env, platform: o.platform, cwd: o.cwd, now: o.now });
  for (const d of rm.diagnostics ?? []) bag.add(d);
  if (rm.ok === true) bag.add({ severity: 'info', code: 'mcp-toggle-restart-needed', phase: PHASE, message: `disabled '${name}'. Restart Claude Code to drop the connection; run \`claude-mgr enable --type mcp ${name}\` to restore it.` });
  return result({ ok: rm.ok === true, name, desired: false, action: 'disable', stashWritten: true, command: rm.command ?? null }, bag);
}

/** ENABLE: delegate `claude mcp add-json` from the stash, then clear the stash. */
async function enableServer(ctx) {
  const { name, mgrStateDir, entry, stashed, bag, refuse, enableWrites, o } = ctx;
  if (entry !== null) {
    // Already present = already enabled. Clear a stale stash (it was re-added out-of-band).
    if (stashed && enableWrites && typeof ctx.assertWritable === 'function') { for (const d of deleteStash({ mgrStateDir, name, assertWritable: ctx.assertWritable }).diagnostics) bag.add(d); }
    bag.add({ severity: 'info', code: 'mcp-toggle-already-enabled', phase: PHASE, message: `mcp server '${name}' is already present in ~/.claude.json (enabled)${stashed ? '; cleared a stale stash' : ''}` });
    return result({ ok: true, dryRun: !enableWrites, name, desired: true, action: 'noop', alreadyInState: true }, bag);
  }
  if (!stashed) return refuse('mcp-toggle-not-found', `mcp server '${name}' is not present and has no claude-mgr stash to restore; nothing to enable`, { name, desired: true, action: 'not-found' });
  const rec = readStash(mgrStateDir, name);
  if (!rec || !rec.config) return refuse('mcp-toggle-stash-unreadable', `the stash for '${name}' is missing or unreadable; cannot restore`, { name, desired: true });

  const human = `claude mcp add-json ${name} <json> --scope ${rec.scope || 'user'}`;
  if (!enableWrites) {
    bag.add({ severity: 'info', code: 'mcp-toggle-dry-run', phase: PHASE, message: `would run \`${human}\` from the stash, then clear the stash (re-run with --apply).` });
    return result({ ok: true, dryRun: true, name, desired: true, action: 'enable' }, bag);
  }
  if (typeof ctx.assertWritable !== 'function') return refuse('mcp-toggle-bad-args', 'assertWritable (the gate) must be injected to --apply', { name, desired: true });

  const add = await ctx.mcpAddJsonFn({ name, json: JSON.stringify(rec.config), scope: rec.scope || 'user', targetClaudeDir: ctx.targetClaudeDir, enableWrites: true, env: o.env, platform: o.platform, cwd: o.cwd });
  for (const d of add.diagnostics ?? []) bag.add(d);
  let stashDeleted = false;
  if (add.ok === true) { const del = deleteStash({ mgrStateDir, name, assertWritable: ctx.assertWritable }); for (const d of del.diagnostics) bag.add(d); stashDeleted = del.deleted; bag.add({ severity: 'info', code: 'mcp-toggle-restart-needed', phase: PHASE, message: `re-enabled '${name}'. Restart Claude Code to connect.` }); }
  return result({ ok: add.ok === true, name, desired: true, action: 'enable', stashDeleted, command: add.command ?? null }, bag);
}
