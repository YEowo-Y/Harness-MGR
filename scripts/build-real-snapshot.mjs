/**
 * build-real-snapshot.mjs
 *
 * Walks the real ~/.claude directory and produces a REDACTED structure snapshot:
 * - Directory names and component names only (no file contents, no values)
 * - File counts per directory
 * - NO credentials, NO token-like strings, NO raw absolute paths
 *
 * Replacements applied to ALL string values:
 *   real home path  → <HOME>
 *   real username   → <USER>
 *   Windows paths   → <HOME>/...
 *   hex/base64 blobs ≥20 chars → <REDACTED>
 *
 * Output: test/fixtures/real-snapshot/snapshot.json
 *
 * Usage (run manually by maintainer; do NOT auto-run in CI):
 *   node test/fixtures/build-real-snapshot.mjs
 *
 * The output is safe to commit. The raw ~/.claude is never committed.
 */

import { readdirSync, statSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, userInfo } from 'node:os';

const HOME = homedir();
const USERNAME = (() => { try { return userInfo().username; } catch { return ''; } })();

// ── Redaction ─────────────────────────────────────────────────────────────────

/** @param {string} s */
function redact(s) {
  if (typeof s !== 'string') return s;
  // Home path first (contains username, so replace before username pass)
  if (HOME) {
    s = s.split(HOME.replace(/\\/g, '/')).join('<HOME>');
    s = s.split(HOME).join('<HOME>');
  }
  if (USERNAME) s = s.split(USERNAME).join('<USER>');
  // Any remaining absolute Windows or POSIX-style paths
  s = s.replace(/[A-Za-z]:[/\\]Users[/\\][^/\\\s"']+/g, '<HOME>');
  s = s.replace(/\/[cC]\/Users\/[^/\s"']+/g, '<HOME>');
  // Token-like blobs: hex ≥20 or base64url ≥32
  s = s.replace(/\b[0-9a-fA-F]{20,}\b/g, '<REDACTED>');
  s = s.replace(/[A-Za-z0-9+/=_-]{32,}/g, '<REDACTED>');
  return s;
}

/** @param {unknown} obj @returns {unknown} */
function redactDeep(obj) {
  if (typeof obj === 'string') return redact(obj);
  if (Array.isArray(obj)) return obj.map(redactDeep);
  if (obj && typeof obj === 'object') {
    /** @type {Record<string,unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[redact(k)] = redactDeep(v);
    return out;
  }
  return obj;
}

// ── Filesystem helpers ────────────────────────────────────────────────────────

/** @param {string} dir */
function shallowWalk(dir) {
  try {
    const entries = readdirSync(dir);
    const dirs = [], files = [];
    for (const name of entries) {
      try {
        const st = statSync(join(dir, name));
        (st.isDirectory() ? dirs : files).push(name);
      } catch { /* skip unreadable */ }
    }
    return { dirs, files };
  } catch {
    return { dirs: [], files: [], error: 'EACCES' };
  }
}

/** @param {string} dir */
function walkSkills(dir) {
  const { dirs } = shallowWalk(dir);
  return dirs.map((name) => ({
    name: redact(name),
    hasSKILLmd: existsSync(join(dir, name, 'SKILL.md')),
    fileCount: shallowWalk(join(dir, name)).files.length,
  }));
}

/** @param {string} dir */
function walkAgents(dir) {
  return shallowWalk(dir).files.map((f) => redact(basename(f, '.md')));
}

/** @param {string} dir */
function walkCommands(dir) {
  return shallowWalk(dir).files.map((f) => redact(basename(f, '.md')));
}

/** @param {string} pluginsDir */
function walkPlugins(pluginsDir) {
  /** @type {Record<string,unknown>} */
  const result = {};
  const { dirs, files } = shallowWalk(pluginsDir);
  result.topFiles = files.map(redact).sort();
  result.topDirs = dirs.map(redact).sort();

  const ipPath = join(pluginsDir, 'installed_plugins.json');
  if (existsSync(ipPath)) {
    try {
      const raw = JSON.parse(readFileSync(ipPath, 'utf-8'));
      result.installedPluginsVersion = raw.version;
      result.installedPluginKeys = Object.keys(raw.plugins ?? {}).map(redact).sort();
      result.installedPluginCount = result.installedPluginKeys.length;
    } catch {
      result.installedPluginsError = 'parse-error';
    }
  }

  const cacheDir = join(pluginsDir, 'cache');
  if (existsSync(cacheDir)) {
    const { dirs: marketplaces } = shallowWalk(cacheDir);
    result.cache = marketplaces.map((mkt) => {
      const { dirs: plugins } = shallowWalk(join(cacheDir, mkt));
      return {
        marketplace: redact(mkt),
        plugins: plugins.map((pl) => {
          const { dirs: versions } = shallowWalk(join(cacheDir, mkt, pl));
          return { plugin: redact(pl), versions: versions.map(redact) };
        }),
      };
    });
  }

  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const claudeDir = join(HOME, '.claude');
const top = shallowWalk(claudeDir);

const KNOWN_TOP_DIRS = [
  'agents', 'backups', 'cache', 'commands', 'debug', 'downloads',
  'file-history', 'hooks', 'hud', 'paste-cache', 'plans', 'plugins',
  'projects', 'session-env', 'sessions', 'shell-snapshots', 'skills',
  'tasks', 'telemetry',
];

/** @type {Record<string,unknown>} */
const counts = {};
for (const dir of KNOWN_TOP_DIRS) {
  const p = join(claudeDir, dir);
  if (!existsSync(p)) { counts[dir] = null; continue; }
  const { dirs, files } = shallowWalk(p);
  counts[dir] = { files: files.length, dirs: dirs.length };
}

const skillsDir = join(claudeDir, 'skills');
const agentsDir = join(claudeDir, 'agents');
const commandsDir = join(claudeDir, 'commands');
const pluginsDir = join(claudeDir, 'plugins');
const hooksDir = join(claudeDir, 'hooks');

const skillsList = existsSync(skillsDir) ? walkSkills(skillsDir) : null;
const agentsList = existsSync(agentsDir) ? walkAgents(agentsDir) : null;
const commandsList = existsSync(commandsDir) ? walkCommands(commandsDir) : null;

/** @type {Record<string,unknown>} */
const snapshot = {
  _meta: {
    generatedAt: new Date().toISOString(),
    generatedBy: 'build-real-snapshot.mjs',
    note: 'REDACTED — structure and counts only. No file contents, no setting values, no credentials.',
    claudeDir: '<HOME>/.claude',
    nodeVersion: process.version,
  },
  topLevel: {
    dirs: top.dirs.map(redact).sort(),
    files: top.files.map(redact).sort(),
  },
  counts,
  agents: agentsList ? { count: agentsList.length, names: agentsList.sort() } : null,
  skills: skillsList ? { count: skillsList.length, items: skillsList } : null,
  commands: commandsList ? { count: commandsList.length, names: commandsList.sort() } : null,
  plugins: existsSync(pluginsDir) ? walkPlugins(pluginsDir) : null,
  hooks: existsSync(hooksDir) ? {
    topFiles: shallowWalk(hooksDir).files.map(redact).sort(),
    topDirs: shallowWalk(hooksDir).dirs.map(redact).sort(),
  } : null,
};

// Final safety pass: deep-redact every string in the output
const safe = redactDeep(snapshot);

const here = fileURLToPath(import.meta.url);
const outPath = join(here, '..', '..', 'test', 'fixtures', 'real-snapshot', 'snapshot.json');
writeFileSync(outPath, JSON.stringify(safe, null, 2) + '\n', 'utf-8');
console.log('Written:', outPath);
console.log('Skills:', snapshot.skills?.count,
  '| Agents:', snapshot.agents?.count,
  '| Commands:', snapshot.commands?.count);
