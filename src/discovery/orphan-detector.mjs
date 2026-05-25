/**
 * Orphan detection (P1.U11).
 *
 * Walks a Claude Code config root and classifies unexpected filesystem entries
 * into two categories — hard orphans and soft orphans — recorded as facts:
 *
 *   hard — an entry at the TOP LEVEL of the config root whose name is not in
 *           KNOWN_TOP_DIRS (for directories) or KNOWN_TOP_FILES (for files).
 *           "Hard" because it has no recognised home at all.
 *
 *   soft — a file found DIRECTLY INSIDE one of the three component directories
 *           (skills/, agents/, commands/) that does not conform to that dir's
 *           recognised shape. "Soft" because the parent dir is known; only the
 *           entry inside it is unexpected.
 *
 * Subdirectories under skills/, agents/, and commands/ are intentionally NOT
 * walked further:
 *   - A subdir under skills/ is a skill dir or a candidate skill dir; its
 *     internal files are skill-owned (SKILL.md + supporting references).
 *   - Subdirs under agents/ and commands/ are reserved for deferred namespacing
 *     (see components.mjs: `commands/git/commit.md` → `/git:commit`).
 *
 * Orphan records are FACTS about the filesystem, not judgments. The info-severity
 * `orphan-files` doctor check (P2.U6 #12) is the appropriate place to evaluate
 * whether a given orphan warrants user attention.
 *
 * --- Pure module ---
 * Takes `rootDir` explicitly; does NOT import paths.mjs or reexport.mjs (those
 * are async and would break sync testability). The CLI boundary (P1.U15) passes
 * authoritative values resolved from paths.mjs at runtime.
 *
 * Zero npm dependencies. Node stdlib only. Never throws.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { KNOWN_TOP_DIRS } from './settings.mjs';

/**
 * Files that legitimately live directly in a Claude Code config root. This list
 * is intentionally CONSERVATIVE: a newer Claude Code release may add a top-level
 * file not listed here, which would surface as an informational hard orphan
 * (orphans are facts, not judgments — the doctor decides if it matters). Extend
 * as ground-truth evolves. (Note: ~/.claude.json lives in the HOME dir, not in
 * the config root, so it is intentionally absent.)
 */
export const KNOWN_TOP_FILES = Object.freeze([
  'settings.json', 'settings.local.json', 'CLAUDE.md', '.credentials.json', '.mcp.json',
  // Claude Code runtime files added in newer releases:
  '.last-cleanup', 'bash-commands.log', 'cost-tracker.log', 'history.jsonl',
  'mcp-needs-auth-cache.json',
]);

/**
 * Top-level FILE patterns for entries that cannot be matched by exact name (e.g.
 * UUID-suffixed or timestamp-suffixed runtime files). Each RegExp is tested against
 * the base name only. Currently covers:
 *   - security_warnings_state_<uuid>.json  — Claude Code security-warning state files
 *   - CLAUDE.md.backup.<timestamp>          — Claude Code config backups (doctor #13
 *     `claude-md-backup-bloat` owns the "too many" judgment; recognising them here
 *     prevents double-flagging as both a backup AND an orphan)
 *
 * --- Third-party ecosystem (oh-my-claudecode / OMC) file patterns ---
 * NOTE: these are NOT Claude-Code-native. They are common OMC runtime artifacts
 * recognised here so a heavily-OMC harness is not drowned in orphan noise. This
 * block is deliberately isolated so it can be dropped if claude-mgr is ever
 * distributed standalone without OMC.
 *   - .omc-*.json  — OMC config/version/state files (.omc-config.json, .omc-version.json, …)
 */
export const KNOWN_TOP_FILE_PATTERNS = Object.freeze([
  /^security_warnings_state_[0-9a-fA-F-]+\.json$/,
  /^CLAUDE\.md\.backup\..+/,
  // oh-my-claudecode (OMC) runtime artifacts:
  /^\.omc-[\w.-]+\.json$/,
]);

