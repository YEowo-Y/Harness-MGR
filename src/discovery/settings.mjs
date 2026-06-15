/**
 * Settings + top-level-layout discovery (P1.U9).
 *
 * Two exported scanners, both pure (take `rootDir`, never throw, reuse the
 * shared JSON reader):
 *
 *   discoverSettings(rootDir)     reads <rootDir>/settings.json and extracts the
 *                                 statusLine reference (the one top-level setting
 *                                 the inventory + doctor #18 care about). Deep
 *                                 per-key settings MERGE is deliberately NOT done
 *                                 here — that is settings-merge's job (P1.U13),
 *                                 which re-reads the layered files itself.
 *
 *   discoverTopLevelDirs(rootDir) classifies the immediate sub-DIRECTORIES of the
 *                                 config root against the 19 directories a real
 *                                 Claude Code home is known to create, so the
 *                                 inventory can show layout and orphan detection
 *                                 (P1.U11) has a baseline. `hud/` is one of the
 *                                 19, which is why "captures statusLine + hud +
 *                                 all 19 top dirs" is one cohesive unit.
 *
 * settings.json is parsed with the JSONC reader (readJsoncFile, P2.U3), so a
 * user's comments / trailing commas are tolerated and repeated keys surface as
 * `settings-duplicate-key` warn diagnostics carrying 1-based line:column (the
 * last value wins, matching JSON.parse). The doctor's `settings-json-valid`
 * check (P2.U4) consumes those facts and decides how to present them.
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { readJsoncFile, isJsonObject } from './read-json.mjs';

/**
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 */

/**
 * The 19 top-level directories a real Claude Code home is known to create
 * (verified ground-truth scan, plan line 179). Anything present but not in this
 * set is surfaced as `unknown` — a candidate orphan or a newer Claude Code dir.
 */
export const KNOWN_TOP_DIRS = Object.freeze([
  'agents', 'backups', 'cache', 'commands', 'debug', 'downloads', 'file-history',
  'hooks', 'hud', 'paste-cache', 'plans', 'plugins', 'projects', 'session-env',
  'sessions', 'shell-snapshots', 'skills', 'tasks', 'telemetry',
]);

/**
 * @typedef {Object} StatusLine
 * @property {string} [type]
 * @property {string} [command]
 */

/**
 * @typedef {Object} SettingsRecord
 * @property {string} path           absolute path to settings.json
 * @property {boolean} present       whether the file exists and parsed
 * @property {StatusLine|null} statusLine
 * @property {Diagnostic[]} diagnostics
 */

/**
 * Read <rootDir>/settings.json and extract the statusLine reference.
 * @param {string} rootDir
 * @returns {SettingsRecord}
 */
export function discoverSettings(rootDir) {
  const bag = new DiagnosticBag();
  if (typeof rootDir !== 'string' || rootDir.length === 0) {
    bag.add({ severity: 'error', code: 'discover-bad-root', message: 'rootDir must be a non-empty string', phase: 'settings' });
    return { path: '', present: false, statusLine: null, diagnostics: bag.all() };
  }

  const file = join(rootDir, 'settings.json');
  const { value, error, missing, duplicateKeys } = readJsoncFile(file);
  if (missing) return { path: file, present: false, statusLine: null, diagnostics: bag.all() };
  if (error) {
    bag.add({ severity: 'error', code: 'settings-unreadable', message: error, path: file, phase: 'settings' });
    return { path: file, present: false, statusLine: null, diagnostics: bag.all() };
  }
  if (!isJsonObject(value)) {
    bag.add({ severity: 'warn', code: 'settings-malformed', message: 'settings.json is not a JSON object', path: file, phase: 'settings' });
    return { path: file, present: false, statusLine: null, diagnostics: bag.all() };
  }

  // A repeated key is valid JSONC (last value wins) but almost always a mistake,
  // so surface each one as a fact for the doctor to judge (settings-json-valid).
  for (const dup of duplicateKeys) {
    bag.add({ severity: 'warn', code: 'settings-duplicate-key', message: `duplicate key "${dup.key}" at line ${dup.line}, column ${dup.column} (last value wins)`, path: file, phase: 'settings' });
  }

  return { path: file, present: true, statusLine: extractStatusLine(value.statusLine), diagnostics: bag.all() };
}

