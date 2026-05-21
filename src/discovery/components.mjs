/**
 * Component discovery (P1.U7).
 *
 * Walks the three user-tier component directories under a given config root —
 * `skills/<name>/SKILL.md`, `agents/*.md`, `commands/*.md` — and returns a
 * deterministic `ComponentRecord[]` plus a `Diagnostic[]`. NEVER throws (the
 * scanner contract from diagnostic.mjs: "any read-path failure becomes a
 * Diagnostic"). Bad input degrades to a diagnostic; the scan continues.
 *
 * The actual frontmatter parsing lives in ./frontmatter.mjs (a pure,
 * zero-dependency, never-throws parser). This module is responsible only for
 * walking the filesystem and assembling records.
 *
 * --- Pure module, by design ---
 * Takes the config root as an explicit argument and depends only on node:fs /
 * node:path + the parser and the Source/Diagnostic typedefs. It does NOT resolve
 * the real ~/.claude (no reexport import), so it loads synchronously and is
 * trivial to test against fixture directories. Resolving the live config dir —
 * and the M2 "missing hooks/lib surfaces a Diagnostic" follow-up — belong to the
 * CLI boundary (P1.U15), not here.
 *
 * --- Scope (P1.U7, deliberately minimal) ---
 * Walks are FLAT to match the current fixture corpus: skills are one-level
 * directories, agents/commands are flat `.md` files. Namespaced commands
 * (`commands/git/commit.md` -> `/git:commit`) need recursion; that lands with a
 * dedicated nested fixture in a later unit, not here.
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeSource } from '../lib/source.mjs';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { parseFrontmatter } from './frontmatter.mjs';

/**
 * @typedef {import('../lib/source.mjs').Source} Source
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 */

/**
 * @typedef {'skill'|'agent'|'command'} ComponentKind
 */

/**
 * A discovered component. `name` is the LOADER IDENTITY (the key Claude Code
 * keys on for shadowing): the directory name for skills, the file basename for
 * commands, and the frontmatter `name` for agents (falling back to the file
 * basename when absent/unparseable). `frontmatter` is the raw parsed scalar map,
 * so analysis can later compare the declared `name` against the loader identity.
 *
 * @typedef {Object} ComponentRecord
 * @property {ComponentKind} kind
 * @property {string} name
 * @property {string} path                          absolute path to the component file
 * @property {Source} source                         provenance (user tier in Phase 1)
 * @property {Record<string, string>} frontmatter    parsed scalar frontmatter fields
 */

/**
 * The standard `{components, diagnostics}` shape every scanner returns. Matches
 * the ConfigProvider.scanComponents contract sketched in the plan.
 *
 * @typedef {Object} DiscoveryResult
 * @property {ComponentRecord[]} components
 * @property {Diagnostic[]} diagnostics
 */

/**
 * Discover all user-tier components under `rootDir`. Never throws: a missing
 * component directory yields nothing, an unreadable one yields a diagnostic, and
 * a malformed file yields a record (with a path-derived name) plus a diagnostic.
 * Output is sorted by (kind, name, path) so callers get a deterministic list
 * regardless of filesystem readdir order — important for golden-file tests and
 * the stable JSON envelope.
 *
 * @param {string} rootDir                 the config root to scan (e.g. a CLAUDE_CONFIG_DIR)
 * @param {Partial<Source>} [sourceInput]  provenance override (defaults to user tier)
 * @returns {DiscoveryResult}
 */
export function discoverComponents(rootDir, sourceInput) {
  const bag = new DiagnosticBag();
  if (typeof rootDir !== 'string' || rootDir.length === 0) {
    bag.add({
      severity: 'error',
      code: 'discover-bad-root',
      message: 'rootDir must be a non-empty string',
      phase: 'components',
    });
    return { components: [], diagnostics: bag.all() };
  }

  const source = makeSource(sourceInput);
  /** @type {ComponentRecord[]} */
  const components = [
    ...collectSkills(rootDir, source, bag),
    ...collectFlat(rootDir, 'agent', source, bag),
    ...collectFlat(rootDir, 'command', source, bag),
  ];

  components.sort(byKindNamePath);
  return { components, diagnostics: bag.all() };
}