/**
 * Top-level DIRECTORY names that are NOT Claude-Code-native but belong to the
 * oh-my-claudecode (OMC) framework. Recognised here so a heavily-OMC harness is
 * not drowned in hard-orphan noise. This block is deliberately isolated so it can
 * be dropped if claude-mgr is ever distributed standalone without OMC.
 *   .omc          — OMC root state directory (contains state/ subdir)
 *   homunculus    — OMC agent-state store
 *   metrics       — OMC usage metrics
 *   session-data  — OMC session persistence
 *   teams         — OMC team configuration
 */
export const KNOWN_ECOSYSTEM_TOP_DIRS = Object.freeze([
  '.omc', 'homunculus', 'metrics', 'session-data', 'teams',
]);

/**
 * Top-level entry names that belong to claude-mgr ITSELF and must never be flagged
 * as hard orphans. '.mgr-state' mirrors MGR_STATE_DIRNAME in src/paths.mjs; '.mgr' is
 * the dogfood install dir (a symlink in production). The CLI boundary (P1.U15) will
 * pass authoritative values resolved from paths.mjs; this default covers the common case.
 */
export const DEFAULT_OWN_TOP_DIRS = Object.freeze(['.mgr-state', '.mgr']);

/**
 * @typedef {Object} OrphanRecord
 * @property {'hard'|'soft'} category   hard = unknown TOP-LEVEL entry; soft = unrecognized file inside a known component dir
 * @property {'file'|'dir'} entryType
 * @property {string} name              the entry's base name
 * @property {string} path              absolute path
 * @property {string} container         for soft: 'skills'|'agents'|'commands'; for hard: '' (the config root)
 * @property {string} reason            short human-readable explanation
 */

/**
 * @typedef {Object} OrphanResult
 * @property {OrphanRecord[]} hard
 * @property {OrphanRecord[]} soft
 * @property {import('../lib/diagnostic.mjs').Diagnostic[]} diagnostics
 */

/**
 * Resolve a dirent's effective type, following symlinks. Returns 'dir', 'file',
 * or null (broken symlink / socket / fifo / device — caller skips).
 * @param {import('node:fs').Dirent} entry
 * @param {string} parentDir
 * @returns {'dir'|'file'|null}
 */
function resolveEntryType(entry, parentDir) {
  if (entry.isDirectory()) return 'dir';
  if (entry.isFile()) return 'file';
  if (entry.isSymbolicLink()) {
    try {
      const st = statSync(join(parentDir, entry.name));
      if (st.isDirectory()) return 'dir';
      if (st.isFile()) return 'file';
      return null;
    } catch {
      return null; // broken symlink
    }
  }
  return null; // socket / fifo / device
}