/**
 * @param {*} raw the settings.json `statusLine` value
 * @returns {StatusLine|null}
 */
function extractStatusLine(raw) {
  if (!isJsonObject(raw)) return null;
  /** @type {StatusLine} */
  const sl = {};
  if (typeof raw.type === 'string') sl.type = raw.type;
  if (typeof raw.command === 'string') sl.command = raw.command;
  // An empty/contentless statusLine ({} or junk-only fields) is "no usable
  // statusLine" — collapse to null so callers can rely on `StatusLine|null`.
  if (!sl.type && !sl.command) return null;
  return sl;
}

/**
 * @typedef {Object} TopDirsRecord
 * @property {{name: string, present: boolean}[]} known   the 19 known dirs, each flagged present/absent
 * @property {string[]} unknown                           present dirs not in the known set (sorted)
 * @property {Diagnostic[]} diagnostics
 */

/**
 * Classify the immediate sub-directories of `rootDir` against a known-top-dirs list
 * (default KNOWN_TOP_DIRS). A target descriptor injects its own set via `knownDirs`
 * (codex passes descriptor.knownTopDirs so codex's prompts/sqlite/rules/… are recognized
 * rather than flagged `unknown`); an absent/non-array/empty `knownDirs` falls back to
 * KNOWN_TOP_DIRS so Claude — and any bare caller — stay byte-identical.
 * Symlinked directories count as present (the dogfood `.mgr` install is a dir
 * symlink); a broken symlink is skipped, never thrown.
 * @param {string} rootDir
 * @param {string[]} [knownDirs]  known-top-dirs to classify against (default KNOWN_TOP_DIRS)
 * @returns {TopDirsRecord}
 */
export function discoverTopLevelDirs(rootDir, knownDirs) {
  const bag = new DiagnosticBag();
  const knownNames = Array.isArray(knownDirs) && knownDirs.length > 0 ? knownDirs : KNOWN_TOP_DIRS;
  if (typeof rootDir !== 'string' || rootDir.length === 0) {
    bag.add({ severity: 'error', code: 'discover-bad-root', message: 'rootDir must be a non-empty string', phase: 'top-dirs' });
    return { known: knownNames.map((name) => ({ name, present: false })), unknown: [], diagnostics: bag.all() };
  }

  const present = listSubDirs(rootDir, bag);
  const knownSet = new Set(knownNames);
  const known = knownNames.map((name) => ({ name, present: present.has(name) }));
  const unknown = [...present].filter((n) => !knownSet.has(n)).sort();
  return { known, unknown, diagnostics: bag.all() };
}

/**
 * Set of immediate sub-directory names of `rootDir` (real dirs + symlinks that
 * resolve to dirs). A missing root is not an error here (empty set); any other
 * read failure is recorded.
 * @param {string} rootDir
 * @param {DiagnosticBag} bag
 * @returns {Set<string>}
 */
function listSubDirs(rootDir, bag) {
  /** @type {Set<string>} */
  const dirs = new Set();
  let entries;
  try {
    entries = readdirSync(rootDir, { withFileTypes: true });
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      bag.add({ severity: 'error', code: 'top-dirs-unreadable', message: errMessage(err), path: rootDir, phase: 'top-dirs' });
    }
    return dirs;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      dirs.add(e.name);
    } else if (e.isSymbolicLink()) {
      try {
        if (statSync(join(rootDir, e.name)).isDirectory()) dirs.add(e.name);
      } catch {
        // broken symlink — not a directory we can see; skip silently
      }
    }
  }
  return dirs;
}

/** @param {unknown} err @returns {string} */
function errMessage(err) {
  return err instanceof Error ? err.message : String(err ?? '');
}
