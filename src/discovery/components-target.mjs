/**
 * Target-aware (multi-source) component discovery (P6 — codex multi-source scan).
 *
 * `discoverComponentsForTarget({rootDir, descriptor})` returns the SAME
 * `{components, diagnostics}` shape as discoverComponents, but in addition to the
 * per-target HOME walk it also walks each EXTRA component root the descriptor
 * declares in `componentSources` (P6). For Codex that is the IN-TREE plugin caches
 * (`plugins/cache/<marketplace>/<plugin>/<leaf>/skills/<name>/SKILL.md`), so a real
 * codex scan now sees plugin-provided skills alongside the home skills.
 *
 * --- Back-compat (LOAD-BEARING) ---
 * Claude declares NO `componentSources`, so for Claude (and any descriptor without
 * extra sources) this is byte-identical to discoverComponents(rootDir, …) — pinned
 * by a deepEqual drift-guard test. scan.mjs calls THIS instead of discoverComponents.
 *
 * --- Provenance ---
 * A plugin-cache component is tiered 'plugin' with `source.plugin` = the plugin dir
 * name and `source.marketplace` = the marketplace dir name. That namespacing is what
 * keeps a plugin skill (`github:gh-fix-ci`) from colliding with a home skill
 * (`gh-fix-ci`) in the Claude resolution model; codex's own co-existence semantics
 * are handled honestly downstream (analysis/codex-coexistence.mjs + conflicts).
 *
 * --- Symlink / dedup safety ---
 * Each marketplace/plugin/leaf level is enumerated with `readdirSync(withFileTypes)`
 * and filtered to real directories (`ent.isDirectory()`), which excludes symlinks (a
 * Dirent reports `isDirectory()===false` for a symlink). So codex's `latest -> <version>`
 * leaf is NOT followed and the versioned skill is counted once. The innermost
 * SKILL.md symlink guard in collectSkillMd (reused via discoverComponents) is the
 * second line of defense against reading foreign file content via a link.
 *
 * --- Pure, M2-safe, never-throws ---
 * Reuses discoverComponents for every walk, so it inherits the never-throws contract.
 * Imports only node:fs/path + components.mjs + DiagnosticBag — NEVER paths.mjs (the
 * descriptor is injected by the caller). Output is sorted by (kind, name, path).
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { discoverComponents, byKindNamePath } from './components.mjs';

/**
 * @typedef {import('./components.mjs').ComponentRecord} ComponentRecord
 * @typedef {import('./components.mjs').DiscoveryResult} DiscoveryResult
 * @typedef {import('../targets/descriptor.mjs').TargetDescriptor} TargetDescriptor
 */

/**
 * Discover all components for a target: the home `componentKinds` walk PLUS every
 * extra `componentSources` root the descriptor declares. Never throws.
 *
 * @param {{rootDir: string, descriptor?: TargetDescriptor}} opts
 * @returns {DiscoveryResult}
 */
export function discoverComponentsForTarget(opts) {
  const { rootDir, descriptor } = opts ?? {};
  const bag = new DiagnosticBag();
  if (typeof rootDir !== 'string' || rootDir.length === 0) {
    bag.add({ severity: 'error', code: 'discover-bad-root', message: 'rootDir must be a non-empty string', phase: 'components' });
    return { components: [], diagnostics: bag.all() };
  }

  // 1. Home walk (tier 'user') — byte-identical to the pre-multisource behavior.
  const home = discoverComponents(rootDir, undefined, { descriptor });
  /** @type {ComponentRecord[]} */
  const components = home.components.slice();
  for (const d of home.diagnostics) bag.add(d);

  // 2. Extra component sources. Absent (Claude) → nothing added, byte-identical.
  const sources = Array.isArray(descriptor?.componentSources) ? descriptor.componentSources : [];
  for (const src of sources) {
    if (!src) continue;
    if (src.kind === 'plugin-cache') {
      for (const rec of walkPluginCache(rootDir, src, bag)) components.push(rec);
    } else if (src.kind === 'sibling-dir') {
      for (const rec of walkSiblingDir(rootDir, src, bag)) components.push(rec);
    }
  }

  // Re-sort the merged list with the SAME comparator the home walk uses (single source).
  components.sort(byKindNamePath);
  return { components, diagnostics: bag.all() };
}