/** Sort comparator for hard orphans: (entryType, name) — 'dir' < 'file'. */
function compareHard(a, b) {
  if (a.entryType !== b.entryType) return a.entryType < b.entryType ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Sort comparator for soft orphans: (container, name). */
function compareSoft(a, b) {
  if (a.container !== b.container) return a.container < b.container ? -1 : a.container > b.container ? 1 : 0;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** The combined known-dir set: CC-native (from settings.mjs) + OMC ecosystem. */
const ALL_KNOWN_TOP_DIRS = new Set([...KNOWN_TOP_DIRS, ...KNOWN_ECOSYSTEM_TOP_DIRS]);

/** Frozen Set for O(1) exact-name look-ups against KNOWN_TOP_FILES. */
const KNOWN_TOP_FILE_SET = new Set(KNOWN_TOP_FILES);

/**
 * Returns true if `name` is a recognised top-level file (exact match OR matches
 * any pattern in KNOWN_TOP_FILE_PATTERNS). Pure, never throws.
 * @param {string} name
 * @returns {boolean}
 */
function isKnownTopFile(name) {
  if (KNOWN_TOP_FILE_SET.has(name)) return true;
  for (const re of KNOWN_TOP_FILE_PATTERNS) {
    if (re.test(name)) return true;
  }
  return false;
}

/**
 * Read and classify all top-level entries of `rootDir`.
 * Returns {hard, componentDirsPresent} or null when the root is unreadable/missing.
 * @param {string} rootDir
 * @param {Set<string>} ownTopDirs
 * @param {DiagnosticBag} bag
 * @returns {{hard: OrphanRecord[], componentDirsPresent: Set<string>}|null}
 */
function classifyTopLevel(rootDir, ownTopDirs, bag) {
  let topEntries;
  try {
    topEntries = readdirSync(rootDir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return null; // missing root is silent
    bag.add({ severity: 'error', code: 'orphans-unreadable', message: err instanceof Error ? err.message : String(err ?? ''), path: rootDir, phase: 'orphans' });
    return null;
  }

  /** @type {OrphanRecord[]} */
  const hard = [];
  /** @type {Set<string>} */
  const componentDirsPresent = new Set();

  for (const entry of topEntries) {
    const name = entry.name;
    const entryType = resolveEntryType(entry, rootDir);
    if (entryType === null) continue;
    if (ownTopDirs.has(name)) continue;

    if (entryType === 'dir') {
      if (ALL_KNOWN_TOP_DIRS.has(name)) {
        if (name === 'skills' || name === 'agents' || name === 'commands') {
          componentDirsPresent.add(name);
        }
      } else {
        hard.push({ category: 'hard', entryType: 'dir', name, path: join(rootDir, name), container: '', reason: 'unknown top-level directory' });
      }
    } else if (!isKnownTopFile(name)) {
      hard.push({ category: 'hard', entryType: 'file', name, path: join(rootDir, name), container: '', reason: 'unknown top-level file' });
    }
  }

  return { hard, componentDirsPresent };
}

/**
 * Walk skills/, agents/, and commands/ directly (one level deep) and collect
 * soft orphans: loose files under skills/, non-.md files under agents/ or commands/.
 * @param {string} rootDir
 * @param {Set<string>} componentDirsPresent
 * @param {DiagnosticBag} bag
 * @returns {OrphanRecord[]}
 */
function collectSoftOrphans(rootDir, componentDirsPresent, bag) {
  /** @type {OrphanRecord[]} */
  const soft = [];

  for (const container of ['skills', 'agents', 'commands']) {
    if (!componentDirsPresent.has(container)) continue;
    const subDir = join(rootDir, container);
    let subEntries;
    try {
      subEntries = readdirSync(subDir, { withFileTypes: true });
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        bag.add({ severity: 'error', code: 'orphans-unreadable', message: err instanceof Error ? err.message : String(err ?? ''), path: subDir, phase: 'orphans' });
      }
      continue;
    }

    for (const entry of subEntries) {
      const name = entry.name;
      const entryType = resolveEntryType(entry, subDir);
      if (entryType === null || entryType === 'dir') continue; // dirs are not flagged

      if (container === 'skills') {
        soft.push({ category: 'soft', entryType: 'file', name, path: join(subDir, name), container: 'skills', reason: 'loose file in skills/ (skills must be <name>/SKILL.md)' });
      } else if (!/\.md$/i.test(name)) {
        soft.push({ category: 'soft', entryType: 'file', name, path: join(subDir, name), container, reason: `non-.md file in ${container}/` });
      }
    }
  }

  return soft;
}

/**
 * Detect hard and soft orphans in a Claude Code config root.
 *
 * @param {string} rootDir
 * @param {{ownTopDirs?: string[]}} [opts]
 * @returns {OrphanResult}
 */
export function detectOrphans(rootDir, opts) {
  const bag = new DiagnosticBag();

  if (typeof rootDir !== 'string' || rootDir.length === 0) {
    bag.add({ severity: 'error', code: 'discover-bad-root', message: 'rootDir must be a non-empty string', phase: 'orphans' });
    return { hard: [], soft: [], diagnostics: bag.all() };
  }

  const ownTopDirs = new Set(opts?.ownTopDirs ?? DEFAULT_OWN_TOP_DIRS);
  const top = classifyTopLevel(rootDir, ownTopDirs, bag);

  if (top === null) return { hard: [], soft: [], diagnostics: bag.all() };

  const { hard, componentDirsPresent } = top;
  const soft = collectSoftOrphans(rootDir, componentDirsPresent, bag);

  hard.sort(compareHard);
  soft.sort(compareSoft);

  return { hard, soft, diagnostics: bag.all() };
}
