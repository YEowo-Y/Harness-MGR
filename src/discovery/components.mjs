/**
 * Component discovery (P1.U7; descriptor-aware P6.U3).
 *
 * Walks each target's component directories under a given config root and returns
 * a deterministic `ComponentRecord[]` plus a `Diagnostic[]`. NEVER throws (the
 * scanner contract from diagnostic.mjs: "any read-path failure becomes a
 * Diagnostic"). Bad input degrades to a diagnostic; the scan continues.
 *
 * The walk is DRIVEN by a per-target `componentKinds` table (one `{kind, dir,
 * layout}` entry per kind, layout ∈ 'skill-md'|'flat-md'|'flat-toml'). When no
 * descriptor is INJECTED via `opts.descriptor`, the historic Claude triple
 * (skills/<name>/SKILL.md, agents/*.md, commands/*.md) is used — so the absent-
 * descriptor path reproduces today's claude behavior BYTE-FOR-BYTE (the final
 * (kind, name, path) sort guarantees identical output regardless of iteration
 * order). A drift-guard test reconciles the local default against claudeDescriptor.
 *
 * --- Architecture constraint (LOAD-BEARING) ---
 * Dependency direction is targets/ → discovery/, never reverse. This module MUST
 * NOT statically import any src/targets/* module; the default kinds live here as a
 * module-local literal, and a descriptor (when used) is INJECTED by the caller.
 *
 * The actual frontmatter parsing lives in ./frontmatter.mjs (a pure,
 * zero-dependency, never-throws parser). This module is responsible only for
 * walking the filesystem and assembling records.
 *
 * --- Pure module, by design ---
 * Takes the config root as an explicit argument and depends only on node:fs /
 * node:path + the parser and the Source/Diagnostic typedefs. It does NOT resolve
 * the real ~/.claude (never imports paths.mjs / reexport.mjs), keeping its static
 * graph paths.mjs-free and trivial to test against fixture directories. Resolving
 * the live config dir — and surfacing a Diagnostic when that resolution fails —
 * belongs to the CLI boundary (P1.U15), not here. (Historically reexport.mjs
 * borrowed the config dir from ~/.claude/hooks/lib via a dynamic import + top-level
 * await, which is why staying reexport-free mattered for sync loading; the resolver
 * is first-party and synchronous now, so that specific concern is gone — but the
 * inject-the-root design still stands on its own.)
 *
 * --- Scope ---
 * Walks are FLAT to match the current fixture corpus: skills are one-level
 * directories, agents/commands are flat files. Namespaced commands
 * (`commands/git/commit.md` -> `/git:commit`) need recursion; that lands with a
 * dedicated nested fixture in a later unit, not here. The `flat-toml` layout
 * (codex agents) is filename-identity only — TOML content is NOT parsed this batch.
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { readFileSync, readdirSync, existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { makeSource } from '../lib/source.mjs';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { parseFrontmatter } from './frontmatter.mjs';
import { isAppleMetadata } from '../lib/apple-metadata.mjs';

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
 * The DEFAULT component kinds, used when no descriptor is INJECTED. Mirrors the
 * historically hardwired claude triple (skills/<name>/SKILL.md + agents/*.md +
 * commands/*.md). A drift-guard test reconciles this against claudeDescriptor so
 * the targets/ single-source and this discovery default can never silently diverge.
 */
const DEFAULT_COMPONENT_KINDS = Object.freeze([
  Object.freeze({ kind: 'skill', dir: 'skills', layout: 'skill-md' }),
  Object.freeze({ kind: 'agent', dir: 'agents', layout: 'flat-md' }),
  Object.freeze({ kind: 'command', dir: 'commands', layout: 'flat-md' }),
]);

/**
 * Discover all user-tier components under `rootDir`. Never throws: a missing
 * component directory yields nothing, an unreadable one yields a diagnostic, and
 * a malformed file yields a record (with a path-derived name) plus a diagnostic.
 * Output is sorted by (kind, name, path) so callers get a deterministic list
 * regardless of filesystem readdir order — important for golden-file tests and
 * the stable JSON envelope.
 *
 * The walk is driven by `opts.descriptor.componentKinds` when supplied; absent a
 * descriptor it reproduces today's claude behavior byte-for-byte. `flat-toml`
 * (codex agents) is filename-identity only — TOML content is NOT parsed this batch.
 *
 * @param {string} rootDir                 the config root to scan (e.g. a CLAUDE_CONFIG_DIR)
 * @param {Partial<Source>} [sourceInput]  provenance override (defaults to user tier)
 * @param {{descriptor?: import('../targets/descriptor.mjs').TargetDescriptor}} [opts]
 * @returns {DiscoveryResult}
 */