/**
 * Skills are directories: `skills/<name>/SKILL.md`. The loader identity is the
 * directory name (not the frontmatter `name`). A subdirectory without a
 * SKILL.md is simply not a skill and is skipped.
 * @param {string} rootDir
 * @param {Source} source
 * @param {DiagnosticBag} bag
 * @returns {ComponentRecord[]}
 */
function collectSkills(rootDir, source, bag) {
  const skillsDir = join(rootDir, 'skills');
  /** @type {ComponentRecord[]} */
  const out = [];
  for (const ent of safeReaddir(skillsDir, bag)) {
    if (!ent.isDirectory()) continue;
    const file = join(skillsDir, ent.name, 'SKILL.md');
    if (!existsSync(file)) continue;
    out.push({ kind: 'skill', name: ent.name, path: file, source, frontmatter: readFrontmatterFile(file, bag) });
  }
  return out;
}

/**
 * Agents and commands are flat `.md` files. The loader identity is the file
 * basename, except agents prefer the frontmatter `name` when present.
 * @param {string} rootDir
 * @param {ComponentKind} kind          'agent' or 'command'
 * @param {Source} source
 * @param {DiagnosticBag} bag
 * @returns {ComponentRecord[]}
 */
function collectFlat(rootDir, kind, source, bag) {
  const dir = join(rootDir, kind === 'agent' ? 'agents' : 'commands');
  /** @type {ComponentRecord[]} */
  const out = [];
  for (const ent of safeReaddir(dir, bag)) {
    if (!ent.isFile() || !/\.md$/i.test(ent.name)) continue;
    const file = join(dir, ent.name);
    const base = ent.name.replace(/\.md$/i, '');
    const frontmatter = readFrontmatterFile(file, bag);
    const name = kind === 'agent' && typeof frontmatter.name === 'string' && frontmatter.name.length
      ? frontmatter.name
      : base;
    out.push({ kind, name, path: file, source, frontmatter });
  }
  return out;
}

/**
 * Read + parse one component file's frontmatter, routing failures to the bag.
 * ENOENT is silent (the file vanished between readdir/existsSync and read — a
 * benign TOCTOU race; same treatment safeReaddir gives a missing dir). Any other
 * read failure -> 'error' diagnostic. Malformed frontmatter -> 'warn' (a
 * data-quality issue the user should fix, not a tool fault). Always returns a
 * map so the caller can still build a record.
 * @param {string} file
 * @param {DiagnosticBag} bag
 * @returns {Record<string,string>}
 */
function readFrontmatterFile(file, bag) {
  let text;
  try {
    text = readFileSync(file, 'utf-8');
  } catch (err) {
    if (!(err && err.code === 'ENOENT')) {
      bag.addError('component-read-failed', err, { path: file, phase: 'components' });
    }
    return parseFrontmatter('').data;
  }
  const parsed = parseFrontmatter(text);
  if (parsed.error) {
    bag.add({
      severity: 'warn',
      code: 'frontmatter-invalid',
      message: parsed.error,
      path: file,
      phase: 'components',
      fix: 'fix the YAML frontmatter so values are well-formed',
    });
  }
  return parsed.data;
}

/**
 * readdir that never throws. A missing directory (ENOENT) means "no components
 * of this kind" and is silent; any other error becomes a diagnostic.
 * @param {string} dir
 * @param {DiagnosticBag} bag
 * @returns {import('node:fs').Dirent[]}
 */
function safeReaddir(dir, bag) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    bag.addError('component-dir-unreadable', err, { path: dir, phase: 'components' });
    return [];
  }
}

/**
 * Stable ordering: kind, then name, then path. Uses code-unit comparison so the
 * order is identical across platforms (locale-independent).
 * @param {ComponentRecord} a
 * @param {ComponentRecord} b
 * @returns {number}
 */
function byKindNamePath(a, b) {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.path === b.path) return 0;
  return a.path < b.path ? -1 : 1;
}