/**
 * Walk a plugin-cache source: `<rootDir>/<src.dir>/<marketplace>/<plugin>/<leaf>/`
 * and discover the declared `src.kinds` inside each leaf, tiered 'plugin' with
 * marketplace+plugin provenance. Reuses discoverComponents per leaf (so the SKILL.md
 * symlink guard + never-throws come for free). Symlinked leaves are skipped. Never throws.
 * @param {string} rootDir
 * @param {{dir?: unknown, kinds?: unknown}} src
 * @param {DiagnosticBag} bag
 * @returns {ComponentRecord[]}
 */
function walkPluginCache(rootDir, src, bag) {
  /** @type {ComponentRecord[]} */
  const out = [];
  if (typeof src.dir !== 'string' || src.dir.length === 0) return out;
  if (!Array.isArray(src.kinds) || src.kinds.length === 0) return out;
  const kinds = src.kinds;

  const cacheRoot = join(rootDir, src.dir);
  for (const marketplace of safeDirNames(cacheRoot, bag)) {           // marketplaces
    const mpDir = join(cacheRoot, marketplace);
    for (const plugin of safeDirNames(mpDir, bag)) {                  // plugins
      const pluginDir = join(mpDir, plugin);
      for (const leaf of safeDirNames(pluginDir, bag)) {             // version/hash leaves (symlinks skipped)
        const leafDir = join(pluginDir, leaf);
        // Reuse the home collector per leaf: tier 'plugin' + provenance, walking the
        // declared kinds (skills) under leafDir. discoverComponents never throws.
        const r = discoverComponents(leafDir, { tier: 'plugin', plugin, marketplace }, { descriptor: { componentKinds: kinds } });
        for (const c of r.components) out.push(c);
        for (const d of r.diagnostics) bag.add(d);
      }
    }
  }
  return out;
}

/**
 * Walk a sibling-dir source: `<dirname(rootDir)>/<src.dir>/` (a documented scope
 * OUTSIDE the config dir — codex's USER-scope `~/.agents`), discovering the declared
 * `src.kinds` there tiered 'user'. Resolving as a SIBLING of the config dir keeps the
 * default `~/.codex` → `~/.agents` (codex's USER scope) AND stays hermetic +
 * self-consistent under a `--config-dir` override. Reuses discoverComponents (so the
 * symlink-safe SKILL.md guard + never-throws come for free). M2-safe (dirname/join
 * only — no paths.mjs, no homedir()). Never throws.
 * @param {string} rootDir
 * @param {{dir?: unknown, kinds?: unknown}} src
 * @param {DiagnosticBag} bag
 * @returns {ComponentRecord[]}
 */
function walkSiblingDir(rootDir, src, bag) {
  /** @type {ComponentRecord[]} */
  const out = [];
  if (typeof src.dir !== 'string' || src.dir.length === 0) return out;
  if (!Array.isArray(src.kinds) || src.kinds.length === 0) return out;
  const base = join(dirname(rootDir), src.dir);
  // tier 'user': a user-scope location (not a plugin). Distinguished from the home
  // dir's skills by path. discoverComponents never throws (missing base → empty).
  const r = discoverComponents(base, { tier: 'user' }, { descriptor: { componentKinds: src.kinds } });
  for (const c of r.components) out.push(c);
  for (const d of r.diagnostics) bag.add(d);
  return out;
}

/**
 * Names of the REAL sub-directories of `dir` (symlinks excluded — a Dirent reports
 * isDirectory()===false for a symlink, so codex's `latest` leaf is never followed).
 * A missing dir (ENOENT) is silent ("no plugin cache here"); any other error → a
 * diagnostic. Never throws.
 * @param {string} dir
 * @param {DiagnosticBag} bag
 * @returns {string[]}
 */
function safeDirNames(dir, bag) {
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (!(err && err.code === 'ENOENT')) bag.addError('component-dir-unreadable', err, { path: dir, phase: 'components' });
    return [];
  }
  /** @type {string[]} */
  const names = [];
  for (const ent of ents) if (ent.isDirectory()) names.push(ent.name);
  return names;
}