export function discoverComponents(rootDir, sourceInput, opts) {
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
  const kinds = Array.isArray(opts?.descriptor?.componentKinds)
    ? opts.descriptor.componentKinds
    : DEFAULT_COMPONENT_KINDS;

  /** @type {ComponentRecord[]} */
  const components = [];
  for (const spec of kinds) {
    for (const rec of collectKind(rootDir, spec, source, bag)) components.push(rec);
  }

  // The final (kind, name, path) sort is what guarantees byte-identical output
  // regardless of the componentKinds iteration order.
  components.sort(byKindNamePath);
  return { components, diagnostics: bag.all() };
}

/**
 * Dispatch one `{kind, dir, layout}` spec to its layout collector. A malformed
 * spec (non-object, or non-string/empty `kind`/`dir`) yields nothing; an unknown
 * layout yields nothing (flag no records). Pure, never throws.
 * @param {string} rootDir
 * @param {{kind?: unknown, dir?: unknown, layout?: unknown}} spec
 * @param {Source} source
 * @param {DiagnosticBag} bag
 * @returns {ComponentRecord[]}
 */
function collectKind(rootDir, spec, source, bag) {
  if (!spec || typeof spec !== 'object') return [];
  const { kind, dir, layout } = spec;
  if (typeof kind !== 'string' || kind.length === 0) return [];
  if (typeof dir !== 'string' || dir.length === 0) return [];
  switch (layout) {
    case 'skill-md':  return collectSkillMd(rootDir, dir, kind, source, bag);
    case 'flat-md':   return collectFlatMd(rootDir, dir, kind, source, bag);
    case 'flat-toml': return collectFlatToml(rootDir, dir, kind, source, bag);
    default:          return []; // unknown layout: flag nothing
  }
}

/**
 * Skills are directories: `<dir>/<name>/SKILL.md`. The loader identity is the
 * directory name (not the frontmatter `name`). A subdirectory without a
 * SKILL.md is simply not a skill and is skipped.
 * @param {string} rootDir
 * @param {string} dir          the component sub-directory (e.g. 'skills')
 * @param {ComponentKind} kind
 * @param {Source} source
 * @param {DiagnosticBag} bag
 * @returns {ComponentRecord[]}
 */
function collectSkillMd(rootDir, dir, kind, source, bag) {
  const skillsDir = join(rootDir, dir);
  /** @type {ComponentRecord[]} */
  const out = [];
  for (const ent of safeReaddir(skillsDir, bag)) {
    if (isAppleMetadata(ent.name)) continue; // .DS_Store/._*/.AppleDouble are never components (mac consistency)
    if (!ent.isDirectory()) continue;
    const file = join(skillsDir, ent.name, 'SKILL.md');
    // SECURITY: refuse to follow a symlinked SKILL.md. existsSync + readFileSync
    // both FOLLOW links, so a planted SKILL.md -> ~/.ssh/id_rsa (or any token
    // file) would read FOREIGN content into ComponentRecord.frontmatter, which
    // flows to `inventory --format json`. The lstat guard must run first.
    // Mirrors the symlink-never-follow rule in src/ops/snapshot-walk.mjs and
    // src/discovery/probe-state.mjs. (A top-level skill DIR-symlink is already
    // skipped above by !ent.isDirectory(); a symlinked agents/commands file by the
    // ent.isFile() gate in collectFlatMd/collectFlatToml.)
    if (isSymlinkPath(file)) {
      bag.add({
        severity: 'warn',
        code: 'component-symlink-skipped',
        message: `skipped symlinked SKILL.md (refusing to follow a link out of the config dir): ${ent.name}`,
        path: file,
        phase: 'components',
        fix: 'replace the symlinked SKILL.md with a real file inside the config dir',
      });
      continue;
    }
    if (!existsSync(file)) continue;
    out.push({ kind, name: ent.name, path: file, source, frontmatter: readFrontmatterFile(file, bag) });
  }
  return out;
}

/**
 * Flat `.md` files in `<dir>`. The loader identity is the file basename, except
 * agents prefer the frontmatter `name` when present (the codex `prompts/`
 * command kind, like the claude command kind, uses the basename).
 * @param {string} rootDir
 * @param {string} dir          the component sub-directory (e.g. 'agents'/'commands'/'prompts')
 * @param {ComponentKind} kind
 * @param {Source} source
 * @param {DiagnosticBag} bag
 * @returns {ComponentRecord[]}
 */
