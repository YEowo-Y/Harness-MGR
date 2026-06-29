/**
 * Codex config.toml probe (P6 codex doctor: #26/#27).
 *
 * A PASSIVE I/O gatherer — reads only, never spawns, never writes. It is the
 * fact-gathering half for the two codex-specific doctor checks the pure
 * codex-checks.mjs judges:
 *   #26 config-toml-valid — was config.toml parseable? (tomlError)
 *   #27 trust-overbroad   — which [projects."P"] tables trust an overbroad path?
 *
 * codex keeps its whole config in `~/.codex/config.toml`. The `[projects."<path>"]`
 * tables each carry a `trust_level` ("trusted"/"untrusted"/absent); a project whose
 * path transitively trusts the whole home dir (or a drive root) is the #27 signal.
 *
 * This gather is only invoked for a codex target (doctor-facts gates it on
 * descriptor.id === 'codex'); a Claude run never touches it.
 *
 * --- M2-safe ---
 * NEVER imports src/paths.mjs — the home dir is injected by the caller (resolved
 * via node:os there), keeping this module's static graph paths.mjs-free (the
 * M2-safe property the boundary self-check enforces).
 *
 * Zero npm dependencies. Node stdlib only. Never throws.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readTomlFile } from './read-toml.mjs';
import { CODEX_STATE_TMP_RE } from '../targets/codex.mjs';

/**
 * @typedef {Object} LeftoverStateTmp
 * @property {number} count    how many `..codex-global-state.json.tmp-*` files are in configDir
 * @property {string[]} sample up to 3 of the matching names (sorted), for the #28 message/UX
 */

/**
 * @typedef {Object} CodexConfigFacts
 * @property {string|null} tomlError       the readTomlFile error (parse/read), or null when valid/missing
 * @property {string[]} trustedProjects    every `[projects."P"]` key whose table has trust_level === 'trusted'
 * @property {string} homeDir              passed through (the OS home dir) for #27's overbroad judgment
 * @property {LeftoverStateTmp} leftoverStateTmp  count of leftover ..codex-global-state.json.tmp-* files; judged by #28
 */

/** Prototype-polluting keys to skip when iterating a parsed table, defensively. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Gather codex config.toml facts: parse-validity + the trusted-project list.
 *
 * A missing config.toml is benign: tomlError null + trustedProjects []. A parse/read
 * error surfaces as tomlError set (judged into a #26 ERROR) — trustedProjects stays
 * [] because there is no parsed table to read. Never throws.
 *
 * @param {{ configDir: string, homeDir: string }} opts
 * @returns {{ codexConfig: CodexConfigFacts, diagnostics: import('../lib/diagnostic.mjs').Diagnostic[] }}
 */
export function gatherCodexConfig(opts) {
  // `|| {}` (not a destructuring default, which only catches `undefined`) so a
  // literal `null` opts also degrades safely — honors the never-throws contract.
  const { configDir, homeDir } = opts || {};
  /** @type {import('../lib/diagnostic.mjs').Diagnostic[]} */
  const diagnostics = [];
  const home = typeof homeDir === 'string' ? homeDir : '';
  // Leftover-state scan is independent of config.toml validity (a corrupt config
  // doesn't change what cruft is on disk), so compute it once for every return path.
  const leftoverStateTmp = scanLeftoverStateTmp(configDir);

  let file;
  try {
    file = join(typeof configDir === 'string' ? configDir : '', 'config.toml');
  } catch {
    return { codexConfig: { tomlError: null, trustedProjects: [], homeDir: home, leftoverStateTmp }, diagnostics };
  }

  const res = readTomlFile(file);
  // A missing file is benign (no config trust to judge). A read/parse error becomes
  // a tomlError #26 will escalate; we do NOT also emit a gather diagnostic for it
  // (the doctor #26 finding is the user-facing surface).
  const tomlError = res.missing ? null : (typeof res.error === 'string' ? res.error : null);
  const trustedProjects = tomlError ? [] : collectTrustedProjects(res.value);

  return { codexConfig: { tomlError, trustedProjects, homeDir: home, leftoverStateTmp }, diagnostics };
}

/**
 * Count the leftover `..codex-global-state.json.tmp-*` files in configDir (the codex
 * analog of CC's CLAUDE.md.backup.* bloat). READ-ONLY readdir — matches by NAME only
 * (no stat, no symlink follow). A bad/unreadable configDir → {count:0,sample:[]}. The
 * regex is single-sourced from the codex descriptor so the orphan detector recognizes
 * exactly the files #28 counts (never a "known but uncounted" / "counted but orphan" split).
 * Never throws.
 * @param {*} configDir
 * @returns {LeftoverStateTmp}
 */
function scanLeftoverStateTmp(configDir) {
  if (typeof configDir !== 'string' || configDir.length === 0) return { count: 0, sample: [] };
  let names;
  try {
    names = readdirSync(configDir);
  } catch {
    return { count: 0, sample: [] };
  }
  /** @type {string[]} */
  const matched = [];
  for (const n of names) {
    if (typeof n === 'string' && CODEX_STATE_TMP_RE.test(n)) matched.push(n);
  }
  matched.sort();
  return { count: matched.length, sample: matched.slice(0, 3) };
}

/**
 * Collect every key of the parsed `config.projects` table whose value is an object
 * carrying `trust_level === 'trusted'`. parseToml output is Object.create(null), so
 * Object.keys is proto-safe; we still skip __proto__/constructor/prototype defensively.
 * @param {*} parsed  the parseToml root (Object.create(null)) or null
 * @returns {string[]}
 */
function collectTrustedProjects(parsed) {
  /** @type {string[]} */
  const out = [];
  if (!parsed || typeof parsed !== 'object') return out;
  const projects = parsed.projects;
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return out;
  for (const key of Object.keys(projects)) {
    if (UNSAFE_KEYS.has(key)) continue;
    const table = projects[key];
    if (!table || typeof table !== 'object' || Array.isArray(table)) continue;
    if (table.trust_level === 'trusted') out.push(key);
  }
  return out;
}