function collectFlatMd(rootDir, dir, kind, source, bag) {
  const subDir = join(rootDir, dir);
  /** @type {ComponentRecord[]} */
  const out = [];
  for (const ent of safeReaddir(subDir, bag)) {
    if (isAppleMetadata(ent.name)) continue; // an AppleDouble `._roster.md` sidecar is not a component
    if (!ent.isFile() || !/\.md$/i.test(ent.name)) continue;
    const file = join(subDir, ent.name);
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
 * Flat `.toml` files in `<dir>` (codex agents). FILENAME-IDENTITY ONLY: the loader
 * identity is the basename with `.toml` stripped, and the TOML CONTENT is NOT read
 * or parsed this batch (the TOML wave lands later) — `frontmatter` is a fresh empty
 * proto-safe map. The `ent.isFile()` gate already refuses symlinks (same as
 * collectFlatMd), so a planted link is never read.
 * @param {string} rootDir
 * @param {string} dir          the component sub-directory (e.g. 'agents')
 * @param {ComponentKind} kind
 * @param {Source} source
 * @param {DiagnosticBag} bag
 * @returns {ComponentRecord[]}
 */
function collectFlatToml(rootDir, dir, kind, source, bag) {
  const subDir = join(rootDir, dir);
  /** @type {ComponentRecord[]} */
  const out = [];
  for (const ent of safeReaddir(subDir, bag)) {
    if (isAppleMetadata(ent.name)) continue; // an AppleDouble `._agent.toml` sidecar is not a component
    if (!ent.isFile() || !/\.toml$/i.test(ent.name)) continue;
    const file = join(subDir, ent.name);
    const name = ent.name.replace(/\.toml$/i, '');
    out.push({ kind, name, path: file, source, frontmatter: emptyFrontmatter() });
  }
  return out;
}

/** A fresh empty proto-safe frontmatter map — filename identity only (TOML content is not parsed this batch). */
function emptyFrontmatter() {
  return parseFrontmatter('').data;
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
 * True if `p` is a symbolic link. lstatSync does NOT follow the link, so a
 * planted link is detected whether or not its target exists. Never throws: a
 * missing path (the common not-yet-created case) returns false, leaving the
 * existing existsSync/ENOENT handling to run. The discovery layer must not read
 * foreign file CONTENT via a link — same guard as src/ops/snapshot-walk.mjs.
 * @param {string} p
 * @returns {boolean}
 */
function isSymlinkPath(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * readdir that never throws. A missing directory (ENOENT) means "no components
 * of this kind" and is silent; any other error becomes a diagnostic.
 *
 * SECURITY — refuse a symlinked component-dir ROOT before reading it. This is the
 * shared chokepoint for EVERY layout collector (collectSkillMd's `skills/`,
 * collectFlatMd's `agents/`/`commands/`/`prompts/`, collectFlatToml's `agents/`), so
 * guarding here closes the ROOT vector for all kinds AND every walk (home,
 * plugin-cache leaves, and the codex `~/.agents/skills` sibling). Without it, a
 * symlinked root (e.g. `skills/` -> a foreign tree) would have its TARGET enumerated
 * by readdirSync and the foreign SKILL.md/.md frontmatter read into a ComponentRecord
 * that flows to `inventory --format json`. The inner SKILL.md-leaf guard
 * (isSymlinkPath) + the skill-DIR-symlink gate (!ent.isDirectory()) only cover entries
 * BELOW the root, not the root itself. Same never-follow-a-symlinked-root guard as
 * src/ops/snapshot-walk.mjs + src/discovery/probe-state.mjs; lstat reports the link
 * itself (a real dir / absent path is NOT flagged, so normal roots aren't over-rejected).
 * Warned (not silent, unlike the internal snapshot/drift walks) because discovery is
 * user-facing — a user whose component dir is a symlink should see why it was skipped.
 * @param {string} dir
 * @param {DiagnosticBag} bag
 * @returns {import('node:fs').Dirent[]}
 */
function safeReaddir(dir, bag) {
  if (isSymlinkPath(dir)) {
    bag.add({
      severity: 'warn',
      code: 'component-dir-symlink-skipped',
      message: `skipped symlinked component directory (refusing to follow a link out of the config dir): ${dir}`,
      path: dir,
      phase: 'components',
      fix: 'replace the symlinked component directory with a real directory inside the config dir',
    });
    return [];
  }
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
 * order is identical across platforms (locale-independent). Exported so the
 * multi-source wrapper (components-target.mjs) re-sorts a merged home+plugin list
 * with the SAME comparator — one ordering source, no drift.
 * @param {ComponentRecord} a
 * @param {ComponentRecord} b
 * @returns {number}
 */
export function byKindNamePath(a, b) {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.path === b.path) return 0;
  return a.path < b.path ? -1 : 1;
}
